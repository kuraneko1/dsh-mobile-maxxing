/**
 * The 0.2.2 findings (#131-#135) on a phone.
 *
 * Every case drives the real source slice, the way the other bundle tests do:
 * the browser half has no exports, so a function is evaluated on its own
 * against the smallest DOM/service double that can answer it. The desktop
 * contract is pinned the same way - a desktop call does nothing - and the CSS
 * cases assert the rules live in the phone sheet only.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const TICK = String.fromCharCode(96);

/** The declaration from "function name(" through its own closing brace. */
function functionSource(name) {
	const at = CLIENT.indexOf("    function " + name + "(");
	assert.ok(at >= 0, name + " exists");
	const end = CLIENT.indexOf("\n    }\n", at);
	assert.ok(end >= 0, name + " is complete");
	return CLIENT.slice(at, end + "\n    }".length);
}

/** One stylesheet template's body, as the browser receives it. */
function cssTemplate(name) {
	const match = CLIENT.match(new RegExp("const " + name + " = " + TICK + "([\\s\\S]*?)" + TICK + ";\\n"));
	assert.ok(match, name + " exists");
	return match[1];
}

/** The real probe lookup, without the host-injected dictionary. */
function probeValues(key, fallback) {
	if (Array.isArray(PROBES[key]) && PROBES[key].length > 0) return PROBES[key];
	if (fallback === undefined) return [];
	return Array.isArray(fallback) ? fallback : [fallback];
}

// --------------------------------------------------------------------------
// #131: the last session is remembered on this device and restored on boot
// --------------------------------------------------------------------------

const LAST_KEY = /const LAST_SESSION_KEY = "([^"]+)";/.exec(CLIENT)[1];

const SESSION_BLOCK_START = "    /** How long a selected session is re-asserted";
const SESSION_BLOCK_END = "    const NOTIFY_MESSAGES";
const BOOT_AT = "const bootSession = sessionFromUrl()";
const BOOT_TAIL = "requestSession(bootSession);";

/** The session-selection block: the key, the helpers and the opener. */
function sessionBlock() {
	const at = CLIENT.indexOf(SESSION_BLOCK_START);
	const end = CLIENT.indexOf(SESSION_BLOCK_END, at);
	assert.ok(at > 0 && end > at, "the session block is intact");
	return CLIENT.slice(at, end);
}

/** The boot effect's restore line, exactly as the bundle runs it. */
function bootSnippet() {
	const at = CLIENT.indexOf(BOOT_AT);
	assert.ok(at > 0, "the boot restore is wired");
	const end = CLIENT.indexOf(BOOT_TAIL, at) + BOOT_TAIL.length;
	return CLIENT.slice(at, end);
}

function sessionHarness({ phone = true, online = true, stored = null, catalog = {}, url = "" } = {}) {
	const memory = new Map();
	if (stored !== null) memory.set(LAST_KEY, stored);
	const timers = [];
	const state = { shown: "", opened: [] };
	const scope = {
		get: (name) => {
			if (name === "uiWorkspace") return { openSession: (id) => state.opened.push(id) };
			if (name === "sessions") return { list: { getSnapshot: () => ({ byId: catalog }) } };
			return undefined;
		},
		effect: () => {},
	};
	const sandbox = {
		URL,
		phone: () => phone,
		navigator: { onLine: online },
		localStorage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key),
		},
		document: {
			querySelector: (selector) => (selector === "[data-conversation-session]" ? { getAttribute: () => state.shown } : null),
		},
		location: { href: url === "" ? "https://app.example/" : "https://app.example/?session=" + url },
		history: { state: {}, replaceState() {} },
		setInterval: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearInterval: () => {},
	};
	vm.createContext(sandbox);
	vm.runInContext([
		// Declared outside the block in the bundle (the composer's slot owns it).
		"let currentSessionId = null;",
		sessionBlock(),
		"globalThis.api = {",
		"	boot: () => { " + bootSnippet() + " },",
		"	attach: (value) => { attachSessionOpener(value); },",
		"	wanted: () => wantedSession,",
		"};",
	].join("\n"), sandbox);
	const api = sandbox.api;
	api.attach(scope);
	api.boot();
	// One pass of the opener's re-assert loop.
	for (const fn of [...timers]) fn();
	return { api, state, memory };
}

function rememberHarness({ phone = true, stored = null } = {}) {
	const memory = new Map();
	if (stored !== null) memory.set(LAST_KEY, stored);
	const sandbox = {
		phone: () => phone,
		localStorage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key),
		},
	};
	vm.createContext(sandbox);
	vm.runInContext([
		"const LAST_SESSION_KEY = \"" + LAST_KEY + "\";",
		functionSource("rememberLastSession"),
		functionSource("lastSessionFromStorage"),
		"globalThis.api = { rememberLastSession, lastSessionFromStorage };",
	].join("\n"), sandbox);
	return { ...sandbox.api, memory };
}

test("#131 the shown session is stored for this device", () => {
	const phone = rememberHarness();
	assert.equal(phone.lastSessionFromStorage(), "", "nothing is restored before one is stored");
	phone.rememberLastSession("session-1");
	assert.equal(phone.memory.get(LAST_KEY), "session-1");
	assert.equal(phone.lastSessionFromStorage(), "session-1");
	phone.rememberLastSession(null);
	assert.equal(phone.memory.get(LAST_KEY), "session-1", "an unmount does not forget the session");
});

test("#131 a desktop neither writes nor restores the key", () => {
	const desktop = rememberHarness({ phone: false, stored: "session-1" });
	desktop.rememberLastSession("session-2");
	assert.equal(desktop.memory.get(LAST_KEY), "session-1", "a desktop never writes the phone key");
	assert.equal(desktop.lastSessionFromStorage(), "", "a desktop never restores a phone session");
});

test("#131 boot restores the stored session when the URL has none", () => {
	const harness = sessionHarness({ stored: "session-1", catalog: { "session-1": {} } });
	assert.equal(harness.api.wanted(), "session-1");
	assert.deepEqual([...new Set(harness.state.opened)], ["session-1"], "only the stored session is asked for");
});

test("#131 the restore also runs offline", () => {
	const harness = sessionHarness({ stored: "session-1", catalog: { "session-1": {} }, online: false });
	assert.deepEqual([...new Set(harness.state.opened)], ["session-1"], "the service worker boot still restores");
});

test("#131 a URL session still wins over the stored one", () => {
	const harness = sessionHarness({ stored: "session-1", url: "session-2", catalog: { "session-1": {}, "session-2": {} } });
	assert.equal(harness.api.wanted(), "session-2");
	assert.deepEqual([...new Set(harness.state.opened)], ["session-2"]);
});

test("#131 a stored id the catalog no longer knows falls back quietly", () => {
	const harness = sessionHarness({ stored: "gone", catalog: {} });
	assert.doesNotThrow(() => harness.api.wanted());
	assert.deepEqual(harness.state.opened, [], "nothing was opened");
	assert.equal(harness.api.wanted(), "", "the stale request is dropped");
});

test("#131 a desktop boot restores nothing", () => {
	const harness = sessionHarness({ phone: false, stored: "session-1", catalog: { "session-1": {} } });
	assert.equal(harness.api.wanted(), "");
	assert.deepEqual(harness.state.opened, []);
});

// --------------------------------------------------------------------------
// #132: a right-panel control with no session is answered, not thrown
// --------------------------------------------------------------------------

function panelTapHarness({ phone = true, shown = "", lang = "ja" } = {}) {
	const state = { toasts: [] };
	const sandbox = {
		phone: () => phone,
		shownSessionId: () => shown,
		probeValues,
		mobileToast: (text) => state.toasts.push(text),
		t: (key) => (COPY[lang] !== undefined && COPY[lang][key] !== undefined ? COPY[lang][key] : COPY.en[key] ?? key),
	};
	vm.createContext(sandbox);
	vm.runInContext([
		functionSource("consumeNoSessionPanelTap"),
		"globalThis.api = consumeNoSessionPanelTap;",
	].join("\n"), sandbox);
	return { guard: sandbox.api, state };
}

function clickTarget(label) {
	return {
		closest: (selector) => {
			if (selector !== "button[aria-label]") return null;
			return label === null ? null : { getAttribute: () => label };
		},
	};
}

function clickEvent() {
	return {
		prevented: false,
		stopped: false,
		preventDefault() {
			this.prevented = true;
		},
		stopImmediatePropagation() {
			this.stopped = true;
		},
	};
}

test("#132 the dock's new-tab tap is answered with the phone's guidance", () => {
	const harness = panelTapHarness();
	const event = clickEvent();
	assert.equal(harness.guard(event, clickTarget(PROBES.newRightTab[2])), true);
	assert.ok(event.prevented && event.stopped, "the upstream handler never runs");
	assert.deepEqual(harness.state.toasts, [COPY.ja["mux.toast.noSession"]]);
});

test("#132 the expand control is answered too", () => {
	const harness = panelTapHarness();
	const event = clickEvent();
	assert.equal(harness.guard(event, clickTarget("右サイドバーを開く")), true);
	assert.ok(event.prevented);
	assert.equal(harness.state.toasts.length, 1);
});

test("#132 with a session on screen the same tap passes through", () => {
	const harness = panelTapHarness({ shown: "session-1" });
	const event = clickEvent();
	assert.equal(harness.guard(event, clickTarget("新しいタブ")), false);
	assert.equal(event.prevented, false);
	assert.deepEqual(harness.state.toasts, []);
});

test("#132 an unrelated control is never swallowed", () => {
	const harness = panelTapHarness();
	const event = clickEvent();
	assert.equal(harness.guard(event, clickTarget("新しいセッション")), false);
	assert.equal(harness.guard(event, clickTarget(null)), false);
	assert.deepEqual(harness.state.toasts, []);
});

test("#132 a desktop tap is left to upstream", () => {
	const harness = panelTapHarness({ phone: false });
	const event = clickEvent();
	assert.equal(harness.guard(event, clickTarget("新しいタブ")), false);
	assert.equal(event.prevented, false);
	assert.deepEqual(harness.state.toasts, []);
});

test("#132 the capture phase asks the guard before anything else", () => {
	const capture = functionSource("onClickCapture");
	const guardAt = capture.indexOf("if (consumeNoSessionPanelTap(event, target)) return;");
	assert.ok(guardAt > 0, "the guard is wired into the capture phase");
	assert.ok(guardAt < capture.indexOf("rememberDrawerScroll"), "the guard runs first");
	assert.ok(!capture.includes("sidebarRight"), "the guard does not reach into the service");
});

// --------------------------------------------------------------------------
// #134: the drawer marker follows a full-screen route, not just the frame
// --------------------------------------------------------------------------

const DRAWER_BLOCK_START = "    /**\n     * A full-screen surface that owns the screen";
const DRAWER_BLOCK_END = "    function decorateFast()";

function drawerHarness({ phone = true, settings = null } = {}) {
	const attributes = new Map();
	const state = { drawerOpen: false, emits: [] };
	const sandbox = {
		phone: () => phone,
		document: {
			documentElement: {
				setAttribute: (name, value) => attributes.set(name, String(value)),
				getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
			},
			querySelector: (selector) => (selector === '[data-shortcut-modal="settings"]' ? settings : null),
		},
		routeLaidOut: (element) => element.visible !== false,
		state,
		emit: (patch) => {
			state.emits.push(patch);
			Object.assign(state, patch);
		},
	};
	vm.createContext(sandbox);
	const at = CLIENT.indexOf(DRAWER_BLOCK_START);
	const end = CLIENT.indexOf(DRAWER_BLOCK_END, at);
	assert.ok(at > 0 && end > at, "the drawer marker block is intact");
	vm.runInContext([
		CLIENT.slice(at, end),
		"globalThis.api = {",
		"	sync: (root) => { syncDrawerMarker(root); },",
		"	clearLatch: () => { drawerRouteClosed = false; },",
		"	latched: () => drawerRouteClosed,",
		"};",
	].join("\n"), sandbox);
	return { ...sandbox.api, attributes, state };
}

function frameNode({ collapsed = false } = {}) {
	return { hasAttribute: (name) => name === "data-sidebar-collapsed" && collapsed };
}

test("#134 a normal pass still reports the open drawer", () => {
	const harness = drawerHarness({ settings: null });
	harness.sync(frameNode());
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "open");
	assert.equal(harness.state.drawerOpen, true);
});

test("#134 Settings records the closed marker", () => {
	const harness = drawerHarness({ settings: { visible: true } });
	harness.sync(frameNode());
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "closed");
	assert.equal(harness.state.drawerOpen, false, "the store follows the marker");
	assert.equal(harness.latched(), true, "the route's closed marker is remembered");
});

test("#134 Escape cannot resurrect the drawer the route closed", () => {
	const settings = { visible: true };
	const harness = drawerHarness({ settings });
	harness.sync(frameNode());
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "closed");
	// Settings closes; the frame still reports its sidebar open.
	settings.visible = false;
	harness.sync(frameNode());
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "closed", "the stale open drawer stays closed");
	assert.equal(harness.latched(), true);
	harness.clearLatch();
	harness.sync(frameNode());
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "open", "an explicit open ends the latch");
});

test("#134 a pass with no frame records the closed marker", () => {
	const harness = drawerHarness({ settings: null });
	harness.sync(null);
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "closed");
});

test("#134 the frame's own collapsed state settles the latch", () => {
	const harness = drawerHarness({ settings: { visible: true } });
	harness.sync(frameNode({ collapsed: true }));
	assert.equal(harness.attributes.get("data-rdsh-drawer"), "closed");
	assert.equal(harness.latched(), false, "a real collapse leaves nothing to hide");
});

test("#134 a desktop pass never writes the marker", () => {
	const harness = drawerHarness({ phone: false, settings: null });
	harness.sync(frameNode());
	assert.equal(harness.attributes.has("data-rdsh-drawer"), false);
});

test("#134 decorate writes the marker outside the frame branch", () => {
	const decorate = functionSource("decorateFast");
	assert.ok(decorate.includes("syncDrawerMarker(root);"), "the pass syncs the marker");
	assert.ok(!decorate.includes('setAttribute("data-rdsh-drawer"'), "the branch-local write is gone");
	assert.ok(decorate.indexOf("syncDrawerMarker(root);") > decorate.indexOf("if (root !== null)"), "it runs after the frame branch");
});

// --------------------------------------------------------------------------
// #133 / #135: the styles are phone-only and shaped as the findings ask
// --------------------------------------------------------------------------

test("#133 the exit sheet is bottom-anchored with a keyboard-only focus ring", () => {
	const phone = cssTemplate("CSS_PHONE");
	const at = phone.indexOf(".rdsh-mux-exit {");
	assert.ok(at > 0, "the exit sheet is in the phone sheet");
	const block = phone.slice(at, phone.indexOf(".rdsh-mux-exit::backdrop"));
	assert.match(block, /inset: auto 0 0 0/, "the sheet is anchored to the bottom edge");
	assert.match(block, /max-height: calc\(100svh/, "its height is bounded");
	assert.match(block, /overflow-y: auto/, "it scrolls instead of growing");
	assert.match(block, /env\(safe-area-inset-bottom/, "the home-indicator strip is padded");
	assert.match(phone, /\.rdsh-mux-exit button:focus \{ outline: none; \}/, "the always-on ring is removed");
	assert.match(phone, /\.rdsh-mux-exit button:focus-visible \{/, "the ring is painted for keyboard users");
	assert.ok(!phone.includes("margin-block"), "no inline vertical margin workaround");
});

test("#135 the header icon buttons get a 44px hit area without moving", () => {
	const phone = cssTemplate("CSS_PHONE");
	assert.match(phone, /\[data-rdsh-header\] button\[class\*="_iconButton"\]::after/, "the header icon buttons are extended");
	assert.match(phone, /\[data-rdsh-header\] \[data-sidebar-right-expand\]::after/, "the right panel's expand control is extended");
	assert.match(phone, /width: 44px; height: 44px;/, "the target is 44x44");
	assert.match(phone, /position: absolute; inset: 0; margin: auto;/, "the overlay takes no layout space");
});

test("#133/#135 a desktop sheet carries neither rule", () => {
	const device = cssTemplate("CSS_DEVICE");
	const shell = cssTemplate("CSS");
	for (const css of [device, shell]) {
		assert.ok(!css.includes("rdsh-mux-exit button:focus-visible"), "the focus rule is phone-only");
		assert.ok(!css.includes("44px; height: 44px"), "the tap target is phone-only");
		assert.ok(!css.includes("inset: auto 0 0 0"), "the bottom sheet is phone-only");
	}
});
