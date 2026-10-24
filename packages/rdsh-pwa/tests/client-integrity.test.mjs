/**
 * Static checks over the browser half.
 *
 * `client.js` is loaded verbatim, so a reference to something that no longer
 * exists is not a syntax error: it throws the first time that line runs, which
 * is usually during boot or on the first gesture. Two bulk edits here left
 * exactly that behind (`onModelFocusOut`, `textBoxOf`) while every other test
 * stayed green and only a real browser noticed. These checks are the cheap
 * substitute for that browser round trip.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Drop comments and string/template literals, keeping the code shape. */
function stripLiterals(source) {
	const out = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			const quote = character;
			index += 1;
			while (index < source.length) {
				if (source[index] === "\\") {
					index += 2;
					continue;
				}
				if (source[index] === quote) {
					index += 1;
					break;
				}
				index += 1;
			}
			out.push('""');
			continue;
		}
		out.push(character);
		index += 1;
	}
	return out.join("");
}

/** Every name this file brings into scope. */
function declaredNames(code) {
	const declared = new Set();
	const add = (name) => {
		if (/^[A-Za-z_$][\w$]*$/.test(name ?? "")) declared.add(name);
	};
	// A parameter list is flat (`a, b`) or a destructured object
	// (`{ sessionId, useMenuOpenState }`).
	const addParameters = (params) => {
		const text = params.trim();
		if (text.startsWith("{")) {
			for (const inner of text.replace(/^\{|\}$/g, "").split(",")) add(inner.split(":")[0].trim());
			return;
		}
		for (const part of text.split(",")) add(part.split("=")[0].trim());
	};
	for (const match of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
	for (const match of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(match[1]);
	// Object/class method shorthand: `name(...) {`.
	for (const match of code.matchAll(/(?:^|[\s{,])([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) add(match[1]);
	// Object destructuring.
	for (const match of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) {
		for (const part of match[1].split(",")) add(part.split(":")[0].trim().split("=")[0].trim());
	}
	// Array destructuring (React state pairs).
	for (const match of code.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) {
		for (const part of match[1].split(",")) add(part.trim());
	}
	// Arrow parameters, parenthesised and single.
	// One level of nesting covers a default parameter that is itself a call:
	// `function f(a = read(), b = read2())`.
	for (const match of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(((?:[^()]|\([^()]*\))*)\)/g)) addParameters(match[1]);
	for (const match of code.matchAll(/\(((?:[^()]|\([^()]*\))*)\)\s*=>/g)) addParameters(match[1]);
	for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(match[1]);
	return declared;
}

/** Keywords that take a parenthesised clause rather than a call. */
const NOT_A_CALLEE = new Set([
	"if", "for", "while", "switch", "catch", "return", "typeof", "new", "function", "await", "yield",
	"delete", "void", "in", "of", "instanceof", "do", "else", "try", "throw", "case", "super", "import",
	"export", "async", "class", "extends",
]);

/** Browser and host globals a call may legitimately target. */
const GLOBALS = new Set([
	"parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
	"setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
	"queueMicrotask", "structuredClone", "fetch", "atob", "btoa", "getComputedStyle", "matchMedia",
	"Boolean", "Number", "String", "Array", "Object", "Math", "JSON", "Date", "Promise", "Map", "Set", "WeakMap",
	"WeakSet", "Symbol", "RegExp", "Error", "TypeError", "RangeError", "Uint8Array", "Uint32Array", "Intl",
	"URL", "URLSearchParams", "Element", "HTMLElement", "Node", "Event", "CustomEvent", "PointerEvent",
	"KeyboardEvent", "InputEvent", "MouseEvent", "TouchEvent", "Touch", "DataTransfer", "MessageChannel",
	"Notification", "AudioContext", "webkitAudioContext", "MutationObserver", "IntersectionObserver",
	"ResizeObserver", "AbortController", "TextEncoder", "TextDecoder", "Blob", "File", "FileReader", "Image",
	"FormData", "Headers", "Request", "Response", "Proxy", "Reflect", "BigInt", "crypto", "performance",
	"console", "localStorage", "sessionStorage", "document", "window", "navigator", "location", "screen",
	"history", "self", "globalThis", "arguments", "require",
]);

/** Identifiers called as functions that nothing declares. */
function undefinedCalls(code) {
	const declared = declaredNames(code);
	const calls = new Set();
	for (const match of code.matchAll(/(?<![.?\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(match[1]);
	return [...calls]
		.filter((name) => !declared.has(name) && !NOT_A_CALLEE.has(name) && !GLOBALS.has(name))
		.sort();
}

test("no call targets an undeclared identifier", () => {
	// This is what a deleted helper looks like: the definition goes, one call
	// site stays, and nothing notices until that line runs.
	assert.deepEqual(undefinedCalls(stripLiterals(CLIENT)), []);
});

/** Names assigned without ever being declared — the state a bulk edit drops. */
function undefinedAssignments(code) {
	const declared = declaredNames(code);
	const keywords = new Set([
		"if", "for", "while", "switch", "catch", "return", "typeof", "new", "function", "await", "yield",
		"delete", "void", "in", "of", "instanceof", "do", "else", "try", "throw", "case", "super", "import",
		"export", "async", "class", "extends",
	]);
	const host = new Set(["globalThis", "window", "document", "navigator", "location", "localStorage",
		"sessionStorage", "screen", "history", "self", "console", "performance", "crypto", "module", "exports"]);
	const assigned = new Set();
	for (const match of code.matchAll(/(?<![.?\w$])([A-Za-z_$][\w$]*)\s*=(?!=)/g)) assigned.add(match[1]);
	return [...assigned].filter((name) => !declared.has(name) && !keywords.has(name) && !host.has(name)).sort();
}

test("no assignment targets an undeclared variable", () => {
	// `allowFocusElement = field` with the `let` above it deleted is a
	// ReferenceError on the first focus event, not at load time.
	assert.deepEqual(undefinedAssignments(stripLiterals(CLIENT)), []);
});

test("every addEventListener handler is defined", () => {
	const missing = [];
	for (const match of CLIENT.matchAll(/addEventListener\(\s*"[a-z]+"\s*,\s*([A-Za-z_$][\w$]*)/g)) {
		if (match[1] === "async") continue;
		if (!new RegExp(`function ${match[1]}\\b|(?:const|let|var) ${match[1]}\\s*=`).test(CLIENT)) missing.push(match[1]);
	}
	assert.deepEqual(missing, [], "a listener is registered without a definition");
});

test("the bundle registers exactly one client module", () => {
	const registrations = CLIENT.match(/window\.__ModuleLoader__\.load\(/g) ?? [];
	assert.equal(registrations.length, 1, "one package is one browser module");
	assert.match(CLIENT, /window\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*"rdsh-pwa",/);
});

test("no data attribute is styled without ever being written", () => {
	const styled = new Set();
	for (const match of CLIENT.matchAll(/\[(data-rdsh-[a-z0-9-]+)\]/g)) styled.add(match[1]);
	const missing = [];
	for (const attribute of styled) {
		const exact = new RegExp(`(?:setAttribute|toggleAttribute)\\(\\s*"${attribute}"`).test(CLIENT);
		const prefix = attribute.split("-").slice(0, -1).join("-");
		const templated = new RegExp(`(?:setAttribute|toggleAttribute)\\(\\s*\`${prefix}-\\$\\{`).test(CLIENT);
		const quoted = new RegExp("[\"'`]" + attribute + "[\"'`]").test(CLIENT.replace(/\[(data-rdsh-[a-z0-9-]+)\]/g, ""));
		if (!exact && !templated && !quoted) missing.push(attribute);
	}
	assert.deepEqual(missing, [], "styled but never written");
});

/** The source of one top-level helper, from its declaration to its closing brace. */
function helperBody(name) {
	const start = CLIENT.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	const close = CLIENT.indexOf("\n    }\n", start);
	return CLIENT.slice(start, close === -1 ? undefined : close);
}

test("the context meter reads the projection instead of opening the popover", () => {
	// #13: a real click opened the popover for about 80ms on every update, and
	// the rule that hid it only lived inside the phone media query, so a
	// settings modal flickered on desktop too.
	assert.equal(/data-rdsh-context-probe/.test(CLIENT), false, "the probe attribute and its rule are gone");
	const meter = helperBody("contextUsageText");
	assert.equal(/\.click\(/.test(meter), false, "reading the meter must not click the button");
	assert.match(meter, /projectionValues\(/, "the figures come from the Session projection");
	assert.match(meter, /contextPressure/);
	assert.match(meter, /pressureTokens/, "the same numerator the upstream panel uses");
});

test("the transcript keeps its column tag and the reference 349px measure", () => {
	// #14: the tag itself sets the 16px gutters, so the "24px or more"
	// heuristic can never hold again — a second decorate dropped the column.
	const body = helperBody("decorateTranscript");
	assert.match(body, /hasAttribute\("data-rdsh-transcript"\)/, "an already tagged node short-circuits the heuristic");
	assert.match(body, /data-rdsh-transcript-column/);
	// The reference column is a fixed, centred 349px reading measure. The
	// 100% conversation rules may not erase it.
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{\s*\n\s*width: 349px !important;/, "the 349px column is gone");
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{[^}]*max-width: 100% !important;/, "a narrow viewport can overflow");
	assert.match(CLIENT, /\[data-rdsh-transcript-column\] \{[^}]*margin-left: auto !important;/, "the column is not centred");
});

test("the question card uses the composer's 16px viewport gutters", () => {
	// The card is no longer pinned to the transcript's 349px column: on a
	// phone it is viewport - 32px so both edges sit 16px from the screen. The
	// frame spans the seat, box-sizing keeps its own padding from enlarging it,
	// and flex must not shrink the card back to the content width.
	assert.match(
		CLIENT,
		/\[data-rdsh-question-frame\] \{[^}]*box-sizing: border-box !important;[^}]*width: 100% !important;[^}]*max-width: 100% !important;[^}]*justify-content: flex-start !important;[^}]*padding-left: 16px !important; padding-right: 16px !important;/,
		"the question frame no longer spans the seat with a 16px gutter",
	);
	assert.match(
		CLIENT,
		/\[data-rdsh-question-frame\] > \[data-rdsh-question-card\] \{[^}]*flex: 0 0 auto !important;[^}]*width: calc\(100vw - 32px\) !important;[^}]*max-width: calc\(100vw - 32px\) !important;[^}]*margin-left: 0 !important; margin-right: 0 !important;/,
		"the card is not viewport - 32px with zero auto margins",
	);
	assert.match(CLIENT, /\[data-rdsh-question-card\] > \[class\*="_header"\]/, "the direct-child header padding is gone");
	assert.match(CLIENT, /\[data-rdsh-question-card\] > \[class\*="_footer"\]/, "the direct-child footer padding is gone");
	assert.equal(/\[data-rdsh-question-card\] \[class\*="_footer"\]/.test(CLIENT), false, "the descendant selector is back");
	assert.equal(/\[data-rdsh-question-card\] \[class\*="_option"\]/.test(CLIENT), false, "the ambiguous option selector is back");
	assert.match(CLIENT, /\[class\*="_field"\] > \* \{ font-size: 16px/, "the answer mirror and the textarea share the font");
});

test("the device theme never writes the shared preference", () => {
	// #5: theme.setTheme() writes the profile, which is what propagated a phone
	// change to every connected browser. The override must stay browser-local.
	assert.equal(/setTheme\s*\(/.test(stripLiterals(CLIENT)), false, "theme.setTheme() must never be called");
	assert.match(CLIENT, /rdsh-pwa:device-theme/, "the choice is stored per browser");
	assert.match(CLIENT, /data-ds-dark-theme/, "the override repaints the upstream palette attribute");
});

// ---------------------------------------------------------------------------
// Phone scoping: anything that dresses upstream DOM, or that assumes a finger,
// has to stay inside the phone query or a desktop session looks like a phone.
// ---------------------------------------------------------------------------

/** Both `const CSS = \`…\`` blocks, with the query interpolated in. */
function cssBlocks() {
	const blocks = [...CLIENT.matchAll(/const CSS = `([\s\S]*?)`;\n/g)].map((match) => match[1]);
	assert.ok(blocks.length >= 2, "expected the shell and the layout stylesheets");
	return blocks.map((css) => css.replace(/\$\{NARROW_QUERY\}/g, "(max-width: 767px)"));
}

/**
 * Flatten a stylesheet into one entry per declaration block.
 *
 * Comments are dropped first: this file's comments quote selectors, and a
 * brace inside prose would otherwise open a block.
 */
function cssRules(css) {
	const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [];
	const stack = [];
	let current = "";
	for (const character of source) {
		if (character === "{") {
			stack.push(current.trim());
			if (current.trim() !== "") rules.push({ head: current.trim(), at: [...stack.slice(0, -1)] });
			current = "";
			continue;
		}
		if (character === "}") {
			stack.pop();
			current = "";
			continue;
		}
		if (character === ";") {
			current = "";
			continue;
		}
		current += character;
	}
	return rules;
}

/** The text just inside a function declaration or an arrow constant. */
function functionHead(name, length = 900) {
	const declared = CLIENT.indexOf(`function ${name}(`);
	const assigned = CLIENT.indexOf(`const ${name} = (`);
	const at = declared >= 0 ? declared : assigned;
	assert.ok(at >= 0, `${name} is missing`);
	return CLIENT.slice(at, at + length);
}

test("upstream hooks are styled only inside the phone query", () => {
	// The report behind this test: on a desktop, running sessions showed the
	// phone ring, the open row was painted with a hard-coded #232324, image
	// previews were darkened and cropped. Those rules used to sit outside the
	// media block. The safe-area rules are the only exception: they key off
	// `env()` values, which are zero on a desktop. The hide-list rules are the
	// second: their attribute is only written at phone width, so the attribute
	// itself is the gate. The session colour frame is the third: the reference
	// build paints it on desktop too.
	const allow = [
		/^html\[data-rdsh-safe-(top|bottom|left|right)\]/,
		/^html\[data-rdsh-native-gap\]/,
		/^html\[data-rdsh-pwa=/,
		/^html\[data-rdsh-hide-settings\]/,
		/^\[data-rdsh-session-frame\]$/,
	];
	const phone = (at) => at.some((head) => /max-width:\s*767px/.test(head));
	const leaked = [];
	for (const css of cssBlocks()) {
		for (const rule of cssRules(css)) {
			if (!/\[data-rdsh-/.test(rule.head)) continue;
			if (phone(rule.at)) continue;
			if (allow.some((pattern) => pattern.test(rule.head))) continue;
			leaked.push(rule.head);
		}
	}
	assert.deepEqual(leaked, [], "styled outside the phone query");
	// The drawer header toggle: every pointer state is label-primary on a
	// transparent background, no Android tap flash, and no delayed tooltip.
	assert.match(
		CLIENT,
		/\[data-rdsh-sidebar-toggle\],\s*\n\s*\[data-rdsh-sidebar-toggle\]:is\(:hover, :active, :focus\) \{\s*\n\s*color: var\(--dsw-alias-label-primary\) !important;\s*\n\s*background: transparent !important;/,
		"the drawer header toggle does not follow the reference paint",
	);
	assert.match(CLIENT, /\[data-rdsh-sidebar-toggle\] \* \{ -webkit-tap-highlight-color: transparent; \}/, "the toggle children keep the tap flash");
	assert.match(CLIENT, /html:has\(\[data-rdsh-sidebar-toggle\]:is\(:hover, :focus\)\) \[role="tooltip"\] \{ display: none !important; \}/, "the toggle tooltip is not suppressed");
});

test("the phone query is the legacy width-only contract", () => {
	// The reference plugin treats everything at or below 767px as a phone,
	// in either orientation. A landscape 844px phone stays in the desktop
	// layout, because that is what the reference build does.
	const definitions = [...CLIENT.matchAll(/const NARROW_QUERY = "([^"]+)";/g)].map((match) => match[1]);
	assert.equal(definitions.length, 2, "one definition per half");
	for (const definition of definitions) {
		assert.equal(definition, "(max-width: 767px)", "the query gained an orientation or pointer clause");
	}
	assert.equal(
		(CLIENT.match(/@media \(max-width: 767px\)/g) ?? []).length,
		0,
		"the stylesheets must interpolate NARROW_QUERY instead of repeating it",
	);
});

test("Enter follows the phone width, as in the reference build", () => {
	// The phone default (Enter inserts a newline) is the opposite of the stock
	// composer. The reference gated it on width only, so a narrow desktop
	// window gets the phone behaviour too.
	const head = functionHead("onKeyDownCapture", 1200);
	assert.match(head, /const finger = phone\(\);/, "onKeyDownCapture no longer asks about the layout");
	assert.match(head, /if \(!finger && !notifyDeviceTurns\(\)\) return;/, "a wide desktop only enters the key path for the #15 opt-in");
	assert.doesNotMatch(stripLiterals(head), /coarsePointer\s*\(/, "a narrow fine pointer would lose the phone default");
});

test("panel-wide decorations stay off the desktop", () => {
	// Both of these reach across upstream UI: the stats dock opens the context
	// panel to read a number, and the lightbox injects a crop button.
	assert.match(functionHead("decorateStatsDock", 500), /if \(!narrow\(\)\) return;/, "decorateStatsDock is not phone-gated");
	assert.match(functionHead("decorateLightbox", 400), /if \(!narrow\(\)\) return;/, "decorateLightbox is not phone-gated");
});

test("leaving the phone layout removes its hooks, while desktop frames stay", () => {
	// Attributes survive a resize on their own: the stylesheet stops applying
	// but the DOM keeps claiming a row is running, and the header title keeps
	// a hook whose sheen no longer exists.
	assert.match(CLIENT, /function clearSessionRowHooks\(\)/, "no row cleanup");
	assert.match(CLIENT, /function clearPhoneHooks\(\)/, "no header/typing cleanup");
	assert.match(
		CLIENT,
		/if \(!media\.matches\) \{\s*\n\s*resetGestures\(\);\s*\n\s*clearPhoneHooks\(\);/,
		"a resize to desktop keeps the phone hooks",
	);
	assert.match(CLIENT, /"data-rdsh-sidebar-toggle"/, "the sidebar toggle tag is not cleaned up");
	const toggle = functionHead("decorateSidebarToggle", 1700);
	assert.match(toggle, /if \(!narrow\(\)\)/, "the sidebar toggle is tagged on a desktop");
	assert.match(toggle, /\[data-slot="sidebar"\]/, "the sidebar toggle search is not bounded by its slot");
	assert.match(toggle, /button\[aria-label="Open sidebar"\], button\[aria-label="Collapse sidebar"\]/, "the toggle action label is not used");
	// The reference decorates rows at every width, so the desktop colour frame
	// exists as a hook and is painted by a rule outside the phone query.
	assert.match(CLIENT, /^\s+decorateSessionRows\(\);\s*$/m, "session rows are no longer decorated on desktop");
	assert.match(CLIENT, /^\[data-rdsh-session-frame\] \{\s*\n\s*box-shadow: inset 0 0 0 2px var\(--rdsh-session-frame\) !important;/m, "the frame hook has no desktop style");
});

test("the live-speed poller only runs on a phone", () => {
	const body = functionHead("LiveSpeed", 2400);
	assert.match(body, /if \(!sessionId \|\| !phone\) \{/, "the poller runs on a desktop");
	assert.match(body, /if \(!phone \|\| speed === null\) return null;/, "the speed label renders on a desktop");
});

test("resize only drops gestures on a real width change or a rotation", () => {
	// The reference did not reset gestures on resize at all. Height-only
	// changes (keyboard, URL bar) and visualViewport events must leave an
	// in-flight swipe alone; a real width change, a rotation or leaving the
	// phone layout still resets it, and touchend/touchcancel always clear.
	assert.match(functionHead("resetGestures", 400), /edgeSwipe = null;\s*\n\s*touchStart = null;/, "no gesture reset");
	// There is a second `onResize` in the crop editor; anchor on the rotation
	// state that only the boot handler declares.
	const at = CLIENT.indexOf("let rotationTimer = 0;");
	assert.ok(at >= 0, "no rotation follow-up");
	const resize = CLIENT.slice(at, at + 1900);
	assert.match(resize, /let gestureWidth = window\.innerWidth;/, "the boot handler does not remember the width");
	assert.match(resize, /if \(window\.innerWidth !== gestureWidth\) \{[\s\S]{0,120}?resetGestures\(\);/, "a width change does not reset gestures");
	assert.match(resize, /const onOrientation = \(\) => \{[\s\S]{0,120}?resetGestures\(\);/, "a rotation does not reset gestures");
	assert.match(resize, /measureSafeArea\(\)/, "resize does not re-measure");
	assert.match(resize, /scheduleDecorate\(\)/, "resize does not redecorate");
	assert.match(resize, /rotationTimer = window\.setTimeout\(\(\) => \{[\s\S]{0,200}?measureSafeArea\(\);[\s\S]{0,100}?scheduleDecorate\(\);[\s\S]{0,80}?\}, 350\)/, "no follow-up pass for the late safe-area values");
	assert.match(CLIENT, /visualViewport\?\.addEventListener\("resize", onLayoutResize\)/, "the visual viewport is not watched");
	assert.doesNotMatch(CLIENT, /visualViewport\?\.addEventListener\("resize", onResize\)/, "visualViewport still empties the gesture");
	assert.match(CLIENT, /attributeFilter: \[[^\]]*"data-sidebar-collapsed"/, "drawer changes are not observed");
	assert.match(CLIENT, /attributeFilter: \[[^\]]*"data-rightbar-collapsed"/, "panel changes are not observed");
});

test("the right panel is only looked for inside its own subtree", () => {
	// A hidden route keeps a 0x0 copy of the collapse button; walking up from
	// it without a boundary tagged the app frame as the panel, which then hid
	// the header and the drawer button with no way back on a phone.
	assert.match(CLIENT, /const RIGHT_PANEL_ROOT = "\[data-sidebar-right-panel\]"/, "no boundary");
	assert.match(functionHead("visibleCollapseButton", 900), /rect\.width <= 0 \|\| rect\.height <= 0/, "the 0x0 ghost is not skipped");
	assert.match(CLIENT, /const boundary = collapse\.closest\(RIGHT_PANEL_ROOT\)/, "the walk is not bounded");
	assert.match(CLIENT, /while \(node !== null && node !== boundary && node !== document\.body\)/, "the walk ignores the boundary");
	assert.match(functionHead("forgetRightPanel", 700), /querySelectorAll\("\[data-rdsh-rightpanel\]"\)/, "stale panel tags are kept");
	assert.match(CLIENT, /host\.closest\("\[hidden\]"\) === null/, "a hidden panel still counts as open");
});

test("a finger drag in the terminal becomes a wheel event", () => {
	// The bundled xterm 6.0 scrolls only on wheel events (there is no DOM
	// scroller), so this bridge is the whole fix; CSS can only get out of its
	// way.
	assert.match(CLIENT, /const XTERM_SCROLLER = "\.xterm-scrollable-element"/, "the scroller node is not named");
	assert.match(CLIENT, /wheel\.deltaMode = 0/, "the wheel delta is not pixel mode");
	assert.match(CLIENT, /wheel\.deltaY = -pixels \* TERMINAL_WHEEL_PER_PX/, "the wheel delta is not derived from the drag");
	assert.match(CLIENT, /function onTouchMove\(event\) \{\s*\n\s*if \(moveTerminalDrag\(event\)\) return;/, "the bridge does not own the gesture");
	assert.match(CLIENT, /function onTouchStart\(event\) \{\s*\n\s*startTerminalDrag\(event\);/, "no drag start");
	assert.match(CLIENT, /function onEdgeSwipeEnd\(\) \{\s*\n\s*edgeSwipe = null;\s*\n\s*endTerminalDrag\(\);/, "the drag outlives the gesture");
	// ...and the overscroll guard must stop cancelling the drags the bridge wants.
	assert.match(CLIENT, /target\.closest\("textarea, input, \.xterm"\)\) return;/, "the overscroll guard still cancels terminal drags");
	assert.match(CLIENT, /target\.closest\("input, textarea, \[contenteditable=true\], \.xterm/, "the back-swipe still claims terminal drags");
});

test("the right panel keeps upstream tab dimensions but its tap replay", () => {
	assert.match(functionHead("decorateRightPanelTabs", 600), /querySelectorAll\('\[data-rdsh-rightpanel\] \[role="tab"\]\[data-dockkit-tab\]'\)/, "the tab selector is not attribute-based");
	assert.match(functionHead("decorateRightPanelTabs", 600), /tab\.setAttribute\("data-rdsh-rtab", ""\)/, "the tab hook is never written");
	// A tap the app turned into a drag never produces a click; replay one.
	assert.match(CLIENT, /tabReplayTimer = window\.setTimeout\(\(\) => \{[\s\S]{0,500}?tabTap\.tab\.dispatchEvent\(new MouseEvent\("click"/, "no tap replay");
	assert.match(CLIENT, /if \(tabTap\.fired \|\| !tabTap\.tab\.isConnected\) return;/, "the replay is not one-shot");
	assert.match(CLIENT, /target\.closest\("\[data-rdsh-rtab\]"\) === tabCandidate\.tab\) tabCandidate\.fired = true;/, "a real click does not cancel the replay");
	// The merged build enlarged the strip (44px rows, min-width 88px, pan-x,
	// selected-only close). The reference leaves the upstream dimensions.
	assert.doesNotMatch(CLIENT, /\[data-rdsh-rightpanel\] \[data-dockkit-tab\] \{\s*\n\s*height: 44px/, "the 44px tab row is still applied");
	assert.doesNotMatch(CLIENT, /\[data-rdsh-rightpanel\] \[data-dockkit-tab\] \{[^}]*min-width: 88px/, "the widened tab minimum is still applied");
	assert.doesNotMatch(CLIENT, /data-dockkit-strip-tabs\] \{\s*\n\s*touch-action: pan-x/, "the tab strip is still forced to pan-x");
	assert.doesNotMatch(CLIENT, /data-dockkit-tab-close\] \{ display: none !important; \}/, "the upstream hover close is still suppressed");
});

import { COPY, PROBES, copyFor } from "../lib/copy.js";
/** Files that render or serve UI copy. `lib/copy.js` is the only exception. */
const UI_FILES = ["client.js", "index.js", "sw.js", "notify/host.js"];

/** CJK kana, ideographs and compatibility ideographs. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Extract every string and template literal, skipping comments.
 *
 * Regex literals are deliberately not collected: the one CJK literal left in
 * `client.js` is a punctuation character class used to pace the title typing
 * animation, not copy. Everything a user can read must be a string.
 */
function stringLiterals(source) {
	const literals = [];
	let index = 0;
	while (index < source.length) {
		const character = source[index];
		if (character === "/" && source[index + 1] === "/") {
			const newline = source.indexOf("\n", index);
			index = newline === -1 ? source.length : newline;
			continue;
		}
		if (character === "/" && source[index + 1] === "*") {
			const end = source.indexOf("*/", index + 2);
			index = end === -1 ? source.length : end + 2;
			continue;
		}
		if (character !== '"' && character !== "'" && character !== "`") {
			index += 1;
			continue;
		}
		const quote = character;
		let text = "";
		index += 1;
		while (index < source.length) {
			if (source[index] === "\\") {
				text += source.slice(index, index + 2);
				index += 2;
				continue;
			}
			if (source[index] === quote) {
				index += 1;
				break;
			}
			text += source[index];
			index += 1;
		}
		literals.push(text);
	}
	return literals;
}



test("no UI copy carries CJK outside the dictionary", () => {
	// The original bug: Japanese literals shipped in a shell that renders in
	// English. Copy now lives in lib/copy.js; a CJK string anywhere else is a
	// regression, whatever the reason. The one exception is index.js's
	// DEFAULTS.description: it is the legacy ja default kept for direct
	// readers of DEFAULTS, while the effective description comes from
	// lib/copy.js for the configured language.
	const allowed = new Set(["index.js: DeepSeek Harness をアプリのように起動します。"]);
	const offenders = [];
	for (const file of UI_FILES) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const literal of stringLiterals(source)) {
			if (CJK.test(literal) && !allowed.has(`${file}: ${literal}`)) offenders.push(`${file}: ${literal.slice(0, 60)}`);
		}
	}
	assert.deepEqual(offenders, [], "a string literal outside lib/copy.js contains CJK");
});

test("every t() key exists in the English dictionary", () => {
	const keys = new Set([...CLIENT.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1]));
	assert.ok(keys.size > 50, "the client uses the dictionary for its UI");
	const missing = [...keys].filter((key) => !(key in COPY.en));
	assert.deepEqual(missing, [], "a t() key has no English string");
});

test("the English dictionary has no CJK and no empty strings", () => {
	const empty = Object.entries(COPY.en).filter(([, value]) => typeof value !== "string" || value === "");
	assert.deepEqual(empty, [], "English keys carry a string");
	const cjk = Object.entries(COPY.en).filter(([, value]) => CJK.test(value));
	assert.deepEqual(cjk, [], "English copy is English");
});

test("the Japanese pack covers every English key with real copy", () => {
	// The reference copy is restored: no key may fall back to English and no
	// pack may invent a key the code never renders.
	const unknown = Object.keys(COPY.ja).filter((key) => !(key in COPY.en));
	assert.deepEqual(unknown, [], "the ja pack carries an unknown key");
	const missing = Object.keys(COPY.en).filter((key) => !(key in COPY.ja));
	assert.deepEqual(missing, [], "the ja pack is missing keys");
	const empty = Object.entries(COPY.ja).filter(([, value]) => typeof value !== "string" || value === "");
	assert.deepEqual(empty, [], "a ja key is empty");
	const samePlaceholders = Object.keys(COPY.en).filter((key) => {
		const names = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join(",");
		return names(COPY.en[key]) !== names(COPY.ja[key]);
	});
	assert.deepEqual(samePlaceholders, [], "a ja string changes a placeholder");
	assert.equal(copyFor("ja")["tab.mobile"], "モバイル", "the ja pack is not used");
	assert.equal(copyFor("xx")["tab.mobile"], COPY.en["tab.mobile"], "an unknown language falls back to English");
});

test("upstream label probes cover English and Japanese", () => {
	// These are never rendered: they are how decoration finds the shell's
	// controls. A single-language probe would silently stop matching if the
	// shell's locale changed, so every known locale stays listed.
	for (const key of ["actions", "stop", "settingsMenu", "untitled"]) {
		assert.ok(Array.isArray(PROBES[key]) && PROBES[key].length >= 2, `${key} is bilingual`);
	}
	assert.ok(PROBES.untitled.includes("new session"));
	assert.ok(PROBES.untitled.includes("新しいセッション"));
});

test("representative Japanese copy matches the reference wording", () => {
	// Not just pack self-consistency: these are the strings a user sees. A
	// mistranslation or an accidental English fallback has to fail here.
	const expected = {
		"tab.pwa": "アプリ",
		"tab.mobile": "モバイル",
		"tab.input": "入力",
		"pwa.section.title": "アプリ（PWA）",
		"mux.fab.open": "セッション一覧を開く",
		"mux.fab.openWithCount": "セッション一覧を開く（未読・質問待ち {count}件）",
		// The row's visible name is part of the reference: it stays "Settings"
		// in the ja pack (the settings tab labels are Japanese, this row is not).
		"mux.settingsRow": "Settings",
		"add.label": "画像やファイルを追加",
		"crop.title": "画像をトリミング",
		"crop.cancel": "キャンセル",
		"crop.save": "クエリに追加",
		"frame.menu": "色枠",
		"sessionId.label": "セッションIDをコピー",
		"notify.turn.completed": "作業完了",
		"notify.questionHeader": "確認",
		"notify.previewQuestion": "このまま進めますか？",
		"sw.offlineHeading": "オフラインです",
		"sw.retry": "再試行",
		"mux.diag.height.title": "画面の高さ",
		"mux.diag.scroll.title": "スクロール",
		"mux.diag.scroll.last": "最後にスクロールした要素",
		// Mixed Japanese/English reference: the turn counter stays English.
		"mux.stats.turn": "{count} turn",
		"mux.stats.turns": "{count} turns",
		// The stats usage line and the detail popover headings stay English too.
		"mux.stats.cacheHit": "Cache hit {percent}%",
		"mux.detail.goal": "Goal",
	};
	for (const [key, value] of Object.entries(expected)) {
		assert.equal(copyFor("ja")[key], value, `${key} does not match the reference Japanese`);
	}
	assert.equal(copyFor("en")["tab.mobile"], "Mobile");
	assert.equal(copyFor("en")["mux.diag.height.title"], "Screen height");
	assert.equal(copyFor("en")["mux.diag.scroll.title"], "Scroll");
});

test("the scrollable scan only runs while the settings card renders", () => {
	// `scrollables()` walks every element, so it must not sit on a
	// decorate/mutation path. The scroll *recorder* is event-driven; the full
	// scan is only the Settings card (and the diagnostics callers).
	const calls = [...CLIENT.matchAll(/scrollables\(\)/g)]
		.filter((match) => !CLIENT.slice(0, match.index).endsWith("function "));
	assert.equal(calls.length, 1, "the full scan is running outside the settings card");
	const start = CLIENT.indexOf("function MobileSection(");
	const end = CLIENT.indexOf("function InputSection(", start);
	assert.ok(start >= 0 && end > start, "MobileSection is missing");
	assert.match(CLIENT.slice(start, end), /scrollables\(\)\.slice\(0, 8\)/, "the settings card stopped showing the scan");
	assert.match(CLIENT, /document\.addEventListener\("scroll", recordScroll, true\)/, "scroll records are no longer event-driven");
	assert.doesNotMatch(helperBody("decorateSlow"), /scrollables/, "the scan joined the slow decorate pass");
});

test("a right-panel swipe closes it even from the left edge", () => {
	// The reference checks `panelOpen && !drawerOpen` before the edge rules,
	// so a rightward swipe from inside the left 36px closes the preview
	// instead of stacking the session drawer on top of it.
	const body = helperBody("onEdgeSwipeStart");
	assert.match(body, /if \(panelOpen && !drawerOpen\) \{/, "the panel close branch is not first");
	assert.equal(/panelOpen && !drawerOpen && touch\.clientX > 36/.test(body), false, "the left edge still opens the drawer over the panel");
	assert.match(body, /closesPanel: true/, "the panel gesture is not marked");
	assert.match(body, /scrolledLeftAncestor\(target\) !== null/, "the horizontal-scroll exclusion is gone");
	assert.match(body, /target\.closest\("input, textarea, \[contenteditable=true\], \.xterm/, "the input/xterm exclusion is gone");
});

test("the reference viewport zoom lock is restored", () => {
	assert.match(
		CLIENT,
		/const content = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";/,
		"the fixed viewport string is gone",
	);
	assert.match(CLIENT, /if \(meta\.getAttribute\("content"\) !== content\) meta\.setAttribute\("content", content\);/, "the viewport is not applied");
	assert.match(CLIENT, /input, textarea, \[contenteditable="true"\] \{\s*\n\s*font-size: 16px !important;/, "the 16px focus guard is gone");
});

test("ensureRightPanelFits is restored and cannot loop or click a ghost", () => {
	const ensure = helperBody("ensureRightPanelFits");
	assert.match(ensure, /if \(!narrow\(\)\)/, "the promotion is not phone-scoped");
	assert.match(ensure, /visibleFullscreenButton\(\)/, "the button is not resolved through the visibility guard");
	assert.match(ensure, /rightPanelFitPending/, "there is no one-shot guard");
	assert.match(ensure, /data-rdsh-auto-fired/, "the same button can be clicked repeatedly");
	const visible = helperBody("visibleFullscreenButton");
	assert.match(visible, /rect\.width <= 0 \|\| rect\.height <= 0/, "a 0x0 ghost is accepted");
	assert.match(visible, /closest\(RIGHT_PANEL_ROOT\) === null/, "a button outside the panel is accepted");
	assert.match(visible, /closest\("\[hidden\]"\) !== null/, "a hidden panel is accepted");
	assert.match(visible, /visibility === "hidden"/, "a hidden button is accepted");
	assert.match(helperBody("decorateSlow"), /ensureRightPanelFits\(\)/, "the slow pass never calls it");
});

test("the restored diagnostics expose the scroll hooks and cards", () => {
	const api = CLIENT.slice(CLIENT.indexOf("globalThis.__RDSH_MOBILE_UX__ = {"));
	assert.match(api, /get lastScrolls\(\) \{ return \[\.\.\.lastScrolls\]; \}/, "lastScrolls is missing");
	assert.match(api, /scrollables,/, "scrollables is missing");
	assert.match(api, /scrollChain,/, "scrollChain is missing");
	assert.match(api, /readViewportMetrics,/, "viewport metrics are missing");
	const start = CLIENT.indexOf("function MobileSection(");
	const end = CLIENT.indexOf("function InputSection(", start);
	const section = CLIENT.slice(start, end);
	assert.match(section, /t\("mux\.diag\.height\.title"\)/, "the screen-height card is missing");
	assert.match(section, /t\("mux\.diag\.scroll\.title"\)/, "the scroll card is missing");
	assert.match(section, /lastScrolls\.slice\(-6\)\.reverse\(\)/, "the last-scroll list is missing");
	assert.match(section, /scrollables\(\)\.slice\(0, 8\)/, "the scrollable list is missing");
});

/**
 * Shipped code files: the entries in package.json's `files` that carry source.
 * Tests are deliberately not listed, so this regression never scans itself.
 */
function shippedCodeFiles() {
	const root = new URL("../", import.meta.url);
	const files = ["index.js", "client.js", "sw.js", "cordis.patch.yml"].map((name) => new URL(name, root));
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
			if (entry.isDirectory()) walk(child);
			else if (/\.(?:js|mjs|json|ya?ml)$/.test(entry.name)) files.push(child);
		}
	};
	walk(new URL("notify/", root));
	walk(new URL("lib/", root));
	return files;
}

test("shipped code carries no personal provider or device identifiers", () => {
	// The reference UI is generic: no operator-specific provider name, account
	// path, or device/host label may reach copy that every install renders.
	// Tests are excluded by shippedCodeFiles(), so this only guards shipped code.
	const personal = new RegExp(
		[
			// a concrete account's home directory: /home/<user>, /Users/<user>
			String.raw`\/(?:home|Users)\/[A-Za-z0-9._-]+`,
			// desktop-style host labels: a short alphabetic prefix plus three
			// digits. Longer digit runs collide with standards and escapes, and
			// codec names share this shape without being identifiers.
			String.raw`(?<![\\#])\b(?!h26[45]\b|x26[45]\b)[a-z]{1,2}\d{3}\b`,
			// RFC 1918 private and Tailscale CGNAT IPv4 literals
			String.raw`\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b`,
			String.raw`\b192\.168\.\d{1,3}\.\d{1,3}\b`,
			String.raw`\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b`,
			String.raw`\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b`,
		].join("|"),
	);
	const detects = (sample) => personal.test(sample);
	for (const sample of [
		"/home/example/app",
		"/Users/example/app",
		"pc123-desktop",
		"10.1.2.3",
		"172.20.3.4",
		"192.168.1.20",
		"100.101.102.103",
	]) {
		assert.ok(detects(sample), `the identifier shape ${sample} is not detected`);
	}
	for (const sample of ["icon-192", "sha256", "h264", "#ef4444", "p1363"]) {
		assert.ok(!detects(sample), `the generic token ${sample} is a false positive`);
	}
	const offenders = [];
	for (const file of shippedCodeFiles()) {
		const text = readFileSync(file, "utf8");
		const match = text.match(personal);
		if (match !== null) offenders.push(`${file.pathname}: ${match[0]}`);
	}
	assert.deepEqual(offenders, [], "a shipped file contains a personal provider or device identifier");
});

test("the question card viewport sizing is phone-only", () => {
	// Desktop must keep the upstream card width: the new 100vw - 32px rule is
	// inside the narrow media block, so no >=768px rule changes.
	const rules = cssBlocks().flatMap((css) => cssRules(css));
	const frame = rules.find((rule) => rule.head === "[data-rdsh-question-frame]");
	const card = rules.find((rule) => rule.head === "[data-rdsh-question-frame] > [data-rdsh-question-card]");
	assert.ok(frame, "the question frame rule is missing");
	assert.ok(card, "the question card rule is missing");
	for (const rule of [frame, card]) {
		assert.ok(rule.at.some((head) => /max-width:\s*767px/.test(head)), `${rule.head} is outside the phone query`);
	}
});

test("the queue dock meets the composer and the preview never covers it", () => {
	// Phone-only: the dock is as wide as the composer card, pulled flush to its
	// top edge, with square bottom corners. The preview is fixed and height
	// capped so a long queued text scrolls above the composer.
	assert.match(CLIENT, /\[data-rdsh-queue-dock\] \{[^}]*width: calc\(100% - 32px\) !important;[^}]*margin-bottom: -6px !important;/, "the queue dock is not attached to the composer");
	assert.match(CLIENT, /\[data-rdsh-queue-panel\] \{[^}]*border-bottom-left-radius: 0 !important;[^}]*border-bottom-right-radius: 0 !important;/, "the queue panel keeps floating bottom corners");
	assert.match(CLIENT, /\.rdsh-mux-queue-preview \{[^}]*position: fixed;[^}]*max-height: min\(50vh, 360px\);[^}]*overflow-y: auto;/, "the queued text preview is not a capped overlay");
	assert.match(CLIENT, /\.rdsh-mux-queue-menu \{[^}]*position: fixed;/, "the long-press menu is not an overlay");
	const rules = cssBlocks().flatMap((css) => cssRules(css));
	for (const head of ["[data-rdsh-queue-dock]", "[data-rdsh-queue-panel]", ".rdsh-mux-queue-preview", ".rdsh-mux-queue-menu"]) {
		const rule = rules.find((entry) => entry.head === head);
		assert.ok(rule, `${head} is missing`);
		assert.ok(rule.at.some((media) => /max-width:\s*767px/.test(media)), `${head} is outside the phone query`);
	}
});

test("the workspace picker caps its list and keeps Add workspace outside it", () => {
	assert.match(CLIENT, /\[data-rdsh-workspace-menu\] \{[^}]*max-height: min\(70vh, 520px\) !important;/, "the workspace menu is not height-bounded");
	assert.match(CLIENT, /\[data-rdsh-workspace-menu\] \[data-rdsh-workspace-viewport\] \{[^}]*max-height: min\(40vh, 320px\) !important;[^}]*overflow-y: auto !important;/, "the workspace list is not the scroll viewport");
	assert.match(CLIENT, /\[data-rdsh-workspace-menu\] \[data-rdsh-workspace-hidden\] \{ display: none !important; \}/, "filtered rows are still visible");
	assert.match(CLIENT, /\.rdsh-mux-workspace-search input \{[^}]*font-size: 16px;/, "the search field can trigger iOS zoom");
	assert.match(CLIENT, /\.rdsh-mux-workspace-empty \{[^}]*font-size: 13px;/, "the no-match row has no style");
	const rules = cssBlocks().flatMap((css) => cssRules(css));
	for (const head of ["[data-rdsh-workspace-menu]", "[data-rdsh-workspace-menu] [data-rdsh-workspace-viewport]", ".rdsh-mux-workspace-search", ".rdsh-mux-workspace-empty"]) {
		const rule = rules.find((entry) => entry.head === head);
		assert.ok(rule, `${head} is missing`);
		assert.ok(rule.at.some((media) => /max-width:\s*767px/.test(media)), `${head} is outside the phone query`);
	}
});
