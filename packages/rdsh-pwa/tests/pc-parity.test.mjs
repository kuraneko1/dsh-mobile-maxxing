/**
 * Static checks for the restored phone/desktop split.
 *
 * The legacy contract is width-only: at 767px or below the phone UI (hide
 * list, settings tab merge, Enter, attachment hijack, push owner) applies even
 * with a mouse. A wide window keeps the stock UI, and the desktop notification
 * opt-in stays an opt-in. These checks pin the decision points.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const HOST = readFileSync(new URL("../notify/host.js", import.meta.url), "utf8");

/** One top-level helper, from its declaration to its closing brace. */
function functionBody(name) {
	const start = CLIENT.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} exists`);
	const close = CLIENT.indexOf("\n    }\n", start);
	return CLIENT.slice(start, close === -1 ? undefined : close);
}

/** The lines of one `const NAME = [ ... ];` array literal. */
function arrayLiteral(name) {
	const start = CLIENT.indexOf(`const ${name} = [`);
	assert.notEqual(start, -1, `${name} exists`);
	const end = CLIENT.indexOf("];", start);
	return CLIENT.slice(start, end === -1 ? undefined : end);
}

test("hiding is decided by the phone width, not by the pointer", () => {
	// The reference plugin hid the list whenever the window was <=767px,
	// including a narrow desktop window driven by a mouse.
	const body = functionBody("applyHideList");
	assert.match(body, /const hideOnThisDevice = !disabled && narrow\(\);/, "the hide decision ignores the width");
	assert.match(body, /if \(hideOnThisDevice && shouldHide\(label, labels\)\)/, "buttons are hidden without asking the width");
	assert.match(body, /modal !== null && narrow\(\)/, "the PWA/Input tab merge no longer follows the phone layout");
	assert.doesNotMatch(body, /!disabled && phone\(\)/, "the hide list became device-gated again");
});

test("the hide-settings attribute follows the phone width", () => {
	assert.match(CLIENT, /const onPhone = phone\(\);/, "decorateFast does not ask the device");
	assert.match(
		CLIENT,
		/document\.documentElement\.toggleAttribute\("data-rdsh-hide-settings", !hideListDisabled && narrow\(\)\);/,
		"the settings-hiding attribute is not width-gated",
	);
	assert.match(CLIENT, /html\[data-rdsh-hide-settings\] \[data-rdsh-setting-hidden\]/);
});

test("label rewrites and the plus hijack follow phone()", () => {
	// `phone()` is the width rule, so a narrow fine pointer still gets the
	// phone UI while a wide window (mouse or touch) keeps the stock one.
	assert.match(functionBody("phone"), /return narrow\(\);/, "phone() is not the width rule");
	const sidebar = functionBody("decorateSidebarSettingsRow");
	assert.match(sidebar, /if \(!phone\(\)\) \{/, "the sidebar Settings row is not phone-gated");
	assert.match(sidebar, /removeAttribute\("data-rdsh-more-row"\)/, "leaving the phone layout leaves the account row hidden");
	assert.match(functionBody("decorateComposer"), /if \(phone\(\)\) \{/, "the composer label is not phone-gated");
	assert.match(functionBody("onMouseDownCapture"), /if \(!phone\(\)\) return;/, "the mousedown guard is not phone-gated");
	assert.match(functionBody("onClickCapture"), /addButtonOf\(target\) !== null && phone\(\)/, "the + hijack is not phone-gated");
});

test("the reference 13-label hide list is restored", () => {
	const defaults = arrayLiteral("HIDE_DEFAULT");
	for (const label of [
		"Open in Files",
		"More ways to open",
		"More actions",
		"Feedback",
		"Sign in",
		"Keyboard shortcuts",
		"Desktop notifications",
		"Show coding view",
		"Built-in plugins",
		"Open in Text Editor",
		"Open in editor",
		"Open in Explorer",
		"Reveal in Finder",
	]) {
		assert.equal(defaults.includes(`"${label}"`), true, `${label} is missing from the hide list`);
	}
	assert.match(defaults, /"Open configuration file"/, "the merged-build addition was dropped");
});

test("the mobile tab only inlines the other sections at phone width", () => {
	const body = functionBody("MobileSection");
	assert.match(body, /const onPhone = s\.phone === true;/, "the section still keys off the device");
	assert.match(body, /s\.narrow && onPhone \? h\(InputSection\) : null/, "InputSection is not inlined at phone width");
	assert.match(
		body,
		/s\.narrow && onPhone && typeof globalThis\.__RDSH_PWA_SETTINGS_SECTION__ === "function"/,
		"the PWA section is not inlined at phone width",
	);
	assert.match(CLIENT, /id: "pwa",/, "the App tab is gone");
	assert.match(CLIENT, /id: "mobile-ux-input",/, "the Input tab is gone");
});

test("the phone-only settings cards follow the phone layout", () => {
	const body = functionBody("MobileSection");
	assert.match(body, /onPhone \? t\("mux\.section\.desc"\) : t\("mux\.section\.desc\.desktop"\)/, "the desktop description is missing");
	assert.match(body, /onPhone \? h\("p", \{ className: "rdsh-mux-note" \}, t\("mux\.section\.plusNote"\)\) : null/, "the + note is shown on a desktop");
	assert.match(body, /onPhone\s*\n\s*\? h\(/, "the hidden-controls card is not gated on the device");
	assert.match(body, /t\("mux\.hidden\.title"\)/, "the hidden-controls card disappeared entirely");
});

test("a wide desktop stays stock unless it opts into phone notifications", () => {
	assert.match(HOST, /onlyMobileTurns: true/, "the host default must stay phone-only");
	assert.match(CLIENT, /const NOTIFY_DEVICE_TURNS_KEY = "rdsh-mobile-ux:notify-device-turns";/);
	assert.match(functionBody("readNotifyDeviceTurns"), /NOTIFY_DEVICE_TURNS_KEY/);
	const mark = functionBody("markMobileSession");
	assert.match(mark, /if \(!phone\(\) && !notifyDeviceTurns\(\)\) return;/, "markMobileSession ignores the opt-in");
	assert.match(functionBody("onKeyDownCapture"), /const finger = phone\(\);/, "Enter no longer follows the phone width");
	assert.match(functionBody("onKeyDownCapture"), /if \(!finger && !notifyDeviceTurns\(\)\) return;/, "Enter ignores the desktop opt-in");
	assert.match(functionBody("onClickCapture"), /if \(phone\(\) \|\| notifyDeviceTurns\(\)\)/, "button sends are not marked on a desktop");
	assert.match(functionBody("MobileSection"), /writeNotifyDeviceTurns\(event\.target\.checked\)/, "the setting has no control");
});
