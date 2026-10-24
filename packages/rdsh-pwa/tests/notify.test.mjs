/**
 * Notification half: payload copy, encryption and the push request shape.
 *
 * The cryptography is checked by decrypting what this module produces with an
 * independent implementation of the receiving side (RFC 8291), which is the
 * only way to know the framing is right without a real push service.
 */

import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	applyNotify,
	buildQuestionPayload,
	buildTurnEndPayload,
	encryptPushPayload,
	endpointAudience,
	fillTemplate,
	fromBase64Url,
	makePayload,
	normalizeNotifyConfig,
	PushStore,
	toBase64Url,
	vapidAuthorization,
} from "../notify/host.js";
import { copyFor } from "../lib/copy.js";

test("base64url round-trips and drops padding", () => {
	const bytes = randomBytes(37);
	const encoded = toBase64Url(bytes);
	assert.match(encoded, /^[A-Za-z0-9_-]+$/, "no +, / or = survive");
	assert.deepEqual(fromBase64Url(encoded), bytes);
});

test("templates keep unknown placeholders visible", () => {
	assert.equal(fillTemplate("{a} and {b}", { a: "x" }), "x and {b}");
	assert.equal(fillTemplate("{session}", { session: "名前" }), "名前");
});

test("copy config merges over the defaults by type", () => {
	const merged = normalizeNotifyConfig({ appName: "APP", onlyMobileTurns: false, bogus: 1 });
	assert.equal(merged.appName, "APP");
	assert.equal(merged.onlyMobileTurns, false);
	assert.equal("bogus" in merged, false, "unknown keys are ignored");
	assert.equal(normalizeNotifyConfig({ onlyMobileTurns: "yes" }).onlyMobileTurns, true, "a wrong type keeps the default");
});

test("turn-end and question payloads carry the session id", () => {
	const turn = buildTurnEndPayload("session-1", { kind: "completed" }, { session: "テスト", lang: "en" });
	assert.equal(turn.sessionId, "session-1");
	assert.equal(turn.title, "テスト", "the session name is the headline");
	assert.match(turn.url, /session=session-1/);

	const question = buildQuestionPayload(
		{ agent: { id: "session-2" }, questions: [{ header: "確認", question: "進めますか？" }] },
		{ session: "別の名前", lang: "en" },
	);
	assert.equal(question.sessionId, "session-2");
	assert.equal(question.title, "別の名前");
	assert.match(question.body, /進めますか？/);
});

test("an unnamed session falls back to the app prefix", () => {
	const payload = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "en" });
	assert.equal(payload.title, "DSH: Work finished");
});

test("payload copy follows the configured language", () => {
	// English stays available explicitly. Japanese uses COPY.ja per key and
	// falls back to English for keys that have not been translated yet.
	const english = buildTurnEndPayload("s", { kind: "aborted" }, { session: "", lang: "en" });
	assert.equal(english.title, "DSH: Stopped (interrupted)");
	assert.equal(english.body, "End reason: aborted");
	const japaneseStrings = copyFor("ja");
	const japanese = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "ja" });
	assert.equal(japanese.title, `DSH: ${japaneseStrings["notify.turn.completed"]}`);
	assert.equal(japanese.body, japaneseStrings["notify.turn.detailCompleted"]);

	const question = buildQuestionPayload({ agent: { id: "q" }, questions: [{ question: "Proceed?" }] }, { lang: "en" });
	assert.equal(question.title, "DSH: Confirm", "the default question header is English");
});

test("encryption round-trips against an independent receiver", () => {
	// The browser side: a P-256 key pair and a 16-byte auth secret.
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const authSecret = randomBytes(16);
	const subscription = {
		endpoint: "https://push.example/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(authSecret) },
	};
	const plaintext = JSON.stringify({ title: "t", body: "b" });
	const body = encryptPushPayload(subscription, plaintext);

	// aes128gcm framing: salt(16) | record size(4) | key id len(1) | key id | data
	const salt = body.subarray(0, 16);
	const recordSize = body.readUInt32BE(16);
	const keyIdLength = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + keyIdLength);
	const ciphertext = body.subarray(21 + keyIdLength);
	assert.equal(recordSize, 4096);
	assert.equal(keyIdLength, 65, "an uncompressed P-256 point");
	assert.equal(asPublic[0], 4, "the point is uncompressed");

	// The receiver's half of RFC 8291 §3.4.
	const sharedSecret = userAgent.computeSecret(asPublic);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), userAgent.getPublicKey(), asPublic]);
	const inputKeyMaterial = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
	const contentKey = Buffer.from(hkdfSync("sha256", inputKeyMaterial, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", inputKeyMaterial, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

	const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
	decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
	const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);

	// The last record ends with the 0x02 padding delimiter.
	assert.equal(record[record.length - 1], 2);
	assert.equal(record.subarray(0, record.length - 1).toString("utf8"), plaintext);
});

test("each message uses a fresh ephemeral key", () => {
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const subscription = {
		endpoint: "https://push.example/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
	const first = encryptPushPayload(subscription, "a").subarray(21, 86);
	const second = encryptPushPayload(subscription, "a").subarray(21, 86);
	assert.notDeepEqual(first, second, "reusing the key would let a captured message be replayed");
});

test("VAPID produces a signed ES256 JWT for the endpoint origin", async () => {
	const { generateVapidKeys } = await import("../notify/host.js");
	const keys = generateVapidKeys();
	const header = vapidAuthorization({ keys, audience: "https://web.push.apple.com", subject: "https://app.example" });
	assert.match(header, /^vapid t=[^,]+, k=[A-Za-z0-9_-]+$/);
	const jwt = header.slice("vapid t=".length, header.indexOf(", k="));
	const [head, claims] = jwt.split(".");
	const decodedHeader = JSON.parse(Buffer.from(fromBase64Url(head)).toString("utf8"));
	const decodedClaims = JSON.parse(Buffer.from(fromBase64Url(claims)).toString("utf8"));
	assert.deepEqual(decodedHeader, { typ: "JWT", alg: "ES256" });
	assert.equal(decodedClaims.aud, "https://web.push.apple.com");
	assert.equal(decodedClaims.sub, "https://app.example");
	assert.ok(decodedClaims.exp > Date.now() / 1000, "the token is in the future");
});

test("the endpoint origin is what VAPID signs for", () => {
	assert.equal(endpointAudience("https://web.push.apple.com/QPuf3"), "https://web.push.apple.com");
	assert.equal(endpointAudience("not a url"), "");
});

test("the store persists a subscription and picks the VAPID subject", () => {
	const file = join(mkdtempSync(join(tmpdir(), "rdsh-pwa-")), "push.json");
	const store = new PushStore(file);
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const subscription = {
		endpoint: "https://web.push.apple.com/abc",
		keys: { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) },
	};
	assert.equal(store.subscriptions().length, 0);
	assert.equal(store.add(subscription, { label: "iOS", origin: "https://app.example:8444" }), 1);
	assert.equal(store.subscriptions()[0].origin, "https://app.example:8444");
	// Apple rejects mailto:root@localhost, so the app origin is preferred.
	assert.equal(store.subject(""), "https://app.example:8444");
	assert.equal(store.subject("mailto:me@example.com"), "mailto:me@example.com", "an explicit subject wins");
	assert.equal(store.remove(subscription.endpoint), true);
	assert.equal(store.subscriptions().length, 0);

	// A second store instance reads the same file back.
	const again = new PushStore(file);
	assert.equal(again.keys().publicKey, store.keys().publicKey, "the VAPID pair is stable across restarts");
});

test("a subscription without keys is refused", () => {
	const file = join(mkdtempSync(join(tmpdir(), "rdsh-pwa-")), "push.json");
	const store = new PushStore(file);
	assert.throws(() => store.add({ endpoint: "https://x/y" }), /client keys/);
	assert.throws(() => store.add({ keys: {} }), /endpoint/);
});

test("push endpoints must be real https push services", () => {
	const file = join(mkdtempSync(join(tmpdir(), "rdsh-pwa-")), "push.json");
	const store = new PushStore(file);
	const userAgent = createECDH("prime256v1");
	userAgent.generateKeys();
	const keys = { p256dh: toBase64Url(userAgent.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	// The host POSTs to whatever is stored, so anything that is not a public
	// https push service has to be refused at subscribe time.
	for (const endpoint of [
		"http://web.push.apple.com/abc",
		"https://127.0.0.1:9999/x",
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.5/x",
		"https://192.168.1.10/x",
		"https://172.16.0.9/x",
		"https://localhost/x",
		"https://printer.local/x",
		"not-a-url",
	]) {
		assert.throws(() => store.add({ endpoint, keys }), /subscription endpoint/, endpoint);
	}
	assert.equal(store.subscriptions().length, 0, "nothing was stored");
	// A real push service is accepted.
	assert.equal(store.add({ endpoint: "https://web.push.apple.com/abc", keys }, { origin: "https://app.example" }), 1);
});

test("a phone send marks the next turn; a desktop send does not", async () => {
	const home = mkdtempSync(join(tmpdir(), "rdsh-fromphone-"));
	const file = join(home, "rdsh-pwa", "push.json");
	mkdirSync(join(home, "rdsh-pwa"), { recursive: true });
	const makeKeys = () => {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		return { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	};
	const store = new PushStore(file);
	store.add({ endpoint: "https://web.push.apple.com/phone", keys: makeKeys() }, { origin: "https://app.example:8446" });
	store.add({ endpoint: "https://web.push.apple.com/old", keys: makeKeys() }, { origin: "https://app.example:8444" });

	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	process.env.DSH_HOME = home;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	try {
		const listeners = new Map();
		const agent = { id: "s1" };
		const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
		const routes = new Map();
		const services = {
			agents,
			connection: { requestRejection: () => undefined },
			webServer: {
				register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
				tapIndex() { return () => {}; },
				getOrigin: () => "https://app.example:8446",
			},
		};
		const scope = {
			...services,
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
			effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
		};
		const ctx = {
			inject(deps, callback) { return callback(scope); },
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => {}; },
			effect(fn) { return scope.effect(fn); },
		};
		applyNotify(ctx, { onlyMobileTurns: true });
		const mobileSend = routes.get("/api/rdsh-pwa/push/mobile-send");
		const post = async (path, body) => {
			const req = Readable.from([Buffer.from(JSON.stringify(body))]);
			req.method = "POST";
			req.url = path;
			req.headers = { origin: "https://app.example:8446" };
			let status = 0;
			await routes.get(path).handler(req, { writeHead(code) { status = code; }, end() {} });
			return status;
		};
		const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

		assert.equal(await post("/api/rdsh-pwa/push/mobile-send", { sessionId: "s1" }), 200);
		listeners.get("session/event")({ id: "s1" }, { type: "turn/start" });
		listeners.get("session/event")({ id: "s1" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "only the origin that sent the turn is pushed");

		calls.length = 0;
		listeners.get("session/event")({ id: "s2" }, { type: "turn/start" });
		listeners.get("session/event")({ id: "s2" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
		await wait();
		assert.deepEqual(calls, [], "a desktop turn is not pushed when onlyMobileTurns is true");
	} finally {
		globalThis.fetch = previousFetch;
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("notification fan-out targets the app that started the turn or request", async () => {
	const home = mkdtempSync(join(tmpdir(), "rdsh-targeting-"));
	const file = join(home, "rdsh-pwa", "push.json");
	mkdirSync(join(home, "rdsh-pwa"), { recursive: true });
	const makeKeys = () => {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		return { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	};
	const store = new PushStore(file);
	store.add({ endpoint: "https://web.push.apple.com/phone", keys: makeKeys() }, { origin: "https://app.example:8446" });
	store.add({ endpoint: "https://web.push.apple.com/old", keys: makeKeys() }, { origin: "https://app.example:8444" });

	const previousHome = process.env.DSH_HOME;
	const previousFetch = globalThis.fetch;
	process.env.DSH_HOME = home;
	const calls = [];
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		return { status: 201, ok: true };
	};
	const wait = () => new Promise((resolve) => setTimeout(resolve, 20));
	const harness = (getOrigin) => {
		const listeners = new Map();
		const routes = new Map();
		const agent = { id: "s1" };
		const agents = { get: (id) => (id === "s1" ? agent : undefined), roots: () => [agent] };
		const services = {
			agents,
			connection: { requestRejection: () => undefined },
			webServer: {
				register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
				tapIndex() { return () => {}; },
				getOrigin: () => getOrigin,
			},
		};
		const scope = {
			...services,
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => listeners.delete(event); },
			effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
		};
		const ctx = {
			inject(deps, callback) { return callback(scope); },
			get: (name) => services[name],
			on(event, handler) { listeners.set(event, handler); return () => {}; },
			effect(fn) { return scope.effect(fn); },
		};
		applyNotify(ctx, { onlyMobileTurns: true });
		return { routes, listeners };
	};
	const request = async (target, path, { method = "POST", body = undefined, origin = undefined } = {}) => {
		const text = body === undefined ? "" : JSON.stringify(body);
		const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
		req.method = method;
		req.url = path;
		req.headers = origin === undefined ? {} : { origin };
		let status = 0;
		await target.routes.get(path).handler(req, { writeHead(code) { status = code; }, end() {} });
		return status;
	};
	const turn = (target, id, type) => target.listeners.get("session/event")({ id }, { type, data: { reason: { kind: "completed" } } });
	const question = (target) => target.listeners.get("user-questions/request")({ agent: { id: "s1", session: { id: "s1" } }, questions: [{ header: "Q", question: "Continue?" }] }, () => {});

	try {
		// No request-derived origin: /test without an Origin header keeps the
		// historical all-subscriptions fallback.
		const legacy = harness("http://127.0.0.1:3207");
		assert.equal(await request(legacy, "/api/rdsh-pwa/push/test", { body: {} }), 200);
		await wait();
		assert.deepEqual(calls.sort(), ["https://web.push.apple.com/old", "https://web.push.apple.com/phone"].sort());
		calls.length = 0;

		// An origin-less mobile-send keeps the legacy fallback as well.
		assert.equal(await request(legacy, "/api/rdsh-pwa/push/mobile-send", { body: { sessionId: "s1" } }), 200);
		turn(legacy, "s1", "turn/start");
		turn(legacy, "s1", "turn/end");
		await wait();
		assert.equal(calls.length, 2, "an origin-less mobile-send no longer falls back");

		// /test with an explicit origin sends only to that app.
		calls.length = 0;
		assert.equal(await request(legacy, "/api/rdsh-pwa/push/test", { body: {}, origin: "https://app.example:8446" }), 200);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"]);

		// mobile-send with the page origin pins turn/end to that app.
		calls.length = 0;
		assert.equal(await request(legacy, "/api/rdsh-pwa/push/mobile-send", { body: { sessionId: "s1", origin: "https://app.example:8446" } }), 200);
		turn(legacy, "s1", "turn/start");
		turn(legacy, "s1", "turn/end");
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"]);

		// webServer.getOrigin() matching a stored subscription seeds ownOrigins.
		calls.length = 0;
		const seeded = harness("https://app.example:8446");
		question(seeded);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "a matching server origin was not adopted");

		// A non-matching internal origin is not adopted.
		calls.length = 0;
		const internal = harness("http://127.0.0.1:3207");
		question(internal);
		await wait();
		assert.equal(calls.length, 2, "an internal origin was incorrectly adopted");

		// Question fallback: ownOrigins when no turn origin is known.
		calls.length = 0;
		const own = harness("http://127.0.0.1:3207");
		assert.equal(await request(own, "/api/rdsh-pwa/push/vapid", { method: "GET", origin: "https://app.example:8444" }), 200);
		question(own);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/old"]);

		// Question priority: the turn's origin wins over ownOrigins.
		calls.length = 0;
		assert.equal(await request(own, "/api/rdsh-pwa/push/mobile-send", { body: { sessionId: "s1", origin: "https://app.example:8446" } }), 200);
		turn(own, "s1", "turn/start");
		question(own);
		await wait();
		assert.deepEqual(calls, ["https://web.push.apple.com/phone"], "the turn origin did not win over ownOrigins");
	} finally {
		globalThis.fetch = previousFetch;
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
	}
});

test("a broken push store does not stop the PWA routes", async () => {
	// applyNotify opens a state file; when that throws, the rest of the plugin
	// must still mount. Mount with a context whose file cannot be written.
	const { apply: applyPlugin } = await import("../index.js");
	const routes = new Map();
	const webServer = {
		register(route) { routes.set(route.path, route); return () => routes.delete(route.path); },
		tapIndex() { return () => {}; },
		getOrigin: () => "http://127.0.0.1:0",
	};
	const services = {
		webServer,
		agents: { get: () => undefined, roots: () => [] },
		connection: { requestRejection: () => undefined },
	};
	const scope = {
		...services,
		get: (name) => services[name],
		on: () => () => {},
		effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
	};
	const ctx = {
		inject: (deps, callback) => callback(scope),
		get: (name) => services[name],
		effect: (fn) => scope.effect(fn),
	};
	// A directory where the state file should be makes the write fail.
	const blocked = join(mkdtempSync(join(tmpdir(), "rdsh-pwa-")), "rdsh-pwa");
	mkdtempSync(blocked);
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = join(blocked, "..");
	try {
		// Force the store path to be a directory so PushStore cannot save.
		mkdirSync(join(blocked, "push.json"), { recursive: true });
		applyPlugin(ctx, {});
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
	}
	assert.ok(routes.has("/manifest.webmanifest"), "the PWA routes still mounted");
	assert.ok(routes.has("/sw.js"));
});

test("payload shape is what the service worker reads", () => {
	const payload = makePayload("session-9", "question", "t", "b");
	assert.deepEqual(Object.keys(payload).sort(), ["body", "kind", "sessionId", "title", "url"]);
	assert.equal(payload.kind, "question");
	assert.match(payload.url, /^\/?(\?|.*[?&])session=session-9$/, "a relative URL the worker can navigate to");
});
