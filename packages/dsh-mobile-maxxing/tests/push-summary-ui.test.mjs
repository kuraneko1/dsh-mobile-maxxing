import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { COPY, PROBES } from "../lib/copy.js";

const CLIENT = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const SUMMARY_KEYS = [
	"mux.summary.title",
	"mux.summary.desc",
	"mux.summary.label",
	"mux.summary.off",
	"mux.summary.loading",
	"mux.summary.saving",
	"mux.summary.saved",
	"mux.summary.savedOff",
	"mux.summary.saveFailed",
	"mux.summary.loadFailed",
	"mux.summary.unavailable",
	"mux.summary.empty",
	"mux.summary.missingModel",
];

function stub(depth = 0) {
	const value = function stubbed() {
		return depth > 4 ? undefined : stub(depth + 1);
	};
	return new Proxy(value, {
		get(_target, key) {
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

function createElementStub() {
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
		replaceChildren() {},
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

function createMemoryStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)); },
		removeItem: (key) => { map.delete(key); },
		clear: () => map.clear(),
		key: (index) => [...map.keys()][index] ?? null,
		get length() { return map.size; },
	};
}

function createReactHarness() {
	const Fragment = Symbol("Fragment");
	const instances = new Map();
	let activeInstance = null;
	let hookCursor = 0;
	let mountedRoot = null;
	let mountedTree = null;
	let renderScheduled = false;
	let unmounted = false;
	const pendingEffects = [];

	function flattenChildren(rawChildren) {
		const out = [];
		const push = (item) => {
			if (item === null || item === undefined || typeof item === "boolean") return;
			if (Array.isArray(item)) {
				for (const child of item) push(child);
				return;
			}
			out.push(item);
		};
		for (const child of rawChildren) push(child);
		return out;
	}

	function createElement(type, props, ...rawChildren) {
		const normalizedProps = props ? { ...props } : {};
		const children = flattenChildren(rawChildren);
		if (children.length > 0) normalizedProps.children = children;
		return { type, props: normalizedProps, children };
	}

	function depsEqual(prev, next) {
		if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false;
		for (let index = 0; index < prev.length; index += 1) {
			if (!Object.is(prev[index], next[index])) return false;
		}
		return true;
	}

	function scheduleRender() {
		if (unmounted || renderScheduled || mountedRoot === null) return;
		renderScheduled = true;
		queueMicrotask(() => {
			renderScheduled = false;
			if (!unmounted && mountedRoot !== null) renderNow();
		});
	}

	function getInstance(path, component) {
		let instance = instances.get(path);
		if (!instance || instance.component !== component) {
			if (instance) cleanupInstance(instance);
			instance = { component, hooks: [], path };
			instances.set(path, instance);
		}
		return instance;
	}

	function cleanupInstance(instance) {
		for (const hook of instance.hooks) {
			if (hook && hook.kind === "effect" && typeof hook.cleanup === "function") {
				hook.cleanup();
				hook.cleanup = undefined;
			}
		}
	}

	function renderNode(vnode, path, seenPaths) {
		if (vnode === null || vnode === undefined || typeof vnode === "boolean") return null;
		if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
		if (Array.isArray(vnode)) {
			return vnode
				.map((item, index) => renderNode(item, `${path}.${index}`, seenPaths))
				.filter((item) => item !== null);
		}
		if (typeof vnode.type === "function") {
			seenPaths.add(path);
			const instance = getInstance(path, vnode.type);
			const prevInstance = activeInstance;
			const prevCursor = hookCursor;
			activeInstance = instance;
			hookCursor = 0;
			let rendered;
			try {
				rendered = vnode.type(vnode.props || {});
			} finally {
				activeInstance = prevInstance;
				hookCursor = prevCursor;
			}
			return renderNode(rendered, `${path}>0`, seenPaths);
		}
		if (vnode.type === Fragment) {
			return (vnode.children || [])
				.map((child, index) => renderNode(child, `${path}.${index}`, seenPaths))
				.filter((item) => item !== null);
		}
		const children = [];
		const rawChildren = vnode.children || [];
		for (let index = 0; index < rawChildren.length; index += 1) {
			const childTree = renderNode(rawChildren[index], `${path}.${index}`, seenPaths);
			if (Array.isArray(childTree)) children.push(...childTree);
			else if (childTree !== null) children.push(childTree);
		}
		return {
			type: vnode.type,
			props: vnode.props || {},
			children,
		};
	}

	function flushEffects() {
		while (pendingEffects.length > 0) {
			const { hook, fn } = pendingEffects.shift();
			if (unmounted) return;
			if (typeof hook.cleanup === "function") {
				hook.cleanup();
				hook.cleanup = undefined;
			}
			const cleanup = fn();
			if (typeof cleanup === "function") hook.cleanup = cleanup;
		}
	}

	function renderNow() {
		if (unmounted || mountedRoot === null) return null;
		const seenPaths = new Set();
		mountedTree = renderNode(createElement(mountedRoot.Component, mountedRoot.props), "0", seenPaths);
		for (const [path, instance] of [...instances.entries()]) {
			if (!seenPaths.has(path)) {
				cleanupInstance(instance);
				instances.delete(path);
			}
		}
		flushEffects();
		return mountedTree;
	}

	const React = {
		Fragment,
		createElement,
		memo(component) {
			return component;
		},
		useState(initial) {
			const instance = activeInstance;
			const index = hookCursor++;
			if (index >= instance.hooks.length) {
				const value = typeof initial === "function" ? initial() : initial;
				instance.hooks.push({ kind: "state", value });
			}
			const hook = instance.hooks[index];
			const setState = (update) => {
				if (unmounted) return;
				const next = typeof update === "function" ? update(hook.value) : update;
				if (!Object.is(next, hook.value)) {
					hook.value = next;
					scheduleRender();
				}
			};
			return [hook.value, setState];
		},
		useEffect(fn, deps) {
			const instance = activeInstance;
			const index = hookCursor++;
			const existing = instance.hooks[index];
			if (!existing) {
				const hook = { kind: "effect", deps, cleanup: undefined };
				instance.hooks[index] = hook;
				pendingEffects.push({ hook, fn });
				return;
			}
			if (deps === undefined || !depsEqual(existing.deps, deps)) {
				existing.deps = deps;
				pendingEffects.push({ hook: existing, fn });
			}
		},
		useRef(initial) {
			const instance = activeInstance;
			const index = hookCursor++;
			if (index >= instance.hooks.length) {
				instance.hooks.push({ kind: "ref", current: initial });
			}
			return instance.hooks[index];
		},
		useMemo(factory, deps) {
			const instance = activeInstance;
			const index = hookCursor++;
			const existing = instance.hooks[index];
			if (!existing || deps === undefined || !depsEqual(existing.deps, deps)) {
				const value = factory();
				instance.hooks[index] = { kind: "memo", value, deps };
				return value;
			}
			return existing.value;
		},
		useCallback(callback, deps) {
			return React.useMemo(() => callback, deps);
		},
	};

	return {
		React,
		mount(Component, props = {}) {
			unmounted = false;
			mountedRoot = { Component, props };
			renderNow();
			return mountedTree;
		},
		tree() {
			return mountedTree;
		},
		async flush() {
			for (let index = 0; index < 8; index += 1) {
				await new Promise((resolve) => setImmediate(resolve));
				if (renderScheduled) {
					renderScheduled = false;
					renderNow();
				}
			}
		},
		unmount() {
			unmounted = true;
			for (const instance of instances.values()) cleanupInstance(instance);
			instances.clear();
			pendingEffects.length = 0;
			mountedRoot = null;
			mountedTree = null;
		},
	};
}

function findNodes(node, predicate, out = []) {
	if (node === null || node === undefined || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) findNodes(item, predicate, out);
		return out;
	}
	if (predicate(node)) out.push(node);
	if (Array.isArray(node.children)) {
		for (const child of node.children) findNodes(child, predicate, out);
	}
	return out;
}

function textOf(node) {
	if (node === null || node === undefined) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	return (node.children || []).map(textOf).join("");
}

function makeJsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		async json() {
			return body;
		},
	};
}

function bootMobileSection({ lang = "en", fetchImpl }) {
	let definition;
	const disposers = [];
	const registeredSlots = new Map();
	const reactHarness = createReactHarness();
	const storage = createMemoryStorage();
	const silentLog = { error() {}, warn() {}, log() {}, info() {} };

	const sandbox = {
		__RDSH_PWA_PROBES__: PROBES,
		__RDSH_PWA_COPY__: COPY,
		__RDSH_PWA_LANG__: lang,
		__RDSH_DEVICE_MODE__: "mobile",
		window: {
			__ModuleLoader__: {
				load(value) {
					definition = value;
				},
			},
		},
		document: (() => {
			const doc = createElementStub();
			doc.baseURI = "http://localhost/";
			doc.visibilityState = "visible";
			doc.activeElement = null;
			doc.head = createElementStub();
			doc.body = createElementStub();
			doc.documentElement = createElementStub();
			doc.createElement = () => createElementStub();
			doc.styleSheets = [];
			return doc;
		})(),
		navigator: {
			userAgent: "Mozilla/5.0 (iPhone)",
			platform: "iPhone",
			maxTouchPoints: 5,
			onLine: true,
			serviceWorker: {
				controller: null,
				getRegistration: async () => null,
				ready: Promise.resolve(null),
			},
		},
		location: { origin: "http://localhost:3080", href: "http://localhost:3080/", pathname: "/", search: "", hash: "" },
		localStorage: storage,
		sessionStorage: createMemoryStorage(),
		matchMedia: (query) => ({
			matches: query.includes("max-width: 767px"),
			addEventListener() {},
			removeEventListener() {},
		}),
		addEventListener() {},
		removeEventListener() {},
		setTimeout: () => 0,
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
		console: silentLog,
		URL,
		URLSearchParams,
		Intl,
		TextEncoder,
		TextDecoder,
		AbortController,
		structuredClone,
		fetch: fetchImpl,
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
		Notification: { permission: "default" },
		AudioContext: class AudioContext {},
		screen: { width: 390, height: 844 },
		innerWidth: 390,
		innerHeight: 844,
		devicePixelRatio: 3,
		performance: { now: () => 0 },
		queueMicrotask,
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

	vm.createContext(sandbox);
	vm.runInContext(CLIENT, sandbox, { filename: "client.js" });
	assert.ok(definition !== undefined, "client.js registered module");

	const requireImpl = (name) => {
		if (name === "react") return reactHarness.React;
		if (name === "react-dom/client") return { createRoot: () => ({ render() {} }) };
		if (name === "react-dom") return { createPortal: (node) => node };
		return stub();
	};
	const plugin = definition.factory(requireImpl);
	const ctx = {
		effect(fn) {
			const dispose = fn();
			if (typeof dispose === "function") disposers.push(dispose);
			return typeof dispose === "function" ? dispose : () => {};
		},
		inject(_deps, callback) {
			return callback(ctx);
		},
		slots: {
			inject(_deps, callback) {
				return typeof callback === "function" ? callback() : undefined;
			},
			entries() {
				return undefined;
			},
			register(entry, component) {
				registeredSlots.set(entry.id, { entry, component });
				return () => {};
			},
		},
		get() {
			return undefined;
		},
		on() {
			return () => {};
		},
	};
	plugin.apply(ctx);

	const mobileSlot = registeredSlots.get("mobile-ux");
	assert.ok(mobileSlot && typeof mobileSlot.component === "function", "MobileSection is registered in settings.section");

	reactHarness.mount(mobileSlot.component, {});

	const summarySelect = () => {
		const selects = findNodes(
			reactHarness.tree(),
			(node) => node.type === "select" && node.props["aria-label"] === COPY[lang]["mux.summary.title"],
		);
		assert.equal(selects.length, 1, "expected exactly one summary model <select>");
		return selects[0];
	};

	const statusNotes = () =>
		findNodes(reactHarness.tree(), (node) => node.type === "p" && node.props.role === "status").map(textOf);

	return {
		reactHarness,
		summarySelect,
		statusNotes,
		cleanup() {
			reactHarness.unmount();
			for (const dispose of disposers.splice(0).reverse()) {
				try {
					dispose();
				} catch {
				}
			}
		},
	};
}

test("all mux.summary.* keys exist, are non-empty, and match placeholders in en and ja", () => {
	const placeholderNames = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
	for (const key of SUMMARY_KEYS) {
		assert.equal(typeof COPY.en[key], "string", `${key} missing from COPY.en`);
		assert.ok(COPY.en[key].trim().length > 0, `${key} empty in COPY.en`);
		assert.equal(typeof COPY.ja[key], "string", `${key} missing from COPY.ja`);
		assert.ok(COPY.ja[key].trim().length > 0, `${key} empty in COPY.ja`);
		assert.deepEqual(placeholderNames(COPY.en[key]), placeholderNames(COPY.ja[key]), `${key} placeholder mismatch`);
	}
});

test("MobileSection fetches summary-model on mount, renders optgroups/options with / and :, and selects saved model", async () => {
	const requests = [];
	let resolveGet;
	const getPromise = new Promise((resolve) => {
		resolveGet = resolve;
	});

	const app = bootMobileSection({
		lang: "en",
		fetchImpl(url, options = {}) {
			requests.push({ url: String(url), options });
			if (String(url).endsWith("/summary-model")) return getPromise;
			return Promise.resolve(makeJsonResponse({ ok: true }));
		},
	});

	try {
		const loadingSelect = app.summarySelect();
		assert.equal(loadingSelect.props.disabled, true);
		assert.ok(app.statusNotes().includes(COPY.en["mux.summary.loading"]));

		const getCall = requests.find((entry) => entry.url === "api/dsh-mobile-maxxing/push/summary-model");
		assert.ok(getCall, "expected GET summary-model call on mount");
		assert.equal(getCall.options.cache, "no-store");

		resolveGet(makeJsonResponse({
			ok: true,
			available: true,
			selection: { mode: "model", provider: "openrouter", model: "anthropic/claude-3.7-sonnet:thinking" },
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }],
				},
				{
					id: "openrouter",
					name: "OpenRouter",
					models: [{ provider: "openrouter", id: "anthropic/claude-3.7-sonnet:thinking", name: "Claude 3.7 Sonnet" }],
				},
			],
		}));
		await app.reactHarness.flush();

		const select = app.summarySelect();
		assert.equal(select.props.disabled, false);
		assert.equal(
			select.props.value,
			JSON.stringify(["openrouter", "anthropic/claude-3.7-sonnet:thinking"]),
		);

		const directOptions = select.children.filter((child) => child.type === "option");
		assert.equal(directOptions.length, 1);
		assert.equal(directOptions[0].props.value, "");
		assert.equal(textOf(directOptions[0]), COPY.en["mux.summary.off"]);

		const optgroups = select.children.filter((child) => child.type === "optgroup");
		assert.equal(optgroups.length, 2);
		assert.equal(optgroups[0].props.label, "OpenAI");
		assert.equal(optgroups[1].props.label, "OpenRouter");
		assert.equal(
			optgroups[1].children[0].props.value,
			JSON.stringify(["openrouter", "anthropic/claude-3.7-sonnet:thinking"]),
		);
		assert.equal(textOf(optgroups[1].children[0]), "Claude 3.7 Sonnet");
		assert.equal(app.statusNotes().includes(COPY.en["mux.summary.loading"]), false);
	} finally {
		app.cleanup();
	}
});

test("selecting a model with / and : posts { mode: 'model', provider, model } and shows saved status in en and ja", async () => {
	for (const lang of ["en", "ja"]) {
		const posts = [];
		const app = bootMobileSection({
			lang,
			fetchImpl(url, options = {}) {
				if (String(url).endsWith("/summary-model") && options.method === "POST") {
					const parsedBody = JSON.parse(options.body);
					posts.push(parsedBody);
					return Promise.resolve(makeJsonResponse({ ok: true, selection: parsedBody }));
				}
				if (String(url).endsWith("/summary-model")) {
					return Promise.resolve(makeJsonResponse({
						ok: true,
						available: true,
						selection: { mode: "off" },
						providers: [
							{
								id: "openrouter",
								name: "OpenRouter",
								models: [
									{
										provider: "openrouter",
										id: "deepseek/deepseek-chat:free",
										name: "DeepSeek Chat (free)",
									},
								],
							},
						],
					}));
				}
				return Promise.resolve(makeJsonResponse({ ok: true }));
			},
		});

		try {
			await app.reactHarness.flush();
			const select = app.summarySelect();
			assert.equal(select.props.value, "");

			const nextValue = JSON.stringify(["openrouter", "deepseek/deepseek-chat:free"]);
			await select.props.onChange({ target: { value: nextValue } });
			await app.reactHarness.flush();

			assert.deepEqual(posts, [{ mode: "model", provider: "openrouter", model: "deepseek/deepseek-chat:free" }]);
			assert.equal(app.summarySelect().props.value, nextValue);
			assert.ok(app.statusNotes().includes(COPY[lang]["mux.summary.saved"]));
		} finally {
			app.cleanup();
		}
	}
});

test("selecting Off posts { mode: 'off' } and displays savedOff status", async () => {
	const posts = [];
	const app = bootMobileSection({
		lang: "en",
		fetchImpl(url, options = {}) {
			if (String(url).endsWith("/summary-model") && options.method === "POST") {
				const parsedBody = JSON.parse(options.body);
				posts.push(parsedBody);
				return Promise.resolve(makeJsonResponse({ ok: true, selection: parsedBody }));
			}
			if (String(url).endsWith("/summary-model")) {
				return Promise.resolve(makeJsonResponse({
					ok: true,
					available: true,
					selection: { mode: "model", provider: "openai", model: "gpt-4o-mini" },
					providers: [{ id: "openai", name: "OpenAI", models: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }] }],
				}));
			}
			return Promise.resolve(makeJsonResponse({ ok: true }));
		},
	});

	try {
		await app.reactHarness.flush();
		await app.summarySelect().props.onChange({ target: { value: "" } });
		await app.reactHarness.flush();

		assert.deepEqual(posts, [{ mode: "off" }]);
		assert.equal(app.summarySelect().props.value, "");
		assert.ok(app.statusNotes().includes(COPY.en["mux.summary.savedOff"]));
	} finally {
		app.cleanup();
	}
});

test("failed POST preserves previous selection and shows localized saveFailed message", async () => {
	const initialValue = JSON.stringify(["openai", "gpt-4o-mini"]);
	const nextValue = JSON.stringify(["openrouter", "anthropic/claude-3.7-sonnet:thinking"]);
	const app = bootMobileSection({
		lang: "en",
		fetchImpl(url, options = {}) {
			if (String(url).endsWith("/summary-model") && options.method === "POST") {
				return Promise.resolve(makeJsonResponse({ ok: false, error: "disk full" }, 500));
			}
			if (String(url).endsWith("/summary-model")) {
				return Promise.resolve(makeJsonResponse({
					ok: true,
					available: true,
					selection: { mode: "model", provider: "openai", model: "gpt-4o-mini" },
					providers: [
						{ id: "openai", name: "OpenAI", models: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }] },
						{ id: "openrouter", name: "OpenRouter", models: [{ provider: "openrouter", id: "anthropic/claude-3.7-sonnet:thinking", name: "Claude 3.7 Sonnet" }] },
					],
				}));
			}
			return Promise.resolve(makeJsonResponse({ ok: true }));
		},
	});

	try {
		await app.reactHarness.flush();
		assert.equal(app.summarySelect().props.value, initialValue);

		await app.summarySelect().props.onChange({ target: { value: nextValue } });
		await app.reactHarness.flush();

		assert.equal(app.summarySelect().props.value, initialValue);
		assert.ok(app.statusNotes().includes("Could not save summary model (disk full)"));
	} finally {
		app.cleanup();
	}
});

test("saved model absent from providers renders missingModel fallback option and keeps selection visible", async () => {
	const missingValue = JSON.stringify(["openrouter", "retired/model:beta"]);
	const app = bootMobileSection({
		lang: "en",
		fetchImpl(url) {
			if (String(url).endsWith("/summary-model")) {
				return Promise.resolve(makeJsonResponse({
					ok: true,
					available: true,
					selection: { mode: "model", provider: "openrouter", model: "retired/model:beta" },
					providers: [
						{ id: "openai", name: "OpenAI", models: [{ provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" }] },
					],
				}));
			}
			return Promise.resolve(makeJsonResponse({ ok: true }));
		},
	});

	try {
		await app.reactHarness.flush();
		const select = app.summarySelect();
		assert.equal(select.props.value, missingValue);
		const missingOption = select.children.find((child) => child.type === "option" && child.props.value === missingValue);
		assert.ok(missingOption, "expected fallback option for unavailable saved model");
		assert.equal(textOf(missingOption), "Saved (unavailable): openrouter / retired/model:beta");
	} finally {
		app.cleanup();
	}
});

test("available: false, empty providers, and GET failure each show the expected status note and disabled state", async () => {
	for (const [label, handler, expectedKey, expectedDisabled] of [
		[
			"unavailable",
			() => Promise.resolve(makeJsonResponse({ ok: true, available: false, selection: { mode: "off" }, providers: [] })),
			"mux.summary.unavailable",
			false,
		],
		[
			"empty",
			() => Promise.resolve(makeJsonResponse({ ok: true, available: true, selection: { mode: "off" }, providers: [] })),
			"mux.summary.empty",
			false,
		],
		[
			"loadFailed",
			() => Promise.reject(new Error("network down")),
			"mux.summary.loadFailed",
			true,
		],
	]) {
		const app = bootMobileSection({
			lang: "en",
			fetchImpl(url) {
				if (String(url).endsWith("/summary-model")) return handler();
				return Promise.resolve(makeJsonResponse({ ok: true }));
			},
		});
		try {
			await app.reactHarness.flush();
			assert.equal(
				app.summarySelect().props.disabled,
				expectedDisabled,
				`expected disabled=${expectedDisabled} for ${label}`,
			);
			assert.ok(
				app.statusNotes().includes(COPY.en[expectedKey]),
				`expected ${expectedKey} status note for ${label}, got ${JSON.stringify(app.statusNotes())}`,
			);
		} finally {
			app.cleanup();
		}
	}
});
