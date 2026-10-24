/**
 * Browser-half smoke test: does the module body and its `apply` run at all?
 *
 * The client bundle is loaded verbatim, so a reference to something that no
 * longer exists is not a syntax error — it throws the first time that line
 * runs, which is usually during boot. Bulk edits here twice left such a
 * reference behind while every other test stayed green, and only a real
 * browser noticed. This runs the module against a stub environment so a
 * ReferenceError fails the suite instead.
 *
 * The stub is a recursive Proxy: any property read answers "something", and
 * any call answers another stub. That is enough for the layout code's many
 * incidental DOM reads, while a genuinely undeclared identifier still raises
 * ReferenceError because that is a scope lookup, not a property read.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** A value that answers every operation without doing anything. */
function stub(depth = 0) {
	const value = function stubbed() {
		return depth > 4 ? undefined : stub(depth + 1);
	};
	return new Proxy(value, {
		get(target, key) {
			if (key === Symbol.toPrimitive) return () => 0;
			if (key === Symbol.iterator) return function* empty() {};
			if (key === "then") return undefined;
			if (key === "toString" || key === "valueOf") return () => "";
			if (depth > 4) return undefined;
			return stub(depth + 1);
		},
		apply() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		construct() {
			return depth > 4 ? undefined : stub(depth + 1);
		},
		set() {
			return true;
		},
		has() {
			return true;
		},
	});
}

/** A DOM element stand-in: every method answers, attributes start empty. */
function element() {
	const store = new Map();
	return new Proxy({
		baseURI: "http://localhost/",
		attributes: [],
		children: [],
		childNodes: [],
		classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
		dataset: {},
		style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
		querySelector: () => null,
		querySelectorAll: () => [],
		closest: () => null,
		contains: () => false,
		append() {},
		appendChild() {},
		remove() {},
		removeChild() {},
		insertBefore() {},
		addEventListener() {},
		removeEventListener() {},
		setAttribute(name, value) { store.set(name, String(value)); },
		getAttribute: (name) => (store.has(name) ? store.get(name) : null),
		hasAttribute: (name) => store.has(name),
		removeAttribute(name) { store.delete(name); },
		toggleAttribute(name, force) { if (force === true) store.set(name, ""); else store.delete(name); },
		getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
		focus() {},
		blur() {},
		click() {},
		matches: () => false,
		get innerHTML() { return ""; },
		set innerHTML(_value) {},
		textContent: "",
	}, {
		get(target, key) {
			if (key in target) return target[key];
			return stub();
		},
		set(target, key, value) {
			target[key] = value;
			return true;
		},
	});
}

/**
 * A localStorage that remembers, for tests that boot with a saved choice.
 *
 * The plain stub answers every call, which is enough for code that only checks
 * for a missing key but cannot express "this browser opted in".
 */
function memoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => {
			map.set(key, String(value));
		},
		removeItem: (key) => {
			map.delete(key);
		},
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		},
	};
}

/**
 * Evaluate the bundle in a stub browser and run the plugin's `apply`.
 *
 * `narrow` answers the phone-width media query, `coarse` and `standalone`
 * answer the device queries `phone()` asks, `storage` supplies remembered
 * localStorage entries, `configureDocument` lets a test wire up the few DOM
 * nodes it cares about, `schedule` replaces setTimeout, and `clock` (an object
 * with a `now` field) replaces `Date.now` for code that gives up after a delay.
 */
function bootClient({
	narrow = false,
	coarse = false,
	standalone = false,
	storage = null,
	clock = null,
	configureDocument = () => {},
	schedule = () => 0,
} = {}) {
	let definition;
	const sandbox = {
		// index.js injects the probe table into the page; the stub needs the same
		// vocabulary or the bilingual upstream-label matching falls back to
		// English and the Chinese cases never match.
		__RDSH_PWA_PROBES__: PROBES,
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
		},
		document: (() => {
			const doc = element();
			doc.baseURI = "http://localhost/";
			doc.visibilityState = "visible";
			doc.activeElement = null;
			doc.head = element();
			doc.body = element();
			doc.documentElement = element();
			doc.createElement = () => element();
			doc.styleSheets = [];
			configureDocument(doc);
			return doc;
		})(),
		navigator: stub(),
		location: stub(),
		localStorage: storage === null ? stub() : memoryStorage(storage),
		sessionStorage: stub(),
		matchMedia: (query) => ({
			matches: Boolean(
				(narrow && query.includes("max-width: 767px"))
				|| (coarse && query === "(pointer: coarse)")
				|| (standalone && query === "(any-pointer: coarse)"),
			),
			addEventListener() {},
			removeEventListener() {},
		}),
		addEventListener() {},
		removeEventListener() {},
		setTimeout: schedule,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: () => 0,
		cancelAnimationFrame() {},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		IntersectionObserver: class {
			observe() {}
			disconnect() {}
		},
		getComputedStyle: () => stub(),
		console,
		// Real globals the layout code legitimately uses.
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: () => Promise.resolve(stub()),
		// DOM classes: `instanceof` needs a callable right-hand side.
		Element: class Element {},
		HTMLElement: class HTMLElement {},
		Node: class Node {},
		Event: class Event {},
		CustomEvent: class CustomEvent {},
		PointerEvent: class PointerEvent {},
		KeyboardEvent: class KeyboardEvent {},
		TouchEvent: class TouchEvent {},
		Touch: class Touch {},
		MessageChannel: class MessageChannel {},
		Notification: stub(),
		AudioContext: class AudioContext {},
		screen: stub(),
		innerWidth: 390,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		globalThis: undefined,
	};
	if (clock !== null) {
		sandbox.Date = class FakeDate extends Date {
			static now() {
				return clock.now;
			}
		};
	}
	sandbox.globalThis = sandbox;
	sandbox.window.document = sandbox.document;
	sandbox.window.matchMedia = sandbox.matchMedia;
	sandbox.window.setTimeout = sandbox.setTimeout;
	sandbox.window.clearTimeout = sandbox.clearTimeout;
	sandbox.window.setInterval = sandbox.setInterval;
	sandbox.window.clearInterval = sandbox.clearInterval;
	sandbox.window.requestAnimationFrame = sandbox.requestAnimationFrame;
	sandbox.window.addEventListener = sandbox.addEventListener;
	sandbox.window.removeEventListener = sandbox.removeEventListener;
	sandbox.window.location = sandbox.location;
	sandbox.window.navigator = sandbox.navigator;
	sandbox.window.localStorage = sandbox.localStorage;
	sandbox.window.screen = sandbox.screen;
	sandbox.window.performance = sandbox.performance;
	sandbox.window.innerWidth = 390;
	sandbox.window.innerHeight = 844;
	vm.createContext(sandbox);

	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "the module registered itself");

	const plugin = definition.factory((name) => stub());
	assert.equal(typeof plugin.apply, "function", "the module returns a plugin");

	// `apply` is what boot() runs from. It touches a lot of DOM; the stub
	// absorbs that, and an undeclared identifier still throws.
	const ctx = {
		effect(fn) {
			const dispose = fn();
			return typeof dispose === "function" ? dispose : () => {};
		},
		inject(deps, callback) {
			return callback(ctx);
		},
		slots: {
			inject() {},
			register() {
				return () => {};
			},
		},
		get: () => undefined,
		on: () => () => {},
	};
	plugin.apply(ctx);
	return { definition, sandbox };
}

test("the browser module registers and boots without a ReferenceError", () => {
	let booted;
	assert.doesNotThrow(() => {
		booted = bootClient();
	}, "the module body must evaluate and apply must not throw a ReferenceError");
	assert.equal(booted.definition.id, "rdsh-pwa");
});

/**
 * Boot the client with an open drawer, tap a button carrying `label`, and say
 * whether the drawer's own collapse button was pressed once timers settled.
 */
function drawerClosedAfterTapping(label, { narrow = true } = {}) {
	const timers = [];
	const clickHandlers = [];
	let collapsePresses = 0;
	const collapse = element();
	collapse.click = () => {
		collapsePresses += 1;
	};
	const drawerFrame = element();
	const root = element();
	root.firstElementChild = { firstElementChild: drawerFrame };

	bootClient({
		narrow,
		schedule: (callback) => timers.push(callback),
		configureDocument(doc) {
			doc.getElementById = (id) => (id === "root" ? root : null);
			doc.querySelector = (selector) => (selector === '[aria-label="Collapse sidebar"]' ? collapse : null);
			doc.addEventListener = (type, handler) => {
				if (type === "click") clickHandlers.push(handler);
			};
		},
	});
	assert.equal(clickHandlers.length, 1, "the client listens for clicks once");
	timers.length = 0;

	const button = element();
	button.setAttribute("aria-label", label);
	const target = { closest: (selector) => (selector === "button[aria-label]" ? button : null) };
	clickHandlers[0]({ target, preventDefault() {}, stopImmediatePropagation() {} });
	for (const callback of timers.splice(0)) callback();
	return collapsePresses === 1;
}

test("tapping a New session button on a phone closes the drawer", () => {
	assert.equal(drawerClosedAfterTapping("New session"), true, "sidebar button");
	assert.equal(drawerClosedAfterTapping("New session in my-repo"), true, "workspace button");
	assert.equal(drawerClosedAfterTapping("新建会话"), true, "zh sidebar button");
	assert.equal(drawerClosedAfterTapping("在“my-repo”中新建会话"), true, "zh workspace button");
});

test("other buttons leave the drawer open, and so does a wide screen", () => {
	assert.equal(drawerClosedAfterTapping("Plugins"), false);
	assert.equal(drawerClosedAfterTapping("Session actions"), false);
	assert.equal(drawerClosedAfterTapping("New session", { narrow: false }), false);
});

/**
 * Boot the client with the composer holding `draft` and its caret in it, tap
 * the composer's primary button, and hand back what a test needs to play the
 * app: the editor, the pending timers, and `pass()` to run them once.
 *
 * Nothing here clears the draft. The app does that, so a test decides when.
 */
function tapSend({ draft = "hello", label = "Send message", ...options } = {}) {
	const timers = [];
	const clickHandlers = [];
	const clock = { now: 1000 };
	const editor = element();
	editor.textContent = draft;
	let blurs = 0;
	editor.blur = () => {
		blurs += 1;
	};
	let doc;
	bootClient({
		narrow: true,
		coarse: true,
		clock,
		...options,
		schedule: (callback) => timers.push(callback),
		configureDocument(configured) {
			doc = configured;
			doc.activeElement = editor;
			doc.querySelector = (selector) => (selector === "[data-composer-input]" ? editor : null);
			doc.addEventListener = (type, handler) => {
				if (type === "click") clickHandlers.push(handler);
			};
		},
	});
	assert.equal(clickHandlers.length, 1, "the client listens for clicks once");
	timers.length = 0;

	const button = element();
	button.disabled = false;
	button.setAttribute("aria-label", label);
	const target = { closest: (selector) => (selector.includes('[class*="primary"]') ? button : null) };
	clickHandlers[0]({ target, preventDefault() {}, stopImmediatePropagation() {} });
	return {
		editor,
		doc,
		clock,
		timers,
		blurs: () => blurs,
		pass() {
			for (const callback of timers.splice(0)) callback();
		},
	};
}

test("a phone send puts the keyboard away once the app has taken the draft", () => {
	const send = tapSend();
	assert.equal(send.blurs(), 0, "nothing happens inside the click, before the app's own handler has run");
	send.pass();
	assert.equal(send.blurs(), 0, "the draft is still in the composer, so the send has not happened yet");
	send.editor.textContent = "";
	send.pass();
	assert.equal(send.blurs(), 1, "the draft is gone: the keyboard goes");
	assert.equal(send.timers.length, 0, "and the wait is over");
});

test("a send the app refuses keeps the keyboard and stops waiting", () => {
	const send = tapSend();
	let passes = 0;
	while (send.timers.length > 0 && passes < 100) {
		send.clock.now += 100;
		send.pass();
		passes += 1;
	}
	assert.ok(passes < 100, "the wait gives up instead of polling forever");
	assert.equal(send.blurs(), 0, "the draft never left, so the user can still fix it");
});

test("only the composer's own keyboard is put away", () => {
	const send = tapSend();
	send.doc.activeElement = element();
	send.editor.textContent = "";
	send.pass();
	assert.equal(send.blurs(), 0, "focus had moved to another field, which keeps it");
});

test("the stop button leaves the keyboard alone", () => {
	const send = tapSend({ label: "Stop", draft: "" });
	assert.equal(send.timers.length, 0, "stopping a turn is not a send");
});

test("a desktop window keeps its focus after a send, narrow or not", () => {
	const desktops = {
		"narrow window": { narrow: true, coarse: false },
		"wide window": { narrow: false, coarse: false },
		// The #15 opt-in makes the click handler look at the send button on a
		// desktop, so it is the case most likely to leak the phone behaviour.
		"wide window with the turn-notification opt-in": {
			narrow: false,
			coarse: false,
			storage: { "rdsh-mobile-ux:notify-device-turns": "1" },
		},
	};
	for (const [name, options] of Object.entries(desktops)) {
		const send = tapSend(options);
		send.editor.textContent = "";
		send.pass();
		assert.equal(send.blurs(), 0, `${name}: the composer keeps focus`);
	}
});

/**
 * The device predicate is the #17 fix, so it is exposed on the diagnostics
 * object the boot already publishes (`globalThis.__RDSH_MOBILE_UX__`).
 */
function phoneOf(options) {
	const { sandbox } = bootClient(options);
	const diagnostics = sandbox.__RDSH_MOBILE_UX__;
	assert.ok(diagnostics !== undefined, "the mobile half booted and published its diagnostics");
	assert.equal(typeof diagnostics.phone, "function", "phone() is observable");
	return diagnostics.phone();
}

test("phone() follows the pointer and the display mode, not the width", () => {
	assert.equal(phoneOf({ narrow: false }), false, "a wide mouse window is not a phone");
	assert.equal(phoneOf({ narrow: true }), false, "a narrow desktop window is not a phone");
	assert.equal(phoneOf({ narrow: true, coarse: true }), true, "a coarse pointer is a phone");
	assert.equal(phoneOf({ narrow: false, coarse: true }), true, "a coarse-pointer tablet is a phone at any width");
	// #17: an installed desktop PWA and a fullscreen desktop window both have a
	// keyboard and local editors, so they stay desktops even though their
	// display-mode is standalone/fullscreen.
	assert.equal(phoneOf({ narrow: false, standalone: true }), false, "an installed desktop app is not a phone");
	assert.equal(phoneOf({ narrow: true, standalone: true }), true, "a touch screen in a narrow window is");
});

test("the store reports the device separately from the layout", () => {
	const { sandbox } = bootClient({ narrow: true });
	const state = sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(state.narrow, true, "the layout still measures width");
	assert.equal(state.phone, false, "a narrow desktop window is not a phone");
});

test("the desktop notification opt-in is read from this browser", () => {
	const off = bootClient();
	assert.equal(off.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, false, "phone-only stays the default");
	const on = bootClient({ storage: { "rdsh-mobile-ux:notify-device-turns": "1" } });
	assert.equal(on.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, true, "the saved opt-in is read");
});
