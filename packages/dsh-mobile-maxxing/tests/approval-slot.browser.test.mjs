/** Opt-in real-slot regression: use isolated DSH servers and an owned headless Chrome. */
import assert from "node:assert/strict";
import { test } from "node:test";

const urls = JSON.parse(process.env.DSH_COMPAT_URLS || "[]");
const endpoint = process.env.DSH_COMPAT_CDP || "http://127.0.0.1:9457";

async function page() {
	const target = await (await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })).json();
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map();
	const errors = [];
	socket.onmessage = ({ data }) => {
		const event = JSON.parse(data);
		if (event.id !== undefined) {
			const request = pending.get(event.id);
			pending.delete(event.id);
			if (event.error) request.reject(new Error(event.error.message));
			else request.resolve(event.result);
		} else if (event.method === "Runtime.exceptionThrown"
			|| (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")) errors.push(event);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const key = ++id;
		pending.set(key, { resolve, reject });
		socket.send(JSON.stringify({ id: key, method, params }));
	});
	return {
		send, errors,
		async evaluate(fn, ...args) {
			const r = await send("Runtime.evaluate", {
				expression: "(" + fn.toString() + ")(..." + JSON.stringify(args) + ")",
				awaitPromise: true, returnByValue: true,
			});
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
			return r.result.value;
		},
		async close() {
			socket.close();
			await fetch(endpoint + "/json/close/" + target.id);
		},
	};
}

function snapshot() {
	const body = document.querySelector("[data-conversation-content]");
	const seat = document.querySelector("[data-composer-seat]");
	const scroll = document.querySelector("[data-conversation-scroll]");
	const rect = body.getBoundingClientRect();
	const input = document.querySelector("[data-rdsh-composer-root]");
	const card = document.querySelector("[data-rdsh-add]")?.closest('[class*="_card"]');
	const outer = input?.getBoundingClientRect(), inner = card?.getBoundingClientRect();
	return {
		inputGutters: outer && inner ? { left: inner.left - outer.left, right: outer.right - inner.right } : null,
		x: rect.x, width: rect.width, sameSeat: seat === window.__compatSeat,
		actualHeight: seat.offsetHeight,
		publishedHeight: scroll.style.getPropertyValue("--dsh-composer-height"),
		questionFrames: document.querySelectorAll("[data-rdsh-question-frame]").length,
		approval: document.querySelector(".mna1RW_card") !== null,
		scrollParent: scroll.parentElement.className,
	};
}

async function waitFor(browser, fn) {
	for (let i = 0; i < 80; i++) {
		if (await browser.evaluate(fn)) return;
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	throw new Error("UI did not settle");
}

function mountApproval() {
	const node = document.querySelector("[data-conversation-content]");
	let fiber = node[Object.keys(node).find(k => k.startsWith("__reactFiber$"))];
	while (fiber && (fiber.type?.name !== "FactoryOccurrenceBody" || !fiber.memoizedProps.scopeBinding?.ctx)) fiber = fiber.return;
	const ctx = fiber.memoizedProps.scopeBinding.ctx;
	const host = fiber.dependencies.firstContext.memoizedValue;
	const approval = host.entriesOfSlot("conversation.composer").find(e => e.component.name === "ApprovalPanel");
	let dispose;
	ctx.inject(["slots"], scope => {
		dispose = scope.slots.register({
			name: "conversation.composer", priority: -5, locale: "approval",
			select: () => ({
				key: "mobile-compat-ui-only", toolName: "ui-only", reason: "Approval layout regression",
				answerable: true, answer() { throw new Error("UI fixture must never execute a tool"); },
			}),
			inject: () => ({ resolveReason: reason => reason }),
		}, approval.component);
		return dispose;
	});
	window.__compatRemove = () => dispose?.();
}

test("real approval slot keeps conversation width and returns composer height on rc.1 / rc.3", {
	skip: urls.length === 0 ? "Set DSH_COMPAT_URLS and run an owned Chrome at DSH_COMPAT_CDP" : false,
	timeout: 60_000,
}, async t => {
	for (const url of urls) {
		assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname), "use an isolated loopback QA server");
		const browser = await page();
		try {
			await browser.send("Page.enable"); await browser.send("Runtime.enable"); await browser.send("Network.enable");
			await browser.send("Network.setCacheDisabled", { cacheDisabled: true });
			await browser.send("Network.setBypassServiceWorker", { bypass: true });
			await browser.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
			await browser.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone" });
			await browser.send("Page.navigate", { url });
			await waitFor(browser, () => {
				if (typeof window.__RDSH_MOBILE_UX__?.decorateNow !== "function") return false;
				const node = document.querySelector("[data-conversation-content]");
				if (!node?.getAttribute("data-conversation-session")) return false;
				let f = node[Object.keys(node).find(k => k.startsWith("__reactFiber$"))];
				for (; f; f = f.return) if (f.type?.name === "FactoryOccurrenceBody" && f.memoizedProps.scopeBinding?.ctx) return true;
				return false;
			});
			await browser.evaluate(async () => { __RDSH_MOBILE_UX__.decorateNow(); await document.fonts.ready; await new Promise(requestAnimationFrame); });
			await browser.evaluate(() => { window.__compatSeat = document.querySelector("[data-composer-seat]"); });
			const before = await browser.evaluate(snapshot);
			assert.deepEqual(before.inputGutters, { left: 16, right: 16 });
			await browser.evaluate(mountApproval);
			await waitFor(browser, () => document.querySelector(".mna1RW_card") !== null);
			await browser.evaluate(() => __RDSH_MOBILE_UX__.decorateNow());
			await waitFor(browser, () => {
				const seat = document.querySelector("[data-composer-seat]"), scroll = document.querySelector("[data-conversation-scroll]");
				return scroll.style.getPropertyValue("--dsh-composer-height") === seat.offsetHeight + "px";
			});
			const during = await browser.evaluate(snapshot);
			await browser.evaluate(() => window.__compatRemove());
			await waitFor(browser, () => document.querySelector(".mna1RW_card") === null);
			await browser.evaluate(() => __RDSH_MOBILE_UX__.decorateNow());
			await waitFor(browser, () => {
				const seat = document.querySelector("[data-composer-seat]"), scroll = document.querySelector("[data-conversation-scroll]");
				return scroll.style.getPropertyValue("--dsh-composer-height") === seat.offsetHeight + "px";
			});
			const after = await browser.evaluate(snapshot);
			assert.deepEqual(after.inputGutters, before.inputGutters);
			for (const state of [during, after]) {
				assert.equal(state.width, before.width); assert.equal(state.x, before.x);
				assert.equal(state.questionFrames, 0); assert.equal(state.sameSeat, true);
				assert.equal(state.publishedHeight, state.actualHeight + "px");
			}
			assert.equal(during.approval, true); assert.equal(after.approval, false);
			assert.equal(after.actualHeight, before.actualHeight);
			assert.deepEqual(browser.errors, []);
			t.diagnostic(JSON.stringify({ origin: new URL(url).origin, before, during, after }));
		} finally {
			try { await browser.evaluate(() => window.__compatRemove?.()); } catch {}
			await browser.close();
		}
	}
});
