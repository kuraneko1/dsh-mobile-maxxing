/*
 * dsh-mobile-maxxing — app-shell service worker.
 *
 * Served by the dsh-mobile-maxxing host plugin at /sw.js (root scope). The host prepends
 * `self.__RDSH_PWA_BUILD__` and `self.__RDSH_PWA_CONFIG__`; the build hash is
 * derived from this file's bytes, so editing it retires the old cache and
 * makes the page offer "reload to update".
 *
 * Strategy:
 *   navigation  network first (bounded), fall back to the cached shell, then
 *               to a built-in offline page — a launch never shows the browser's
 *               offline error
 *   static      cache first + background revalidate for /assets, /plugins,
 *               /pwa, /markdown-cjk and the favicons; hashed URLs make
 *               staleness harmless
 *   /api, /hmr, /terminal, non-GET, cross-origin, ranged requests
 *               never intercepted: live state must come from the server
 */

const BUILD = typeof self.__RDSH_PWA_BUILD__ === "string" ? self.__RDSH_PWA_BUILD__ : "dev";
const CONFIG = (self.__RDSH_PWA_CONFIG__ && typeof self.__RDSH_PWA_CONFIG__ === "object" ? self.__RDSH_PWA_CONFIG__ : {});
const NAVIGATION_TIMEOUT_MS = Number.isFinite(CONFIG.navigationTimeoutMs) ? CONFIG.navigationTimeoutMs : 1500;
// UI copy comes from the host's dictionary; the English fallbacks keep this
// worker usable when it is loaded outside the plugin (dev, tests).
const COPY = CONFIG.copy && typeof CONFIG.copy === "object" ? CONFIG.copy : {};
const DOCUMENT_LANG = typeof CONFIG.lang === "string" ? CONFIG.lang.replace(/[^A-Za-z0-9-]/g, "") || "en" : "en";
const copy = (key, fallback) => (typeof COPY[key] === "string" && COPY[key] !== "" ? COPY[key] : fallback);
const CACHE_PREFIX = "dsh-mobile-maxxing-";
const CACHE_NAME = CACHE_PREFIX + BUILD;
const MAX_STATIC_ENTRIES = 250;

const SCOPE = new URL(self.registration.scope);
const SHELL_URL = new URL("./", SCOPE).href;
/**
 * The plugin's own manifest, linked by the mobile bootstrap only. The stock
 * `manifest.webmanifest` is a different file now: it stays the stock manifest
 * for desktop installs, so both are cacheable and only ours is protected.
 */
const MANIFEST_FILE = "dsh-mobile-maxxing.webmanifest";
const MANIFEST_URL = new URL(MANIFEST_FILE, SCOPE).href;

/**
 * Paths, relative to the scope, whose responses are safe to serve from cache.
 *
 * `markdown-cjk/` is the host half's serve-time patched renderer. The document
 * is rewritten to load those URLs instead of `assets/`, so an offline launch
 * needs them in the same cache as the stock assets; without this prefix the
 * rewritten entry chunks are a network-only dependency and the app cannot boot
 * while offline.
 */
const STATIC_PREFIXES = ["assets/", "plugins/", "pwa/", "markdown-cjk/"];
const STATIC_FILES = new Set([
	"favicon.svg",
	"favicon-dark.svg",
	// The stock manifest stays cacheable: a desktop install reads it.
	"manifest.webmanifest",
	MANIFEST_FILE,
]);

/** Never intercept these: the UI reads live state, terminal and HMR need sockets. */
const BYPASS_SEGMENTS = ["/api", "/hmr", "/terminal", "/__"];

const OFFLINE_HTML = `<!doctype html>
<html lang="${DOCUMENT_LANG}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${copy("sw.documentTitle", "Offline — DSH")}</title>
<style>
/* The worker cannot read the stored theme (no DOM, no profile), so the
   offline page follows the OS preference through the system colours. */
:root{color-scheme:light dark}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;background:Canvas;color:CanvasText;
  font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
  padding:calc(env(safe-area-inset-top,0px) + 24px) 24px calc(env(safe-area-inset-bottom,0px) + 24px)}
main{max-width:22rem;text-align:center}
h1{margin:0 0 8px;font-size:18px;font-weight:600}
p{margin:0 0 20px;color:GrayText;font-size:14px}
button{font:inherit;font-size:14px;padding:10px 18px;border-radius:999px;border:0;
  background:LinkText;color:Canvas;cursor:pointer}
button:active{transform:scale(.98)}
</style></head>
<body><main>
<h1>${copy("sw.offlineHeading", "You're offline")}</h1>
<p>${copy("sw.offlineBody1", "Could not reach the DSH server.")}<br>${copy("sw.offlineBody2", "Check your network connection.")}</p>
<button onclick="location.reload()">${copy("sw.retry", "Retry")}</button>
</main></body></html>`;

function isBypassed(url) {
	// A proxy prefix such as /dsh/ keeps working: compare from the scope path.
	const path = url.pathname.slice(SCOPE.pathname.length - 1);
	if (url.searchParams?.has("token")) return true;
	if (path === "/connect" || path.startsWith("/connect/")) return true;
	if (path === "/plugins/events" || path.startsWith("/plugins/events/")) return true;
	return BYPASS_SEGMENTS.some((segment) => path === segment || path.startsWith(segment + "/"));
}

function isStatic(url) {
	const relative = url.pathname.slice(SCOPE.pathname.length);
	if (STATIC_FILES.has(relative)) return true;
	return STATIC_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

/** Fetch with a deadline; the abort looks like any other network failure. */
async function fetchWithTimeout(request, timeoutMs) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(request);
	// Passing init (`{ signal }`) to fetch(navigateRequest, init) changes
	// mode from "navigate" to "same-origin" per the Fetch spec.
	if (request?.mode === "navigate") {
		const pending = fetch(request);
		void Promise.resolve(pending).catch(() => {});
		return withTimeout(pending, timeoutMs);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(request, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

function offlineResponse() {
	return new Response(OFFLINE_HTML, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

/** Keep the shell cache bounded; keys() is insertion order, so drop the oldest. */
/** URLs an offline launch cannot do without; the trim must never evict them. */
const PROTECTED_URLS = new Set([SHELL_URL, MANIFEST_URL]);

async function trim(cache) {
	try {
		const keys = await cache.keys();
		if (keys.length <= MAX_STATIC_ENTRIES) return;
		// Oldest first, but keep the shell and the manifest: they are written at
		// install time, so a plain oldest-first eviction would delete exactly the
		// two entries an offline launch depends on.
		const evictable = keys.filter((key) => !PROTECTED_URLS.has(key.url));
		const overflow = keys.length - MAX_STATIC_ENTRIES;
		for (const key of evictable.slice(0, Math.max(0, overflow))) await cache.delete(key);
	} catch {
		/* quota and opaque-response errors are not worth failing a request over */
	}
}

async function put(cache, request, response) {
	try {
		await cache.put(request, response);
	} catch {
		/* ignore: an uncacheable response still reaches the page */
	}
}

/** Settle with the promise, or reject once the navigation budget is spent. */
function withTimeout(promise, timeoutMs) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
	let timer = 0;
	const expired = new Promise((resolve, reject) => {
		timer = setTimeout(() => reject(new Error("navigation timeout")), timeoutMs);
	});
	return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

const SHELL_SKIP_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|css|m?js|json|webmanifest|woff2?|ttf|otf|map|pdf|txt|xml)$/i;

function canStoreAsShell(requestUrl, response) {
	if (!response || !response.ok || response.type !== "basic") return false;
	const contentType = response.headers?.get?.("content-type");
	if (typeof contentType === "string" && contentType.trim() !== "" && !contentType.toLowerCase().includes("text/html")) {
		return false;
	}
	let parsed;
	try {
		parsed = new URL(requestUrl);
	} catch {
		return true;
	}
	const relative = parsed.pathname.slice(SCOPE.pathname.length);
	if (relative === "") return true;
	if (relative.startsWith("dsh-mobile-maxxing/")) return false;
	if (STATIC_FILES.has(relative) || STATIC_PREFIXES.some((prefix) => relative.startsWith(prefix))) return false;
	return !SHELL_SKIP_EXTENSIONS.test(parsed.pathname);
}

function extractShellAssets(html, scriptsOnly = false) {
	if (typeof html !== "string" || html === "") return [];
	const urls = new Set();
	for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
		try {
			const resolved = new URL(match[1], SHELL_URL);
			if (resolved.origin === SCOPE.origin && isStatic(resolved)) urls.add(resolved.href);
		} catch {}
	}
	if (!scriptsOnly) {
		for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
			const tag = match[0];
			const rel = /\brel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? "";
			if (rel !== "stylesheet" && rel !== "modulepreload") continue;
			const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
			if (!href) continue;
			try {
				const resolved = new URL(href, SHELL_URL);
				if (resolved.origin === SCOPE.origin && isStatic(resolved)) urls.add(resolved.href);
			} catch {}
		}
	}
	return [...urls];
}

async function precacheShellAssets(cache, html) {
	const assets = extractShellAssets(html, false);
	if (assets.length === 0) return;
	for (const assetUrl of assets) {
		try {
			if ((await cache.match(assetUrl)) !== undefined) continue;
			const assetResponse = await fetch(assetUrl);
			if (assetResponse && assetResponse.ok) await put(cache, assetUrl, assetResponse);
		} catch {
			/* ignore single asset failure; navigation fallback checks script presence */
		}
	}
	await trim(cache);
}

async function shellReadyOffline(cache, cached) {
	if (cached === undefined || typeof cached.clone !== "function") return false;
	let html = "";
	try {
		const copy = cached.clone();
		if (typeof copy.text === "function") html = await copy.text();
	} catch {
		return true;
	}
	const scripts = extractShellAssets(html, true);
	for (const scriptUrl of scripts) {
		try {
			if ((await cache.match(scriptUrl)) === undefined) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * The network answer for a navigation. Navigation preload (enabled at
 * activation) starts the request while the worker is still booting; without
 * it the request only left once the worker had started and run this handler.
 */
async function navigationResponse(event) {
	const preload = event.preloadResponse;
	if (preload !== undefined && preload !== null) {
		const settledPreload = Promise.resolve(preload).catch(() => undefined);
		if (typeof event.waitUntil === "function") event.waitUntil(settledPreload);
		const preloaded = await withTimeout(preload, NAVIGATION_TIMEOUT_MS);
		if (preloaded) return preloaded;
	}
	return fetchWithTimeout(event.request, NAVIGATION_TIMEOUT_MS);
}

/**
 * Network first, the cached shell when the network fails or is too slow.
 *
 * The page gets the response as soon as it arrives: storing the shell runs in
 * the background (waitUntil). Awaiting the cache write first held the whole
 * document back until it had downloaded and been written, so the browser
 * could not start parsing it.
 */
async function handleNavigation(event) {
	try {
		const response = await navigationResponse(event);
		if (canStoreAsShell(event.request?.url ?? SHELL_URL, response)) {
			// Canonical key: the launch URL may carry auth fragments or query
			// parameters that must not multiply shell entries.
			const copy = response.clone();
			const assetCopy = typeof response.clone === "function" ? response.clone() : null;
			event.waitUntil((async () => {
				const cache = await caches.open(CACHE_NAME);
				await put(cache, SHELL_URL, copy);
				if (assetCopy !== null && typeof assetCopy.text === "function") {
					try {
						await precacheShellAssets(cache, await assetCopy.text());
					} catch {}
				}
			})());
		}
		return response;
	} catch {
		const cache = await caches.open(CACHE_NAME);
		const cached = await cache.match(SHELL_URL);
		if (cached === undefined) return offlineResponse();
		return (await shellReadyOffline(cache, cached)) ? cached : offlineResponse();
	}
}

/** CacheStorage ignores HTTP freshness; honor it before skipping revalidation. */
function freshStaticResponse(response, now = Date.now()) {
 const control = response.headers.get("cache-control") || "";
 if (/(?:^|,)\s*(?:no-cache|no-store)(?:\s*(?:[=,]|$))/i.test(control)) return false;
 const lifetime = /(?:^|,)\s*max-age\s*=\s*"?(\d+)"?(?:\s*(?:,|$))/i.exec(control);
 const date = Date.parse(response.headers.get("date") || "");
 const age = Number(response.headers.get("age") || 0);
 if (!lifetime || !Number.isFinite(date) || date > now || !Number.isFinite(age) || age < 0) return false;
 return now - date + age * 1000 < Number(lifetime[1]) * 1000;
}

/**
 * @param {Request} request
 * @param {(work: Promise<void>) => void} [defer] keeps the worker alive for
 *   background work (the fetch event's waitUntil). Without it the cache write
 *   is awaited before the response is returned.
 */
async function handleStatic(request, defer) {
	const cache = await caches.open(CACHE_NAME);
	const cached = await cache.match(request);
	if (cached !== undefined) {
		// Fresh immutable chunks and one-day icons need no network, cache
		// write or full key scan. Expired responses still revalidate (#144).
		if (freshStaticResponse(cached)) return cached;
		// Mutable assets still revalidate; replacement cannot grow this cache.
		const revalidate = fetch(request)
			.then(async (response) => {
				if (response.ok) await put(cache, request, response);
			})
			.catch(() => {});
		if (typeof defer === "function") defer(revalidate);
		return cached;
	}
	try {
		const response = await fetch(request);
		if (response.ok) {
			// The page reads the body while it is being stored: a first visit no
			// longer waits for each chunk to be fully cached (and the key scan of
			// trim) before it can parse it.
			const copy = response.clone();
			const store = (async () => {
				await put(cache, request, copy);
				await trim(cache);
			})();
			if (typeof defer === "function") defer(store);
			else await store;
		}
		return response;
	} catch {
		// `cached` was already returned above when it existed, so this is the
		// network-down, nothing-stored case.
		return Response.error();
	}
}

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		// Take over as soon as the new worker is installed. Without this an
		// already-open app kept the previous worker (and its push handling)
		// until every tab was closed — on iOS standalone that can be never, so
		// the old worker kept showing system notifications (#25).
		self.skipWaiting();
		const cache = await caches.open(CACHE_NAME);
		// Shell first: an offline launch must find the document even if an icon
		// is missing from a deployment.
		for (const url of [SHELL_URL, MANIFEST_URL]) {
			try {
				const response = await fetch(url, { cache: "reload" });
				if (response.ok) {
					const assetCopy = url === SHELL_URL && typeof response.clone === "function" ? response.clone() : null;
					await put(cache, url, response);
					if (assetCopy !== null && typeof assetCopy.text === "function") {
						try {
							await precacheShellAssets(cache, await assetCopy.text());
						} catch {}
					}
				}
			} catch {
				/* leave install to succeed; the navigation handler repairs later */
			}
		}
	})());
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		for (const key of await caches.keys()) {
			if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) await caches.delete(key);
		}
		// Start navigation requests in parallel with booting this worker.
		try {
			await self.registration.navigationPreload?.enable();
		} catch {
			/* unsupported: navigations fall back to fetch() in the handler */
		}
		await self.clients.claim();
	})());
});

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (isBypassed(url)) return;
	if (request.headers.get("range") !== null) return;
	if (request.mode === "navigate") {
		event.respondWith(handleNavigation(event));
		return;
	}
	// A dev reload asks for fresh bytes; let the network answer it untouched.
	if (request.cache === "no-store") return;
	if (isStatic(url)) event.respondWith(handleStatic(request, (work) => event.waitUntil(work)));
});

/*
 * Web Push.
 *
 * Only one worker can control a scope. The browser half redirects a legacy
 * `/push/sw.js` registration here, and these handlers speak this package's own
 * contract: `{ title, body, url, sessionId, kind }` in, `dsh-mobile-maxxing:open-session`
 * out. The previous plugin's message name is still accepted for pages that are
 * already open across an upgrade.
 */
function pushPayload(event) {
	const payload = {
		title: copy("sw.pushTitle", "DSH"),
		body: copy("sw.pushBody", "You have a new notification"),
		url: "./",
		sessionId: "",
		kind: "notice",
	};
	try {
		const data = event.data === null ? null : event.data.json();
		if (data !== null && typeof data === "object") {
			if (typeof data.title === "string") payload.title = data.title;
			if (typeof data.body === "string" && data.body.length > 0) payload.body = data.body;
			if (typeof data.url === "string" && data.url !== "") payload.url = data.url;
			if (typeof data.sessionId === "string") payload.sessionId = data.sessionId;
			if (typeof data.kind === "string") payload.kind = data.kind;
		}
	} catch {
		/* a non-JSON payload keeps the defaults */
	}
	return payload;
}

self.addEventListener("push", (event) => {
	const payload = pushPayload(event);
	event.waitUntil((async () => {
		// Every received Web Push must produce a user-visible notification:
		// WebKit revokes a subscription after three silent pushes, and
		// Chromium/Edge substitute a generic banner. A visible page shows its
		// own local banner instead; the host only skips a push for a notice
		// that page already acknowledged.
		await self.registration.showNotification(payload.title, {
			body: payload.body,
			icon: new URL("pwa/icon-192.png", SCOPE).href,
			badge: new URL("pwa/badge-96.png", SCOPE).href,
			// One banner per session: a shared tag would merge different sessions.
			tag: payload.sessionId !== "" ? `dsh-mobile-maxxing:${payload.sessionId}` : "dsh-mobile-maxxing:notice",
			renotify: true,
			requireInteraction: true,
			data: { url: payload.url, sessionId: payload.sessionId },
			actions: [{ action: "open", title: copy("sw.open", "Open") }],
		});
	})());
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = (event.notification.data && typeof event.notification.data === "object") ? event.notification.data : {};
	const target = typeof data.url === "string" && data.url !== "" ? data.url : SHELL_URL;
	let resolvedTarget = SHELL_URL;
	try {
		resolvedTarget = new URL(target, SCOPE).href;
	} catch {}
	const sessionId = typeof data.sessionId === "string" ? data.sessionId : "";
	event.waitUntil((async () => {
		const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
		// Prefer the window the user was looking at; matchAll's order says
		// nothing about which one that is.
		const ordered = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused)
			|| Number(b.visibilityState === "visible") - Number(a.visibilityState === "visible"));
		for (const client of ordered) {
			if (!("focus" in client)) continue;
			try {
				await client.focus();
			} catch {
				// A window that refuses focus is already gone; keep looking
				// instead of abandoning the click.
				continue;
			}
			// The SPA has no session routing: an open window is switched in-page
			// by the notification plugin's listener instead of by a URL.
			if (sessionId !== "" && "postMessage" in client) {
				client.postMessage({ type: "dsh-mobile-maxxing:open-session", sessionId });
				return;
			}
			if (resolvedTarget !== SHELL_URL && new URL(resolvedTarget).origin === SCOPE.origin && "navigate" in client) {
				try {
					await client.navigate(resolvedTarget);
					return;
				} catch {
					// Uncontrolled windows throw TypeError on client.navigate();
					// fall through to another client or openWindow().
					continue;
				}
			}
			return;
		}
		await self.clients.openWindow(resolvedTarget);
	})());
});

self.addEventListener("message", (event) => {
	const data = event.data;
	if (data === null || typeof data !== "object") return;
	if (data.type === "SKIP_WAITING") {
		self.skipWaiting();
		return;
	}
	if (data.type === "PING" && event.ports !== null && event.ports.length > 0) {
		event.ports[0].postMessage({ type: "PONG", build: BUILD, cache: CACHE_NAME });
	}
});

/**
 * Re-subscribe when the browser retires the subscription (RFC 8030 §5.4).
 *
 * Without this the phone silently stops receiving notifications after a
 * rotation until the user visits Settings and presses the button again.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
	event.waitUntil((async () => {
		try {
			let subscription = event.newSubscription ?? null;
			if (subscription === null) {
				const response = await fetch(new URL("api/dsh-mobile-maxxing/push/vapid", SCOPE), { cache: "no-store" });
				if (!response.ok) throw new Error("push key unavailable");
				const { publicKey } = await response.json();
				const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
				const raw = atob((publicKey + padding).replace(/-/g, "+").replace(/_/g, "/"));
				const key = new Uint8Array([...raw].map((character) => character.charCodeAt(0)));
				subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
			}
			// The host retires the endpoint this rotation replaced (#98). The
			// page keeps its own copy in localStorage, which a worker cannot
			// read, so the replaced registration is named here instead.
			const previousEndpoint = typeof event.oldSubscription?.endpoint === "string" ? event.oldSubscription.endpoint : "";
			const saved = await fetch(new URL("api/dsh-mobile-maxxing/push/subscribe", SCOPE), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					subscription: subscription.toJSON(),
					label: navigator.userAgent,
					origin: self.location.origin,
					previousEndpoint,
				}),
			});
			if (!saved.ok) throw new Error("push subscription registration failed");
		} catch {
			console.warn("[dsh-mobile-maxxing] push subscription rotation failed; the app will retry");
		}
	})());
});
