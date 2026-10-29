import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf("    function installAndroidBack("), source.indexOf("    /** Read `?session=` once"));
assert.ok(code.startsWith("    function installAndroidBack(") && code.length < 6000);

function fixture({ android = true, standalone = true, active = true, initial = null, asyncStart = false } = {}) {
  let view = "session", blocked = false, draft = "", attachment = false, drawer = false, route = false;
  let starts = 0, closes = 0, routeBacks = 0, observer, dispose, timer;
  const listeners = new Map(), entries = [initial]; let index = 0;
  const history = {
    get state() { return entries[index]; },
    pushState(state) { entries.splice(++index); entries.push(state); },
    back() { if (index > 0) { index--; listeners.get("popstate")?.({ state: entries[index] }); } },
    forward() { if (index + 1 < entries.length) { index++; listeners.get("popstate")?.({ state: entries[index] }); } },
  };
  const document = {
    body: {}, documentElement: { getAttribute: () => drawer ? "open" : "closed" },
    querySelector(selector) {
      if (selector === "header[data-window-drag]") return { className: view === "blank" ? "_headerBlank" : "_header" };
      if (selector.startsWith('[role="dialog"]')) return blocked ? {} : null;
      if (selector.includes('[class*="_rail"]')) return attachment ? {} : null;
      if (selector.includes('contenteditable')) return { textContent: draft };
      return null;
    },
    querySelectorAll: () => [],
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
  };
  const window = { matchMedia: () => ({ matches: standalone }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) };
  const context = { window, document, history, location: { href: "https://example.test/" }, navigator: { userAgent: android ? "Android" : "iPhone", userActivation: { hasBeenActive: active } },
    setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout: () => { timer = null; },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
    shownSessionId: () => view === "session" ? "s" : "", closeDrawer: () => { drawer = false; closes++; }, pressRouteBack: () => { if (!route) return false; routeBacks++; route = false; return true; } };
  const install = vm.runInNewContext(code + "\ninstallAndroidBack", context);
  install({ effect(fn) { dispose = fn(); } }, { startSession() { starts++; if (!asyncStart) view = "blank"; } });
  return { history, listeners, sync: () => observer?.(), timeout: () => timer?.(), dispose: () => dispose?.(), get starts() { return starts; }, get closes() { return closes; }, get routeBacks() { return routeBacks; }, set view(v) { view = v; }, set blocked(v) { blocked = v; }, set draft(v) { draft = v; }, set attachment(v) { attachment = v; }, set drawer(v) { drawer = v; }, set route(v) { route = v; } };
}

test("Android standalone: session back to blank, next back is native", () => {
  const f = fixture(); assert.equal(f.history.state.__dshMobileAndroidBack, true);
  f.history.back(); assert.equal(f.starts, 1); assert.equal(f.history.state, null);
  f.sync(); f.history.back(); assert.equal(f.starts, 1);
});
test("other devices and ordinary tabs do not touch history", () => {
  for (const options of [{ android: false }, { standalone: false }]) {
    const f = fixture(options); assert.equal(f.history.state, null); assert.equal(f.listeners.size, 0);
  }
});
test("existing New removes sentinel; forward does not reopen session", () => {
  const f = fixture(); f.view = "blank"; f.sync(); assert.equal(f.history.state, null);
  f.history.forward(); assert.equal(f.history.state, null); assert.equal(f.starts, 0);
});
test("dialog and attachment are not discarded", () => {
  for (const key of ["blocked", "attachment"]) {
    const f = fixture(); f[key] = key === "draft" ? "unsent" : true; f.history.back();
    assert.equal(f.starts, 0, key); assert.equal(f.history.state.__dshMobileAndroidBack, true);
  }
});
test("drawer and existing route get priority", () => {
  const f = fixture(); f.drawer = true; f.history.back(); assert.equal(f.closes, 1); assert.equal(f.starts, 0);
  f.route = true; f.history.back(); assert.equal(f.routeBacks, 1); assert.equal(f.starts, 0);
  f.history.back(); assert.equal(f.starts, 1);
});
test("reload adopts an owned entry without duplication; dispose detaches listeners", () => {
  const f = fixture({ initial: { __dshMobileAndroidBack: true } }); assert.equal(f.history.state.__dshMobileAndroidBack, true);
  f.dispose(); assert.equal(f.listeners.size, 0);
});
test("restored session waits for user activation", () => {
  const f = fixture({ active: false }); assert.equal(f.history.state, null);
  f.listeners.get("pointerdown")({ isTrusted: false }); assert.equal(f.history.state, null);
  f.listeners.get("pointerdown")({ isTrusted: true }); assert.equal(f.history.state.__dshMobileAndroidBack, true);
});
test("async transition does not rearm on intervening mutations and recovers on failure", () => {
  const f = fixture({ asyncStart: true }); f.history.back(); f.sync(); assert.equal(f.history.state, null);
  f.timeout(); assert.equal(f.history.state.__dshMobileAndroidBack, true);
});
test("async successful transition leaves no extra history", () => {
  const f = fixture({ asyncStart: true }); f.history.back(); f.sync(); f.view = "blank"; f.sync();
  assert.equal(f.history.state, null); f.timeout(); assert.equal(f.history.state, null);
});
test("existing object history state is retained; unsupported states are untouched", () => {
  const f = fixture({ initial: { router: "kept" } }); assert.equal(f.history.state.router, "kept");
  f.history.back(); assert.equal(f.history.state.router, "kept");
  const primitive = fixture({ initial: "other" }); assert.equal(primitive.history.state, "other");
});
