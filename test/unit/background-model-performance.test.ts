import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runSingleStepInner, runSubagent } from "../../src/runs/background/subagent-runner.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { createModelPerformanceCacheKey, ModelPerformanceStore } from "../../src/runs/shared/model-performance.ts";
import { MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS } from "../../src/runs/shared/model-performance-probe.ts";
import { clearExclusions, getExcludedCount } from "../../src/runs/shared/model-exclusions.ts";
import type { RunnerSubagentStep } from "../../src/runs/shared/parallel-utils.ts";

const performanceConfig = {
	firstTokenTimeoutMs: 45_000,
	hardTokensPerSecond: 2,
	softTokensPerSecond: 8,
	cacheTtlMs: 300_000,
};

function step(overrides: Partial<RunnerSubagentStep> = {}): RunnerSubagentStep {
	return {
		agent: "worker",
		task: "answer",
		model: "gateway/slow",
		modelCandidates: ["gateway/slow", "gateway/fast"],
		modelRouting: {
			modelClass: "smart",
			source: "per-run",
			poolDigest: "background-ranking-test",
			candidates: ["gateway/slow", "gateway/fast"],
		},
		modelPerformance: performanceConfig,
		inheritProjectContext: false,
		inheritGlobalContext: false,
		inheritSkills: false,
		...overrides,
	};
}

async function run(stepConfig: RunnerSubagentStep, options: {
	failFirst?: boolean;
	childSessions?: ChildSessionFactory;
	onAttemptStart?: (attempt: { model?: string }) => void;
	onModelPerformanceProbe?: (notice: { message: string }) => void;
	awaitBackgroundTasks?: boolean;
} = {}): Promise<{
	launched: string[];
	log: string;
	events: string;
	backgroundTasks: Promise<void>[];
	result: Awaited<ReturnType<typeof runSingleStepInner>>;
}> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "background-model-ranking-"));
	const launched: string[] = [];
	const backgroundTasks: Promise<void>[] = [];
	const childSessions: ChildSessionFactory = {
		supportsModelPerformanceProbes: options.childSessions?.supportsModelPerformanceProbes,
		async create(input) {
			launched.push(input.model ?? "default");
			if (options.childSessions) return options.childSessions.create(input);
			const fail = options.failFirst === true && launched.length === 1;
			let listener: ((event: ChildSessionEvent) => void) | undefined;
			return {
				subscribe(next) { listener = next; return () => { listener = undefined; }; },
				async prompt() {
					const message = {
						role: "assistant",
						api: "openai-completions",
						provider: "gateway",
						model: input.model,
						stopReason: fail ? "error" : "stop",
						content: fail ? [] : [{ type: "text", text: "done" }],
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					};
					if (fail) Object.assign(message, { errorMessage: "503 service unavailable" });
					listener?.({
						type: "message_end",
						message,
					});
				},
				async steer() {},
				async followUp() {},
				async abort() {},
				async dispose() {},
				messages: [],
				sessionFile: undefined,
				sessionId: "background-model-ranking",
				modelId: input.model,
			};
		},
		async dispose() { await options.childSessions?.dispose(); },
	};
	try {
		const outputFile = path.join(cwd, "output.log");
		const result = await runSingleStepInner(stepConfig, {
			cwd,
			id: "background-model-ranking",
			flatIndex: 0,
			flatStepCount: 1,
			previousOutput: "",
			placeholder: "{previous}",
			outputFile,
			sessionEnabled: false,
			childSessions,
			onAttemptStart: options.onAttemptStart,
			onModelPerformanceProbe: options.onModelPerformanceProbe,
			registerBackgroundTask: (task) => backgroundTasks.push(task),
		});
		if (options.awaitBackgroundTasks !== false) await Promise.all(backgroundTasks);
		const eventsPath = path.join(cwd, "events.jsonl");
		return {
			launched,
			log: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf-8") : "",
			events: fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, "utf-8") : "",
			backgroundTasks,
			result,
		};
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

describe("background model performance selection", () => {
	it("starts a model-class child with the fastest fresh cached candidate using default settings", async () => {
		const configured = step({ modelPerformance: undefined });
		const key = createModelPerformanceCacheKey(configured.modelRouting!, configured.modelCandidates!);
		const now = Date.now();
		const store = new ModelPerformanceStore();
		store.record(key, { candidate: "gateway/slow", recordedAt: now, ttftMs: 2_000, estimatedTokensPerSecond: 2, source: "run" });
		store.record(key, { candidate: "gateway/fast", recordedAt: now, ttftMs: 100, estimatedTokensPerSecond: 40, source: "run" });

		const { launched, result } = await run(configured);

		assert.deepEqual(launched, ["gateway/fast"]);
		assert.equal(result.exitCode, 0, result.error);
		assert.deepEqual(result.modelRouting?.candidates, ["gateway/slow", "gateway/fast"]);
	});

	it("keeps an exact-model child on its configured model", async () => {
		const configured = step({ modelRouting: undefined });

		const { launched, result } = await run(configured);

		assert.deepEqual(launched, ["gateway/slow"]);
		assert.equal(result.exitCode, 0, result.error);
	});

	it("starts the primary immediately while a cold alternative is probed in the background", { timeout: 2_000 }, async () => {
		const candidates = ["gateway/cold-primary", "gateway/cold-faster"];
		const routing = { modelClass: "smart", source: "per-run" as const, poolDigest: "background-cold-probe", candidates };
		const cacheKey = createModelPerformanceCacheKey(routing, candidates);
		const store = new ModelPerformanceStore();
		for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		let releaseProbe: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
		let markProbeStarted: (() => void) | undefined;
		const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
		const launches: Array<{ model?: string; probe: boolean }> = [];
		const promptOrder: string[] = [];
		const factory: ChildSessionFactory = {
			supportsModelPerformanceProbes: true,
			async create(launch) {
				const probe = launch.maxOutputTokens !== undefined;
				launches.push({ model: launch.model, probe });
				if (!probe) await new Promise<void>((resolve) => setTimeout(resolve, 20));
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				const messages: unknown[] = [];
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						promptOrder.push(probe ? "probe" : "primary");
						if (probe) {
							markProbeStarted?.();
							await probeGate;
							listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "fast probe output" } });
							messages.push({ role: "assistant", content: [{ type: "text", text: "fast probe output" }], stopReason: "stop" });
							return;
						}
						listener?.({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: `task completed on ${launch.model}` }], model: launch.model, stopReason: "stop",
							usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
					get messages() {
						// SAFETY: This local fixture only appends Pi-compatible assistant messages above.
						return messages as ChildSession["messages"];
					},
					sessionFile: undefined, sessionId: `cold-${launch.model}`, modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const configured = step({ model: candidates[0], modelCandidates: candidates, modelRouting: routing });
		let deadline: NodeJS.Timeout | undefined;
		try {
			const firstRun = run(configured, { childSessions: factory, awaitBackgroundTasks: false });
			const first = await Promise.race([
				firstRun,
				new Promise<never>((_resolve, reject) => {
					deadline = setTimeout(() => reject(new Error("primary task waited for the background probe")), 500);
				}),
			]);
			if (deadline) clearTimeout(deadline);
			assert.equal(first.result.output, `task completed on ${candidates[0]}`);
			assert.equal(first.backgroundTasks.length, 1);
			await probeStarted;
			assert.deepEqual(launches.slice(0, 2), [
				{ model: candidates[0], probe: false },
				{ model: candidates[1], probe: true },
			]);
			assert.deepEqual(promptOrder.slice(0, 2), ["primary", "probe"]);
			releaseProbe?.();
			await Promise.all(first.backgroundTasks);
			assert.deepEqual(store.read(cacheKey, performanceConfig.cacheTtlMs).map(({ candidate }) => candidate), [candidates[1]]);

			const second = await run(configured, { childSessions: factory });
			assert.equal(second.launched[0], candidates[1], "the next task should use the warmed alternative");
			assert.equal(second.result.output, `task completed on ${candidates[1]}`);
		} finally {
			if (deadline) clearTimeout(deadline);
			releaseProbe?.();
			for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		}
	});

	it("records safe cold-cache probe outcomes without changing the parent result", async () => {
		const candidates = ["gateway/probe-primary", "gateway/probe-cached", "gateway/probe-success", "gateway/probe-failure"];
		const routing = { modelClass: "smart", source: "per-run" as const, poolDigest: "background-probe-observability", candidates };
		const cacheKey = createModelPerformanceCacheKey(routing, candidates);
		const store = new ModelPerformanceStore();
		for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		store.record(cacheKey, {
			candidate: candidates[0]!, recordedAt: Date.now(), ttftMs: 20, estimatedTokensPerSecond: 50, source: "run",
		});
		store.record(cacheKey, {
			candidate: candidates[1]!, recordedAt: Date.now(), ttftMs: 500, estimatedTokensPerSecond: 10, source: "run",
		});
		const probeLaunches: Parameters<ChildSessionFactory["create"]>[0][] = [];
		const notices: string[] = [];
		const factory: ChildSessionFactory = {
			supportsModelPerformanceProbes: true,
			async create(launch) {
				const probe = launch.maxOutputTokens !== undefined;
				if (probe) probeLaunches.push(launch);
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				const messages: unknown[] = [];
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						if (!probe) {
							listener?.({ type: "message_end", message: {
								role: "assistant", content: [{ type: "text", text: "main task completed" }], model: launch.model, stopReason: "stop",
								usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
							} });
							return;
						}
						if (launch.model === candidates[3]) throw new Error("probe backend unavailable");
						listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "measured probe output" } });
						messages.push({ role: "assistant", content: [{ type: "text", text: "measured probe output" }], stopReason: "stop" });
					},
					async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
					get messages() {
						// SAFETY: This local fixture only appends Pi-compatible assistant messages above.
						return messages as ChildSession["messages"];
					},
					sessionFile: undefined, sessionId: `probe-${launch.model}`, modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		try {
			const { result, log, events } = await run(step({
				model: candidates[0], modelCandidates: candidates, modelRouting: routing,
			}), {
				childSessions: factory,
				onModelPerformanceProbe: ({ message }) => notices.push(message),
			});

			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "main task completed");
			assert.doesNotMatch(result.output, /performance probe/i);
			assert.deepEqual(probeLaunches.map(({ model }) => model), [candidates[2], candidates[3]]);
			for (const launch of probeLaunches) {
				assert.deepEqual(launch.storage, { kind: "memory" });
				assert.equal(launch.maxOutputTokens, MODEL_PERFORMANCE_PROBE_MAX_ESTIMATED_TOKENS);
				assert.deepEqual(launch.tools, []);
				assert.deepEqual(launch.extensionPaths, []);
				assert.equal(launch.ambientExtensions, false);
				assert.deepEqual(launch.hooks, []);
				assert.equal(launch.noSkills, true);
				assert.equal(launch.noContextFiles, true);
			}
			assert.equal(notices.length, 3);
			assert.match(notices[0]!, /probing 2 unmeasured alternatives/i);
			assert.ok(notices.some((line) => /probe-success.*sampled/i.test(line)));
			assert.ok(notices.some((line) => /probe-failure.*failed/i.test(line)));
			assert.match(log, /probing 2 unmeasured alternatives/i);
			assert.match(log, /probe-success.*sampled/i);
			assert.match(log, /probe-failure.*failed/i);
			assert.match(events, /subagent\.model-performance-probe\.started/);
			assert.match(events, /subagent\.model-performance-probe\.result/);
			assert.deepEqual(
				store.read(cacheKey, performanceConfig.cacheTtlMs).map(({ candidate }) => candidate).sort(),
				[candidates[0], candidates[1], candidates[2]].sort(),
			);
		} finally {
			for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		}
	});

	it("publishes the runner result before draining probes and disposes afterward", { timeout: 3_000 }, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "background-probe-lifecycle-"));
		const asyncDir = path.join(cwd, "async");
		const resultPath = path.join(asyncDir, "result.json");
		const candidates = ["gateway/lifecycle-primary", "gateway/lifecycle-alternative"];
		const routing = { modelClass: "smart", source: "per-run" as const, poolDigest: "background-probe-lifecycle", candidates };
		const cacheKey = createModelPerformanceCacheKey(routing, candidates);
		const store = new ModelPerformanceStore();
		for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		let releaseProbe: (() => void) | undefined;
		const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
		let factoryDisposed = false;
		const factory: ChildSessionFactory = {
			supportsModelPerformanceProbes: true,
			async create(launch) {
				const probe = launch.maxOutputTokens !== undefined;
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				const messages: unknown[] = [];
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						if (probe) {
							await probeGate;
							listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lifecycle probe output" } });
							messages.push({ role: "assistant", content: [{ type: "text", text: "lifecycle probe output" }], stopReason: "stop" });
							return;
						}
						listener?.({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: "published primary result" }], model: launch.model, stopReason: "stop",
							usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
					get messages() {
						// SAFETY: This local fixture only appends Pi-compatible assistant messages above.
						return messages as ChildSession["messages"];
					},
					sessionFile: undefined, sessionId: `lifecycle-${launch.model}`, modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() { factoryDisposed = true; },
		};
		let runSettled = false;
		try {
			const running = runSubagent({
				id: "background-probe-lifecycle",
				cwd,
				asyncDir,
				resultPath,
				placeholder: "{previous}",
				sessionId: "background-probe-parent-session",
				steps: [step({ model: candidates[0], modelCandidates: candidates, modelRouting: routing })],
			}, factory).finally(() => { runSettled = true; });
			for (let attempt = 0; attempt < 100 && !fs.existsSync(resultPath); attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.equal(fs.existsSync(resultPath), true, "the primary result should publish while the probe is pending");
			assert.equal(runSettled, false);
			assert.equal(factoryDisposed, false);
			const published = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
			assert.equal(published.results[0].output, "published primary result");
			releaseProbe?.();
			await running;
			assert.equal(factoryDisposed, true);
			const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8"));
			const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf-8");
			assert.ok(
				status.steps[0].recentOutput.some((line: string) => /lifecycle-alternative.*sampled/i.test(line)),
				JSON.stringify({ recentOutput: status.steps[0].recentOutput, events }),
			);
			assert.match(events, /subagent\.model-performance-probe\.result/);
			assert.deepEqual(store.read(cacheKey, performanceConfig.cacheTtlMs).map(({ candidate }) => candidate), [candidates[1]]);
		} finally {
			releaseProbe?.();
			for (const candidate of candidates) store.invalidate(cacheKey, candidate);
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not probe when the child-session factory lacks probe capability", async () => {
		const candidates = ["gateway/gated-primary", "gateway/gated-alternative"];
		const { launched, backgroundTasks, result } = await run(step({
			model: candidates[0], modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-probe-gate", candidates },
		}));

		assert.equal(result.exitCode, 0, result.error);
		assert.deepEqual(launched, [candidates[0]]);
		assert.deepEqual(backgroundTasks, []);
	});

	it("does not cool down a failed model-class candidate across tasks", async () => {
		clearExclusions();
		const configured = step({
			model: "gateway/no-cooldown-a",
			modelCandidates: ["gateway/no-cooldown-a", "gateway/no-cooldown-b"],
			modelRouting: {
				modelClass: "smart",
				source: "per-run",
				poolDigest: "background-no-cooldown-test",
				candidates: ["gateway/no-cooldown-a", "gateway/no-cooldown-b"],
			},
		});

		const { launched, result } = await run(configured, { failFirst: true });

		assert.deepEqual(launched, ["gateway/no-cooldown-a", "gateway/no-cooldown-b"]);
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(getExcludedCount(), 0);
	});

	it("retries a hard-stalled incomplete response in the same child session", { timeout: 2_000 }, async () => {
		const candidates = ["gateway/hard-slow", "gateway/hard-fast"];
		let creations = 0;
		const retries: string[] = [];
		let retryGuardObserved = false;
		const statusModels: Array<string | undefined> = [];
		const factory: ChildSessionFactory = {
			async create(launch) {
				creations++;
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				let releaseInitial: (() => void) | undefined;
				let initialPending = false;
				let activeModel = launch.model;
				const messages: unknown[] = [];
				const emit = (event: ChildSessionEvent) => listener?.(event);
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						initialPending = true;
						emit({ type: "agent_start" });
						emit({ type: "turn_start" });
						await new Promise<void>((resolve) => { releaseInitial = resolve; });
					},
					async abort() {
						if (!initialPending) return;
						initialPending = false;
						const aborted = {
							role: "assistant", content: [{ type: "text", text: "discard this partial response" }], model: activeModel,
							stopReason: "aborted", errorMessage: "aborted",
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						};
						messages.push(aborted);
						emit({ type: "message_end", message: aborted });
						emit({ type: "turn_end", message: aborted, toolResults: [] });
						emit({ type: "agent_end", messages: [aborted] });
						emit({ type: "agent_settled" });
						releaseInitial?.();
					},
					async retryCurrentResponseWithModel(model, canContinue) {
						assert.ok(canContinue);
						assert.equal(canContinue(), true);
						retryGuardObserved = true;
						retries.push(model);
						activeModel = model;
						emit({ type: "agent_start" });
						emit({ type: "turn_start" });
						const completed = {
							role: "assistant", content: [{ type: "text", text: "completed on hard-fast" }], model,
							stopReason: "stop",
							usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						};
						messages.push(completed);
						emit({ type: "message_end", message: completed });
						emit({ type: "turn_end", message: completed, toolResults: [] });
						emit({ type: "agent_end", messages: [completed] });
						emit({ type: "agent_settled" });
					},
					async switchModelForNextResponse() {},
					async steer() {},
					async followUp() {},
					async dispose() {},
					get messages() {
						// SAFETY: This local fixture only appends Pi-compatible assistant messages above.
						return messages as ChildSession["messages"];
					},
					sessionFile: undefined,
					sessionId: "background-hard-switch",
					get modelId() { return activeModel; },
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const configured = step({
			model: candidates[0], modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-hard-switch", candidates },
			modelPerformance: { ...performanceConfig, firstTokenTimeoutMs: 20 },
		});
		const cacheKey = createModelPerformanceCacheKey(configured.modelRouting!, candidates);
		const store = new ModelPerformanceStore();
		store.record(cacheKey, { candidate: candidates[0]!, recordedAt: Date.now(), ttftMs: 500, estimatedTokensPerSecond: 3, source: "run" });
		const keepAlive = setInterval(() => {}, 100);
		try {
			const { launched, log, result } = await run(configured, {
				childSessions: factory,
				onAttemptStart: ({ model }) => statusModels.push(model),
			});
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "completed on hard-fast");
			assert.doesNotMatch(result.output, /discard this partial response/);
			assert.equal(result.model, candidates[1]);
			assert.deepEqual(result.attemptedModels, candidates);
			assert.equal(result.modelAttempts?.[0]?.failoverReason, "performance:hard");
			assert.deepEqual(launched, [candidates[0]]);
			assert.deepEqual(retries, [candidates[1]]);
			assert.equal(retryGuardObserved, true);
			assert.equal(creations, 1);
			assert.deepEqual(statusModels, candidates);
			assert.match(log, /model performance.*retrying the incomplete response/i);
			assert.equal(store.read(cacheKey, performanceConfig.cacheTtlMs).some(({ candidate }) => candidate === candidates[0]), false);
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("caches a real throughput sample before retrying a hard-slow response", async () => {
		const realNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const candidates = ["gateway/hard-rate-slow", "gateway/hard-rate-fast"];
		const factory: ChildSessionFactory = {
			async create(launch) {
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				let releaseInitial: (() => void) | undefined;
				let activeModel = launch.model;
				const emit = (event: ChildSessionEvent) => listener?.(event);
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						const aborted = new Promise<void>((resolve) => { releaseInitial = resolve; });
						emit({ type: "turn_start" });
						for (let second = 1; second <= 21; second++) {
							now = second * 1_000;
							emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "xxxx" } });
						}
						await aborted;
					},
					async abort() {
						const aborted = {
							role: "assistant", content: [{ type: "text", text: "discard hard-rate partial" }], model: activeModel,
							stopReason: "aborted", errorMessage: "aborted",
							usage: { input: 1, output: 21, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						};
						emit({ type: "message_end", message: aborted });
						releaseInitial?.();
					},
					async retryCurrentResponseWithModel(model, canContinue) {
						assert.equal(canContinue?.(), true);
						activeModel = model;
						now = 22_000;
						emit({ type: "turn_start" });
						emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "completed quickly" } });
						now = 23_000;
						emit({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: "completed after hard-rate retry" }], model,
							stopReason: "stop",
							usage: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async switchModelForNextResponse() {},
					async steer() {}, async followUp() {}, async dispose() {},
					messages: [], sessionFile: undefined, sessionId: "background-hard-rate-switch",
					get modelId() { return activeModel; },
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const configured = step({
			model: candidates[0], modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-hard-rate-switch", candidates },
		});
		const cacheKey = createModelPerformanceCacheKey(configured.modelRouting!, candidates);
		const store = new ModelPerformanceStore();
		for (const candidate of candidates) store.invalidate(cacheKey, candidate);

		try {
			const { result } = await run(configured, { childSessions: factory });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "completed after hard-rate retry");
			assert.deepEqual(
				store.read(cacheKey, performanceConfig.cacheTtlMs).map(({ candidate, source }) => ({ candidate, source })),
				[...candidates].sort().map((candidate) => ({ candidate, source: "run" })),
			);
		} finally {
			Date.now = realNow;
			for (const candidate of candidates) store.invalidate(cacheKey, candidate);
		}
	});

	it("does not launch a model twice after an in-session performance switch", { timeout: 2_000 }, async () => {
		const candidates = ["gateway/once-a", "gateway/once-b", "gateway/once-c"];
		const createdModels: string[] = [];
		const retriedModels: string[] = [];
		const factory: ChildSessionFactory = {
			async create(launch) {
				createdModels.push(launch.model!);
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				let releaseInitial: (() => void) | undefined;
				const emit = (event: ChildSessionEvent) => listener?.(event);
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						if (launch.model === candidates[0]) {
							const aborted = new Promise<void>((resolve) => { releaseInitial = resolve; });
							emit({ type: "turn_start" });
							await aborted;
							return;
						}
						emit({ type: "turn_start" });
						emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done on c" } });
						emit({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: "done on c" }], model: launch.model, stopReason: "stop",
							usage: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async abort() { releaseInitial?.(); },
					async retryCurrentResponseWithModel(model, canContinue) {
						assert.equal(canContinue?.(), true);
						retriedModels.push(model);
						emit({ type: "turn_start" });
						emit({ type: "message_end", message: {
							role: "assistant", content: [], model, stopReason: "error", errorMessage: "503 service unavailable",
							usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async switchModelForNextResponse() {},
					async steer() {}, async followUp() {}, async dispose() {},
					messages: [], sessionFile: undefined, sessionId: `background-once-${launch.model}`, modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const configured = step({
			model: candidates[0], modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-candidate-once", candidates },
			modelPerformance: { ...performanceConfig, firstTokenTimeoutMs: 20 },
		});

		const keepAlive = setInterval(() => {}, 100);
		try {
			const { result } = await run(configured, { childSessions: factory });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "done on c");
			assert.deepEqual(createdModels, [candidates[0], candidates[2]]);
			assert.deepEqual(retriedModels, [candidates[1]]);
			assert.deepEqual(result.attemptedModels, candidates);
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("retains a soft-slow tool response and switches before the next response", async () => {
		const realNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const candidates = ["gateway/soft-slow", "gateway/soft-fast"];
		const switches: string[] = [];
		const factory: ChildSessionFactory = {
			async create(launch) {
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				let activeModel = launch.model;
				const messages: unknown[] = [];
				const emit = (event: ChildSessionEvent) => listener?.(event);
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						emit({ type: "agent_start" });
						emit({ type: "turn_start" });
						for (let second = 1; second <= 31; second++) {
							now = second * 1_000;
							emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(20) } });
						}
						const toolCall = {
							role: "assistant",
							content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } }],
							model: activeModel, stopReason: "toolUse",
							usage: { input: 2, output: 155, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						};
						messages.push(toolCall);
						emit({ type: "message_end", message: toolCall });
						emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } });
						assert.deepEqual(switches, [], "soft degradation must wait until the current turn finishes");
						const toolResult = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "retained tool result" }] };
						messages.push(toolResult);
						emit({ type: "tool_result_end", toolCallId: "read-1", toolName: "read", message: toolResult });
						emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read" });
						emit({ type: "turn_end", message: toolCall, toolResults: [toolResult] });
						now = 32_000;
						emit({ type: "turn_start" });
						emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "completed quickly" } });
						now = 33_000;
						const completed = {
							role: "assistant", content: [{ type: "text", text: "completed after retained tool result" }], model: activeModel,
							stopReason: "stop",
							usage: { input: 3, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						};
						messages.push(completed);
						emit({ type: "message_end", message: completed });
						emit({ type: "turn_end", message: completed, toolResults: [] });
						emit({ type: "agent_end", messages: [toolCall, toolResult, completed] });
						emit({ type: "agent_settled" });
					},
					async switchModelForNextResponse(model) { switches.push(model); activeModel = model; },
					async retryCurrentResponseWithModel() { throw new Error("hard retry was not expected"); },
					async steer() {},
					async followUp() {},
					async abort() {},
					async dispose() {},
					get messages() {
						// SAFETY: This local fixture only appends Pi-compatible assistant and tool-result messages above.
						return messages as ChildSession["messages"];
					},
					sessionFile: undefined,
					sessionId: "background-soft-switch",
					get modelId() { return activeModel; },
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const configured = step({
			model: candidates[0], modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-soft-switch", candidates },
		});
		const cacheKey = createModelPerformanceCacheKey(configured.modelRouting!, candidates);

		try {
			const { result } = await run(configured, { childSessions: factory });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "completed after retained tool result");
			assert.equal(result.model, candidates[1]);
			assert.deepEqual(result.attemptedModels, candidates);
			assert.equal(result.modelAttempts?.[0]?.failoverReason, "performance:soft");
			assert.deepEqual(switches, [candidates[1]]);
			assert.deepEqual(
				new ModelPerformanceStore().read(cacheKey, performanceConfig.cacheTtlMs).map(({ candidate, source }) => ({ candidate, source })),
				[
					{ candidate: "gateway/soft-fast", source: "run" },
					{ candidate: "gateway/soft-slow", source: "run" },
				],
			);
		} finally {
			Date.now = realNow;
		}
	});

	it("does not rerun a completed final response only because it was soft-slow", async () => {
		const realNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		const candidates = ["gateway/final-slow", "gateway/final-unused"];
		const switches: string[] = [];
		const factory: ChildSessionFactory = {
			async create(launch) {
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						listener?.({ type: "turn_start" });
						for (let second = 1; second <= 31; second++) {
							now = second * 1_000;
							listener?.({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(20) } });
						}
						listener?.({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: "slow but complete" }], model: launch.model, stopReason: "stop",
							usage: { input: 1, output: 155, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async switchModelForNextResponse(model) { switches.push(model); },
					async retryCurrentResponseWithModel(model) { switches.push(model); },
					async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
					messages: [], sessionFile: undefined, sessionId: "background-final-slow", modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		try {
			const { result } = await run(step({
				model: candidates[0], modelCandidates: candidates,
				modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-final-slow", candidates },
			}), { childSessions: factory });
			assert.equal(result.exitCode, 0, result.error);
			assert.equal(result.output, "slow but complete");
			assert.deepEqual(switches, []);
			assert.deepEqual(result.attemptedModels, [candidates[0]]);
		} finally {
			Date.now = realNow;
		}
	});

	it("lets the last candidate continue through a hard stall", { timeout: 1_000 }, async () => {
		const candidate = "gateway/only-candidate";
		let aborts = 0;
		let retries = 0;
		const factory: ChildSessionFactory = {
			async create(launch) {
				let listener: ((event: ChildSessionEvent) => void) | undefined;
				return {
					subscribe(next) { listener = next; return () => { listener = undefined; }; },
					async prompt() {
						listener?.({ type: "turn_start" });
						await new Promise((resolve) => setTimeout(resolve, 40));
						listener?.({ type: "message_end", message: {
							role: "assistant", content: [{ type: "text", text: "eventually completed" }], model: launch.model, stopReason: "stop",
							usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
						} });
					},
					async switchModelForNextResponse() {},
					async retryCurrentResponseWithModel() { retries++; },
					async steer() {}, async followUp() {}, async abort() { aborts++; }, async dispose() {},
					messages: [], sessionFile: undefined, sessionId: "background-last-candidate", modelId: launch.model,
				} satisfies ChildSession;
			},
			async dispose() {},
		};
		const candidates = [candidate];
		const { result } = await run(step({
			model: candidate, modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "background-last-candidate", candidates },
			modelPerformance: { ...performanceConfig, firstTokenTimeoutMs: 10 },
		}), { childSessions: factory });
		assert.equal(result.exitCode, 0, result.error);
		assert.equal(result.output, "eventually completed");
		assert.equal(aborts, 0);
		assert.equal(retries, 0);
	});
});
