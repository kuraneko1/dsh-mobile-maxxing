import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const decorate = source.match(/    function decorateQuestionCards\(\) \{[\s\S]*?\n    \}/)[0];

function node(className, parentElement = null) {
	const attrs = new Map();
	return {
		classList: className.split(" "), parentElement, isConnected: true,
		querySelector: () => null, querySelectorAll: () => [],
		setAttribute: (k, v) => attrs.set(k, v),
		removeAttribute: k => attrs.delete(k),
		hasAttribute: k => attrs.has(k),
		closest(selector) {
			for (let e = this; e; e = e.parentElement) if (e.classList.some(c => c.endsWith("_frame"))) return e;
			return null;
		},
	};
}
function fixture() {
	const app = node("shell_frame extra");
	const approvalRoot = node("approval_root", app);
	const approval = node("approval_card", approvalRoot);
	approval.querySelector = () => node("approval_strip");
	const frame = node("question_frame extra", app);
	const question = node("question_card extra", frame);
	question.querySelector = () => node("question_options");
	const planFrame = node("plan_frame", app);
	const plan = node("plan_card", planFrame);
	plan.querySelector = () => node("plan_strip");
	const nodes = [app, approvalRoot, approval, frame, question, planFrame, plan];
	let cards = [approval, question, plan];
	let mobile = true;
	const tagged = [];
	const document = {
		querySelectorAll(selector) {
			if (selector === '[class*="_card"]') return cards;
			const attr = selector.slice(1, -1);
			return nodes.filter(e => e.hasAttribute(attr));
		},
	};
	const context = {
		document, phone: () => mobile,
		classToken: (e, re) => e?.classList.some(c => re.test(c)) ?? false,
		questionBehaviorCards: new Map(), questionArrowState: new Map(),
		clearQuestionArrows() {}, clearQuestionBehaviors() {}, clearQuestionBehavior() {},
		clearOwnedAttribute(k) { for (const e of nodes) e.removeAttribute(k); },
		decorateQuestionArrow(e) { tagged.push(e); }, installQuestionCardBehavior() {}, revealQuestionField() {},
	};
	vm.runInNewContext(decorate + "\nthis.run = decorateQuestionCards;", context);
	return { app, approval, frame, question, planFrame, plan, tagged, run: context.run,
		removeCards() { cards = []; }, desktop() { mobile = false; } };
}

test("approval strips never turn the app frame into a question frame", () => {
	const f = fixture(); f.run();
	assert.equal(f.app.hasAttribute("data-rdsh-question-frame"), false);
	assert.equal(f.approval.hasAttribute("data-rdsh-question-card"), false);
	assert.deepEqual(f.tagged, [f.question, f.plan]);
	assert.equal(f.frame.hasAttribute("data-rdsh-question-frame"), true);
	assert.equal(f.planFrame.hasAttribute("data-rdsh-question-frame"), true);
});

test("a mobile pass repairs stale app decoration and unmounted cards", () => {
	const f = fixture();
	f.app.setAttribute("data-rdsh-question-frame", "");
	f.approval.setAttribute("data-rdsh-question-card", "");
	f.run();
	assert.equal(f.app.hasAttribute("data-rdsh-question-frame"), false);
	assert.equal(f.approval.hasAttribute("data-rdsh-question-card"), false);
	f.removeCards(); f.run();
	assert.equal(f.frame.hasAttribute("data-rdsh-question-frame"), false);
	assert.equal(f.planFrame.hasAttribute("data-rdsh-question-frame"), false);
	assert.equal(f.question.hasAttribute("data-rdsh-question-card"), false);
});

test("desktop still removes mobile question decoration instead of adding it", () => {
	const f = fixture(); f.run(); f.desktop(); f.run();
	assert.equal(f.frame.hasAttribute("data-rdsh-question-frame"), false);
	assert.equal(f.question.hasAttribute("data-rdsh-question-card"), false);
});
