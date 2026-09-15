/**
 * End-to-end model-class failover smoke tests.
 *
 * These execute the real foreground spawn/JSONL/result pipeline against the
 * repository's faux Pi provider process; no external credentials are used.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createMockPi, makeAgent, type MockPi } from "../support/helpers.ts";

describe("model-class failover E2E", () => {
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	beforeEach(() => mockPi.reset());

	after(() => mockPi.uninstall());

	it("hands a transient first-candidate failure to the next frozen class candidate", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "primary unavailable" }],
					model: "provider-a/primary",
					errorMessage: "HTTP 408 provider timeout",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "fallback completed" });
		const candidates = ["provider-a/primary", "provider-b/fallback"];

		const result = await runSync(process.cwd(), [makeAgent("worker")], "worker", "Complete the smoke task.", {
			runId: "e2e-model-class-transient",
			modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "e2e-transient", candidates },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "provider-b/fallback");
		assert.deepEqual(result.attemptedModels, candidates);
		assert.equal(mockPi.callCount(), 2);
	});

	it("tries the next same-provider candidate after an auth failure", async () => {
		mockPi.onCall({
			jsonl: [{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "credentials rejected" }],
					model: "provider-a/primary",
					errorMessage: "HTTP 401 unauthorized",
					usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			}],
			exitCode: 1,
		});
		mockPi.onCall({ output: "same gateway fallback completed" });
		const candidates = ["provider-a/primary", "provider-a/secondary", "provider-b/fallback"];

		const result = await runSync(process.cwd(), [makeAgent("worker")], "worker", "Complete the auth smoke task.", {
			runId: "e2e-model-class-auth-domain",
			modelCandidates: candidates,
			modelRouting: { modelClass: "smart", source: "per-run", poolDigest: "e2e-auth", candidates },
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.model, "provider-a/secondary");
		assert.deepEqual(result.attemptedModels, ["provider-a/primary", "provider-a/secondary"]);
		assert.equal(result.modelAttempts?.[0]?.skippedModels, undefined);
		assert.equal(result.modelAttempts?.[0]?.failureCategory, "failure-domain");
		assert.equal(mockPi.callCount(), 2);
	});
});
