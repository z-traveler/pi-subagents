import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { warmModelPerformanceCache } from "../../src/runs/shared/model-performance-probe.ts";
import {
	DEFAULT_MODEL_PERFORMANCE_CONFIG,
	ModelPerformanceStore,
	type ModelPerformanceCacheKey,
} from "../../src/runs/shared/model-performance.ts";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function leaseStoreOptions(now: () => number, pid: number, liveProcesses: ReadonlySet<number>) {
	return {
		rootDir: cacheRoot,
		now,
		pid,
		hostname: "test-host",
		processStartIdentity: `process-${pid}`,
		isProcessAlive: (candidatePid: number) => liveProcesses.has(candidatePid),
		getProcessStartIdentity: (candidatePid: number) => liveProcesses.has(candidatePid)
			? `process-${candidatePid}`
			: undefined,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition.");
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
}

const key: ModelPerformanceCacheKey = {
	modelClass: "smart",
	poolDigest: "pool-v1",
	candidates: ["gateway/a:high"],
	protocolVersion: 1,
};

let cacheRoot = "";

beforeEach(() => {
	cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-probe-"));
});

afterEach(() => {
	fs.rmSync(cacheRoot, { recursive: true, force: true });
});

describe("model performance probes", () => {
	it("records a successful tool-free probe observation", async () => {
		let now = 1_000;
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now });
		const results = await warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			now: () => now,
			execute: async ({ candidate, maxEstimatedTokens, signal, onDelta }) => {
				assert.equal(candidate, "gateway/a:high");
				assert.equal(maxEstimatedTokens, 64);
				assert.equal(signal.aborted, false);
				now = 1_500;
				onDelta("x".repeat(128));
				now = 2_500;
			},
		});

		assert.equal(results.length, 1);
		assert.equal(results[0]?.status, "sampled");
		assert.deepEqual(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), [{
			candidate: "gateway/a:high",
			recordedAt: 2_500,
			ttftMs: 500,
			estimatedTokensPerSecond: 32,
			source: "probe",
		}]);
	});

	it("does not let an in-flight probe recreate evidence invalidated by a real response", async () => {
		let now = 1_000;
		const started = deferred();
		const release = deferred();
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now });
		const completion = warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			now: () => now,
			execute: async ({ onDelta }) => {
				now = 1_500;
				onDelta("x".repeat(128));
				started.resolve();
				await release.promise;
				now = 2_500;
			},
		});

		await started.promise;
		new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now }).invalidate(key, "gateway/a:high");
		release.resolve();

		assert.deepEqual(await completion, []);
		assert.deepEqual(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), []);
	});

	it("probes only candidates without a fresh observation", async () => {
		const partialKey = { ...key, candidates: ["gateway/a:high", "gateway/b:high"] };
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 2_000 });
		store.record(partialKey, {
			candidate: "gateway/a:high",
			recordedAt: 1_000,
			ttftMs: 100,
			estimatedTokensPerSecond: 20,
			source: "run",
		});
		const probed: string[] = [];
		await warmModelPerformanceCache({
			key: partialKey,
			candidates: partialKey.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			now: () => 2_000,
			execute: async ({ candidate, onDelta }) => {
				probed.push(candidate);
				onDelta("xxxx");
			},
		});

		assert.deepEqual(probed, ["gateway/b:high"]);
	});

	it("limits probes to two concurrent provider requests across batches", async () => {
		let running = 0;
		let maxRunning = 0;
		let starts = 0;
		const firstTwoStarted = deferred();
		const thirdStarted = deferred();
		const gates = [deferred(), deferred(), deferred()];
		const execute = async ({ onDelta }: { onDelta(delta: string): void }) => {
			const index = starts++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (starts === 2) firstTwoStarted.resolve();
			if (starts === 3) thirdStarted.resolve();
			onDelta("xxxx");
			await gates[index]!.promise;
			running--;
		};
		const batches = ["a", "b", "c"].map((id) => {
			const batchKey = { ...key, poolDigest: `pool-${id}`, candidates: [`gateway/${id}`] };
			return warmModelPerformanceCache({
				key: batchKey,
				candidates: batchKey.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: new ModelPerformanceStore({ rootDir: cacheRoot, now: () => 1_000 }),
				now: () => 1_000,
				execute,
			});
		});

		await firstTwoStarted.promise;
		assert.equal(starts, 2);
		gates[0]!.resolve();
		await thirdStarted.promise;
		assert.equal(maxRunning, 2);
		gates[1]!.resolve();
		gates[2]!.resolve();
		await Promise.all(batches);
	});

	it("keeps a queued batch lease alive so the same key cannot start duplicate paid probes", async () => {
		const slotStore = new ModelPerformanceStore({ rootDir: cacheRoot });
		const occupied = [
			slotStore.claimProbeSlot(30_000, 2),
			slotStore.claimProbeSlot(30_000, 2),
		];
		assert.ok(occupied[0]);
		assert.ok(occupied[1]);
		let refreshes = 0;
		const refreshed = deferred();
		class ObservedStore extends ModelPerformanceStore {
			override refreshProbe(cacheKey: ModelPerformanceCacheKey): boolean {
				const result = super.refreshProbe(cacheKey);
				if (result && ++refreshes === 4) refreshed.resolve();
				return result;
			}
		}
		const firstStore = new ObservedStore({ rootDir: cacheRoot });
		const secondStore = new ModelPerformanceStore({ rootDir: cacheRoot });
		let paidRequests = 0;
		const first = warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store: firstStore,
			timeoutMs: 30,
			execute: async ({ onDelta }) => {
				paidRequests++;
				onDelta("xxxx");
			},
		});

		try {
			await refreshed.promise;
			assert.deepEqual(await warmModelPerformanceCache({
				key,
				candidates: key.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: secondStore,
				timeoutMs: 30,
				execute: async () => { paidRequests++; },
			}), []);
			slotStore.releaseProbeSlot(occupied[0]!);
			assert.equal((await first)[0]?.status, "sampled");
			assert.equal(paidRequests, 1);
		} finally {
			for (const claim of occupied) if (claim) slotStore.releaseProbeSlot(claim);
		}
	});

	it("cancels a batch when it loses its lease", async () => {
		const started = deferred();
		let refreshes = 0;
		class LosingStore extends ModelPerformanceStore {
			override refreshProbe(cacheKey: ModelPerformanceCacheKey): boolean {
				if (++refreshes === 1) return super.refreshProbe(cacheKey);
				return false;
			}
		}
		const store = new LosingStore({ rootDir: cacheRoot });
		const results = await warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			timeoutMs: 30,
			execute: async ({ signal, onDelta }) => {
				onDelta("partial");
				started.resolve();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});

		await started.promise;
		assert.deepEqual(results, [{ candidate: "gateway/a:high", status: "cancelled" }]);
		assert.deepEqual(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), []);
	});

	it("aborts an active provider request when another key takes over its expired global slot", async () => {
		let now = 1_000;
		const liveProcesses = new Set([101, 202]);
		const started = deferred();
		const providerAborted = deferred();
		const firstStore = new ModelPerformanceStore(leaseStoreOptions(() => now, 101, liveProcesses));
		const contenderStore = new ModelPerformanceStore(leaseStoreOptions(() => now, 202, liveProcesses));
		const firstKey = { ...key, poolDigest: "slot-owner" };
		const first = warmModelPerformanceCache({
			key: firstKey,
			candidates: firstKey.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store: firstStore,
			timeoutMs: 100,
			now: () => now,
			execute: async ({ signal, onDelta }) => {
				onDelta("partial");
				started.resolve();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
					providerAborted.resolve();
					resolve();
				}, { once: true }));
			},
		});
		await started.promise;
		liveProcesses.delete(101);
		now += 30_001;
		const takeover = contenderStore.claimProbeSlot(30_000, 2);
		assert.equal(takeover?.slot, 0);

		try {
			await providerAborted.promise;
			assert.deepEqual(await first, [{ candidate: "gateway/a:high", status: "cancelled" }]);
			assert.deepEqual(firstStore.read(firstKey, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), []);
		} finally {
			if (takeover) contenderStore.releaseProbeSlot(takeover);
		}
	});

	it("keeps a large cold pool behind two local global-lock contenders", async () => {
		class CountingStore extends ModelPerformanceStore {
			claimCalls = 0;
			override claimProbeSlot(leaseMs: number, concurrency: number) {
				this.claimCalls++;
				return super.claimProbeSlot(leaseMs, concurrency);
			}
		}
		const candidates = Array.from({ length: 20 }, (_, index) => `gateway/model-${index}`);
		const largeKey = { ...key, poolDigest: "large-pool", candidates };
		const firstTwoStarted = deferred();
		const releaseFirstTwo = deferred();
		const store = new CountingStore({ rootDir: cacheRoot });
		let starts = 0;
		const completion = warmModelPerformanceCache({
			key: largeKey,
			candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			execute: async ({ onDelta }) => {
				const index = starts++;
				onDelta("xxxx");
				if (starts === 2) firstTwoStarted.resolve();
				if (index < 2) await releaseFirstTwo.promise;
			},
		});

		await firstTwoStarted.promise;
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.equal(store.claimCalls, 2);
		releaseFirstTwo.resolve();
		await completion;
		assert.equal(starts, candidates.length);
	});

	it("limits provider requests to two across host-local processes", async () => {
		const readyDir = path.join(cacheRoot, "ready");
		const releaseDir = path.join(cacheRoot, "release");
		fs.mkdirSync(readyDir, { recursive: true });
		fs.mkdirSync(releaseDir, { recursive: true });
		const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-performance-probe.ts")).href;
		const performanceUrl = pathToFileURL(path.resolve("src/runs/shared/model-performance.ts")).href;
		const script = `
			import * as fs from "node:fs";
			import * as path from "node:path";
			import { warmModelPerformanceCache } from ${JSON.stringify(moduleUrl)};
			import { DEFAULT_MODEL_PERFORMANCE_CONFIG, ModelPerformanceStore } from ${JSON.stringify(performanceUrl)};
			const [rootDir, id, readyDir, releaseDir] = process.argv.slice(1);
			const key = { modelClass: "smart", poolDigest: "pool-" + id, candidates: ["gateway/" + id], protocolVersion: 1 };
			await warmModelPerformanceCache({
				key,
				candidates: key.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: new ModelPerformanceStore({ rootDir }),
				timeoutMs: 5_000,
				execute: async ({ onDelta }) => {
					onDelta("xxxx");
					fs.writeFileSync(path.join(readyDir, id), "ready");
					while (!fs.existsSync(path.join(releaseDir, id))) {
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
				},
			});
		`;
		const children = ["a", "b", "c"].map((id) => {
			const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script,
				cacheRoot, id, readyDir, releaseDir], { stdio: ["ignore", "ignore", "pipe"] });
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => { stderr += chunk; });
			const done = new Promise<void>((resolve, reject) => {
				child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`probe child ${id} exited ${code}: ${stderr}`)));
			});
			return { id, child, done };
		});

		try {
			await waitUntil(() => fs.readdirSync(readyDir).length >= 2);
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			const firstWave = fs.readdirSync(readyDir);
			assert.equal(firstWave.length, 2);
			fs.writeFileSync(path.join(releaseDir, firstWave[0]!), "release");
			await waitUntil(() => fs.readdirSync(readyDir).length === 3);
		} finally {
			for (const { id } of children) fs.writeFileSync(path.join(releaseDir, id), "release");
			await Promise.all(children.map(({ done }) => done));
		}
	});

	it("aborts a stalled probe at the bounded timeout without caching it", async () => {
		const store = new ModelPerformanceStore({ rootDir: cacheRoot });
		let probeSignal: AbortSignal | undefined;
		const results = await warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			timeoutMs: 10,
			execute: async ({ signal }) => {
				probeSignal = signal;
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});

		assert.equal(probeSignal?.aborted, true);
		assert.deepEqual(results, [{ candidate: "gateway/a:high", status: "timed-out" }]);
		assert.deepEqual(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), []);
	});

	it("keeps global slots after timeout and token bounds until provider requests have exited", async () => {
		const providerExits = [deferred(), deferred()];
		const providerAborts = [deferred(), deferred()];
		const boundedResults = [deferred(), deferred()];
		const observedStatuses: string[] = [];
		const occupiedSettled = [false, false];
		const occupied = ["hold-a", "hold-b"].map((id, index) => {
			const batchKey = { ...key, poolDigest: id, candidates: [`gateway/${id}`] };
			const completion = warmModelPerformanceCache({
				key: batchKey,
				candidates: batchKey.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: new ModelPerformanceStore({ rootDir: cacheRoot }),
				timeoutMs: 10,
				onResult: ({ status }) => {
					observedStatuses[index] = status;
					boundedResults[index]!.resolve();
				},
				execute: async ({ signal, onDelta }) => {
					signal.addEventListener("abort", providerAborts[index]!.resolve, { once: true });
					if (index === 1) onDelta("x".repeat(256));
					await providerExits[index]!.promise;
				},
			});
			void completion.then(() => { occupiedSettled[index] = true; });
			return completion;
		});
		let thirdStarted = false;
		let third: Promise<unknown> | undefined;
		try {
			await Promise.all([
				...providerAborts.map(({ promise }) => promise),
				...boundedResults.map(({ promise }) => promise),
			]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(observedStatuses, ["timed-out", "sampled"]);
			assert.deepEqual(occupiedSettled, [false, false]);

			const thirdKey = { ...key, poolDigest: "third", candidates: ["gateway/third"] };
			third = warmModelPerformanceCache({
				key: thirdKey,
				candidates: thirdKey.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: new ModelPerformanceStore({ rootDir: cacheRoot }),
				timeoutMs: 1_000,
				execute: async ({ onDelta }) => {
					thirdStarted = true;
					onDelta("xxxx");
				},
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			assert.equal(thirdStarted, false);
			providerExits[0]!.resolve();
			await waitUntil(() => thirdStarted);
			providerExits[1]!.resolve();
			assert.deepEqual((await Promise.all(occupied)).map(([result]) => result?.status), ["timed-out", "sampled"]);
			await third;
		} finally {
			providerExits.forEach(({ resolve }) => resolve());
			await Promise.allSettled([...occupied, ...(third ? [third] : [])]);
		}
	});

	it("keeps the same-key batch lease until a timed-out provider request exits", async () => {
		const providerExit = deferred();
		const providerAborted = deferred();
		const boundedResult = deferred();
		let starts = 0;
		let observedStatus: string | undefined;
		let firstSettled = false;
		const firstStore = new ModelPerformanceStore({ rootDir: cacheRoot });
		const secondStore = new ModelPerformanceStore({ rootDir: cacheRoot });
		const first = warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store: firstStore,
			timeoutMs: 10,
			onResult: ({ status }) => {
				observedStatus = status;
				boundedResult.resolve();
			},
			execute: async ({ signal }) => {
				starts++;
				signal.addEventListener("abort", providerAborted.resolve, { once: true });
				await providerExit.promise;
			},
		});
		void first.then(() => { firstSettled = true; });

		try {
			await Promise.all([providerAborted.promise, boundedResult.promise]);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(observedStatus, "timed-out");
			assert.equal(firstSettled, false);
			assert.deepEqual(await warmModelPerformanceCache({
				key,
				candidates: key.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: secondStore,
				timeoutMs: 10,
				execute: async () => { starts++; },
			}), []);
			assert.equal(starts, 1);
		} finally {
			providerExit.resolve();
			assert.deepEqual(await first, [{ candidate: "gateway/a:high", status: "timed-out" }]);
		}
	});

	it("stops at about 64 estimated output tokens and keeps the bounded sample", async () => {
		let now = 1_000;
		const store = new ModelPerformanceStore({ rootDir: cacheRoot, now: () => now });
		const results = await warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			now: () => now,
			execute: async ({ signal, onDelta }) => {
				now = 1_100;
				onDelta("x".repeat(128));
				assert.equal(signal.aborted, false);
				now = 2_100;
				onDelta("x".repeat(256));
				assert.equal(signal.aborted, true);
				now = 3_100;
				onDelta("x".repeat(128));
			},
		});

		assert.equal(results[0]?.status, "sampled");
		assert.equal(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs)[0]?.estimatedTokensPerSecond, 64);
	});

	it("cancels an active probe through the caller signal without caching partial output", async () => {
		const controller = new AbortController();
		const started = deferred();
		const store = new ModelPerformanceStore({ rootDir: cacheRoot });
		const visible: string[] = [];
		const completion = warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			signal: controller.signal,
			onResult: ({ status }) => visible.push(status),
			execute: async ({ signal, onDelta }) => {
				onDelta("partial");
				started.resolve();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			},
		});

		await started.promise;
		controller.abort();
		assert.deepEqual(await completion, [{ candidate: "gateway/a:high", status: "cancelled" }]);
		assert.deepEqual(visible, ["cancelled"]);
		assert.deepEqual(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs), []);
	});

	it("removes a cancelled probe from the global concurrency queue", async () => {
		const occupied = deferred();
		const gates = [deferred(), deferred()];
		let starts = 0;
		const blockers = ["a", "b"].map((id, index) => {
			const batchKey = { ...key, poolDigest: `occupied-${id}`, candidates: [`gateway/${id}`] };
			return warmModelPerformanceCache({
				key: batchKey,
				candidates: batchKey.candidates,
				config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
				store: new ModelPerformanceStore({ rootDir: cacheRoot }),
				execute: async ({ onDelta }) => {
					onDelta("xxxx");
					starts++;
					if (starts === 2) occupied.resolve();
					await gates[index]!.promise;
				},
			});
		});
		await occupied.promise;

		const controller = new AbortController();
		const queuedKey = { ...key, poolDigest: "queued", candidates: ["gateway/queued"] };
		let queuedResult: unknown;
		const queued = warmModelPerformanceCache({
			key: queuedKey,
			candidates: queuedKey.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store: new ModelPerformanceStore({ rootDir: cacheRoot }),
			signal: controller.signal,
			execute: async () => { throw new Error("cancelled queued probe must not start"); },
		}).then((result) => { queuedResult = result; });
		controller.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			assert.deepEqual(queuedResult, []);
		} finally {
			gates.forEach(({ resolve }) => resolve());
			await Promise.all([...blockers, queued]);
		}
	});

	it("does not let expired live owners lose batch leases or global slots", () => {
		let now = Date.now();
		const liveProcesses = new Set([101, 202]);
		const first = new ModelPerformanceStore(leaseStoreOptions(() => now, 101, liveProcesses));
		const second = new ModelPerformanceStore(leaseStoreOptions(() => now, 202, liveProcesses));
		assert.equal(first.claimProbe(key, 10), true);
		const slot = first.claimProbeSlot(10, 1);
		assert.ok(slot);

		now += 20;
		assert.equal(second.claimProbe(key, 10), false);
		assert.equal(second.claimProbeSlot(10, 1), undefined);

		first.releaseProbe(key);
		first.releaseProbeSlot(slot);
	});

	it("lets a new process reclaim a dead owner's batch lease without stale-owner release", () => {
		let now = Date.now();
		const liveProcesses = new Set([101, 202, 303]);
		const first = new ModelPerformanceStore(leaseStoreOptions(() => now, 101, liveProcesses));
		const second = new ModelPerformanceStore(leaseStoreOptions(() => now, 202, liveProcesses));
		const third = new ModelPerformanceStore(leaseStoreOptions(() => now, 303, liveProcesses));
		assert.equal(first.claimProbe(key, 10), true);
		now += 20;
		liveProcesses.delete(101);
		assert.equal(second.claimProbe(key, 10), true);

		assert.equal(first.refreshProbe(key), false);
		first.releaseProbe(key);
		assert.equal(third.claimProbe(key, 10), false);
		second.releaseProbe(key);
		assert.equal(third.claimProbe(key, 10), true);
		third.releaseProbe(key);
	});

	it("treats a failing result observer as best-effort", async () => {
		const store = new ModelPerformanceStore({ rootDir: cacheRoot });
		const results = await warmModelPerformanceCache({
			key,
			candidates: key.candidates,
			config: DEFAULT_MODEL_PERFORMANCE_CONFIG,
			store,
			onResult: () => { throw new Error("stale UI context"); },
			execute: async ({ onDelta }) => onDelta("xxxx"),
		});

		assert.equal(results[0]?.status, "sampled");
		assert.equal(store.read(key, DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs).length, 1);
	});
});
