/**
 * A running (ringed) session row must paint in a sidebar too short to scroll.
 *
 * iOS Safari painted nothing for a ringed row, not its fill, name or ring,
 * while the sidebar list did not overflow; the same row painted once the list
 * overflowed. markRingList() tags the list that holds the ringed row so the
 * phone sheet can give it its own layer whether or not it scrolls. These
 * tests drive the real function against a small DOM double and pin the CSS
 * and cleanup that go with it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** The declaration from `function name(` through its own closing brace. */
function functionSource(name) {
	const at = source.indexOf(`    function ${name}(`);
	assert.ok(at >= 0, `${name} exists`);
	const end = source.indexOf("\n    }\n", at);
	assert.ok(end >= 0, `${name} is complete`);
	return source.slice(at, end + "\n    }".length);
}

const markSource = functionSource("markRingList");

/** Just enough of an element for markRingList: attributes, class, parent. */
function element(className = "", attributes = {}) {
	const attrs = new Map(Object.entries(attributes));
	const node = {
		className,
		parentElement: null,
		children: [],
		hasAttribute: (name) => attrs.has(name),
		getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
		setAttribute: (name, value) => attrs.set(name, String(value)),
		removeAttribute: (name) => attrs.delete(name),
		append(...kids) {
			for (const kid of kids) {
				kid.parentElement = node;
				node.children.push(kid);
			}
		},
		matches: (selector) => selector.split(",").some((one) => matchOne(node, one.trim())),
		closest(selector) {
			for (let at = node; at !== null; at = at.parentElement) if (at.matches(selector)) return at;
			return null;
		},
	};
	return node;
}

/** The selector forms markRingList uses: [attr], [class$="x"], [class*="x"]. */
function matchOne(node, selector) {
	let m = /^\[([\w-]+)\]$/.exec(selector);
	if (m) return node.hasAttribute(m[1]);
	m = /^\[class([$*])="([^"]*)"\]$/.exec(selector);
	if (m) return m[1] === "$" ? node.className.endsWith(m[2]) : node.className.includes(m[2]);
	throw new Error(`unsupported selector in the double: ${selector}`);
}

function all(root) {
	const out = [];
	const walk = (node) => {
		out.push(node);
		for (const kid of node.children) walk(kid);
	};
	walk(root);
	return out;
}

/**
 * Upstream's sidebar shape: sidebar > list > group section > row wrapper >
 * session row. `scrolls` adds the data-rdsh-scroll tag markScrollers() writes
 * only when the list overflows.
 */
function sidebar({ ringed = true, scrolls = false } = {}) {
	const root = element("x_sidebarCol", { "data-rdsh-sidebar": "" });
	const list = element("bhn1Oq_list", scrolls ? { "data-rdsh-scroll": "" } : {});
	const section = element("bhn1Oq_groupSection");
	const wrapper = element("_root_bgejw_3");
	const row = element("YDXeBa_sessionRow", ringed ? { "data-rdsh-ring-row": "" } : {});
	root.append(list);
	list.append(section);
	section.append(wrapper);
	wrapper.append(row);
	return { root, list, row };
}

function run(root) {
	const document = {
		querySelector(selector) {
			assert.equal(selector, "[data-rdsh-sidebar] [data-rdsh-ring-row]");
			return all(root).find((node) => node.hasAttribute("data-rdsh-ring-row") && node.closest("[data-rdsh-sidebar]") !== null) ?? null;
		},
		querySelectorAll(selector) {
			assert.equal(selector, "[data-rdsh-ring-list]");
			return all(root).filter((node) => node.hasAttribute("data-rdsh-ring-list"));
		},
	};
	vm.runInNewContext(`${markSource}\nmarkRingList();`, { document });
}

test("a short list holding a running row is tagged even though it does not scroll", () => {
	const { root, list, row } = sidebar();
	run(root);
	assert.equal(list.hasAttribute("data-rdsh-ring-list"), true, "the non-scrolling list was left without its layer");
	assert.equal(row.hasAttribute("data-rdsh-ring-list"), false);
});

test("a scrolling list is tagged too", () => {
	const { root, list } = sidebar({ scrolls: true });
	run(root);
	assert.equal(list.hasAttribute("data-rdsh-ring-list"), true);
});

test("the tag leaves once no session runs", () => {
	const { root, list, row } = sidebar();
	run(root);
	row.removeAttribute("data-rdsh-ring-row");
	run(root);
	assert.equal(list.hasAttribute("data-rdsh-ring-list"), false, "an idle list kept its extra layer");
});

test("the phone sheet gives the tagged list its own layer, and a desktop pass strips the tag", () => {
	assert.match(
		source,
		/html\[data-rdsh-anim="outline"\] \[data-rdsh-ring-list\] \{\s*will-change: transform;\s*\}/,
		"the ring list has no layer of its own",
	);
	const hooks = source.slice(source.indexOf("const SESSION_ROW_HOOKS = ["), source.indexOf("];", source.indexOf("const SESSION_ROW_HOOKS = [")));
	assert.match(hooks, /"data-rdsh-ring-list",/, "the ring list tag is not in the cleanup list");
	const rows = source.slice(source.indexOf("    function decorateSessionRows("), source.indexOf("\n    }\n", source.indexOf("    function decorateSessionRows(")));
	assert.match(rows, /\n\s+markRingList\(\);\n/, "the session-row pass no longer tags the list");
});
