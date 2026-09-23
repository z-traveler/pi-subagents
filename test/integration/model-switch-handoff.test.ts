import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { it } from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { createDefaultChildSessionFactory, type ChildSession, type ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";

const usage: Usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const sourceMessage: AssistantMessage = {
	role: "assistant", provider: "source", model: "original", api: "openai-responses", timestamp: 2,
	stopReason: "toolUse", usage,
	content: [
		{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_source", encrypted_content: "source-only-signature" }) },
		{ type: "text", text: "The edit is complete; next verify it." },
		{ type: "toolCall", id: "call_edit|fc_source", name: "edit", arguments: { path: "result.ts", edits: [{ oldText: "before", newText: "after" }] } },
	],
};

type WireItem = { type?: string; role?: string; content?: unknown };
type WireRequest = { model: string; input: WireItem[]; tools?: Array<{ name: string }> };
type FixtureOutput = { type: string; id: string; status: string; role?: string; content?: Array<{ type: string; text: string; annotations?: never[] }>; summary?: never[]; call_id?: string; name?: string; arguments?: string };
type FixtureResponse = { id: string; model?: string; status?: string; output?: FixtureOutput[]; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } };
type FixtureSseEvent = { type: string; response?: FixtureResponse; output_index?: number; item?: FixtureOutput };

function lastAssistant(child: ChildSession): AssistantMessage {
	const last = child.messages.at(-1);
	assert.ok(last?.role === "assistant");
	return last;
}

async function fixture(options: { sourceTool?: boolean; stallSource?: boolean; unsettled?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-handoff-"));
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const savedOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.PI_OFFLINE = "1";
	const requests: WireRequest[] = [];
	let toolExecutions = 0;
	let sourceRequests = 0;
	let sourceStalled!: () => void;
	const stalled = new Promise<void>((resolve) => { sourceStalled = resolve; });
	const server = http.createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body: WireRequest = JSON.parse(Buffer.concat(chunks).toString());
		requests.push(body);
		if (body.model !== "original" && body.input.some((item) => item.role === "assistant" || item.type === "function_call") && !body.input.some((item) => item.type === "reasoning")) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "The reasoning_text in the thinking mode must be passed back to the API." } }));
			return;
		}
		if (body.model === "original") {
			sourceRequests++;
			if (options.stallSource && (!options.sourceTool || sourceRequests > 1)) {
				sourceStalled();
				return; // Remain pending until the child's AbortSignal closes the request.
			}
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		const output: FixtureOutput[] = [
			{ type: "reasoning", id: "rs_target", content: [{ type: "reasoning_text", text: "Target reasoning" }], summary: [], status: "completed" },
			{ type: "message", id: "msg_target", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Verified the existing edit.", annotations: [] }] },
		];
		if (body.model === "original" && options.sourceTool && sourceRequests === 1) {
			output[1] = { type: "function_call", id: "fc_mutation", call_id: "call_mutation", name: "fixture_mutation", arguments: "{}", status: "completed" };
		}
		const emit = (event: FixtureSseEvent) => response.write(`data: ${JSON.stringify(event)}\n\n`);
		emit({ type: "response.created", response: { id: "resp_test" } });
		for (const [output_index, item] of output.entries()) {
			emit({ type: "response.output_item.added", output_index, item });
			emit({ type: "response.output_item.done", output_index, item });
		}
		emit({ type: "response.completed", response: { id: "resp_test", model: body.model, status: "completed", output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: listen(0, "127.0.0.1") above creates a TCP listener, not a pipe.
	const address = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${address.port}/v1`;
	fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: Object.fromEntries([
		["source", "original"], ["target", "replacement"],
	].map(([provider, id]) => [provider, { baseUrl, api: "openai-responses", apiKey: "fixture", models: (provider === "target" ? [id, "another"] : [id]).map((id) => ({ id, reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 1000 })) }])) }));
	fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	const manager = pi.SessionManager.create(root, path.join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "Edit result.ts, then verify. Do not repeat completed mutations.", timestamp: 1 });
	manager.appendMessage(sourceMessage);
	const resultText = `Changed result.ts\n${"x".repeat(2500)}\nIMPORTANT_END_OF_TOOL_RESULT`;
	if (!options.unsettled) manager.appendMessage({ role: "toolResult", toolCallId: "call_edit|fc_source", toolName: "edit", content: [{ type: "text", text: resultText }], isError: false, timestamp: 3 });
	const sessionFile = manager.getSessionFile();
	assert.ok(sessionFile);
	const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => pi });
	// SAFETY: The factory/handoff only reads fanoutChild from this fixture runtime.
	const launch: ChildSessionLaunch = {
		cwd: root, storage: { kind: "file", sessionFile }, model: "source/original:high",
		extensionPaths: [], ambientExtensions: false, noSkills: true, noContextFiles: true,
		hooks: [{ name: "fixture-mutation", factory(api) {
			api.registerTool({ name: "fixture_mutation", label: "Mutation", description: "Count a test mutation", parameters: Type.Object({}),
				async execute() {
					toolExecutions++;
					fs.writeFileSync(path.join(root, "mutation-count"), String(toolExecutions));
					return { content: [{ type: "text", text: "MUTATION_COMPLETED_ONCE" }], details: {} };
				},
			});
		} }],
		tools: ["fixture_mutation"], runtime: { fanoutChild: false } as ChildSessionLaunch["runtime"],
	};
	return {
		root, manager, factory, launch, requests, resultText, sessionFile, stalled,
		get toolExecutions() { return toolExecutions; },
		async cleanup() {
			await factory.dispose();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
			if (savedOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = savedOffline;
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

it("a child continues on a reasoning-strict provider without replaying foreign assistant or tool records", { timeout: 20000 }, async () => {
	const seen = await fixture();
	try {
		const child = await seen.factory.create(seen.launch);
		await child.switchModelForNextResponse!("target/replacement:high");
		await child.prompt("Continue with verification.");
		const last = lastAssistant(child);
		assert.equal(last.stopReason, "stop", last.errorMessage);
		const input = seen.requests[0]!.input;
		assert.equal(input.some((item) => item.role === "assistant" || item.type === "function_call" || item.type === "function_call_output"), false);
		const text = JSON.stringify(input);
		assert.match(text, /Do not repeat completed mutations/);
		assert.match(text, /The edit is complete/);
		assert.match(text, /IMPORTANT_END_OF_TOOL_RESULT/);
		assert.doesNotMatch(text, /source-only-signature/);
		const restored = pi.SessionManager.open(seen.sessionFile);
		assert.ok(restored.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.model === "original"), "raw source evidence survives");
	} finally { await seen.cleanup(); }
});

it("soft switching after a tool batch preserves its results without re-executing mutations", { timeout: 20000 }, async () => {
	const seen = await fixture({ sourceTool: true });
	try {
		const child = await seen.factory.create(seen.launch);
		let switching: Promise<void> | undefined;
		child.subscribe((event) => {
			if (event.type === "turn_end" && !switching) switching = child.switchModelForNextResponse!("target/replacement:high");
		});
		await child.prompt("Perform the next mutation and verify it.");
		await switching;
		assert.deepEqual(seen.requests.map((request) => request.model), ["original", "replacement"]);
		assert.equal(seen.toolExecutions, 1);
		assert.match(JSON.stringify(seen.requests[1]!.input), /MUTATION_COMPLETED_ONCE/);
		assert.equal(lastAssistant(child).stopReason, "stop", lastAssistant(child).errorMessage);
		assert.ok(seen.requests[1]!.input.some((item) => item.role === "developer" || item.role === "system"), "system prompt survives");
		assert.ok(seen.requests[1]!.tools?.some((tool) => tool.name === "fixture_mutation"), "executable tool declarations survive");
	} finally { await seen.cleanup(); }
});

for (const sourceTool of [false, true]) {
	it(`hard switching rolls back the partial response and hands off from ${sourceTool ? "tool results" : "user input"}`, { timeout: 20000 }, async () => {
		const seen = await fixture({ sourceTool, stallSource: true });
		try {
			const child = await seen.factory.create(seen.launch);
			const running = child.prompt("Continue with the pending task.");
			await seen.stalled;
			await child.abort();
			await running;
			assert.equal(lastAssistant(child).stopReason, "aborted");
			await child.retryCurrentResponseWithModel!("target/replacement:high");
			assert.equal(lastAssistant(child).stopReason, "stop", lastAssistant(child).errorMessage);
			const input = seen.requests.at(-1)!.input;
			assert.equal(input.some((item) => item.role === "assistant" || item.type === "function_call" || item.type === "function_call_output"), false);
			assert.match(JSON.stringify(input), /Continue with the pending task/);
			assert.match(JSON.stringify(input), /IMPORTANT_END_OF_TOOL_RESULT/);
			assert.equal(seen.toolExecutions, sourceTool ? 1 : 0);
			if (sourceTool) assert.match(JSON.stringify(input), /MUTATION_COMPLETED_ONCE/);
		} finally { await seen.cleanup(); }
	});
}

it("opening a fallback candidate hands off once, retains its own reasoning, and survives resume", { timeout: 20000 }, async () => {
	const seen = await fixture();
	try {
		const targetLaunch = { ...seen.launch, model: "target/replacement:high" };
		const child = await seen.factory.create(targetLaunch);
		await child.prompt("Continue the task.");
		assert.equal(lastAssistant(child).stopReason, "stop", lastAssistant(child).errorMessage);
		await child.dispose();
		const resumed = await seen.factory.create(targetLaunch);
		await resumed.prompt("Check the result again.");
		assert.equal(lastAssistant(resumed).stopReason, "stop", lastAssistant(resumed).errorMessage);
		assert.ok(seen.requests[1]!.input.some((item) => item.type === "reasoning"), "native target signatures are replayed");
		const countHandoffs = () => pi.SessionManager.open(seen.sessionFile).getEntries().filter((entry) => entry.type === "compaction").length;
		assert.equal(countHandoffs(), 1);
		await resumed.switchModelForNextResponse!("target/another:high");
		await resumed.prompt("Continue on another model at the same provider.");
		assert.equal(countHandoffs(), 2);
		assert.equal(seen.requests[2]!.input.some((item) => item.role === "assistant" || item.type === "reasoning"), false);
		assert.match(JSON.stringify(seen.requests[2]!.input), /IMPORTANT_END_OF_TOOL_RESULT/);
	} finally { await seen.cleanup(); }
});

it("same-model thinking changes leave native history intact", { timeout: 20000 }, async () => {
	const seen = await fixture();
	try {
		const child = await seen.factory.create(seen.launch);
		await child.switchModelForNextResponse!("source/original:low");
		await child.prompt("Continue on the same model.");
		assert.ok(seen.requests[0]!.input.some((item) => item.type === "function_call"));
		assert.equal(pi.SessionManager.open(seen.sessionFile).getEntries().some((entry) => entry.type === "compaction"), false);
	} finally { await seen.cleanup(); }
});

it("handoffs preserve images without baking parent-only notices into conversation text", { timeout: 20000 }, async () => {
	const seen = await fixture();
	try {
		const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1xkAAAAASUVORK5CYII=" };
		seen.manager.appendCustomMessageEntry("subagent-notify", "PARENT_ONLY_NOTICE", false);
		seen.manager.appendMessage({ role: "user", content: [{ type: "text", text: "Compare this image." }, image], timestamp: 4 });
		const child = await seen.factory.create(seen.launch);
		await child.switchModelForNextResponse!("target/replacement:high");
		await child.prompt("Continue with the image.");
		const input = JSON.stringify(seen.requests[0]!.input);
		assert.doesNotMatch(input, /PARENT_ONLY_NOTICE/);
		assert.match(input, /Compare this image/);
		assert.ok(input.includes(`data:image/png;base64,${image.data}`), "image remains a native attachment, not base64 summary text");
		assert.equal((input.match(/input_image/g) ?? []).length, 1);
	} finally { await seen.cleanup(); }
});

it("an unsettled tool batch blocks the handoff before any replacement request", { timeout: 20000 }, async () => {
	const seen = await fixture({ unsettled: true });
	try {
		const child = await seen.factory.create(seen.launch);
		await assert.rejects(child.switchModelForNextResponse!("target/replacement:high"), /unsettled/);
		assert.equal(seen.requests.length, 0);
		assert.equal(pi.SessionManager.open(seen.sessionFile).getEntries().some((entry) => entry.type === "compaction"), false);
	} finally { await seen.cleanup(); }
});
