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
import { COPY, PROBES } from "../lib/copy.js";

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
 * nodes it cares about, and `schedule` replaces setTimeout.
 */
function bootClient({
	narrow = false,
	coarse = false,
	standalone = false,
	storage = null,
	configureDocument = () => {},
	schedule = () => 0,
	frame = () => 0,
	frames = null,
	failFirstSlot = false,
	windowAdd = null,
	windowRemove = null,
	lang = undefined,
	copy = null,
	fetchImpl = null,
} = {}) {
	let definition;
	const disposers = [];
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
		addEventListener: windowAdd ?? (() => {}),
		removeEventListener: windowRemove ?? (() => {}),
		setTimeout: schedule,
		clearTimeout() {},
		setInterval: () => 0,
		clearInterval() {},
		requestAnimationFrame: frames !== null ? (callback) => { frames.push(callback); return 0; } : frame,
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
		fetch: fetchImpl ?? (() => Promise.resolve(stub())),
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
	if (lang !== undefined) sandbox.__RDSH_PWA_LANG__ = lang;
	if (copy !== null) sandbox.__RDSH_PWA_COPY__ = copy;
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
			if (typeof dispose === "function") disposers.push(dispose);
			return typeof dispose === "function" ? dispose : () => {};
		},
		inject(deps, callback) {
			return callback(ctx);
		},
		slots: {
			inject(deps, callback) {
				if (typeof callback === "function") return callback();
				return undefined;
			},
			register() {
				if (failFirstSlot) {
					failFirstSlot = false;
					throw new Error("first slot registration failed");
				}
				return () => {};
			},
		},
		get: () => undefined,
		on: () => () => {},
	};
	plugin.apply(ctx);
	return {
		definition,
		sandbox,
		ctx,
		disposers,
		disposeAll() {
			const errors = [];
			for (const dispose of disposers.splice(0).reverse()) {
				try {
					dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			return errors;
		},
	};
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
	assert.equal(drawerClosedAfterTapping("Session actions"), false);
	assert.equal(drawerClosedAfterTapping("New session", { narrow: false }), false);
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

test("phone() is the legacy width rule, exactly", () => {
	// The reference contract: <=767px is the phone UI. Pointer kind does not
	// widen it, so a wide touch tablet and a wide mouse desktop both stay
	// stock; a narrow window is phone UI with either pointer.
	assert.equal(phoneOf({ narrow: false }), false, "a wide mouse window is not a phone");
	assert.equal(phoneOf({ narrow: false, coarse: true }), false, "a wide coarse-pointer tablet is not a phone");
	assert.equal(phoneOf({ narrow: false, standalone: true }), false, "an installed wide desktop app is not a phone");
	assert.equal(phoneOf({ narrow: true }), true, "a narrow mouse window is phone UI");
	assert.equal(phoneOf({ narrow: true, coarse: true }), true, "a narrow touch window is phone UI");
	assert.equal(phoneOf({ narrow: true, standalone: true }), true, "a narrow installed app is phone UI");
});

test("the store reports the device separately from the layout", () => {
	const { sandbox } = bootClient({ narrow: true });
	const state = sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(state.narrow, true, "the layout still measures width");
	assert.equal(state.phone, true, "a narrow window is phone UI even with a mouse");
	const wide = bootClient({ narrow: false }).sandbox.__RDSH_MOBILE_UX__.state;
	assert.equal(wide.phone, false, "a wide mouse window is not phone UI");
});

test("the desktop notification opt-in is read from this browser", () => {
	const off = bootClient();
	assert.equal(off.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, false, "phone-only stays the default");
	const on = bootClient({ storage: { "rdsh-mobile-ux:notify-device-turns": "1" } });
	assert.equal(on.sandbox.__RDSH_MOBILE_UX__.state.notifyDeviceTurns, true, "the saved opt-in is read");
});

test("the legacy hide list applies at phone width even with a fine pointer", () => {
	const frames = [];
	const button = element();
	button.setAttribute("aria-label", "More actions");
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? [button] : []);
			doc.querySelector = () => null;
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(button.hasAttribute("data-rdsh-hidden"), true, "a narrow fine-pointer window keeps the stock icon");
	booted.disposeAll();

	const wideButton = element();
	wideButton.setAttribute("aria-label", "More actions");
	const wide = bootClient({
		narrow: false,
		frames: [],
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === "button[aria-label], [role='menuitem']" ? [wideButton] : []);
			doc.querySelector = () => null;
		},
	});
	assert.equal(wideButton.hasAttribute("data-rdsh-hidden"), false, "a wide window hides a stock control");
	wide.disposeAll();
});

test("the effect disposer tears down without a ReferenceError or a stale listener", () => {
	const adds = [];
	const removes = [];
	const booted = bootClient({
		configureDocument(doc) {
			const add = doc.addEventListener;
			const remove = doc.removeEventListener;
			doc.addEventListener = (type, handler, options) => {
				adds.push(handler);
				add.call(doc, type, handler, options);
			};
			doc.removeEventListener = (type, handler, options) => {
				removes.push(handler);
				remove.call(doc, type, handler, options);
			};
		},
	});
	assert.ok(booted.sandbox.__RDSH_MOBILE_UX__ !== undefined, "the mobile half booted");
	assert.ok(booted.disposers.length > 0, "the boot registered effects");
	const errors = booted.disposeAll();
	assert.deepEqual(errors.map((error) => String(error)), [], "teardown threw (displayMedia was the old ReferenceError)");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__, undefined, "the diagnostics object was not removed");
	const stale = adds.filter((handler) => !removes.includes(handler));
	assert.deepEqual(stale, [], "a document listener outlived its effect");
});

test("a height-only resize keeps an in-flight swipe; a width change drops it", () => {
	const windowHandlers = [];
	const documentHandlers = [];
	const open = element();
	let presses = 0;
	open.click = () => {
		presses += 1;
	};
	const booted = bootClient({
		narrow: true,
		windowAdd: (type, handler) => windowHandlers.push([type, handler]),
		windowRemove() {},
		configureDocument(doc) {
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = (selector) => (selector.includes("Open sidebar") ? open : null);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	const end = handler("touchend", "onEdgeSwipeEnd");
	assert.equal(typeof start, "function", "the edge swipe start is registered");
	assert.equal(typeof move, "function", "the edge swipe move is registered");
	assert.equal(typeof end, "function", "the edge swipe end is registered");
	const onResize = [...windowHandlers].filter(([type]) => type === "resize").at(-1)?.[1];
	assert.equal(typeof onResize, "function", "the boot resize handler is registered");

	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 200 }] });
	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	// A keyboard / URL-bar resize changes height only: the gesture must live.
	onResize();
	move(touch(90));
	assert.equal(presses, 1, "a height-only resize cancelled the swipe");

	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	// A real width change invalidates the stored start point.
	booted.sandbox.innerWidth = 320;
	booted.sandbox.window.innerWidth = 320;
	onResize();
	move(touch(90));
	assert.equal(presses, 1, "a width change did not reset the gesture");

	start({ touches: [{ clientX: 10, clientY: 200 }], target: {} });
	move(touch(40));
	end();
	move(touch(90));
	assert.equal(presses, 1, "touchend did not clear the gesture");
	booted.disposeAll();
});

test("the injected language wins over the shell document language", () => {
	const shellLang = (value) => (doc) => {
		doc.documentElement.lang = value;
	};
	// The host default (ja) must restore the reference UI even when the shell
	// document stays lang="en"; an explicit en must equally win over a ja
	// shell. The document language is only the fallback.
	assert.equal(bootClient({ lang: "ja", configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ lang: "en", configureDocument: shellLang("ja") }).sandbox.__RDSH_MOBILE_UX__.lang, "en");
	assert.equal(bootClient({ lang: "ja-JP", configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ configureDocument: shellLang("ja") }).sandbox.__RDSH_MOBILE_UX__.lang, "ja");
	assert.equal(bootClient({ configureDocument: shellLang("en") }).sandbox.__RDSH_MOBILE_UX__.lang, "en");
	assert.equal(bootClient().sandbox.__RDSH_MOBILE_UX__.lang, "en", "no signals falls back to English");
});

test("one failing part does not stop the other client halves", () => {
	const errors = [];
	const original = console.error;
	console.error = (...args) => errors.push(args);
	try {
		const booted = bootClient({ failFirstSlot: true });
		assert.ok(booted.sandbox.__RDSH_MOBILE_UX__ !== undefined, "mobile UX died with the PWA part");
		assert.ok(
			errors.some(([message]) => String(message).includes("pwa client half failed to apply")),
			"the failure was not logged with the part name",
		);
		booted.disposeAll();
	} finally {
		console.error = original;
	}
});

test("the detail popover dismisses inside/outside/Escape and dispose leaves nothing", () => {
	const timers = [];
	const documentHandlers = [];
	const removedHandlers = [];
	const pop = element();
	const inside = { id: "inside" };
	const outside = { id: "outside" };
	let currentPop = null;
	let popConnected = false;
	pop.isConnected = false;
	pop.contains = (target) => target === inside || target === pop;
	pop.remove = () => {
		popConnected = false;
		pop.isConnected = false;
		currentPop = null;
	};
	const todo = element();
	todo.setAttribute("data-rdsh-todo-text", "A long todo item");
	todo.setAttribute("data-rdsh-todo-status", "in_progress");
	const booted = bootClient({
		narrow: true,
		schedule: (callback) => timers.push(callback),
		configureDocument(doc) {
			let armed = false;
			let created = 0;
			doc.createElement = () => {
				if (armed && created === 0) {
					created += 1;
					currentPop = pop;
					popConnected = true;
					pop.isConnected = true;
					return pop;
				}
				return element();
			};
			doc.querySelector = (selector) => (selector === ".rdsh-mux-detail" ? currentPop : null);
			doc.addEventListener = (type, handler) => {
				if (type === "click" && handler.name === "onClickCapture") armed = true;
				documentHandlers.push([type, handler]);
			};
			doc.removeEventListener = (type, handler) => removedHandlers.push([type, handler]);
			doc.__resetPopover = () => {
				created = 0;
			};
		},
	});
	timers.length = 0;
	const click = [...documentHandlers].find(([type, handler]) => type === "click" && handler.name === "onClickCapture")?.[1];
	assert.equal(typeof click, "function", "the click handler is registered");
	const target = {
		closest: (selector) => (selector === "[data-rdsh-todo-item]" ? todo : null),
	};
	const open = () => {
		booted.sandbox.document.__resetPopover();
		click({ target, preventDefault() {}, stopImmediatePropagation() {} });
		assert.equal(currentPop, pop, "the popover was not created");
		assert.equal(popConnected, true);
		for (const callback of timers.splice(0)) callback();
		const pointer = [...documentHandlers].filter(([type, handler]) => type === "pointerdown" && handler.name === "dismiss").at(-1)?.[1];
		const key = [...documentHandlers].filter(([type, handler]) => type === "keydown" && handler.name === "dismissKey").at(-1)?.[1];
		assert.equal(typeof pointer, "function", "the pointer dismiss listener was not attached");
		assert.equal(typeof key, "function", "the Escape listener was not attached");
		return { pointer, key };
	};

	let { pointer, key } = open();
	// A tap inside the popover must not retire the outside dismissal.
	pointer({ target: inside });
	assert.equal(popConnected, true, "an inside tap closed the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), false, "the pointer listener was removed on an inside tap");
	pointer({ target: outside });
	assert.equal(popConnected, false, "an outside tap did not close the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "the outside dismissal leaked its listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "the Escape listener leaked after an outside tap");

	({ pointer, key } = open());
	key({ key: "Escape" });
	assert.equal(popConnected, false, "Escape did not close the popover");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "Escape leaked the pointer listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "Escape leaked its own listener");

	({ pointer, key } = open());
	booted.disposeAll();
	assert.equal(popConnected, false, "dispose left the popover in the DOM");
	assert.equal(removedHandlers.some(([, handler]) => handler === pointer), true, "dispose leaked the pointer listener");
	assert.equal(removedHandlers.some(([, handler]) => handler === key), true, "dispose leaked the Escape listener");
});

test("a wide desktop still gets the session colour frame hook", () => {
	const frames = [];
	const row = element();
	row.setAttribute("data-row-key", "session:s1");
	let frameColor = null;
	row.style = { setProperty(name, value) { if (name === "--rdsh-session-frame") frameColor = value; }, removeProperty() {} };
	const booted = bootClient({
		narrow: false,
		frames,
		storage: { "rdsh-mobile-ux:session-frames": JSON.stringify({ s1: "#ff6b6b" }) },
		configureDocument(doc) {
			doc.querySelectorAll = (selector) => (selector === '[data-row-key^="session:"]' ? [row] : []);
			doc.querySelector = () => null;
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(row.hasAttribute("data-rdsh-session"), true, "the desktop row was not decorated");
	assert.equal(row.hasAttribute("data-rdsh-session-frame"), true, "the desktop colour frame hook was not generated");
	assert.equal(frameColor, "#ff6b6b", "the frame colour was not written");
	booted.disposeAll();
});

test("a rightward swipe closes an open right panel from the left edge too", () => {
	const documentHandlers = [];
	const collapse = element();
	const panel = element();
	let closes = 0;
	collapse.getBoundingClientRect = () => ({ width: 24, height: 24, top: 0, left: 0, right: 24, bottom: 24 });
	collapse.closest = (selector) => (selector === "[data-sidebar-right-panel]" ? panel : null);
	collapse.click = () => {
		closes += 1;
	};
	const booted = bootClient({
		narrow: true,
		configureDocument(doc) {
			doc.documentElement.setAttribute("data-rdsh-rightpanel-open", "");
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = () => null;
			doc.querySelectorAll = (selector) => (selector === '[aria-label="Collapse right sidebar"]' ? [collapse] : []);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 200 }] });
	for (const from of [10, 200]) {
		start({ touches: [{ clientX: from, clientY: 200 }], target: {} });
		move(touch(from + 90));
	}
	assert.equal(closes, 2, "the panel did not close from one of the start positions");
	booted.disposeAll();
});

test("the four-row drawer survives decoration when the upstream nav exists", () => {
	// The reference drawer's four rows are New Session (stock), Plugins and
	// Automation tasks (stock `sidebar.panellist` rows), and the Settings row
	// this plugin injects into that nav. If upstream renders no nav at all
	// (panels list empty), there is nowhere to inject. This pins the part this
	// package owns: decoration keeps the three stock rows visible and adds the
	// fourth after Automation tasks, even when no account menu is signed in.
	const frames = [];
	const nav = element();
	const newSession = element();
	const plugins = element();
	const auto = element();
	newSession.setAttribute("aria-label", "New Session");
	plugins.setAttribute("aria-label", "Plugins");
	auto.setAttribute("aria-label", "Automation tasks");
	let afterNode = null;
	auto.after = (node) => {
		afterNode = node;
		auto.nextElementSibling = node;
		nav.lastElementChild = node;
	};
	nav.querySelector = (selector) => {
		if (selector === 'button[aria-label="Automation tasks"]') return auto;
		if (selector === 'button[aria-label="Plugins"]') return plugins;
		if (selector === "[data-rdsh-settings-row]") return null;
		return null;
	};
	const created = [];
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			const create = doc.createElement;
			doc.createElement = (tag) => {
				const node = create(tag);
				created.push(node);
				return node;
			};
			doc.querySelector = (selector) => (selector === "nav.hHd-Xa_panelList" ? nav : null);
			doc.querySelectorAll = (selector) => {
				if (selector === "button[aria-label], [role='menuitem']") {
					return [newSession, plugins, auto, ...(afterNode === null ? [] : [afterNode])];
				}
				if (selector === "button") return [newSession, plugins, auto];
				return [];
			};
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	const row = afterNode ?? created.find((node) => node.hasAttribute?.("data-rdsh-settings-row"));
	assert.ok(row, "the Settings row was not inserted");
	for (const control of [newSession, plugins, auto]) {
		assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "a stock drawer row was hidden");
	}
	assert.equal(row.hasAttribute("data-rdsh-settings-row"), true);
	assert.equal(afterNode, row, "the row was appended instead of following Automation tasks");
	assert.equal(auto.nextElementSibling, row, "the Settings row is not the fourth visible row");
	assert.match(row.getAttribute("aria-label"), /^(?:Settings|mux\.settingsRow)$/);
	assert.deepEqual(
		[newSession, plugins, auto, row].map((control) => control.hasAttribute("data-rdsh-hidden")),
		[false, false, false, false],
		"one of the four drawer rows is hidden",
	);
	booted.disposeAll();
});

test("a localized Settings row is never mistaken for the account menu", () => {
	// Regression: COPY.ja used to render the injected row with aria-label
	// "設定", which is also one of PROBES.accountMenu. On the second decorate
	// pass `querySelector` returned that row, its parent nav was tagged with
	// `data-rdsh-more-row`, and the stylesheet hid the whole panel list (the
	// three rows collapsed to 0x0, as the QA screenshots show). The account
	// lookup must exclude the row this function just created, and must clear a
	// stale nav tag from an earlier pass.
	const frames = [];
	const nav = element();
	const footer = element();
	footer.className = "yHnPSG_anchor";
	const account = element();
	const newSession = element();
	const plugins = element();
	const auto = element();
	const createdButtons = [];
	newSession.setAttribute("aria-label", "New Session");
	plugins.setAttribute("aria-label", "Plugins");
	auto.setAttribute("aria-label", "Automation tasks");
	account.setAttribute("aria-label", "Account menu");
	account.closest = (selector) => (selector.includes("yHnPSG_anchor") ? footer : null);
	const settingsRow = () => createdButtons.find((button) => button.hasAttribute("data-rdsh-settings-row")) ?? null;
	const allButtons = () => [newSession, plugins, auto, ...(settingsRow() === null ? [] : [settingsRow()]), account];
	auto.after = (node) => {
		node.parentElement = nav;
		auto.nextElementSibling = node;
		nav.lastElementChild = node;
	};
	nav.querySelector = (selector) => {
		if (selector === 'button[aria-label="Automation tasks"]') return auto;
		if (selector === 'button[aria-label="Plugins"]') return plugins;
		if (selector === "[data-rdsh-settings-row]") return settingsRow();
		return null;
	};
	const booted = bootClient({
		narrow: true,
		frames,
		lang: "ja",
		copy: { ...COPY, ja: { ...COPY.ja, "mux.settingsRow": "設定" } },
		configureDocument(doc) {
			const create = doc.createElement;
			doc.createElement = (tag) => {
				const node = create(tag);
				if (tag === "button") createdButtons.push(node);
				return node;
			};
			doc.querySelector = (selector) => {
				if (selector === "nav.hHd-Xa_panelList") return nav;
				if (selector.includes('aria-label="Account menu"')) return settingsRow() ?? account;
				return null;
			};
			doc.querySelectorAll = (selector) => {
				if (selector.includes('aria-label="Account menu"')) {
					return settingsRow() === null ? [account] : [settingsRow(), account];
				}
				if (selector === "button") return allButtons();
				if (selector === "button[aria-label], [role='menuitem']") return allButtons();
				if (selector === "[data-rdsh-more-row]") {
					return [nav, footer, ...(settingsRow() === null ? [] : [settingsRow()])]
						.filter((element) => element.hasAttribute("data-rdsh-more-row"));
				}
				return [];
			};
		},
	});
	for (let pass = 0; pass < 3; pass += 1) {
		for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
		booted.sandbox.__RDSH_MOBILE_UX__.decorate();
	}
	const row = settingsRow();
	assert.ok(row, "the Settings row was not created");
	assert.equal(row.getAttribute("aria-label"), "設定");
	assert.equal(nav.hasAttribute("data-rdsh-more-row"), false, "the nav was tagged as the account row and hidden");
	assert.equal(footer.hasAttribute("data-rdsh-more-row"), true, "the real account footer lost its hidden-row tag");
	assert.equal(auto.nextElementSibling, row, "the Settings row did not stay after Automation tasks");
	for (const control of [newSession, plugins, auto, row]) {
		assert.equal(control.hasAttribute("data-rdsh-hidden"), false, "one of the four rows is hidden");
	}
	booted.disposeAll();
});

test("tapping Plugins or Automation tasks closes the phone drawer, never a desktop sidebar", () => {
	// Both rows open a full-screen route. On a phone the drawer must leave the
	// screen; on a desktop-width window the stock sidebar is not ours to close.
	assert.equal(drawerClosedAfterTapping("Plugins"), true, "Plugins left the drawer open");
	assert.equal(drawerClosedAfterTapping("Automation tasks"), true, "Automation tasks left the drawer open");
	assert.equal(drawerClosedAfterTapping("Plugins", { narrow: false }), false, "a desktop sidebar was closed");
	assert.equal(drawerClosedAfterTapping("Automation tasks", { narrow: false }), false, "a desktop sidebar was closed");
	// Existing rows keep their behaviour.
	assert.equal(drawerClosedAfterTapping("New session"), true);
	assert.equal(drawerClosedAfterTapping("Settings"), false);
});

test("a left-edge swipe opens the drawer even when it starts on a route row", () => {
	const windowHandlers = [];
	const documentHandlers = [];
	const open = element();
	let presses = 0;
	open.click = () => {
		presses += 1;
	};
	const booted = bootClient({
		narrow: true,
		windowAdd: (type, handler) => windowHandlers.push([type, handler]),
		windowRemove() {},
		configureDocument(doc) {
			doc.addEventListener = (type, handler) => documentHandlers.push([type, handler]);
			doc.querySelector = (selector) => (selector.includes("Open sidebar") ? open : null);
		},
	});
	const handler = (type, name) => [...documentHandlers].reverse()
		.find(([registered, fn]) => registered === type && fn.name === name)?.[1];
	const start = handler("touchstart", "onEdgeSwipeStart");
	const move = handler("touchmove", "onEdgeSwipeMove");
	assert.equal(typeof start, "function");
	assert.equal(typeof move, "function");
	const touch = (x) => ({ cancelable: true, preventDefault() {}, touches: [{ clientX: x, clientY: 420 }] });
	const RouteRow = booted.sandbox.Element;
	const row = new RouteRow();
	row.closest = (selector) => (selector.includes("button") ? {} : null);

	// x=8 is inside the route's full-width row. A rightward drag must still
	// become the drawer gesture rather than being rejected by the button guard.
	start({ touches: [{ clientX: 8, clientY: 420 }], target: row });
	move(touch(120));
	assert.equal(presses, 1, "the route row swallowed the left-edge swipe");

	// A non-edge start over the same row keeps the old button rule.
	start({ touches: [{ clientX: 200, clientY: 420 }], target: row });
	move(touch(320));
	assert.equal(presses, 1, "a non-edge button swipe opened the drawer");
	booted.disposeAll();
});

test("closeDrawer clears a stale open attribute when the route has no frame", () => {
	const booted = bootClient({
		narrow: true,
		configureDocument(doc) {
			doc.getElementById = () => null;
			doc.querySelector = () => null;
		},
	});
	booted.sandbox.document.documentElement.setAttribute("data-rdsh-drawer", "open");
	booted.sandbox.__RDSH_MOBILE_UX__.closeDrawer();
	assert.equal(booted.sandbox.document.documentElement.getAttribute("data-rdsh-drawer"), "closed");
	assert.equal(booted.sandbox.__RDSH_MOBILE_UX__.state.drawerOpen, false);
	booted.disposeAll();
});

test("a route heading is tagged for the FAB inset only on a phone route", () => {
	const frames = [];
	const center = element();
	const wrapper = element();
	const heading = element();
	heading.parentElement = wrapper;
	heading.closest = () => null;
	heading.getBoundingClientRect = () => ({ x: 24, y: 30, top: 30, left: 24, width: 153, height: 28, right: 177, bottom: 58 });
	center.querySelectorAll = (selector) => (selector === "h1" ? [heading] : []);
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return null;
				return null;
			};
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(wrapper.hasAttribute("data-rdsh-route-heading"), true, "the route heading was not tagged");
	booted.disposeAll();

	// The chat surface owns its own H1 (welcome card); it must not be treated
	// as a full-screen route heading.
	const chatFrames = [];
	const chatConversation = element();
	chatConversation.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 390, height: 844, right: 390, bottom: 844 });
	const chatHeading = element();
	const chatWrapper = element();
	chatHeading.parentElement = chatWrapper;
	chatHeading.closest = () => null;
	chatHeading.getBoundingClientRect = () => ({ x: 24, y: 300, top: 300, left: 24, width: 200, height: 28, right: 224, bottom: 328 });
	center.querySelectorAll = (selector) => (selector === "h1" ? [chatHeading] : []);
	const chat = bootClient({
		narrow: true,
		frames: chatFrames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return chatConversation;
				return null;
			};
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && chatFrames.length > 0; index += 1) chatFrames.shift()();
	assert.equal(chatWrapper.hasAttribute("data-rdsh-route-heading"), false, "a chat H1 was tagged as a route heading");
	chat.disposeAll();

	// Desktop is untouched.
	const wideFrames = [];
	const wide = bootClient({
		narrow: false,
		frames: wideFrames,
		configureDocument(doc) {
			doc.querySelector = (selector) => {
				if (selector === "[data-rdsh-center-col]") return center;
				if (selector === "[data-rdsh-conversation]") return null;
				return null;
			};
			doc.querySelectorAll = (selector) => (selector === "[data-rdsh-route-heading]" ? [wrapper] : []);
		},
	});
	for (let index = 0; index < 10 && wideFrames.length > 0; index += 1) wideFrames.shift()();
	assert.equal(wrapper.hasAttribute("data-rdsh-route-heading"), false, "a desktop route heading was tagged");
	wide.disposeAll();
});

test("boot records this page's push origin so a restart cannot double-fan-out", () => {
	const urls = [];
	const booted = bootClient({
		fetchImpl: (url) => {
			urls.push(String(url));
			return Promise.resolve(stub());
		},
	});
	assert.ok(
		urls.some((url) => url.endsWith("api/rdsh-pwa/push/config")),
		`boot did not call the push config route: ${JSON.stringify(urls)} ${JSON.stringify(booted.sandbox.__RDSH_MOBILE_UX__?.state?.bootError)}`,
	);
	booted.disposeAll();
});

test("mobile-send carries the page origin so the host can route the turn back", () => {
	const calls = [];
	const booted = bootClient({
		narrow: true,
		fetchImpl: (url, options) => {
			calls.push({ url: String(url), body: options?.body });
			return Promise.resolve(stub());
		},
	});
	booted.sandbox.location = { origin: "https://app.example:8446", href: "https://app.example:8446/" };
	booted.sandbox.window.location = booted.sandbox.location;
	booted.sandbox.__RDSH_MOBILE_UX__.markMobileSession("session-1");
	const call = calls.find((entry) => entry.url.endsWith("api/rdsh-pwa/push/mobile-send"));
	assert.ok(call, "mobile-send was not called");
	assert.deepEqual(JSON.parse(call.body), { sessionId: "session-1", origin: "https://app.example:8446" });
	booted.disposeAll();
});

test("the queue dock gets stable hooks for the compact/attached row UI", () => {
	const frames = [];
	const dock = element();
	const panel = element();
	const row = element();
	const preview = element();
	preview.textContent = "  A fixed queued message  ";
	dock.querySelector = (selector) => (selector === '[class*="_panel"]' ? panel : null);
	dock.querySelectorAll = (selector) => (selector === "li" ? [row] : []);
	row.querySelector = (selector) => (selector === '[class*="_preview"]' ? preview : null);
	const booted = bootClient({
		narrow: true,
		frames,
		configureDocument(doc) {
			doc.querySelector = (selector) => (selector === "[data-queue-dock]" ? dock : null);
			doc.querySelectorAll = () => [];
		},
	});
	for (let index = 0; index < 10 && frames.length > 0; index += 1) frames.shift()();
	assert.equal(dock.hasAttribute("data-rdsh-queue-dock"), true);
	assert.equal(panel.hasAttribute("data-rdsh-queue-panel"), true);
	assert.equal(row.hasAttribute("data-rdsh-queue-row"), true);
	assert.equal(preview.hasAttribute("data-rdsh-queue-preview"), true);
	assert.equal(preview.getAttribute("data-rdsh-queue-text"), "A fixed queued message");
	assert.equal(preview.getAttribute("tabindex"), "0");
	booted.disposeAll();
});
