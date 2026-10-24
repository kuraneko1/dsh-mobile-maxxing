/**
 * Host-half unit tests: no DSH process, no browser.
 *
 * The plugin is pure enough to test directly: the manifest, the index
 * decoration and every HTTP route are ordinary functions over (req, res).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { apply, buildManifest, decorateIndex, normalizeConfig } from "../index.js";
import { buildTurnEndPayload } from "../notify/host.js";
import { COPY, PROBES, copyFor } from "../lib/copy.js";

/**
 * A context good enough to mount the plugin.
 *
 * Every injected dependency is answered with something shaped like the real
 * service, so the routes and the index decoration can be driven directly.
 * `injections` records what was asked for, which is how the tests pin the set
 * of services the package needs from DSH.
 */
function mount(config, overrides = {}) {
	const routes = new Map();
	const taps = [];
	const injections = [];
	const webServer = {
		register(route) {
			assert.equal(routes.has(route.path), false, `duplicate route ${route.path}`);
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		},
		tapIndex(fn) {
			taps.push(fn);
			return () => taps.splice(taps.indexOf(fn), 1);
		},
		getOrigin: () => "http://127.0.0.1:0",
	};
	/** Agents: no sessions, which is what a quiet deployment looks like. */
	const agents = {
		get: () => undefined,
		roots: () => [],
	};
	const services = {
		webServer,
		agents,
		connection: { requestRejection: () => undefined },
		sessions: undefined,
		...overrides,
	};
	// A real injected context exposes each dependency as a property as well as
	// through get(); the routes use both forms.
	const scope = {
		...services,
		get(name) {
			return services[name];
		},
		on() {
			return () => {};
		},
		effect(fn) {
			const dispose = typeof fn === "function" ? fn() : undefined;
			return typeof dispose === "function" ? dispose : () => {};
		},
	};
	const listeners = [];
	const ctx = {
		inject(deps, callback) {
			injections.push([...deps]);
			return callback(scope);
		},
		get(name) {
			return services[name];
		},
		// The mobile-ux half subscribes to `llm/stream`; without `on` it threw
		// inside mountPart, which swallowed the error and left that half
		// untested while the suite stayed green.
		on(event, handler) {
			listeners.push({ event, handler });
			return () => {};
		},
		effect(fn) {
			return scope.effect(fn);
		},
	};
	apply(ctx, config);
	return { routes, taps, injections, services, listeners };
}

/** Invoke one registered route with a fake request/response pair. */
async function call(route, method = "GET", url = route.path) {
	const chunks = [];
	let status;
	let headers;
	const res = {
		writeHead(code, value) {
			status = code;
			headers = value;
		},
		end(body) {
			if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(body));
		},
	};
	await route.handler({ method, url }, res);
	return { status, headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString("utf8") };
}

const INDEX = `<!doctype html><html lang="en"><head><base href="./"><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>`;

/** The `globalThis.__RDSH_PWA_*__` values from the injected payload script. */
function injectedPayload(html) {
	const script = /<script>(globalThis\.__RDSH_PWA_[A-Z_]+__=[\s\S]*?)<\/script>/.exec(html);
	assert.ok(script !== null, "the payload script exists");
	const values = {};
	for (const match of script[1].matchAll(/globalThis\.(__RDSH_PWA_[A-Z_]+__)=([\s\S]*?)(?=;globalThis\.__RDSH_PWA_|$)/g)) {
		values[match[1]] = JSON.parse(match[2].replaceAll("\\u003c", "<"));
	}
	return values;
}

test("manifest carries the installability fields Chrome requires", () => {
	const manifest = buildManifest({});
	assert.equal(manifest.display, "standalone");
	assert.equal(manifest.prefer_related_applications, false);
	assert.equal(typeof manifest.start_url, "string");
	assert.equal(manifest.id, "./");
	const sizes = manifest.icons.map((icon) => icon.sizes);
	assert.ok(sizes.includes("192x192"), "an install prompt needs a 192px icon");
	assert.ok(sizes.includes("512x512"), "a splash screen needs a 512px icon");
	assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"), "Android masks the icon");
	assert.ok(manifest.icons.some((icon) => icon.type === "image/svg+xml"), "the vector mark stays available");
	// Relative URLs keep the app correct behind a prefix-stripping proxy.
	assert.ok(manifest.icons.every((icon) => !icon.src.startsWith("/")));
	assert.equal(manifest.scope, "./");
});

test("manifest normalizes hostile or partial config", () => {
	const manifest = buildManifest({
		display: "bogus",
		name: "  ",
		shortName: "<script>",
		themeColor: "url(javascript:alert(1))",
		backgroundColor: "#123456",
		navigationTimeoutMs: 10 ** 9,
	});
	assert.equal(manifest.display, "standalone", "an unknown display falls back");
	assert.equal(manifest.name, "DeepSeek Harness", "blank names fall back");
	assert.equal(manifest.theme_color, "#151517", "non-colors are rejected");
	assert.equal(manifest.background_color, "#123456");
	assert.equal(normalizeConfig({ navigationTimeoutMs: 10 ** 9 }).navigationTimeoutMs, 10000);
	assert.equal(normalizeConfig({ navigationTimeoutMs: -5 }).navigationTimeoutMs, 300);
});

test("index decoration adds iOS metadata and an edge-to-edge viewport", () => {
	const html = decorateIndex(INDEX, {});
	assert.ok(html.includes('name="mobile-web-app-capable"'),
		"the standard capable meta is used");
	assert.ok(!html.includes('name="apple-mobile-web-app-capable"'),
		"the Apple-only capable meta would force the iOS 26 legacy frame");
	assert.ok(html.includes('rel="apple-touch-icon"'));
	assert.ok(html.includes('name="format-detection" content="telephone=no"'));
	assert.ok(html.includes('name="apple-mobile-web-app-status-bar-style" content="black-translucent"'),
		"the split-plugin status bar default is restored");
	assert.ok(html.includes("viewport-fit=cover"));
	assert.ok(html.includes("interactive-widget=resizes-content"));
	assert.ok(html.includes("width=device-width"));
	assert.ok(html.includes("initial-scale=1"), "existing viewport parts survive");
	// A light-only profile can still ask for dark glyphs.
	const light = decorateIndex(INDEX, { appleStatusBarStyle: "default" });
	assert.ok(light.includes('name="apple-mobile-web-app-status-bar-style" content="default"'));
});

test("manifest copy follows the dictionary for the configured language", () => {
	// The package-wide default is Japanese again. Until COPY.ja has the key,
	// copyFor() falls back to English per key; assert the dictionary result so
	// this stays true when the Japanese pack lands.
	const japanese = buildManifest({});
	assert.equal(japanese.lang, "ja", "the default language is ja again");
	assert.equal(japanese.description, copyFor("ja")["manifest.description"]);
	assert.deepEqual(japanese.screenshots.map((shot) => shot.label), [
		copyFor("ja")["manifest.screenshot.chat"],
		copyFor("ja")["manifest.screenshot.desktop"],
	]);

	// An explicit en profile keeps the existing English strings.
	const english = buildManifest({ lang: "en" });
	assert.equal(english.lang, "en", "en remains available");
	assert.equal(english.description, COPY.en["manifest.description"]);
	assert.deepEqual(english.screenshots.map((shot) => shot.label), [
		COPY.en["manifest.screenshot.chat"],
		COPY.en["manifest.screenshot.desktop"],
	]);
	// A filled ja pack wins for its own keys; an empty one falls back to en.
	const jaDescription = COPY.ja["manifest.description"];
	assert.equal(
		japanese.description,
		typeof jaDescription === "string" && jaDescription !== "" ? jaDescription : COPY.en["manifest.description"],
	);
	// An unknown language is not accepted: manifest and copy would disagree.
	assert.equal(buildManifest({ lang: "xx" }).lang, "ja");
});

/** The exact strings the split plugin shipped; the ja pack must reproduce them. */
const LEGACY_JA = {
	"manifest.description": "DeepSeek Harness をアプリのように起動します。",
	"notify.turn.completed": "作業完了",
	"notify.turn.detailCompleted": "作業が完了しました。",
	"sw.documentTitle": "オフライン — DSH",
	"sw.offlineHeading": "オフラインです",
};

test("the completed ja pack reproduces the legacy Japanese host copy", async (t) => {
	const missing = [];
	for (const [key, expected] of Object.entries(LEGACY_JA)) {
		const actual = COPY.ja[key];
		if (typeof actual === "string" && actual !== "") {
			assert.equal(actual, expected, `COPY.ja[${key}] matches the old copy`);
		} else {
			missing.push(key);
		}
	}
	if (missing.length > 0) {
		t.skip(`COPY.ja is not filled yet: ${missing.join(", ")}`);
		return;
	}
	assert.equal(buildManifest({}).description, LEGACY_JA["manifest.description"]);
	const turn = buildTurnEndPayload("s", { kind: "completed" }, { session: "", lang: "ja" });
	assert.equal(turn.title, `DSH: ${LEGACY_JA["notify.turn.completed"]}`);
	assert.equal(turn.body, LEGACY_JA["notify.turn.detailCompleted"]);
	const { routes } = mount({});
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, new RegExp(`"sw\\.documentTitle":${JSON.stringify(LEGACY_JA["sw.documentTitle"])}`));
	assert.match(worker.text, new RegExp(`"sw\\.offlineHeading":${JSON.stringify(LEGACY_JA["sw.offlineHeading"])}`));
});

test("index decoration injects the dictionary, the probes and the normalized language", () => {
	const html = decorateIndex(INDEX, {});
	assert.ok(html.includes("__RDSH_PWA_COPY__="), "the browser half needs the copy table");
	assert.ok(html.includes("__RDSH_PWA_PROBES__="), "label matching needs every known locale");
	assert.equal((html.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1,
		"the host language is exposed once");
	const payload = injectedPayload(html);
	assert.equal(payload.__RDSH_PWA_COPY__.en["tab.mobile"], "Mobile");
	assert.deepEqual(payload.__RDSH_PWA_COPY__.ja, COPY.ja, "the ja pack travels even while it is being filled");
	assert.deepEqual(payload.__RDSH_PWA_PROBES__, PROBES, "the full probe dictionary travels");
	assert.ok(payload.__RDSH_PWA_PROBES__.actions.includes("操作"), "probes stay bilingual");
	assert.equal(payload.__RDSH_PWA_LANG__, "ja", "the default host language reaches the browser half");
	assert.ok(!html.includes("</script><script>globalThis.__RDSH_PWA_COPY__"), "no raw tag break");
});

test("an explicit en profile makes every host surface English", async () => {
	const html = decorateIndex(INDEX, { lang: "en" });
	assert.equal(injectedPayload(html).__RDSH_PWA_LANG__, "en", "the browser half is told en");

	const manifest = buildManifest({ lang: "en" });
	assert.equal(manifest.lang, "en");
	assert.equal(manifest.description, COPY.en["manifest.description"]);

	const { routes } = mount({ lang: "en" });
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"lang":"en"/);
	assert.match(worker.text, /"sw\.offlineHeading":"You're offline"/);

	const preview = JSON.parse((await call(
		routes.get("/api/rdsh-pwa/push/preview"),
		"GET",
		"/api/rdsh-pwa/push/preview?sessionId=",
	)).text);
	assert.equal(preview.copy.lang, "en");
	assert.equal(preview.turnEnd.title, "DSH: Work finished");
	assert.equal(preview.turnEnd.body, "The work finished.");
});

test("index decoration is idempotent", () => {
	const once = decorateIndex(INDEX, {});
	const twice = decorateIndex(once, {});
	assert.equal(once, twice, "a second tap must not duplicate the block");
	assert.equal(once.split("<!--rdsh-pwa-->").length - 1, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1);
	assert.equal(decorateIndex("", {}), "");
});

test("decorateIndex still works when the document has no viewport or head", () => {
	const bare = decorateIndex("<div id=root></div>", {});
	assert.ok(bare.includes("<!--rdsh-pwa-->"));
	assert.ok(bare.includes("</div>"));
	const noViewport = decorateIndex("<head></head><body></body>", {});
	assert.match(noViewport, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">/);
});

test("an old marker without the payload gets copy, probes and lang exactly once", () => {
	// What the split-plugin tap left behind: marker and PWA meta, no dictionary.
	const legacy = INDEX.replace("</head>", [
		"<!--rdsh-pwa-->",
		'<meta name="mobile-web-app-capable" content="yes">',
		'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
		"</head>",
	].join(""));
	const once = decorateIndex(legacy, {});
	assert.equal((once.match(/globalThis\.__RDSH_PWA_COPY__\s*=/g) ?? []).length, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_PROBES__\s*=/g) ?? []).length, 1);
	assert.equal((once.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1);
	assert.equal(injectedPayload(once).__RDSH_PWA_LANG__, "ja");
	assert.equal((once.match(/name="mobile-web-app-capable"/g) ?? []).length, 1,
		"the legacy meta is not added a second time");
	assert.equal((once.match(/<!--rdsh-pwa-->/g) ?? []).length, 1);
	// Re-tapping the finished response is a no-op.
	assert.equal(decorateIndex(once, {}), once);
});

test("a partial payload gets only the missing globals, with or without the marker", () => {
	const copyOnly = INDEX.replace("</head>",
		'<script>globalThis.__RDSH_PWA_COPY__ = {"en":{}};</script></head>');
	const copyAndProbes = INDEX.replace("</head>",
		'<script>globalThis.__RDSH_PWA_COPY__ = {"en":{}};globalThis.__RDSH_PWA_PROBES__ = {actions:["操作"]};</script></head>');
	for (const base of [copyOnly, copyAndProbes]) {
		for (const html of [base, base.replace("<head>", "<head><!--rdsh-pwa-->")]) {
			const fixed = decorateIndex(html, {});
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_COPY__\s*=/g) ?? []).length, 1,
				"an existing copy table is not duplicated");
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_PROBES__\s*=/g) ?? []).length, 1,
				"an existing probe table is not duplicated");
			assert.equal((fixed.match(/globalThis\.__RDSH_PWA_LANG__\s*=/g) ?? []).length, 1,
				"the missing language is added");
			assert.equal(injectedPayload(fixed).__RDSH_PWA_LANG__, "ja");
			assert.equal(decorateIndex(fixed, {}), fixed, "the result is stable");
		}
	}
});

test("normalizeConfig rejects array, null and hostile language values", () => {
	for (const config of [null, [], "ja", 42, { lang: ["en"] }, { lang: "</script><script>alert(1)</script>" }]) {
		const html = decorateIndex(INDEX, config);
		assert.ok(!html.includes("alert(1)"), "no hostile value reaches the document");
		assert.equal(injectedPayload(html).__RDSH_PWA_LANG__, "ja", "the default is used instead");
	}
	const english = decorateIndex(INDEX, { lang: "en" });
	assert.equal(injectedPayload(english).__RDSH_PWA_LANG__, "en");
	const script = /<script>([\s\S]*?)<\/script>/.exec(english);
	assert.ok(script !== null);
	assert.doesNotThrow(() => new Function(script[1]), "the injected payload is valid JavaScript");
});

test("hostile config values cannot break out of the injected markup", () => {
	const html = decorateIndex(INDEX, {
		appleStatusBarStyle: '"><script>alert(1)</script>',
	});
	assert.ok(!html.includes("alert(1)"), "the rejected value never reaches the document");
	assert.ok(html.includes('name="apple-mobile-web-app-status-bar-style" content="black-translucent"'),
		"the default is used instead");
});

test("routes serve the manifest, the worker and the icons", async () => {
	const { routes, taps, listeners } = mount({});
	assert.ok(routes.has("/manifest.webmanifest"));
	assert.ok(routes.has("/sw.js"));
	assert.ok(routes.has("/pwa/icon-192.png"));
	// One tap adds the PWA tags; the CJK half adds a second only when it can
	// resolve the installed DSH frontend, so the count is environment-dependent.
	// Assert the content instead of the count.
	assert.ok(taps.length >= 1, "at least the PWA tap");
	const decorated = taps.reduce((html, tap) => tap(html), INDEX);
	assert.equal(decorated.split("<!--rdsh-pwa-->").length - 1, 1, "one PWA block");
	assert.equal(injectedPayload(decorated).__RDSH_PWA_LANG__, "ja",
		"the mounted tap injects the normalized host language");
	assert.ok(decorated.includes("__RDSH_MOBILE_UX_CONFIG__"), "the mobile-ux half mounted");
	// Live speed subscribes to the model stream: proof the host half ran.
	assert.ok(listeners.some((entry) => entry.event === "llm/stream"), "mobile-ux subscribed to llm/stream");

	// The notification half is part of this package now.
	for (const path of [
		"/api/rdsh-pwa/push/vapid",
		"/api/rdsh-pwa/push/config",
		"/api/rdsh-pwa/push/subscribe",
		"/api/rdsh-pwa/push/unsubscribe",
		"/api/rdsh-pwa/push/mobile-send",
		"/api/rdsh-pwa/push/preview",
		"/api/rdsh-pwa/push/test",
	]) {
		assert.ok(routes.has(path), `missing ${path}`);
	}

	const manifest = await call(routes.get("/manifest.webmanifest"));
	assert.equal(manifest.status, 200);
	assert.match(manifest.headers["content-type"], /application\/manifest\+json/);
	assert.equal(JSON.parse(manifest.text).display, "standalone");
	assert.equal(JSON.parse(manifest.text).lang, "ja", "the default document language is ja");
	assert.equal(manifest.headers["cache-control"], "no-cache");

	const worker = await call(routes.get("/sw.js"));
	assert.equal(worker.status, 200);
	assert.match(worker.headers["content-type"], /text\/javascript/);
	assert.equal(worker.headers["service-worker-allowed"], "/");
	assert.match(worker.headers["cache-control"], /no-store/);
	assert.match(worker.text, /^self\.__RDSH_PWA_BUILD__="[0-9a-f]{12}";/);
	// The served bytes must parse as JavaScript.
	assert.doesNotThrow(() => new Function(worker.text));

	// The build hash is stable within one activation so an idle restart does
	// not push a bogus "update available" prompt.
	const again = await call(routes.get("/sw.js"));
	assert.equal(again.text, worker.text);
	// It must change when the worker source changes; the cache name derives
	// from it, so a stale shell cannot survive a release.
	assert.match(worker.text, /CACHE_NAME = CACHE_PREFIX \+ BUILD|const CACHE_NAME = CACHE_PREFIX \+ BUILD/);

	for (const icon of ["/pwa/icon-192.png", "/pwa/icon-512.png", "/pwa/icon-maskable-512.png", "/pwa/apple-touch-icon.png", "/pwa/badge-96.png"]) {
		const route = routes.get(icon);
		assert.ok(route, `${icon} is served`);
		const response = await call(route);
		assert.equal(response.status, 200, `${icon} exists`);
		assert.equal(response.headers["content-type"], "image/png");
		assert.ok(response.body.length > 500, `${icon} is not empty`);
	}
});

test("the worker injects the configured navigation timeout", async () => {
	const { routes } = mount({ navigationTimeoutMs: 2500, lang: "en" });
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"navigationTimeoutMs":2500/);
	assert.match(worker.text, /self\.__RDSH_PWA_CONFIG__=/);
	// The offline page and push defaults are rendered by the worker, so its
	// copy travels in the same config header. An explicit en profile keeps the
	// previous English copy.
	assert.match(worker.text, /"lang":"en"/);
	assert.match(worker.text, /"sw\.offlineHeading":"You're offline"/);
});

test("the worker follows the ja default but accepts the en dictionary", async () => {
	const { routes } = mount({});
	const worker = await call(routes.get("/sw.js"));
	assert.match(worker.text, /"lang":"ja"/);
	assert.match(worker.text, new RegExp(`"sw\\.offlineHeading":${JSON.stringify(copyFor("ja")["sw.offlineHeading"])}`));
});

test("the worker treats the markdown-cjk entry chunks as cacheable", async () => {
	// The host rewrites the document to load /markdown-cjk/v1/*.js instead of
	// the stock assets. If the worker does not cache that path, an offline
	// launch serves the shell but the entry scripts fail and the plugin never
	// boots. Evaluate sw.js in a stub scope so this is the worker's own
	// classification, not a comment in the file.
	const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
	const sandbox = {
		self: {
			__RDSH_PWA_BUILD__: "test",
			__RDSH_PWA_CONFIG__: {},
			registration: { scope: "http://127.0.0.1/" },
			location: { origin: "http://127.0.0.1" },
			addEventListener() {},
			clients: { claim: async () => {} },
		},
		caches: { open: async () => ({}) },
		fetch: async () => { throw new Error("offline"); },
		URL,
		Response,
		AbortController,
		setTimeout,
		clearTimeout,
	};
	runInNewContext(`${source}\n;globalThis.__isStatic = isStatic;`, sandbox);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/markdown-cjk/v1/index-CN7NIWNw.js")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/markdown-cjk/v1/vendor-DcuzkuQH.js")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/assets/index-BxpfOGf3.css")), true);
	assert.equal(sandbox.__isStatic(new URL("http://127.0.0.1/api/settings/describe")), false,
		"live API answers still go to the network");
});

test("notification copy defaults to the package language and keeps an explicit override", async () => {
	const previewOf = async (config) => {
		const { routes } = mount(config);
		const route = routes.get("/api/rdsh-pwa/push/preview");
		const response = await call(route, "GET", "/api/rdsh-pwa/push/preview?sessionId=");
		return JSON.parse(response.text);
	};
	assert.equal((await previewOf({})).copy.lang, "ja", "top-level lang is the notification default");
	assert.equal((await previewOf({ lang: "en" })).copy.lang, "en", "an en package keeps English notifications");
	assert.equal((await previewOf({ notifications: { lang: "en" } })).copy.lang, "en",
		"notifications.lang still wins over the package default");
});

test("routes reject methods they do not own", async () => {
	const { routes } = mount({});
	for (const path of ["/manifest.webmanifest", "/sw.js", "/pwa/icon-192.png"]) {
		const response = await call(routes.get(path), "POST");
		assert.equal(response.status, 405);
		assert.equal(response.headers.allow, "GET, HEAD");
	}
});

test("HEAD returns headers without a body", async () => {
	const { routes } = mount({});
	const response = await call(routes.get("/manifest.webmanifest"), "HEAD");
	assert.equal(response.status, 200);
	assert.equal(response.body.length, 0);
	assert.ok(Number(response.headers["content-length"]) > 10);
});

test("a missing optional asset is a 404, not a crash", async () => {
	const { routes } = mount({});
	const route = routes.get("/pwa/screenshot-mobile.png");
	if (route === undefined) return;
	const response = await call(route);
	assert.ok(response.status === 200 || response.status === 404);
});

test("the service worker never caches live state", async () => {
	const { routes } = mount({});
	const source = (await call(routes.get("/sw.js"))).text;
	assert.match(source, /BYPASS_SEGMENTS = \["\/api", "\/hmr", "\/terminal", "\/__"\]/,
		"API answers must always come from the server");
	assert.match(source, /request\.method !== "GET"/, "mutations are never intercepted");
});
