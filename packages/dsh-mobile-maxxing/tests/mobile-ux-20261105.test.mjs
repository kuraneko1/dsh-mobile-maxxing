/**
 * The 2026-11-05 device findings (#141-#145) on a phone.
 *
 * Like the other bundle tests, the browser half has no exports: a slice of the
 * real source runs against the smallest DOM double that can answer it, so the
 * rule under test is the one the bundle ships rather than a copy of it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** The real source from "start" through the first "end" after it. */
function slice(start, end) {
	const at = CLIENT.indexOf(start);
	assert.ok(at >= 0, start.trim() + " exists");
	const stop = CLIENT.indexOf(end, at);
	assert.ok(stop > at, end.trim() + " closes the slice");
	return CLIENT.slice(at, stop);
}

// ---------------------------------------------------------------------------
// #142: the drawer's session search keeps the focus the app gives it
// ---------------------------------------------------------------------------

const GUARD_START = "    let allowFocusElement = null;";
const GUARD_END = "    // Keyboard: a sent message";

function guardHarness({ drawer = "open", inDrawer = true } = {}) {
	class Element {
		constructor() {
			this.tagName = "INPUT";
			this.disabled = false;
			this.readOnly = false;
			this.inDrawer = inDrawer;
		}
		closest(selector) {
			if (selector === 'input, textarea, [contenteditable="true"]') return this;
			if (selector === "[data-rdsh-sidebar]") return this.inDrawer ? this : null;
			return null;
		}
		getAttribute(name) { return name === "type" ? "text" : null; }
		blur() { this.blurred = (this.blurred ?? 0) + 1; }
	}
	const root = { getAttribute: (name) => (name === "data-rdsh-drawer" ? drawer : null) };
	const field = new Element();
	const queued = [];
	const sandbox = {
		Element,
		phone: () => true,
		document: { documentElement: root, activeElement: field },
		setTimeout: (fn) => queued.push(fn),
	};
	vm.runInNewContext(slice(GUARD_START, GUARD_END) + "\nthis.guard = onFocusInGuard; this.pointer = onFocusPointer;", sandbox);
	return {
		field, sandbox, root,
		focus(target = field) {
			sandbox.guard({ target });
			queued.splice(0).forEach((fn) => fn());
			return target.blurred ?? 0;
		},
	};
}

test("the open drawer's own search field keeps the focus the app gives it", () => {
	const h = guardHarness();
	// The search button's click focuses the input programmatically, so no
	// pointerdown ever authorised this field.
	assert.equal(h.focus(), 0, "the drawer's field is not blurred");
	assert.equal(h.field.blurred, undefined);
});

test("a field outside the drawer still needs a deliberate tap", () => {
	const h = guardHarness({ inDrawer: false });
	assert.equal(h.focus(), 1, "the app's automatic focus is still rejected");
});

test("a closed drawer does not authorise its fields", () => {
	const h = guardHarness({ drawer: "closed" });
	assert.equal(h.focus(), 1);
});

test("a deliberate tap on the field itself is unchanged", () => {
	const h = guardHarness({ inDrawer: false });
	h.sandbox.pointer({ target: h.field });
	assert.equal(h.focus(), 0, "onFocusPointer already authorised this field");
});

// ---------------------------------------------------------------------------
// #143: the session list renders one page (20 rows) at a time
// ---------------------------------------------------------------------------

const LIMIT_START = "    const SESSION_PAGE_SIZE = 20;";
const LIMIT_END = "    function toggleDrawer()";

function pagingHarness({ rows: rowCount = 21, drawer = "open", search = "", phone = true } = {}) {
	class Node {
		constructor(tag = "div") {
			this.tagName = tag;
			this.attributes = new Map();
			this.children = [];
			this.listeners = new Map();
			this.textContent = "";
		}
		setAttribute(name, value) { this.attributes.set(name, String(value)); }
		removeAttribute(name) { this.attributes.delete(name); }
		hasAttribute(name) { return this.attributes.has(name); }
		addEventListener(type, fn) { this.listeners.set(type, fn); }
		append(node) { this.children.push(node); }
		remove() { this.removed = true; }
		click() { this.listeners.get("click")?.({ type: "click" }); }
	}
	const rows = Array.from({ length: rowCount }, () => new Node("div"));
	const more = [];
	const scroller = new Node("div");
	scroller.append = (node) => { more.push(node); };
	const searchField = search === null ? null : { value: search };
	const sidebar = {
		querySelectorAll: (selector) => (selector === '[data-row-key^="session:"]' ? rows : []),
		querySelector: (selector) => {
			if (selector === "input") return searchField;
			if (selector === "[data-rdsh-session-more]") return more.find((node) => node.isConnected !== false) ?? null;
			return null;
		},
	};
	const document = {
		documentElement: { getAttribute: (name) => (name === "data-rdsh-drawer" ? drawer : null) },
		querySelector: (selector) => (selector === "[data-rdsh-sidebar]" ? sidebar : null),
		querySelectorAll: (selector) => (selector === "[data-rdsh-session-overflow]" ? rows.filter((row) => row.hasAttribute("data-rdsh-session-overflow")) : []),
		createElement: (tag) => new Node(tag),
	};
	let decorates = 0;
	const sandbox = {
		document, Node,
		phone: () => phone,
		t: (key) => (key === "mux.sessions.more" ? "Show more sessions" : key),
		sessionListScroller: () => scroller,
		scheduleDecorate: () => { decorates += 1; },
	};
	vm.runInNewContext(slice(LIMIT_START, LIMIT_END) + "\nthis.decorateLimit = decorateSessionLimit; this.limit = () => sessionLimit;", sandbox);
	return { rows, more, sidebar, sandbox, decorate: () => sandbox.decorateLimit(), decorates: () => decorates };
}

const hidden = (h) => h.rows.filter((row) => row.hasAttribute("data-rdsh-session-overflow")).length;

test("21 sessions show the first 20 and a Show more button", () => {
	const h = pagingHarness();
	h.decorate();
	assert.equal(hidden(h), 1, "the 21st row is the only hidden one");
	assert.equal(h.more.length, 1, "one button is appended");
	assert.equal(h.more[0].textContent, "Show more sessions");
	assert.equal(h.sandbox.limit(), 20);
});

test("Show more reveals the next page and then retires the button", () => {
	const h = pagingHarness();
	h.decorate();
	h.more[0].click();
	assert.equal(h.decorates(), 1, "the click asks for a decorate pass");
	assert.equal(h.sandbox.limit(), 40);
	h.decorate();
	assert.equal(hidden(h), 0, "all 21 rows are visible");
	assert.equal(h.more[0].removed, true, "no button when nothing is left");
});

test("a search result set is never paged", () => {
	const h = pagingHarness({ search: "qa" });
	h.decorate();
	assert.equal(hidden(h), 0);
	assert.equal(h.more.length, 0);
});

test("a closing drawer keeps its page, a desktop has no paging at all", () => {
	// The drawer slide-out is 300ms; dropping the page at the same instant
	// would paint the whole catalog while the list is still leaving.
	const closed = pagingHarness({ drawer: "closed" });
	closed.decorate();
	assert.equal(hidden(closed), 1, "the page stays applied while the drawer closes");
	const desktop = pagingHarness({ phone: false });
	desktop.rows[3].setAttribute("data-rdsh-session-overflow", "");
	desktop.decorate();
	assert.equal(hidden(desktop), 0, "a desktop keeps every session row");
});


// ---------------------------------------------------------------------------
// #142: the keyboard pin leaves the drawer alone
// ---------------------------------------------------------------------------

const FIT_START = "    function fitVisualViewport() {";
const FIT_END = "    function measureSafeArea()";

function pinHarness({ drawer = "open", dialog = null } = {}) {
	const html = {
		attributes: new Set(),
		getAttribute(name) { return name === "data-rdsh-drawer" ? drawer : null; },
		hasAttribute(name) { return this.attributes.has(name); },
		toggleAttribute(name, on) { if (on) this.attributes.add(name); else this.attributes.delete(name); },
		style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
	};
	const sandbox = {
		document: { documentElement: html, querySelector: (selector) => (selector === '[role="dialog"]' ? dialog : null) },
		window: { innerWidth: 390, innerHeight: 844, visualViewport: { height: 500, offsetTop: 0, scale: 1 } },
		phone: () => true,
		keyboardOpen: () => true,
	};
	vm.runInNewContext(slice(FIT_START, FIT_END) + "\nthis.fit = fitVisualViewport;", sandbox);
	return { html, sandbox, fit: () => sandbox.fit() };
}

test("the open drawer keeps the full-height layout while the keyboard is up", () => {
	const h = pinHarness();
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), false, "no keyboard pin while the drawer is open");
});

test("the chat screen still pins itself to the keyboard", () => {
	const h = pinHarness({ drawer: "closed" });
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), true);
	assert.equal(h.html.style.values.get("--rdsh-vv-height"), "500px");
});

test("a dialog keeps owning its own geometry", () => {
	const h = pinHarness({ drawer: "closed", dialog: {} });
	h.fit();
	assert.equal(h.html.hasAttribute("data-rdsh-keyboard"), false);
});


// ---------------------------------------------------------------------------
// #144: a cold start records baselines instead of typing every title
// ---------------------------------------------------------------------------

const TYPING_START = "    const UNTITLED = probeRegex(";
const TYPING_END = '    /** Upward travel that counts as "flick the banner away". */';

function typingHarness({ mobile = true } = {}) {
	let clock = 2_000_000;
	class Title {
		constructor() { this.childNodes = [{ nodeType: 3, nodeValue: "" }]; this.attributes = new Set(); }
		set value(text) { this.childNodes = [{ nodeType: 3, nodeValue: text }]; }
		hasAttribute(name) { return this.attributes.has(name); }
		removeAttribute(name) { this.attributes.delete(name); }
		setAttribute(name, value) { this.attributes.set(name, String(value)); }
		querySelector() { return null; }
		append() {}
		remove() {}
	}
	class Row {
		constructor(id, title) { this.key = "session:" + id; this.title = title; this.attributes = new Set(); }
		getAttribute(name) { return name === "data-row-key" ? this.key : null; }
		hasAttribute(name) { return this.attributes.has(name); }
		setAttribute(name) { this.attributes.add(name); }
	}
	const rows = [];
	const animations = [];
	const document = {
		querySelector: () => null,
		querySelectorAll: (selector) => (selector === "[data-rdsh-session-title]" ? rows.map((row) => row.title) : []),
		createElement: () => new Title(),
	};
	const sandbox = {
		document, MutationObserver: class { observe() {} disconnect() {} },
		phone: () => mobile,
		probeRegex: () => /^(new session|new chat|untitled)$/i,
		__RDSH_MOBILE_UX_RUNNING__: new Set(),
		Date: { now: () => clock },
	};
	vm.runInNewContext(slice(TYPING_START, TYPING_END) + "\nthis.decorate = decorateSessionTitleTyping; this.setAnimate = (fn) => { animateSessionTitle = fn; };", sandbox);
	sandbox.setAnimate((element, next, previous) => {
		animations.push({ next, previous });
		return { visible: () => next, cancel() {}, reattach() {} };
	});
	return {
		rows, animations, sandbox,
		add(id, text) {
			const title = new Title();
			title.value = text;
			const row = new Row(id, title);
			title.closest = () => row;
			rows.push(row);
			return { row, title, set: (value) => { title.value = value; } };
		},
		decorate: () => sandbox.decorate(),
	};
}

test("existing titles on the first pass never type", () => {
	const h = typingHarness();
	h.add("a", "Alpha"); h.add("b", "Beta"); h.add("c", "Gamma");
	h.decorate();
	assert.equal(h.animations.length, 0, "the boot catalog is a baseline");
});

test("a cold start that paints empty rows before the titles still never types", () => {
	const h = typingHarness();
	const a = h.add("a", ""); const b = h.add("b", "");
	h.decorate();
	a.set("Alpha"); b.set("Beta");
	h.decorate();
	assert.equal(h.animations.length, 0, "placeholder to title is the baseline");
});

test("a cold start that paints raw ids before the titles still never types", () => {
	const h = typingHarness();
	const a = h.add("a", "a"); const b = h.add("b", "b");
	h.decorate();
	a.set("Alpha"); b.set("Beta");
	h.decorate();
	assert.equal(h.animations.length, 0, "the id fallback is not a naming event");
});

test("only a title that changes after the baseline types", () => {
	const h = typingHarness();
	const a = h.add("a", "Alpha"); h.add("b", "Beta");
	h.decorate();
	a.set("Alpha renamed");
	h.decorate();
	assert.deepEqual(h.animations, [{ next: "Alpha renamed", previous: "Alpha" }]);
});

test("a session being named still types its first title", () => {
	const h = typingHarness();
	const a = h.add("a", "New session");
	// decorateSessionRows() tags the row while its session is in the running
	// set; that tag is what the typing pass reads.
	a.row.setAttribute("data-rdsh-running", "");
	h.decorate();
	a.set("Generated name");
	h.decorate();
	assert.deepEqual(h.animations, [{ next: "Generated name", previous: "New session" }]);
});

test("a desktop pass animates nothing", () => {
	const h = typingHarness({ mobile: false });
	const a = h.add("a", "Alpha");
	h.decorate();
	a.set("Alpha renamed");
	h.decorate();
	assert.equal(h.animations.length, 0);
});


// ---------------------------------------------------------------------------
// #145: iOS text autosizing is disabled on the phone sheet only
// ---------------------------------------------------------------------------

function stylesheet(name) {
	const marker = "const " + name + " = " + String.fromCharCode(96);
	const at = CLIENT.indexOf(marker);
	assert.ok(at >= 0, name + " exists");
	const end = CLIENT.indexOf(String.fromCharCode(96) + ";", at + marker.length);
	assert.ok(end > at, name + " is closed");
	return CLIENT.slice(at + marker.length, end);
}

test("the phone sheet stops iOS from autosizing the transcript", () => {
	const phone = stylesheet("CSS_PHONE");
	assert.match(phone, /html \{\s*-webkit-text-size-adjust: 100%;\s*text-size-adjust: 100%;\s*\}/, "both declarations, on html");
	const desktop = stylesheet("CSS_DEVICE");
	assert.ok(!desktop.includes("text-size-adjust"), "a desktop keeps the browser default");
});

