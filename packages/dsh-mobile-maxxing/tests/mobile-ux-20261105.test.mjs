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
