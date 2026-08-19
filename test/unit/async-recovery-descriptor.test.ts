import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import { readAsyncRecoveryDescriptor, resolveRecoveryModelCandidates } from "../../src/runs/background/async-resume.ts";
import { createRunFanoutBudget } from "../../src/runs/shared/run-fanout-budget.ts";

const budgetDirectories: string[] = [];

function runFanoutBudget(runId: string) {
	const descriptor = createRunFanoutBudget(runId, 64);
	budgetDirectories.push(descriptor.directory);
	return descriptor;
}

afterEach(() => {
	for (const directory of budgetDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("async recovery descriptor", () => {
	it("resumes with the session-owning final model followed by untried frozen candidates", () => {
		assert.deepEqual(resolveRecoveryModelCandidates("provider/second", {
			version: 2,
			runFanoutBudget: runFanoutBudget("run-candidates"),
			sourceRunId: "run-candidates",
			agent: "worker",
			cwd: "/repo",
			model: "provider/first",
			modelRouting: {
				modelClass: "smart",
				source: "per-run",
				poolDigest: "digest",
				candidates: ["provider/first", "provider/second", "other/third"],
			},
			systemPromptMode: "replace",
			inheritProjectContext: false,
			inheritSkills: false,
			outputMode: "inline",
			maxSubagentDepth: 2,
			share: false,
		},), ["provider/second", "other/third"]);
	});

	it("accepts a v2 frozen model-routing snapshot while retaining v1 compatibility", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-v2-routing-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 2,
				runFanoutBudget: runFanoutBudget("run-v2"),
				sourceRunId: "run-v2",
				agent: "worker",
				cwd: root,
				model: "provider/primary",
				modelRouting: {
					modelClass: "smart",
					source: "per-run",
					poolDigest: "digest",
					candidates: ["provider/primary", "other/fallback"],
				},
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);
			assert.equal(descriptor?.version, 2);
			assert.deepEqual(descriptor?.modelRouting?.candidates, ["provider/primary", "other/fallback"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("accepts launchContractDigest written by async execution", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-digest-"));
		try {
			const digest = "launch-contract-digest";
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				launchContractDigest: digest,
				runFanoutBudget: runFanoutBudget("run-digest"),
				sourceRunId: "run-digest",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			const descriptor = readAsyncRecoveryDescriptor(root);

			assert.equal(descriptor?.launchContractDigest, digest);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed launchContractDigest values", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-async-recovery-bad-digest-"));
		try {
			fs.writeFileSync(path.join(root, "recovery-descriptor.json"), JSON.stringify({
				version: 1,
				launchContractDigest: {},
				runFanoutBudget: runFanoutBudget("run-bad-digest"),
				sourceRunId: "run-digest",
				agent: "worker",
				cwd: root,
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				outputMode: "inline",
				maxSubagentDepth: 2,
				share: false,
			}), "utf-8");

			assert.throws(
				() => readAsyncRecoveryDescriptor(root),
				/launchContractDigest must be a non-empty string/,
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
