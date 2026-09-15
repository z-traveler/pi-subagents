import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	createMainModelPerformanceProbe,
	createPiModelPerformanceProbeExecutor,
} from "../../src/extension/main-model-performance-probe.ts";
import { DEFAULT_MODEL_PERFORMANCE_CONFIG, ModelPerformanceStore, type ModelPerformanceCacheKey } from "../../src/runs/shared/model-performance.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function model(overrides: Partial<Model<any>> = {}): Model<any> {
	return {
		id: "fast",
		name: "fast",
		api: "faux",
		provider: "opencode",
		baseUrl: "https://opencode.ai/api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
		...overrides,
	};
}

function completedStream(text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const partial = fauxAssistantMessage(text, { api: "faux", provider: "opencode", model: "fast", stopReason: "stop" });
		stream.push({ type: "start", partial });
		stream.push({ type: "thinking_delta", contentIndex: 0, delta: "think", partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
		stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "args", partial });
		stream.push({ type: "done", reason: "stop", message: partial });
	});
	return stream;
}

function context(input: { selected?: Model<any>; streamFn: StreamFn; authenticated?: boolean }) {
	const selected = input.selected ?? model();
	// SAFETY: Tests supply the narrow Pi context surface used by the adapter.
	return {
		signal: undefined,
		sessionManager: { getSessionId: () => "probe-session" },
		modelRegistry: {
			find: (provider: string, id: string) => provider === selected.provider && id === selected.id ? selected : undefined,
			getApiKeyAndHeaders: async () => input.authenticated === false
				? { ok: false as const, error: "missing credentials" }
				: { ok: true as const, apiKey: "secret", env: { REGION: "test" }, headers: { "x-auth": "yes" } },
			getRegisteredProviderConfig: () => ({ api: selected.api, streamSimple: input.streamFn }),
		},
	} as never;
}

describe("main model performance probe adapter", () => {
	it("uses the exact Pi model with no tools, a 64-token bound, auth, thinking, and session headers", async () => {
		const calls: Array<{ model: Model<any>; context: Context; options?: SimpleStreamOptions }> = [];
		const streamFn: StreamFn = (selected, requestContext, options) => {
			calls.push({ model: selected, context: requestContext, options });
			return completedStream("answer");
		};
		const deltas: string[] = [];
		await createPiModelPerformanceProbeExecutor(context({ streamFn }))({
			candidate: "opencode/fast:high",
			signal: new AbortController().signal,
			prompt: "probe prompt",
			maxEstimatedTokens: 64,
			onDelta: (delta) => deltas.push(delta),
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.model.id, "fast");
		assert.equal(calls[0]?.context.messages[0]?.role, "system");
		assert.equal(calls[0]?.context.messages[1]?.role, "user");
		assert.equal(calls[0]?.context.messages[1]?.content, "probe prompt");
		assert.equal((calls[0]?.context.messages[0] as { tools?: unknown } | undefined)?.tools, undefined);
		assert.equal(calls[0]?.options?.maxTokens, 64);
		assert.equal(calls[0]?.options?.reasoning, "high");
		assert.equal(calls[0]?.options?.apiKey, "secret");
		assert.deepEqual(calls[0]?.options?.env, { REGION: "test" });
		assert.deepEqual(calls[0]?.options?.headers, {
			"x-opencode-session": "probe-session",
			"x-opencode-client": "pi",
			"x-auth": "yes",
		});
		assert.deepEqual(deltas, ["think", "answer", "args"]);
	});

	it("rejects unresolved, unauthenticated, and provider-error candidates", async () => {
		const goodStream: StreamFn = () => completedStream("answer");
		const executor = createPiModelPerformanceProbeExecutor(context({ streamFn: goodStream }));
		const execution = {
			signal: new AbortController().signal,
			prompt: "probe",
			maxEstimatedTokens: 64,
			onDelta() {},
		};
		await assert.rejects(executor({ ...execution, candidate: "missing/model" }), /was not found/);
		await assert.rejects(
			createPiModelPerformanceProbeExecutor(context({ streamFn: goodStream, authenticated: false }))({ ...execution, candidate: "opencode/fast" }),
			/missing credentials/,
		);

		const failed: StreamFn = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({
				type: "error",
				reason: "error",
				error: fauxAssistantMessage("", { api: "faux", provider: "opencode", model: "fast", stopReason: "error", errorMessage: "quota exceeded" }),
			}));
			return stream;
		};
		await assert.rejects(
			createPiModelPerformanceProbeExecutor(context({ streamFn: failed }))({ ...execution, candidate: "opencode/fast" }),
			/quota exceeded/,
		);
	});

	it("warms the shared cache and reports a human-displayable result", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-main-model-probe-"));
		roots.push(root);
		const store = new ModelPerformanceStore({ rootDir: root });
		const key: ModelPerformanceCacheKey = {
			modelClass: "fast",
			poolDigest: "adapter",
			candidates: ["opencode/fast"],
			protocolVersion: 1,
		};
		const results: string[] = [];
		const streamFn: StreamFn = () => completedStream("x".repeat(128));
		await createMainModelPerformanceProbe({
			store,
			streamFn,
			onResult: ({ status }) => results.push(status),
		})({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			context: context({ streamFn }),
		});

		assert.deepEqual(results, ["sampled"]);
		assert.equal(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs)[0]?.source, "probe");
	});
});
