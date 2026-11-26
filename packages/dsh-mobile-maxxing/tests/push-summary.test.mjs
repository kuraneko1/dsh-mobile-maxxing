import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { applyNotify, buildTurnEndPayload, NOTIFY_DEFAULTS, PushStore, toBase64Url } from "../notify/host.js";
import {
	buildSummaryPrompt,
	createTurnActivityTracker,
	listSummaryModels,
	normalizeSummarySelection,
	normalizeSummaryText,
	parseSummarySelectionInput,
	SummarySettingsStore,
} from "../notify/summary.js";
import { copyFor } from "../lib/copy.js";

const ORIGIN = "https://app.example:8446";
const SUMMARY_ROUTE = "/api/dsh-mobile-maxxing/push/summary-model";
const PREVIEW_ROUTE = "/api/dsh-mobile-maxxing/push/preview";
const MOBILE_SEND_ROUTE = "/api/dsh-mobile-maxxing/push/mobile-send";
const ACK_ROUTE = "/api/dsh-mobile-maxxing/push/ack";
const WAIT_MS = 1600;

function removeTemporaryHome(home) {
	try {
		if (typeof home !== "string" || home === "") return;
		const root = realpathSync(tmpdir());
		const target = realpathSync(home);
		if (dirname(target) !== root) return;
		if (!basename(target).startsWith("rdsh-summary-")) return;
		if (!lstatSync(target).isDirectory()) return;
		rmSync(target, { recursive: true, force: true });
	} catch {
	}
}

function withHome(run) {
	return async () => {
		const home = mkdtempSync(join(tmpdir(), "rdsh-summary-"));
		const previous = process.env.DSH_HOME;
		process.env.DSH_HOME = home;
		try {
			await run(home, join(home, "dsh-mobile-maxxing"));
		} finally {
			if (previous === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previous;
			removeTemporaryHome(home);
		}
	};
}

function makeDevice(endpoint) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = randomBytes(16);
	return {
		endpoint,
		subscription: {
			endpoint,
			keys: {
				p256dh: toBase64Url(ecdh.getPublicKey()),
				auth: toBase64Url(auth),
			},
		},
		decrypt(body) {
			const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
			const salt = buf.subarray(0, 16);
			const keyIdLength = buf.readUInt8(20);
			const asPublic = buf.subarray(21, 21 + keyIdLength);
			const ciphertext = buf.subarray(21 + keyIdLength);
			const sharedSecret = ecdh.computeSecret(asPublic);
			const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]);
			const ikm = Buffer.from(hkdfSync("sha256", sharedSecret, auth, keyInfo, 32));
			const contentKey = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
			const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
			const decipher = createDecipheriv("aes-128-gcm", contentKey, nonce);
			decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
			const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
			assert.equal(record[record.length - 1], 2);
			return JSON.parse(record.subarray(0, record.length - 1).toString("utf8"));
		},
	};
}

function makeHarness({
	config = {},
	profileName = undefined,
	llm = undefined,
	rejection = undefined,
	transport = undefined,
	sessions = [],
} = {}) {
	const listeners = new Map();
	const routes = new Map();
	const agentsById = new Map();
	for (const entry of sessions) {
		agentsById.set(entry.id, entry);
	}
	const services = {
		agents: { get: (id) => agentsById.get(id) },
		profileContext: profileName === undefined ? undefined : { name: profileName },
		llm,
		connection: { requestRejection: () => rejection },
		sessionTitle: { get: (session) => (session?.title ? { title: session.title } : undefined) },
		webServer: {
			register(route) {
				routes.set(route.path, route);
				return () => routes.delete(route.path);
			},
			tapIndex() {
				return () => {};
			},
			getOrigin: () => ORIGIN,
		},
	};
	const makeContextProxy = (base, injectedDeps = []) => {
		const allowed = new Set(injectedDeps);
		return new Proxy(base, {
			get(target, prop, receiver) {
				if (typeof prop === "string" && prop in services && !(prop in target)) {
					if (allowed.has(prop)) return services[prop];
					throw new Error(`cannot get property "${prop}" without inject`);
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	};
	const createScope = (deps) => makeContextProxy({
		get: (name) => services[name],
		on(event, handler) {
			listeners.set(event, handler);
			return () => listeners.delete(event);
		},
		effect(fn) {
			const dispose = fn();
			return typeof dispose === "function" ? dispose : () => {};
		},
	}, deps);
	const rootScope = createScope([]);
	const ctx = makeContextProxy({
		sessionTitle: services.sessionTitle,
		inject(deps, callback) {
			return callback(createScope(Array.isArray(deps) ? deps : []));
		},
		get: (name) => services[name],
		on(event, handler) {
			listeners.set(event, handler);
			return () => {};
		},
		effect(fn) {
			return rootScope.effect(fn);
		},
	}, []);
	const delivered = [];
	const defaultTransport = async (url, options) => {
		delivered.push({ url: String(url), options });
		return { status: 201, ok: true };
	};
	const api = applyNotify(ctx, config, { transport: transport ?? defaultTransport });
	return {
		...api,
		routes,
		listeners,
		delivered,
		addSession(id, header = { cwd: "/tmp/work" }, title = "") {
			const session = { id, header, title };
			const agent = { id, header, session };
			agentsById.set(id, agent);
			return session;
		},
	};
}

async function callRoute(harness, path, { method = "GET", rawBody = undefined, body = undefined, origin = ORIGIN } = {}) {
	const route = harness.routes.get(path);
	assert.ok(route !== undefined, `missing route ${path}`);
	const text = rawBody !== undefined ? rawBody : body === undefined ? "" : JSON.stringify(body);
	const req = Readable.from(text === "" ? [] : [Buffer.from(text)]);
	req.method = method;
	req.url = path;
	req.headers = origin === undefined ? {} : { origin };
	let status = 0;
	let headers = {};
	let responseText = "";
	await route.handler(req, {
		writeHead(code, nextHeaders = {}) {
			status = code;
			headers = nextHeaders;
		},
		end(chunk) {
			if (typeof chunk === "string") responseText += chunk;
			else if (Buffer.isBuffer(chunk)) responseText += chunk.toString("utf8");
		},
	});
	let json = null;
	try {
		json = responseText === "" ? null : JSON.parse(responseText);
	} catch {
	}
	return { status, headers, text: responseText, json };
}

function makeFakeLlm({
	providers = [{ id: "deepseek", name: "DeepSeek" }],
	modelsByProvider = { deepseek: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] },
	efforts = [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
	chunks = [{ type: "text-delta", index: 0, text: "Implemented the unit tests and verified all checks pass." }],
	onPrepareCall = undefined,
	onStream = undefined,
	prepareError = undefined,
	streamError = undefined,
} = {}) {
	const calls = [];
	return {
		calls,
		listProviders: typeof providers === "function" ? providers : () => providers,
		listModels: typeof modelsByProvider === "function"
			? modelsByProvider
			: (providerId) => modelsByProvider[providerId] ?? [],
		async prepareCall(config, signal, configure) {
			if (prepareError) throw prepareError;
			const modelInfo = {
				provider: config.provider,
				id: config.model,
				name: config.model,
				...(efforts ? { reasoning: { efforts } } : {}),
			};
			const configured = typeof configure === "function" ? configure({ ...config }, modelInfo) : { ...config };
			const record = { prepareConfig: config, configured, streamOptions: null };
			calls.push(record);
			onPrepareCall?.(record, signal, modelInfo);
			return {
				config: configured,
				stream(options) {
					record.streamOptions = options;
					onStream?.(options, record);
					if (streamError) {
						return (async function* () {
							throw streamError;
						})();
					}
					return (async function* () {
						for (const chunk of chunks) {
							if (signal?.aborted) throw signal.reason ?? new Error("aborted");
							yield chunk;
						}
					})();
				},
			};
		},
	};
}

test("selection normalization and HTTP boundary validation reject invalid shapes and keep valid pairs", () => {
	assert.deepEqual(normalizeSummarySelection(undefined), { mode: "off" });
	assert.deepEqual(normalizeSummarySelection({ mode: "off", provider: "a", model: "b" }), { mode: "off" });
	assert.deepEqual(normalizeSummarySelection({ provider: " deepseek ", model: " deepseek-chat " }), {
		mode: "model",
		provider: "deepseek",
		model: "deepseek-chat",
	});
	assert.deepEqual(normalizeSummarySelection({ mode: "model", provider: "a\nb", model: "c" }), { mode: "off" });
	assert.deepEqual(normalizeSummarySelection({ mode: "unknown", provider: "a", model: "b" }), { mode: "off" });

	assert.deepEqual(parseSummarySelectionInput({ mode: "off" }), { ok: true, value: { mode: "off" } });
	assert.deepEqual(parseSummarySelectionInput({ provider: "", model: "" }), { ok: true, value: { mode: "off" } });
	assert.deepEqual(parseSummarySelectionInput({ provider: "  deepseek ", model: " deepseek-chat  " }), {
		ok: true,
		value: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
	});
	assert.deepEqual(parseSummarySelectionInput({ mode: "model", provider: "a".repeat(200), model: "b".repeat(200) }), {
		ok: true,
		value: { mode: "model", provider: "a".repeat(200), model: "b".repeat(200) },
	});

	for (const bad of [
		null,
		[],
		"off",
		{ mode: "auto", provider: "a", model: "b" },
		{ mode: "model", provider: "", model: "" },
		{ mode: "model", provider: "a", model: "" },
		{ provider: "a", model: "" },
		{ provider: "", model: "b" },
		{ provider: "a" },
		{ model: "b" },
		{ mode: "model", provider: "a\u0000b", model: "b" },
		{ mode: "model", provider: "a\nb", model: "b" },
		{ mode: "off", provider: "a\u007fb" },
		{ mode: "model", provider: "a".repeat(201), model: "b" },
		{ mode: "model", provider: "a", model: "b".repeat(201) },
	]) {
		const res = parseSummarySelectionInput(bad);
		assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
	}
});

test("SummarySettingsStore persists per-profile settings separately from push.json and respects explicit off", withHome(async (_home, stateDir) => {
	const pushFile = join(stateDir, "push.json");
	const pushStore = new PushStore(pushFile);
	const device = makeDevice("https://web.push.apple.com/store-check");
	pushStore.add(device.subscription, { origin: ORIGIN });

	const store = new SummarySettingsStore(stateDir, { mode: "model", provider: "default-p", model: "default-m" });
	assert.deepEqual(store.read(), { mode: "model", provider: "default-p", model: "default-m" });

	assert.equal(store.bindProfile("alpha"), true);
	store.write({ mode: "off" });
	const alphaFile = join(stateDir, "push-summary-alpha.json");
	assert.equal(statSync(alphaFile).mode & 0o777, 0o600);

	const alphaReloaded = new SummarySettingsStore(stateDir, { mode: "model", provider: "default-p", model: "default-m" });
	assert.equal(alphaReloaded.bindProfile("alpha"), true);
	assert.deepEqual(alphaReloaded.read(), { mode: "off" });

	const corrupt = new SummarySettingsStore(stateDir, { mode: "model", provider: "default-p", model: "default-m" });
	assert.equal(corrupt.bindProfile("corrupt"), true);
	writeFileSync(join(stateDir, "push-summary-corrupt.json"), JSON.stringify({ mode: "model", provider: "", model: "" }));
	assert.deepEqual(corrupt.read(), { mode: "model", provider: "default-p", model: "default-m" });

	const beta = new SummarySettingsStore(stateDir);
	assert.equal(beta.bindProfile("beta"), true);
	assert.deepEqual(beta.read(), { mode: "off" });
	beta.write({ mode: "model", provider: "openai", model: "gpt-4o-mini" });
	assert.deepEqual(alphaReloaded.read(), { mode: "off" });
	assert.deepEqual(beta.read(), { mode: "model", provider: "openai", model: "gpt-4o-mini" });

	assert.equal(beta.bindProfile("../escape"), false);
	assert.deepEqual(beta.read(), { mode: "model", provider: "openai", model: "gpt-4o-mini" });

	const pushRaw = JSON.parse(readFileSync(pushFile, "utf8"));
	assert.equal("summary" in pushRaw || "summarySelection" in pushRaw, false);
	assert.equal(pushStore.subscriptions().length, 1);
}));

test("activity tracker, prompt framing, and output normalizer enforce bounds cleanly", () => {
	const tracker = createTurnActivityTracker();
	tracker.recordEvent("s1", { type: "turn/start" });
	tracker.recordEvent("s1", { type: "user/message", data: { source: { kind: "cron" }, content: [{ type: "text", text: "ignore cron" }] } });
	for (let i = 0; i < 4; i += 1) {
		tracker.recordEvent("s1", {
			type: "user/message",
			data: { source: { kind: "user" }, content: [{ type: "text", text: `Prompt ${i} ` + "x".repeat(650) }] },
		});
	}
	for (let i = 0; i < 18; i += 1) {
		tracker.recordEvent("s1", {
			type: "tool/call",
			data: { callId: `c-${i}`, name: "read_file", arguments: JSON.stringify({ file_path: `/tmp/f-${i}.js` }) },
		});
	}
	tracker.recordEvent("s1", {
		type: "tool/result",
		data: {
			message: { toolCallId: "c-2", isError: true, content: [{ type: "text", text: "ENOENT" }] },
			error: { name: "FsError", reason: "file not found" },
		},
	});
	tracker.recordEvent("s1", {
		type: "tool/result",
		data: {
			message: { toolCallId: "c-17", isError: true, content: [{ type: "text", text: "EACCES" }] },
			error: { name: "FsError", reason: "permission denied" },
		},
	});
	tracker.recordEvent("s1", {
		type: "assistant/message",
		data: { message: { content: [{ type: "text", text: "EARLY_" + "a".repeat(3800) }] } },
	});
	tracker.recordEvent("s1", {
		type: "assistant/message",
		data: { message: { content: [{ type: "text", text: "FINAL_ANSWER_TAIL" }] } },
	});

	const activity = tracker.finishTurn("s1", { kind: "error", error: { message: "rate limited" } });
	assert.equal(activity.userPrompts.length, 3);
	assert.equal(Array.from(activity.userPrompts[0]).length, 600);
	assert.equal(activity.tools.length, 16);
	assert.equal(activity.omittedTools, 2);
	assert.equal(activity.tools[0].callId, "c-2");
	assert.equal(activity.tools[0].isError, true);
	assert.equal(activity.tools[0].errorText, "file not found");
	assert.equal(activity.tools[15].callId, "c-17");
	assert.equal(activity.tools[15].isError, true);
	assert.equal(activity.tools[15].errorText, "permission denied");
	assert.equal(activity.reasonKind, "error");
	assert.equal(activity.errorMessage, "rate limited");
	assert.equal(activity.hasContent, true);
	assert.equal(NOTIFY_DEFAULTS.summaryTimeoutMs, 8000);
	const totalAssistantChars = activity.assistantTexts.reduce((sum, text) => sum + Array.from(text).length, 0);
	assert.ok(totalAssistantChars <= 4000);
	assert.ok(activity.assistantTexts.join("\n").includes("FINAL_ANSWER_TAIL"), "tail output is preserved");

	assert.equal(tracker.finishTurn("s1", { kind: "completed" }).hasContent, false);

	const { system, input } = buildSummaryPrompt(activity, { lang: "en", sessionName: "api-work" });
	assert.match(system, /English/);
	assert.match(system, /untrusted/);
	assert.ok(Buffer.byteLength(input, "utf8") <= 8192);
	const parsedInput = JSON.parse(input);
	assert.equal(parsedInput.outcome, "error");
	assert.equal(parsedInput.error, "rate limited");

	assert.equal(normalizeSummaryText("```markdown\n**\"「Added tests\nand fixed bug.」\"**\n```"), "Added tests and fixed bug.");
	assert.equal(normalizeSummaryText("   \n\t  "), "");
	assert.equal(Array.from(normalizeSummaryText("x".repeat(300), 50)).length, 50);
});

test("summary-model HTTP route handles auth, missing llm, partial provider failures, validation, persistence, and methods", withHome(async () => {
	const unauth = makeHarness({ rejection: 401 });
	assert.equal((await callRoute(unauth, SUMMARY_ROUTE, { method: "GET" })).status, 401);

	const noLlm = makeHarness({ profileName: "no-llm" });
	const noLlmRes = await callRoute(noLlm, SUMMARY_ROUTE, { method: "GET" });
	assert.equal(noLlmRes.status, 200);
	assert.deepEqual(noLlmRes.json, {
		ok: true,
		selection: { mode: "off" },
		available: false,
		providers: [],
	});

	const warnings = [];
	const prevWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map(String).join(" "));
	try {
		const flakyLlm = makeFakeLlm({
			providers: [
				{ id: "p1", name: "Provider One" },
				{ id: "p2", name: "Provider Two" },
				{ id: "p3", name: "Empty Provider" },
			],
			modelsByProvider: (id) => {
				if (id === "p2") throw new Error("provider two offline");
				if (id === "p3") return [];
				return [
					{ id: "m1", name: "Model One" },
					{ id: "m1", name: "Duplicate Model One" },
					{ id: "m2" },
				];
			},
		});
		const h = makeHarness({ profileName: "alpha", llm: flakyLlm });
		const getRes = await callRoute(h, SUMMARY_ROUTE, { method: "GET" });
		assert.equal(getRes.status, 200);
		assert.equal(getRes.json.available, true);
		assert.deepEqual(getRes.json.providers, [
			{
				id: "p1",
				name: "Provider One",
				models: [
					{ provider: "p1", id: "m1", name: "Model One" },
					{ provider: "p1", id: "m2", name: "m2" },
				],
			},
		]);

		const putRes = await callRoute(h, SUMMARY_ROUTE, { method: "PUT", body: { mode: "off" } });
		assert.equal(putRes.status, 405);
		assert.equal(putRes.headers.allow, "GET, POST");

		const postOk = await callRoute(h, SUMMARY_ROUTE, {
			method: "POST",
			body: { mode: "model", provider: "p1", model: "m1" },
		});
		assert.equal(postOk.status, 200);
		assert.deepEqual(postOk.json, { ok: true, selection: { mode: "model", provider: "p1", model: "m1" } });

		const afterGet = await callRoute(h, SUMMARY_ROUTE, { method: "GET" });
		assert.deepEqual(afterGet.json.selection, { mode: "model", provider: "p1", model: "m1" });

		const previewRes = await callRoute(h, PREVIEW_ROUTE, { method: "GET" });
		assert.equal(previewRes.status, 200);
		assert.deepEqual(previewRes.json.summarySelection, { mode: "model", provider: "p1", model: "m1" });
		assert.equal(previewRes.json.turnEnd.kind, "turn-end");

		const badJson = await callRoute(h, SUMMARY_ROUTE, { method: "POST", rawBody: "{broken" });
		assert.equal(badJson.status, 400);
		assert.equal(badJson.json.ok, false);

		const badPair = await callRoute(h, SUMMARY_ROUTE, {
			method: "POST",
			body: { mode: "model", provider: "p1", model: "" },
		});
		assert.equal(badPair.status, 400);
		assert.deepEqual((await callRoute(h, SUMMARY_ROUTE, { method: "GET" })).json.selection, {
			mode: "model",
			provider: "p1",
			model: "m1",
		});

		const turnOff = await callRoute(h, SUMMARY_ROUTE, { method: "POST", body: { mode: "off" } });
		assert.equal(turnOff.status, 200);
		assert.deepEqual(turnOff.json.selection, { mode: "off" });

		const broken = await listSummaryModels({
			listProviders() { throw new Error("catalog crashed"); },
			listModels() { return []; },
		});
		assert.deepEqual(broken, { available: false, providers: [] });
		assert.ok(warnings.some((line) => line.includes("provider two offline")));
		assert.ok(warnings.some((line) => line.includes("catalog crashed")));
	} finally {
		console.warn = prevWarn;
	}
}));

function seedSubscription(stateDir, device) {
	mkdirSync(stateDir, { recursive: true });
	const store = new PushStore(join(stateDir, "push.json"));
	store.add(device.subscription, { origin: ORIGIN });
}

async function triggerMobileTurn(harness, sessionId, {
	requestId = "req-1",
	prompt = "Add tests for push summary",
	assistantText = "Added push summary unit tests and verified them.",
	toolArgs = { path: "packages/dsh-mobile-maxxing/notify/summary.js" },
	reason = { kind: "completed" },
} = {}) {
	await callRoute(harness, MOBILE_SEND_ROUTE, {
		method: "POST",
		body: { sessionId, requestId, origin: ORIGIN },
	});
	const emit = harness.listeners.get("session/event");
	const session = { id: sessionId, header: { cwd: "/tmp/work" }, title: "Summary Task" };
	emit(session, { type: "turn/start", data: { turn: 1 } });
	emit(session, {
		type: "user/message",
		data: { source: { kind: "user", rpcId: requestId }, content: [{ type: "text", text: prompt }] },
	});
	emit(session, {
		type: "tool/call",
		data: { callId: "call-1", name: "write_file", arguments: JSON.stringify(toolArgs) },
	});
	emit(session, {
		type: "tool/result",
		data: { message: { toolCallId: "call-1", isError: false, content: [{ type: "text", text: "ok" }] } },
	});
	emit(session, {
		type: "assistant/message",
		data: { message: { content: [{ type: "text", text: assistantText }] } },
	});
	emit(session, { type: "turn/end", data: { turn: 1, reason } });
}

test("selected model summarizes unacknowledged turn-end Web Push with lowest reasoning effort and purpose tag", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/phone-summary");
	seedSubscription(stateDir, phone);

	const llm = makeFakeLlm({
		efforts: [{ id: "minimal", name: "Minimal" }, { id: "high", name: "High" }],
		chunks: [
			{ type: "block-start", index: 0, blockType: "reasoning" },
			{ type: "reasoning-delta", index: 0, text: "thinking..." },
			{ type: "block-end", index: 0, block: { type: "reasoning", text: "thinking..." } },
			{ type: "block-start", index: 1, blockType: "text" },
			{ type: "text-delta", index: 1, text: "partial " },
			{ type: "block-end", index: 1, block: { type: "text", text: "\"Implemented summary.js and verified all tests.\"" } },
			{ type: "finish", reason: { kind: "stop" } },
		],
	});
	const harness = makeHarness({
		profileName: "summary-on",
		config: { lang: "en", onlyMobileTurns: true },
		llm,
	});
	harness.addSession("s1", { cwd: "/tmp/work" }, "Summary Task");

	await callRoute(harness, SUMMARY_ROUTE, {
		method: "POST",
		body: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
	});

	await triggerMobileTurn(harness, "s1");
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

	assert.equal(llm.calls.length, 1);
	assert.equal(llm.calls[0].configured.reasoningEffort, "minimal");
	assert.equal(llm.calls[0].configured.maxTokens, 512);
	assert.equal(llm.calls[0].streamOptions.purpose, "dsh-mobile-maxxing:push-summary");
	assert.equal(llm.calls[0].streamOptions.sessionId, "s1");
	assert.equal(harness.delivered.length, 1);
	const pushed = phone.decrypt(harness.delivered[0].options.body);
	assert.equal(pushed.title, "Summary Task");
	assert.equal(pushed.body, "Implemented summary.js and verified all tests.");
	assert.equal(pushed.kind, "turn-end");
}));

test("foreground ACK skips LLM summarization completely; partial ACK invokes LLM once for remaining device", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/fg-phone");
	const tablet = makeDevice("https://web.push.apple.com/bg-tablet");
	seedSubscription(stateDir, phone);

	const llm = makeFakeLlm({
		chunks: [{ type: "text-delta", index: 0, text: "Turn finished cleanly." }, { type: "finish", reason: { kind: "stop" } }],
	});
	const harness = makeHarness({
		profileName: "ack-check",
		config: { lang: "en", onlyMobileTurns: true },
		llm,
	});
	harness.addSession("s1", { cwd: "/tmp/work" }, "Ack Session");
	await callRoute(harness, SUMMARY_ROUTE, {
		method: "POST",
		body: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
	});

	await triggerMobileTurn(harness, "s1", { requestId: "req-ack" });
	const ackAll = await callRoute(harness, ACK_ROUTE, {
		method: "POST",
		body: { endpoint: phone.endpoint, sessionId: "s1", kind: "turn-end", origin: ORIGIN },
	});
	assert.equal(ackAll.json.acknowledged, true);
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
	assert.equal(llm.calls.length, 0);
	assert.equal(harness.delivered.length, 0);

	new PushStore(join(stateDir, "push.json")).add(tablet.subscription, { origin: ORIGIN });
	await triggerMobileTurn(harness, "s1", { requestId: "req-partial" });
	await callRoute(harness, ACK_ROUTE, {
		method: "POST",
		body: { endpoint: phone.endpoint, sessionId: "s1", kind: "turn-end", origin: ORIGIN },
	});
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
	assert.equal(llm.calls.length, 1);
	assert.equal(harness.delivered.length, 1);
	assert.equal(harness.delivered[0].url, tablet.endpoint);
	assert.equal(tablet.decrypt(harness.delivered[0].options.body).body, "Turn finished cleanly.");
}));

test("mode off skips LLM, does not parse tool arguments, and sends stock turn-end copy", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/mode-off");
	seedSubscription(stateDir, phone);
	const llm = makeFakeLlm();
	const harness = makeHarness({
		profileName: "off-check",
		config: { lang: "en", onlyMobileTurns: true },
		llm,
	});
	harness.addSession("s1", { cwd: "/tmp/work" }, "Off Session");

	await callRoute(harness, MOBILE_SEND_ROUTE, {
		method: "POST",
		body: { sessionId: "s1", requestId: "req-off", origin: ORIGIN },
	});
	const emit = harness.listeners.get("session/event");
	const session = { id: "s1", header: { cwd: "/tmp/work" }, title: "Off Session" };
	let toolArgumentsReads = 0;
	const toolCallData = { callId: "call-off", name: "write_file" };
	Object.defineProperty(toolCallData, "arguments", {
		enumerable: true,
		get() {
			toolArgumentsReads += 1;
			return JSON.stringify({ path: "packages/dsh-mobile-maxxing/notify/summary.js" });
		},
	});
	emit(session, { type: "turn/start", data: { turn: 1 } });
	emit(session, {
		type: "user/message",
		data: { source: { kind: "user", rpcId: "req-off" }, content: [{ type: "text", text: "work" }] },
	});
	emit(session, { type: "tool/call", data: toolCallData });
	emit(session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "done" }] } } });
	emit(session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

	assert.equal(toolArgumentsReads, 0, "tool arguments must not be read or parsed when summary mode is off");
	assert.equal(llm.calls.length, 0);
	assert.equal(harness.delivered.length, 1);
	assert.equal(phone.decrypt(harness.delivered[0].options.body).body, copyFor("en")["notify.turn.detailCompleted"]);
}));

test("strict cordis context throwing on undeclared llm property returns available: false and falls back on turn/end", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/cordis-no-llm");
	seedSubscription(stateDir, phone);
	const harness = makeHarness({
		profileName: "cordis-strict",
		config: { lang: "en", onlyMobileTurns: true },
		llm: undefined,
	});
	harness.addSession("s1", { cwd: "/tmp/work" }, "Strict Cordis Session");

	const getRes = await callRoute(harness, SUMMARY_ROUTE, { method: "GET" });
	assert.equal(getRes.status, 200);
	assert.deepEqual(getRes.json, {
		ok: true,
		selection: { mode: "off" },
		available: false,
		providers: [],
	});

	const postRes = await callRoute(harness, SUMMARY_ROUTE, {
		method: "POST",
		body: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
	});
	assert.equal(postRes.status, 200);

	await triggerMobileTurn(harness, "s1", { requestId: "req-cordis" });
	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

	assert.equal(harness.delivered.length, 1);
	assert.equal(phone.decrypt(harness.delivered[0].options.body).body, copyFor("en")["notify.turn.detailCompleted"]);
}));

test("LLM failures, timeouts, tool-call finishes, and empty outputs fall back to stock copy without dropping push", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/fallbacks");
	seedSubscription(stateDir, phone);
	const warnings = [];
	const prevWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map(String).join(" "));

	try {
		const scenarios = [
			{
				label: "prepare error",
				llm: makeFakeLlm({ prepareError: new Error("upstream down") }),
			},
			{
				label: "tool-calls finish",
				llm: makeFakeLlm({
					chunks: [
						{ type: "text-delta", index: 0, text: "Calling tool" },
						{ type: "finish", reason: { kind: "tool-calls" } },
					],
				}),
			},
			{
				label: "tool-call block",
				llm: makeFakeLlm({
					chunks: [
						{ type: "block-start", index: 0, blockType: "tool-call" },
						{ type: "tool-call-delta", index: 0, id: "tc1", name: "bash", argumentsDelta: "{}" },
						{ type: "finish", reason: { kind: "stop" } },
					],
				}),
			},
			{
				label: "empty output",
				llm: makeFakeLlm({
					chunks: [
						{ type: "text-delta", index: 0, text: "   \n  " },
						{ type: "finish", reason: { kind: "stop" } },
					],
				}),
			},
			{
				label: "timeout",
				llm: {
					listProviders: () => [{ id: "deepseek", name: "DeepSeek" }],
					listModels: () => [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
					async prepareCall(config, signal) {
						return {
							config,
							stream() {
								return (async function* () {
									await new Promise((_resolve, reject) => {
										signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
									});
								})();
							},
						};
					},
				},
				timeoutMs: 1000,
				waitMs: 2800,
			},
		];

		for (let i = 0; i < scenarios.length; i += 1) {
			const scenario = scenarios[i];
			const harness = makeHarness({
				profileName: `fb-${i}`,
				config: { lang: "en", onlyMobileTurns: true, summaryTimeoutMs: scenario.timeoutMs ?? 15000 },
				llm: scenario.llm,
			});
			harness.addSession("s1", { cwd: "/tmp/work" }, "Fallback Session");
			await callRoute(harness, SUMMARY_ROUTE, {
				method: "POST",
				body: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
			});
			await triggerMobileTurn(harness, "s1", { requestId: `req-fb-${i}` });
			await new Promise((resolve) => setTimeout(resolve, scenario.waitMs ?? WAIT_MS));

			assert.equal(harness.delivered.length, 1, `expected push delivery on ${scenario.label}`);
			const pushed = phone.decrypt(harness.delivered[0].options.body);
			assert.equal(
				pushed.body,
				copyFor("en")["notify.turn.detailCompleted"],
				`expected stock fallback body on ${scenario.label}`,
			);
		}
		assert.ok(warnings.length >= 3);
	} finally {
		console.warn = prevWarn;
	}
}));

test("desktop turns (under onlyMobileTurns) and subagent turns trigger neither LLM nor push", withHome(async (_home, stateDir) => {
	const phone = makeDevice("https://web.push.apple.com/skip-non-mobile");
	seedSubscription(stateDir, phone);
	const llm = makeFakeLlm();
	const harness = makeHarness({
		profileName: "skip-turns",
		config: { lang: "en", onlyMobileTurns: true },
		llm,
	});
	harness.addSession("root-desktop", { cwd: "/tmp/work" }, "Desktop Turn");
	harness.addSession("sub-1", { cwd: "/tmp/work", origin: "subagent" }, "Subagent Turn");
	await callRoute(harness, SUMMARY_ROUTE, {
		method: "POST",
		body: { mode: "model", provider: "deepseek", model: "deepseek-chat" },
	});

	const emit = harness.listeners.get("session/event");
	emit({ id: "root-desktop" }, { type: "turn/start", data: { turn: 1 } });
	emit({ id: "root-desktop" }, { type: "user/message", data: { source: { kind: "user", rpcId: "desktop-1" }, content: [{ type: "text", text: "hi" }] } });
	emit({ id: "root-desktop" }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "done" }] } } });
	emit({ id: "root-desktop" }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

	await callRoute(harness, MOBILE_SEND_ROUTE, {
		method: "POST",
		body: { sessionId: "sub-1", requestId: "sub-req", origin: ORIGIN },
	});
	emit({ id: "sub-1", header: { origin: "subagent" } }, { type: "turn/start", data: { turn: 1 } });
	emit({ id: "sub-1", header: { origin: "subagent" } }, { type: "user/message", data: { source: { kind: "user", rpcId: "sub-req" }, content: [{ type: "text", text: "work" }] } });
	emit({ id: "sub-1", header: { origin: "subagent" } }, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "subagent done" }] } } });
	emit({ id: "sub-1", header: { origin: "subagent" } }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

	await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
	assert.equal(llm.calls.length, 0);
	assert.equal(harness.delivered.length, 0);

	assert.equal(buildTurnEndPayload("s", { kind: "completed" }, { lang: "en" }).body, copyFor("en")["notify.turn.detailCompleted"]);
	assert.equal(buildTurnEndPayload("s", { kind: "completed" }, { lang: "en", summary: "Custom summary" }).body, "Custom summary");
}));
