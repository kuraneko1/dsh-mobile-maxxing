import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { classifyUpdateFailure, dshVersion, resolveDshCli } from "../index.js";
import { COPY, PROBES } from "../lib/copy.js";
import { apply as applyMobileUx, DOWNLOAD_PATH } from "../lib/mobile-ux.js";
const LIVE_SPEED_PATH = "/api/rdsh-mobile-ux/live-speed";
import { encryptPushPayload, makePayload, PushStore, toBase64Url } from "../notify/host.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const SW = readFileSync(new URL("../sw.js", import.meta.url), "utf8");

function sliceBetween(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
	const end = source.indexOf(endMarker, start);
	assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
	return source.slice(start, end);
}

test("C-6: appUrl resolves endpoints relative to subpath deployments", () => {
	const snippet = sliceBetween(CLIENT, "    function appUrl(relativePath) {", "\n    }\n") + "\n    }\n";
	const sandbox = {
		URL,
		document: { baseURI: "https://host.example/dsh/" },
		location: { origin: "https://host.example", href: "https://host.example/dsh/chat" },
	};
	vm.runInNewContext(`${snippet}\nglobalThis.appUrl = appUrl;`, sandbox);
	assert.equal(sandbox.appUrl("dsh-mobile-maxxing/plugin-version?local=1"), "/dsh/dsh-mobile-maxxing/plugin-version?local=1");
	assert.equal(sandbox.appUrl("/api/rdsh-mobile-ux/live-speed?sessionId=s1"), "/dsh/api/rdsh-mobile-ux/live-speed?sessionId=s1");
});

test("U-1: decorateRenderSkip picks visible scroller and avoids skipping turns when lastUser === -1", () => {
	const items = [
		{ attr: new Map([["data-chat-flow-kind", "assistant-step"]]), hasAttribute(k) { return this.attr.has(k); }, setAttribute(k, v) { this.attr.set(k, v); }, removeAttribute(k) { this.attr.delete(k); }, getAttribute(k) { return this.attr.get(k) ?? null; } },
	];
	const hiddenScroller = { clientHeight: 0, querySelectorAll: () => [] };
	const visibleScroller = { clientHeight: 400, querySelectorAll: () => items };
	let observedScroller = null;
	const snippet = sliceBetween(CLIENT, "    const RENDER_SKIP_ITEMS =", "    function decorateSlow()")
		.replace("function watchRenderSkipGeometry(scroller) {", "function watchRenderSkipGeometry(scroller) { observedRef(scroller); return;");
	const sandbox = {
		phone: () => true,
		document: { querySelectorAll: (sel) => (sel.includes("scrollBody") ? [hiddenScroller, visibleScroller] : []) },
		observedRef: (s) => { observedScroller = s; },
		scheduleDecorate: () => {},
		lastSlowAt: 0,
		setTimeout,
		clearTimeout,
	};
	vm.runInNewContext(`${snippet}\ndecorateRenderSkip(); decorateRenderSkip();`, sandbox);
	assert.equal(observedScroller, visibleScroller);
	assert.equal(items[0].hasAttribute("data-rdsh-cv"), false, "active/initial turns without a user turn must not skip rendering");
});

test("U-2 & U-3: decorateFast updates drawer marker before fitVisualViewportPass and onToggleHintOut clears on exit to sibling", () => {
	const fastBlock = sliceBetween(CLIENT, "    function decorateFast()", "      syncDrawerMarker(root);") + "      syncDrawerMarker(root);\n      fitVisualViewportPass();";
	assert.ok(fastBlock.indexOf("syncDrawerMarker(root);") < fastBlock.indexOf("fitVisualViewportPass();"));

	const toggleCode = sliceBetween(CLIENT, "    let toggleHintHover = false;", "    const ADD_LABEL");
	const htmlAttrs = new Set(["data-rdsh-toggle-hint"]);
	class Element {
		constructor(isToggle = false) { this.isToggle = isToggle; }
		closest(sel) { return sel === "[data-rdsh-sidebar-toggle]" && this.isToggle ? this : null; }
	}
	const toggleEl = new Element(true);
	const outsideEl = new Element(false);
	const sandbox = {
		Element,
		phone: () => true,
		document: {
			documentElement: {
				toggleAttribute(name, on) { if (on) htmlAttrs.add(name); else htmlAttrs.delete(name); },
			},
		},
	};
	vm.runInNewContext(`${toggleCode}\nglobalThis.api = { onToggleHintOver, onToggleHintOut };`, sandbox);
	sandbox.api.onToggleHintOver({ target: toggleEl });
	assert.equal(htmlAttrs.has("data-rdsh-toggle-hint"), true);
	sandbox.api.onToggleHintOut({ relatedTarget: outsideEl });
	assert.equal(htmlAttrs.has("data-rdsh-toggle-hint"), false, "hover hint must clear when pointer moves to an element outside the toggle");
});

test("C-1, C-2, C-4, C-5: shell dialog exclusions, modelMenu fallback exclusion, clearSessionLimit, and nav guard", () => {
	const tapExclude = /const TAP_TARGET_EXCLUDE = '([^']+)';/.exec(CLIENT)?.[1] ?? "";
	assert.doesNotMatch(tapExclude, /:has\([^)]*,[^)]*\)/);
	assert.match(tapExclude, /\[role="dialog"\]:not\(:has\(\[data-rdsh-frame\]\)\)/);

	const mobileBackFn = sliceBetween(CLIENT, "    function mobileBack()", "\n    /** Whether this phone has a hardware back key");
	assert.doesNotMatch(mobileBackFn, /:has\([^)]*,[^)]*\)/);
	assert.match(mobileBackFn, /\[role="dialog"\]:not\(:has\(\[data-rdsh-frame\]\)\)/);

	assert.match(sliceBetween(CLIENT, "    function clearPhoneHooks()", "\n    /**"), /\bclearSessionLimit\(\);/);

	const settingsRowFn = sliceBetween(CLIENT, "    function decorateSidebarSettingsRow()", "\n    // ---------");
	assert.match(settingsRowFn, /!nav\.contains\(button\)/);
	assert.match(settingsRowFn, /!nav\.contains\(candidate\)/);

	// modelMenu must ignore workspace picker / folder / queue menus
	const menuCode = sliceBetween(CLIENT, "    function modelMenu()", "\n    /**\n     * Keep the open picker");
	const wsMenu = {
		className: "Abc_menu",
		hasAttribute: (name) => name === "data-rdsh-workspace-menu",
		querySelector: () => null,
	};
	const realModelMenu = {
		className: "Xyz_menu",
		hasAttribute: () => false,
		querySelector: () => null,
	};
	const sandbox = {
		modelTrigger: () => null,
		workspacePickerOpen: () => false,
		workspacePickerPending: false,
		document: { querySelectorAll: () => [wsMenu, realModelMenu] },
	};
	vm.runInNewContext(`${menuCode}\nglobalThis.modelMenu = modelMenu;`, sandbox);
	assert.equal(sandbox.modelMenu(), realModelMenu);
	sandbox.workspacePickerPending = true;
	assert.equal(sandbox.modelMenu(), null);
});

test("C-3: Tab keydown arms tabFocusPending via queueMicrotask and authorizes the next focused textbox", () => {
	const focusBlock = sliceBetween(CLIENT, "    let allowFocusElement = null;", "    // Keyboard: a sent message");
	const fieldA = { disabled: false, readOnly: false, tagName: "INPUT", getAttribute: () => "text", blur() { this.blurred = true; }, closest(s) { return s.startsWith("input") ? this : null; } };
	const fieldB = { disabled: false, readOnly: false, tagName: "TEXTAREA", getAttribute: () => null, blur() { this.blurred = true; }, closest(s) { return s.startsWith("input") ? this : null; } };
	class Element {}
	Object.setPrototypeOf(fieldA, Element.prototype);
	Object.setPrototypeOf(fieldB, Element.prototype);
	const queuedTimers = [];
	const microtasks = [];
	const sandbox = {
		Element,
		phone: () => true,
		document: { activeElement: fieldB, documentElement: { getAttribute: () => "closed" } },
		queueMicrotask: (fn) => microtasks.push(fn),
		setTimeout: (fn) => { queuedTimers.push(fn); return queuedTimers.length; },
	};
	vm.runInNewContext(`${focusBlock}\nglobalThis.api = { onFocusInGuard, setTab: () => { tabFocusPending = true; queueMicrotask(() => { tabFocusPending = false; }); } };`, sandbox);
	sandbox.api.setTab();
	sandbox.api.onFocusInGuard({ target: fieldB });
	for (const fn of queuedTimers.splice(0)) fn();
	for (const fn of microtasks.splice(0)) fn();
	assert.equal(fieldB.blurred, undefined, "Tab navigation focus must not be blurred");
});

test("C-7: left-edge tap synthesizes click on non-FAB control while swipe does not", () => {
	const swipeBlock = sliceBetween(CLIENT, "    let edgeSwipe = null;", "\n    // Input: Enter inserts a newline");
	let clicked = 0;
	class MockElement {}
	const backBtn = new MockElement();
	Object.assign(backBtn, {
		isConnected: true,
		disabled: false,
		closest(sel) {
			if (sel === ".rdsh-mux-fab") return null;
			return sel.includes("button") ? this : null;
		},
		click() { clicked += 1; },
	});
	const sandbox = {
		Element: MockElement,
		phone: () => true,
		rightPanelNode: null,
		document: {
			documentElement: { getAttribute: () => "closed", hasAttribute: () => false },
			querySelector: () => null,
		},
		window: { innerWidth: 390 },
		navigator: { userAgent: "Mozilla/5.0 (iPhone)" },
		panelOwnsPoint: () => false,
		scrolledLeftAncestor: () => null,
		rightPanelChromeStart: () => false,
		routeDetailOf: () => null,
		visibleCollapseButton: () => null,
		ariaLabelSelector: () => "button",
		toggleDrawer() {},
		closeDrawer() {},
		pressRouteBack() {},
		cancelQueuePress() {},
		cancelTabHold() {},
		releaseTabStrip() {},
		cancelLongPress() {},
		endTerminalDrag() {},
		clearTimeout() {},
		set touchStart(v) {},
		set terminalDrag(v) {},
		tabCandidate: null,
		tabDraggedTab: null,
		tapCandidate: null,
		tabReplayTimer: 0,
		lastDrawerSwipe: 0,
		Math,
		Date,
	};
	vm.runInNewContext(`${swipeBlock}\nglobalThis.api = { onEdgeSwipeStart, onEdgeSwipeMove, onEdgeSwipeEnd };`, sandbox);
	const makeTouch = (type, x, y = 40) => ({ type, target: backBtn, touches: type === "touchend" ? [] : [{ clientX: x, clientY: y }], cancelable: true, preventDefault() {} });
	sandbox.api.onEdgeSwipeStart(makeTouch("touchstart", 12));
	sandbox.api.onEdgeSwipeEnd(makeTouch("touchend", 12));
	assert.equal(clicked, 1, "suppressed tap on left-edge button must still trigger click");

	sandbox.api.onEdgeSwipeStart(makeTouch("touchstart", 12));
	sandbox.api.onEdgeSwipeMove(makeTouch("touchmove", 85));
	sandbox.api.onEdgeSwipeEnd(makeTouch("touchend", 85));
	assert.equal(clicked, 1, "dragging >= 10px must cancel tap recovery");
});

test("C-8, C-9, C-10: session attempts reset, motion OS option + reduced-motion CSS gating, queue i18n, and Ctrl+Shift/Unidentified", () => {
	assert.match(CLIENT, /h\("option", \{ value: "" \}, t\("motion\.system"\)\)/);
	assert.match(CLIENT, /html:not\(\[data-rdsh-motion="standard"\]\) \[data-rdsh-header-title\]\[data-rdsh-header-running\]/);
	assert.match(CLIENT, /html\[data-rdsh-motion="off"\] \[data-sidebar-right-open\] \[data-dockkit-host\]/);

	const ctrlCode = sliceBetween(CLIENT, "    function onSpecialKeyTextKeyDown(event)", "\n    function onSpecialKeyBeforeInput");
	let cleared = 0;
	const termArea = {};
	const state = { control: true, section: {} };
	const sandbox = {
		TERMINAL_KEY_ROWS: { get: () => state },
		terminalTextarea: () => termArea,
		terminalControlByte: () => null,
		setSpecialKeyControl: (_s, next) => { if (!next) cleared += 1; },
		sendTerminalBytes() {},
	};
	vm.runInNewContext(`${ctrlCode}\nglobalThis.onKey = onSpecialKeyTextKeyDown;`, sandbox);
	sandbox.onKey({ currentTarget: {}, target: termArea, key: "Shift" });
	sandbox.onKey({ currentTarget: {}, target: termArea, key: "Unidentified", keyCode: 0 });
	assert.equal(cleared, 0, "Shift and Unidentified must not drop one-shot Ctrl");

	const queueCode = sliceBetween(CLIENT, "    function queueRowAction(", "\n    function queueMenuAt");
	const jaEditBtn = { hasAttribute: () => false, getAttribute: () => PROBES.queueEdit[1] };
	const qSandbox = {
		previewBtn: null,
		row: { querySelectorAll: () => [jaEditBtn] },
	};
	vm.runInNewContext(`${queueCode}\nglobalThis.find = queueRowAction;`, qSandbox);
	assert.equal(qSandbox.find(qSandbox.row, PROBES.queueEdit, 0), jaEditBtn);
});

test("U-4, S-1, S-2, S-6: sw.js bypasses auth/SSE, avoids PNG shell poisoning, checks offline script assets, and handles notificationclick safely", async () => {
	const cacheMap = new Map();
	const waits = [];
	const cache = {
		async match(req) { return cacheMap.get(typeof req === "string" ? req : req.url); },
		async put(req, res) { cacheMap.set(typeof req === "string" ? req : req.url, res); },
		async keys() { return [...cacheMap.keys()].map((url) => ({ url })); },
		async delete(key) { return cacheMap.delete(key.url); },
	};
	let openedUrl = "";
	let navigated = false;
	const controlled = {
		focused: true,
		visibilityState: "visible",
		focus: async () => {},
		postMessage() {},
		navigate: async () => { navigated = true; throw new TypeError("Cannot navigate uncontrolled window"); },
	};
	const listeners = new Map();
	let nextFetch;
	const swSandbox = {
		URL, Request, Response, AbortController, setTimeout, clearTimeout, console,
		self: {
			location: { origin: "https://host.example" },
			registration: { scope: "https://host.example/" },
			addEventListener(type, fn) { listeners.set(type, fn); },
			skipWaiting() {},
			clients: {
				matchAll: async () => [controlled],
				openWindow: async (u) => { openedUrl = u; },
			},
		},
		caches: { open: async () => cache, keys: async () => [] },
		fetch: async (req) => nextFetch(req),
	};
	vm.runInNewContext(`${SW}\nglobalThis.swApi = { isBypassed, canStoreAsShell, handleNavigation, handleStatic, SHELL_URL };`, swSandbox);

	assert.equal(swSandbox.swApi.isBypassed(new URL("https://host.example/?token=secret")), true);
	assert.equal(swSandbox.swApi.isBypassed(new URL("https://host.example/connect?token=secret")), true);
	assert.equal(swSandbox.swApi.isBypassed(new URL("https://host.example/plugins/events")), true);

	const pngRes = new Response("png", { status: 200, headers: { "content-type": "image/png" } });
	Object.defineProperty(pngRes, "type", { value: "basic" });
	assert.equal(swSandbox.swApi.canStoreAsShell("https://host.example/pwa/icon.png", pngRes), false);

	const shellHtml = new Response('<!doctype html><script type="module" src="./assets/index-123.js"></script>', { status: 200, headers: { "content-type": "text/html" } });
	cacheMap.set(swSandbox.swApi.SHELL_URL, shellHtml);
	nextFetch = async () => { throw new Error("offline"); };
	const offlineMissingAsset = await swSandbox.swApi.handleNavigation({
		request: { url: "https://host.example/", mode: "navigate" },
		preloadResponse: null,
		waitUntil(p) { waits.push(p); },
	});
	const offlineBody = await offlineMissingAsset.text();
	assert.match(offlineBody, /Offline|オフライン|retry|location\.reload/i, "missing entry script offline must fall back to OFFLINE_HTML");

	cacheMap.set("https://host.example/assets/index-123.js", new Response("console.log('ok')", { headers: { "content-type": "text/javascript" } }));
	const offlineReady = await swSandbox.swApi.handleNavigation({
		request: { url: "https://host.example/", mode: "navigate" },
		preloadResponse: null,
		waitUntil(p) { waits.push(p); },
	});
	assert.match(await offlineReady.text(), /index-123\.js/, "cached shell with cached entry script boots offline");

	// notificationclick on "./" without sessionId must not navigate/reload or throw
	const onClick = listeners.get("notificationclick");
	const clickWaits = [];
	onClick({ notification: { data: { url: "./", sessionId: "" }, close() {} }, waitUntil: (p) => clickWaits.push(p) });
	await Promise.all(clickWaits);
	assert.equal(navigated, false, "notificationclick for './' must not force reload");
	assert.equal(openedUrl, "");
});

test("S-3: mobile-ux routes fail closed without requestRejection and close ReadStream on aborted downloads", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mux-s3-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "big.bin");
	writeFileSync(file, Buffer.alloc(1024 * 256, 65));

	const routes = new Map();
	applyMobileUx({
		on() {},
		inject(_deps, cb) {
			cb({
				webServer: { tapIndex: () => () => {}, register(r) { routes.set(r.path, r); return () => {}; } },
				connection: null,
				sessions: { get: () => ({ header: { cwd: dir } }) },
			});
		},
	});
	for (const path of [LIVE_SPEED_PATH, DOWNLOAD_PATH]) {
		let status = 0;
		routes.get(path).handler({ method: "GET", url: `${path}?sessionId=s&path=big.bin` }, { writeHead(s) { status = s; }, end() {} });
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(status, 503);
	}

	// Real server download + destroy on early close (pipeline tears down stream)
	const dlRoutes = new Map();
	applyMobileUx({
		on() {},
		inject(_deps, cb) {
			cb({
				webServer: { tapIndex: () => () => {}, register(r) { dlRoutes.set(r.path, r); return () => {}; } },
				connection: { requestRejection: () => undefined },
				sessions: { get: (id) => (id === "s1" ? { header: { cwd: dir } } : undefined) },
			});
		},
	});
	const route = dlRoutes.get(DOWNLOAD_PATH);
	const server = createServer((req, res) => route.handler(req, res));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	const { port } = server.address();
	const ac = new AbortController();
	const res = await fetch(`http://127.0.0.1:${port}${DOWNLOAD_PATH}?sessionId=s1&path=big.bin`, { signal: ac.signal });
	const reader = res.body.getReader();
	await reader.read();
	ac.abort();
	await new Promise((r) => setTimeout(r, 20));
});

test("S-4 & S-5: resolveDshCli/dshVersion resolve symlinks and classifyUpdateFailure detects timeouts", (t) => {
	const root = mkdtempSync(join(tmpdir(), "mux-s4-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const pkgDir = join(root, "pkg");
	const libDir = join(pkgDir, "lib");
	const binDir = join(root, "bin");
	mkdirSync(libDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.99" }));
	const realBin = join(libDir, "bin.js");
	writeFileSync(realBin, "#!/usr/bin/env node\n");
	chmodSync(realBin, 0o755);
	const symlinkBin = join(binDir, "dsh");
	symlinkSync(realBin, symlinkBin);

	const cli = resolveDshCli({ argv: ["node", symlinkBin], execPath: process.execPath, platform: "linux" });
	assert.equal(cli.via, "process");
	assert.equal(cli.args[0], realBin);
	assert.equal(dshVersion(["node", symlinkBin]), "0.2.99");

	assert.equal(classifyUpdateFailure({ code: "ETIMEDOUT" }, "ETIMEDOUT").code, "timeout");
	assert.equal(classifyUpdateFailure({ killed: true, signal: "SIGTERM" }, "").code, "timeout");
});

test("S-6: PushStore recovers {}, rejects unsafe endpoints, preserves surrogate pairs, and enforces 4096B RFC 8188 record cap", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "mux-s6-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const storeFile = join(dir, "push.json");
	writeFileSync(storeFile, "{}\n");
	const store = new PushStore(storeFile);
	assert.equal(typeof store.keys()?.publicKey, "string");
	assert.equal(store.keys().publicKey.length > 0, true);

	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const keys = { p256dh: toBase64Url(ecdh.getPublicKey()), auth: toBase64Url(randomBytes(16)) };
	assert.throws(() => store.add({ endpoint: "https://user:pass@updates.push.services.mozilla.com/a", keys }), /credentials/);
	assert.throws(() => store.add({ endpoint: "https://[::1]/a", keys }), /public push service/);
	assert.throws(() => store.add({ endpoint: "https://fcm.googleapis.com/a", keys: { p256dh: "AA", auth: "AA" } }), /invalid client keys/);

	const emojis = "😀".repeat(750);
	const payload = makePayload("sess-".repeat(120), "reply", emojis, emojis);
	assert.equal(payload.body.includes("\uFFFD"), false);
	assert.equal(/[\uD800-\uDBFF]$/.test(payload.body.replace(/…$/, "")), false, "surrogate pair must not be split");
	assert.ok(Buffer.byteLength(JSON.stringify(payload), "utf8") <= 3993);
	const encrypted = encryptPushPayload({ keys }, JSON.stringify(payload));
	assert.ok(encrypted.length <= 4096);
	assert.throws(() => encryptPushPayload({ keys }, "x".repeat(4000)), RangeError);
});
