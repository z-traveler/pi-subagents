import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	DEFAULT_MODEL_PERFORMANCE_CONFIG,
	GenerationPerformanceMonitor,
	ModelClassPerformanceTracker,
	ModelPerformanceStore,
	generationDeltaText,
	rankModelCandidates,
	type ModelPerformanceCacheKey,
} from "../../src/runs/shared/model-performance.ts";

const cacheKey: ModelPerformanceCacheKey = {
	modelClass: "smart",
	poolDigest: "pool-v1",
	candidates: ["gateway/a:high", "gateway/b:high", "gateway/c:high"],
	protocolVersion: 1,
};

let cacheRoot = "";

beforeEach(() => {
	cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-performance-"));
});

afterEach(() => {
	fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("generation performance monitoring", () => {
	it("uses the agreed defaults", () => {
		assert.deepEqual(DEFAULT_MODEL_PERFORMANCE_CONFIG, {
			firstTokenTimeoutMs: 45_000,
			hardTokensPerSecond: 2,
			softTokensPerSecond: 8,
			cacheTtlMs: 300_000,
		});
	});

	it("reports hard degradation when the first token stalls", () => {
		const monitor = new GenerationPerformanceMonitor(DEFAULT_MODEL_PERFORMANCE_CONFIG, 0);
		assert.equal(monitor.assess(44_999), "normal");
		assert.equal(monitor.assess(45_000), "hard");
	});

	it("distinguishes tolerable and intolerable rolling throughput", () => {
		const soft = new GenerationPerformanceMonitor(DEFAULT_MODEL_PERFORMANCE_CONFIG, 0);
		for (let second = 1; second <= 30; second++) soft.recordDelta("x".repeat(20), second * 1_000);
		assert.equal(soft.assess(31_000), "soft");

		const hard = new GenerationPerformanceMonitor(DEFAULT_MODEL_PERFORMANCE_CONFIG, 0);
		for (let second = 1; second <= 20; second++) hard.recordDelta("xxxx", second * 1_000);
		assert.equal(hard.assess(21_000), "hard");
	});

	it("records first-token latency and estimated throughput", () => {
		const monitor = new GenerationPerformanceMonitor(DEFAULT_MODEL_PERFORMANCE_CONFIG, 1_000);
		monitor.recordDelta("x".repeat(40), 3_000);
		monitor.recordDelta("x".repeat(40), 4_000);
		assert.deepEqual(monitor.complete(5_000), {
			ttftMs: 2_000,
			estimatedTokensPerSecond: 10,
			estimatedOutputTokens: 20,
		});
	});

	it("counts only generation deltas", () => {
		assert.equal(generationDeltaText({ type: "text_delta", delta: "answer" }), "answer");
		assert.equal(generationDeltaText({ type: "thinking_delta", delta: "reason" }), "reason");
		assert.equal(generationDeltaText({ type: "toolcall_delta", delta: '{"path"' }), '{"path"');
		assert.equal(generationDeltaText({ type: "tool_execution_update", delta: "ignored" }), undefined);
		assert.equal(generationDeltaText({ type: "text_end", content: "ignored" }), undefined);
	});
});

describe("model-class performance failover", () => {
	it("uses fresh ranking to choose the best untried candidate after a hard stall", () => {
		const tracker = new ModelClassPerformanceTracker({
			candidates: cacheKey.candidates,
			currentCandidate: "gateway/a:high",
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			observations: () => [
				{ candidate: "gateway/b:high", recordedAt: 1, ttftMs: 500, estimatedTokensPerSecond: 4, source: "probe" },
				{ candidate: "gateway/c:high", recordedAt: 1, ttftMs: 200, estimatedTokensPerSecond: 20, source: "probe" },
			],
		});
		tracker.startResponse(0);

		assert.deepEqual(tracker.assess(45_000), {
			level: "hard",
			switch: { severity: "hard", from: "gateway/a:high", to: "gateway/c:high" },
		});
		assert.deepEqual(tracker.assess(46_000), { level: "hard" });
	});

	it("finishes a tolerably slow tool-call response before switching", () => {
		const tracker = new ModelClassPerformanceTracker({
			candidates: ["gateway/a:high", "gateway/b:high"],
			currentCandidate: "gateway/a:high",
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		});
		tracker.startResponse(0);
		for (let second = 1; second <= 30; second++) tracker.recordDelta("x".repeat(20), second * 1_000);
		assert.deepEqual(tracker.assess(31_000), { level: "soft" });

		const completed = tracker.completeResponse(32_000, true);
		assert.equal(completed.sample?.estimatedOutputTokens, 150);
		assert.deepEqual(completed.switch, { severity: "soft", from: "gateway/a:high", to: "gateway/b:high" });
	});

	it("does not switch after a terminal response or when no candidate remains", () => {
		const tracker = new ModelClassPerformanceTracker({
			candidates: ["gateway/a:high"],
			currentCandidate: "gateway/a:high",
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		});
		tracker.startResponse(0);
		assert.deepEqual(tracker.assess(45_000), { level: "hard" });
		assert.equal(tracker.completeResponse(46_000, false).switch, undefined);
	});

	it("does not revisit a candidate attempted by an earlier run attempt", () => {
		const tracker = new ModelClassPerformanceTracker({
			candidates: ["gateway/a:high", "gateway/b:high", "gateway/c:high"],
			currentCandidate: "gateway/b:high",
			attemptedCandidates: ["gateway/a:high"],
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		});
		tracker.startResponse(0);

		assert.deepEqual(tracker.assess(45_000), {
			level: "hard",
			switch: { severity: "hard", from: "gateway/b:high", to: "gateway/c:high" },
		});
	});
});

describe("model performance cache", () => {
	it("shares fresh observations through the filesystem and expires them by TTL", () => {
		const writer = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 1_000 });
		writer.record(cacheKey, {
			candidate: "gateway/a:high",
			recordedAt: 1_000,
			ttftMs: 500,
			estimatedTokensPerSecond: 12,
			source: "probe",
		});

		const freshReader = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 300_999 });
		assert.equal(freshReader.read(cacheKey, 300_000).length, 1);
		const expiredReader = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 301_000 });
		assert.deepEqual(expiredReader.read(cacheKey, 300_000), []);
	});

	it("keeps a fresh real-run observation ahead of a later probe", () => {
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 2_000 });
		store.record(cacheKey, {
			candidate: "gateway/a:high",
			recordedAt: 2_000,
			ttftMs: 1_000,
			estimatedTokensPerSecond: 4,
			source: "run",
		});
		store.record(cacheKey, {
			candidate: "gateway/a:high",
			recordedAt: 3_000,
			ttftMs: 100,
			estimatedTokensPerSecond: 50,
			source: "probe",
		});

		assert.equal(store.read(cacheKey, 300_000)[0]?.source, "run");
		assert.equal(store.read(cacheKey, 300_000)[0]?.estimatedTokensPerSecond, 4);
	});

	it("invalidates a stale sample when a real response stalls before producing output", () => {
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 2_000 });
		store.record(cacheKey, {
			candidate: "gateway/a:high",
			recordedAt: 1_000,
			ttftMs: 100,
			estimatedTokensPerSecond: 50,
			source: "run",
		});

		store.invalidate(cacheKey, "gateway/a:high");

		assert.deepEqual(store.read(cacheKey, 300_000), []);
	});

	it("does not fail a model response when the cache location is unwritable", () => {
		const fileRoot = path.join(cacheRoot, "not-a-directory");
		fs.writeFileSync(fileRoot, "occupied");
		const store = new ModelPerformanceStore({ rootDir: fileRoot, now: () => 2_000 });
		assert.doesNotThrow(() => store.record(cacheKey, {
			candidate: "gateway/a:high",
			recordedAt: 2_000,
			ttftMs: 100,
			estimatedTokensPerSecond: 20,
			source: "run",
		}));
		assert.doesNotThrow(() => store.invalidate(cacheKey, "gateway/a:high"));
	});

	it("uses a cross-process lease to prevent duplicate probe batches", () => {
		const first = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 1_000 });
		const second = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 1_000 });
		assert.equal(first.claimProbe(cacheKey, 30_000), true);
		assert.equal(second.claimProbe(cacheKey, 30_000), false);
		first.releaseProbe(cacheKey);
		assert.equal(second.claimProbe(cacheKey, 30_000), true);
	});

	it("refreshes a probe-batch lease while it waits for host capacity", () => {
		let now = 1_000;
		const first = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now });
		const second = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now });
		assert.equal(first.claimProbe(cacheKey, 30), true);
		now = 1_020;
		assert.equal(first.refreshProbe(cacheKey), true);
		now = 1_040;
		assert.equal(second.claimProbe(cacheKey, 30), false);
		first.releaseProbe(cacheKey);
		assert.equal(second.claimProbe(cacheKey, 30), true);
	});
});

describe("performance-aware candidate selection", () => {
	it("ranks sampled candidates by predicted completion time and keeps unknown candidates stable", () => {
		const candidates = ["gateway/a:high", "gateway/b:high", "gateway/c:high"];
		const ranked = rankModelCandidates(candidates, [
			{ candidate: "gateway/a:high", recordedAt: 1, ttftMs: 1_000, estimatedTokensPerSecond: 10, source: "run" },
			{ candidate: "gateway/b:high", recordedAt: 1, ttftMs: 2_000, estimatedTokensPerSecond: 20, source: "probe" },
		]);

		assert.deepEqual(ranked, ["gateway/b:high", "gateway/a:high", "gateway/c:high"]);
	});

	it("falls back to declared order without observations", () => {
		assert.deepEqual(rankModelCandidates(cacheKey.candidates, []), cacheKey.candidates);
	});
});
