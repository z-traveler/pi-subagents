import {
	type ModelPerformanceCacheKey,
	type ModelPerformanceConfig,
	type ModelPerformanceObservation,
	ModelPerformanceStore,
} from "./model-performance.ts";

export const MODEL_PERFORMANCE_PROBE_TIMEOUT_MS = 15_000;
export const MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS = 64;
export const MODEL_PERFORMANCE_PROBE_PROMPT =
	"Write a continuous plain-text sequence of varied, unrelated English words. Do not explain or format it; keep writing until the response is stopped.";
const MODEL_PERFORMANCE_PROBE_CONCURRENCY = 2;
const MODEL_PERFORMANCE_PROBE_SLOT_LEASE_MS = MODEL_PERFORMANCE_PROBE_TIMEOUT_MS * 2;
const MODEL_PERFORMANCE_PROBE_SLOT_INITIAL_POLL_MS = 50;
const MODEL_PERFORMANCE_PROBE_SLOT_MAX_POLL_MS = 500;

function waitForProbeSlot(delayMs: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		const timeout = setTimeout(() => finish(true), delayMs);
		const cancel = () => finish(false);
		const finish = (retry: boolean) => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", cancel);
			resolve(retry);
		};
		signal?.addEventListener("abort", cancel, { once: true });
	});
}

interface AcquiredProbeSlot {
	readonly lost: AbortSignal;
	refresh(): boolean;
	release(): void;
}

async function acquireProbeSlot(
	store: ModelPerformanceStore,
	heartbeatMs: number,
	signal?: AbortSignal,
): Promise<AcquiredProbeSlot | undefined> {
	let pollMs = MODEL_PERFORMANCE_PROBE_SLOT_INITIAL_POLL_MS;
	while (!signal?.aborted) {
		const claim = store.claimProbeSlot(MODEL_PERFORMANCE_PROBE_SLOT_LEASE_MS, MODEL_PERFORMANCE_PROBE_CONCURRENCY);
		if (claim) {
			const lost = new AbortController();
			const refresh = (): boolean => {
				const owned = store.refreshProbeSlot(claim);
				if (!owned) lost.abort();
				return owned;
			};
			const heartbeat = setInterval(refresh, heartbeatMs);
			heartbeat.unref();
			let released = false;
			return {
				lost: lost.signal,
				refresh,
				release() {
					if (released) return;
					released = true;
					clearInterval(heartbeat);
					store.releaseProbeSlot(claim);
				},
			};
		}
		if (!await waitForProbeSlot(pollMs, signal)) return undefined;
		pollMs = Math.min(MODEL_PERFORMANCE_PROBE_SLOT_MAX_POLL_MS, pollMs * 2);
	}
	return undefined;
}

export interface ModelPerformanceProbeExecution {
	candidate: string;
	signal: AbortSignal;
	prompt: string;
	maxEstimatedTokens: number;
	onDelta(delta: string): void;
}

/**
 * System boundary for one paid model request. Implementations must disable all
 * tools, use the supplied prompt/output bound, forward generation deltas, and
 * stop their provider stream promptly when `signal` aborts.
 */
export type ModelPerformanceProbeExecutor = (execution: ModelPerformanceProbeExecution) => Promise<void>;

export type ModelPerformanceProbeResult =
	| { candidate: string; status: "sampled"; observation: ModelPerformanceObservation }
	| { candidate: string; status: "failed"; error: string }
	| { candidate: string; status: "cancelled" }
	| { candidate: string; status: "timed-out" };

export interface WarmModelPerformanceCacheOptions {
	key: ModelPerformanceCacheKey;
	candidates: readonly string[];
	config: ModelPerformanceConfig;
	store: ModelPerformanceStore;
	execute: ModelPerformanceProbeExecutor;
	signal?: AbortSignal;
	now?: () => number;
	/** Internal/test override; normal callers use the fixed 15 second probe bound. */
	timeoutMs?: number;
	onResult?: (result: ModelPerformanceProbeResult) => void;
}

async function probeCandidate(
	options: WarmModelPerformanceCacheOptions,
	candidate: string,
	now: () => number,
	timeoutMs: number,
	trackExecution: (settled: Promise<void>) => void,
): Promise<ModelPerformanceProbeResult | undefined> {
	const slotHeartbeatMs = Math.max(1, Math.min(
		MODEL_PERFORMANCE_PROBE_SLOT_LEASE_MS / 3,
		Math.floor(timeoutMs / 3),
	));
	const slot = await acquireProbeSlot(options.store, slotHeartbeatMs, options.signal);
	if (!slot) return undefined;
	if (!options.store.refreshProbe(options.key)) {
		slot.release();
		return undefined;
	}
	const probeGuard = options.store.beginProbe(options.key, candidate);
	if (!probeGuard) {
		slot.release();
		return undefined;
	}
	const report = <T extends ModelPerformanceProbeResult>(result: T): T => {
		try {
			options.onResult?.(result);
		} catch {
			// Human-facing observers are best-effort and may outlive their UI context.
		}
		return result;
	};
	const startedAt = now();
	let firstOutputAt: number | undefined;
	let characters = 0;
	const controller = new AbortController();
	let boundedAt: number | undefined;
	let finishBound: (status: "cancelled" | "timed-out" | "token-limit") => void = () => {};
	const bound = new Promise<"cancelled" | "timed-out" | "token-limit">((resolve) => { finishBound = resolve; });
	const stop = (status: "cancelled" | "timed-out" | "token-limit") => {
		if (boundedAt !== undefined) return;
		boundedAt = now();
		finishBound(status);
		controller.abort();
	};
	const cancel = () => stop("cancelled");
	options.signal?.addEventListener("abort", cancel, { once: true });
	slot.lost.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => stop("timed-out"), timeoutMs);
	let execution: Promise<
		{ status: "completed" } | { status: "failed"; error: string }
	> | undefined;
	let finishResultProcessing: () => void = () => {};
	const resultProcessing = new Promise<void>((resolve) => { finishResultProcessing = resolve; });
	try {
		if (options.signal?.aborted || slot.lost.aborted || !slot.refresh()) {
			slot.release();
			return report({ candidate, status: "cancelled" });
		}
		execution = Promise.resolve().then(() => options.execute({
			candidate,
			signal: controller.signal,
			prompt: MODEL_PERFORMANCE_PROBE_PROMPT,
			maxEstimatedTokens: MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS,
			onDelta(delta) {
				if (!delta || controller.signal.aborted) return;
				firstOutputAt ??= now();
				const characterLimit = MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS * 4;
				characters += Math.min(delta.length, characterLimit - characters);
				if (characters / 4 >= MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS) stop("token-limit");
			},
		})).then(
			() => ({ status: "completed" as const }),
			(error) => ({
				status: "failed" as const,
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		trackExecution(Promise.all([execution, resultProcessing]).then(() => slot.release()));
		const outcome = await Promise.race([
			execution,
			bound.then((status) => ({ status })),
		]);
		if (outcome.status === "cancelled") return report({ candidate, status: "cancelled" });
		if (outcome.status === "failed") return report({ candidate, status: "failed", error: outcome.error });
		if (firstOutputAt === undefined || characters === 0) {
			return outcome.status === "timed-out"
				? report({ candidate, status: "timed-out" })
				: report({ candidate, status: "failed", error: "Probe completed without model output." });
		}
		const recordedAt = boundedAt ?? now();
		const observation: ModelPerformanceObservation = {
			candidate,
			recordedAt,
			ttftMs: firstOutputAt - startedAt,
			estimatedTokensPerSecond: characters / 4 * 1_000 / Math.max(1, recordedAt - firstOutputAt),
			source: "probe",
		};
		if (!options.store.refreshProbe(options.key) || !slot.refresh()) {
			stop("cancelled");
			return report({ candidate, status: "cancelled" });
		}
		if (!options.store.recordProbe(options.key, observation, probeGuard, options.config.cacheTtlMs)) return undefined;
		return report({ candidate, status: "sampled", observation });
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", cancel);
		slot.lost.removeEventListener("abort", cancel);
		finishResultProcessing();
		if (!execution) slot.release();
	}
}

export async function warmModelPerformanceCache(
	options: WarmModelPerformanceCacheOptions,
): Promise<ModelPerformanceProbeResult[]> {
	const fresh = new Set(options.store.read(options.key, options.config.cacheTtlMs).map(({ candidate }) => candidate));
	const candidates = options.candidates.filter((candidate) => !fresh.has(candidate));
	if (candidates.length === 0) return [];
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? MODEL_PERFORMANCE_PROBE_TIMEOUT_MS;
	const probeLeaseMs = Math.max(1, timeoutMs) * candidates.length;
	if (!options.store.claimProbe(options.key, probeLeaseMs)) return [];
	const controller = new AbortController();
	const cancel = () => controller.abort();
	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });
	const activeOptions = { ...options, signal: controller.signal };
	const heartbeat = setInterval(
		() => { if (!options.store.refreshProbe(options.key)) controller.abort(); },
		Math.max(1, Math.floor(probeLeaseMs / 3)),
	);
	heartbeat.unref();
	const executions: Promise<void>[] = [];
	let leaseReleased = false;
	const releaseLease = () => {
		if (leaseReleased) return;
		leaseReleased = true;
		clearInterval(heartbeat);
		options.signal?.removeEventListener("abort", cancel);
		options.store.releaseProbe(options.key);
	};
	try {
		const results = Array.from<ModelPerformanceProbeResult | undefined>({ length: candidates.length });
		let nextCandidateIndex = 0;
		const runWorker = async (): Promise<void> => {
			while (nextCandidateIndex < candidates.length) {
				const candidateIndex = nextCandidateIndex++;
				const candidate = candidates[candidateIndex];
				if (candidate === undefined) return;
				results[candidateIndex] = await probeCandidate(
					activeOptions,
					candidate,
					now,
					timeoutMs,
					(settled) => executions.push(settled),
				);
			}
		};
		await Promise.all(Array.from(
			{ length: Math.min(MODEL_PERFORMANCE_PROBE_CONCURRENCY, candidates.length) },
			() => runWorker(),
		));
		return results.filter((result): result is ModelPerformanceProbeResult => result !== undefined);
	} finally {
		// A bounded result may precede a provider executor that is still honoring
		// abort. Keep the same-key lease until every paid request has actually exited.
		try {
			await Promise.allSettled(executions);
		} finally {
			releaseLease();
		}
	}
}
