import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type Model, type ProviderHeaders, type SimpleStreamOptions, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	type ModelPerformanceProbeExecutor,
	type ModelPerformanceProbeResult,
	type WarmModelPerformanceCacheOptions,
	warmModelPerformanceCache,
} from "../runs/shared/model-performance-probe.ts";
import { generationDeltaText, ModelPerformanceStore } from "../runs/shared/model-performance.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS } from "../shared/model-info.ts";
import { opencodeSessionHeaders } from "../shared/opencode-session-headers.ts";
import type { MainModelPerformanceProbeRequest } from "./main-model-performance.ts";

type RegistryModel = Model<any>;

interface ProbeAuth {
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

function normalizeProbeContext(prompt: string): Parameters<StreamFn>[1] {
	return {
		messages: [
			{ role: "system", content: "Generate only the requested probe text. Do not call tools or explain the task.", timestamp: 0 },
			{ role: "user", content: prompt, timestamp: Date.now() },
		],
	} as Parameters<StreamFn>[1];
}

function splitProviderModel(value: string): { provider: string; id: string } | undefined {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) return undefined;
	return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

function probeThinking(candidate: string): ThinkingLevel | undefined {
	const suffix = splitKnownThinkingSuffix(candidate).thinkingSuffix.slice(1);
	const thinking = THINKING_LEVELS.find((level) => level === suffix);
	return thinking && thinking !== "off" ? thinking : undefined;
}

async function probeAuth(context: ExtensionContext, model: RegistryModel): Promise<ProbeAuth> {
	const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(`Model performance probe auth failed for ${model.provider}/${model.id}: ${auth.error}`);
	const resolved: ProbeAuth = {};
	if (auth.apiKey) resolved.apiKey = auth.apiKey;
	if (auth.headers) resolved.headers = auth.headers;
	if (auth.env) resolved.env = auth.env;
	return resolved;
}

export interface PiModelPerformanceProbeExecutorOptions {
	streamFn?: StreamFn;
}

/** Execute one bounded, tool-free probe through Pi's authenticated model registry. */
export function createPiModelPerformanceProbeExecutor(
	context: ExtensionContext,
	options: PiModelPerformanceProbeExecutorOptions = {},
): ModelPerformanceProbeExecutor {
	return async (execution) => {
		const { baseModel } = splitKnownThinkingSuffix(execution.candidate);
		const named = splitProviderModel(baseModel);
		if (!named) throw new Error(`Model performance probe candidate '${execution.candidate}' must use provider/model form.`);
		const model = context.modelRegistry.find(named.provider, named.id);
		if (!model) throw new Error(`Model performance probe candidate '${baseModel}' was not found.`);
		const auth = await probeAuth(context, model);
		if (execution.signal.aborted) return;
		// SAFETY: Pi's runtime registry exposes this optional lookup even when the
		// compatibility declaration used by the extension omits it.
		const registeredProvider = (context.modelRegistry as typeof context.modelRegistry & {
			getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: StreamFn } | undefined;
		}).getRegisteredProviderConfig?.(model.provider);
		const providerStream = options.streamFn ?? (registeredProvider?.streamSimple && registeredProvider.api === model.api
			? registeredProvider.streamSimple
			: streamSimple);
		const sessionId = context.sessionManager.getSessionId();
		const requestContext = normalizeProbeContext(execution.prompt);
		const streamOptions: SimpleStreamOptions = {
			signal: execution.signal,
			maxTokens: Math.min(execution.maxEstimatedTokens, model.maxTokens),
			headers: { ...opencodeSessionHeaders(model, sessionId), ...auth.headers },
		};
		if (auth.apiKey) streamOptions.apiKey = auth.apiKey;
		if (auth.env) streamOptions.env = auth.env;
		const reasoning = probeThinking(execution.candidate);
		if (reasoning) streamOptions.reasoning = reasoning;
		const stream = await providerStream(model, requestContext, streamOptions);
		for await (const event of stream) {
			const delta = generationDeltaText(event);
			if (delta) execution.onDelta(delta);
		}
		const terminal = await stream.result();
		if (!execution.signal.aborted && (terminal.stopReason === "error" || terminal.stopReason === "aborted")) {
			throw new Error(terminal.errorMessage || `Model performance probe stopped with ${terminal.stopReason}.`);
		}
	};
}

export interface RunPiModelPerformanceProbesOptions {
	store?: ModelPerformanceStore;
	streamFn?: StreamFn;
	onResult?: (result: ModelPerformanceProbeResult, request: MainModelPerformanceProbeRequest) => void;
}

export function formatModelPerformanceProbeResult(result: ModelPerformanceProbeResult): string {
	if (result.status === "sampled") {
		return `Model probe ${result.candidate}: ${result.observation.ttftMs.toFixed(0)}ms first token, ${result.observation.estimatedTokensPerSecond.toFixed(1)} token/s.`;
	}
	if (result.status === "failed") return `Model probe ${result.candidate} failed: ${result.error}`;
	if (result.status === "timed-out") return `Model probe ${result.candidate} timed out.`;
	return `Model probe ${result.candidate} was cancelled.`;
}

export function createMainModelPerformanceProbe(
	options: RunPiModelPerformanceProbesOptions = {},
): (request: MainModelPerformanceProbeRequest) => Promise<void> {
	const store = options.store ?? new ModelPerformanceStore();
	return async (request) => {
		// SAFETY: Registration passes Pi's real ExtensionContext; the narrower public
		// runtime seam keeps advisory tests independent of host-only capabilities.
		const context = request.context as ExtensionContext;
		const executorOptions: PiModelPerformanceProbeExecutorOptions = {};
		if (options.streamFn) executorOptions.streamFn = options.streamFn;
		const warmOptions: WarmModelPerformanceCacheOptions = {
			key: request.key,
			candidates: request.candidates,
			config: request.config,
			store,
			execute: createPiModelPerformanceProbeExecutor(context, executorOptions),
		};
		if (context.signal) warmOptions.signal = context.signal;
		if (options.onResult) warmOptions.onResult = (result) => options.onResult?.(result, request);
		await warmModelPerformanceCache(warmOptions);
	};
}
