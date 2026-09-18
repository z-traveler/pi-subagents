import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { annotateResumeGuidance, asyncRunNotFoundMessage, formatResumeGuidance, hasExistingSessionFile } from "../../src/runs/shared/resume-guidance.ts";
import { getAgentDir } from "../../src/shared/utils.ts";
import type { Details, SingleResult } from "../../src/shared/types.ts";

function makeSessionFile(name: string): string {
	const sessionFile = path.join(getAgentDir(), "resume-guidance-test", name);
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "", "utf-8");
	return sessionFile;
}

function makeResult(details: Partial<Details> & Pick<Details, "mode" | "results">, text = "child output"): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text }],
		details: { runId: "run-1", ...details } as Details,
	} as AgentToolResult<Details>;
}

function child(overrides: Partial<SingleResult> = {}): SingleResult {
	return { index: 0, agent: "echo", task: "task", exitCode: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, ...overrides } as SingleResult;
}

describe("resume guidance", () => {
	it("recognizes only session files that still exist", () => {
		const sessionFile = makeSessionFile("exists.jsonl");
		assert.equal(hasExistingSessionFile(sessionFile), true);
		assert.equal(hasExistingSessionFile(path.join(path.dirname(sessionFile), "missing.jsonl")), false);
		assert.equal(hasExistingSessionFile(undefined), false);
	});

	it("names the revive call for a single resumable child", () => {
		const sessionFile = makeSessionFile("single.jsonl");
		assert.equal(
			formatResumeGuidance("run-1", [{ agent: "echo", sessionFile }]),
			'Revive: subagent({ action: "resume", id: "run-1", message: "..." })',
		);
	});

	it("names the child index when only a later child is resumable", () => {
		const sessionFile = makeSessionFile("second.jsonl");
		assert.equal(
			formatResumeGuidance("run-2", [{ agent: "echo" }, { agent: "echo", sessionFile }]),
			'Revive child: subagent({ action: "resume", id: "run-2", index: 1, message: "..." })',
		);
	});

	it("reports unavailable instead of inventing an id", () => {
		assert.equal(formatResumeGuidance("run-1", [{ agent: "echo" }]), "Resume: unavailable; no child session file was persisted.");
		assert.equal(formatResumeGuidance(undefined, [{ agent: "echo" }]), "Resume: unavailable; no child session file was persisted.");
		assert.equal(formatResumeGuidance("run-1", [{ agent: "echo" }], undefined, { stopped: true }), "Resume: unavailable; stopped runs are not resumable. Start a new run instead.");
	});

	it("appends the revive hint to a completed foreground result", () => {
		const sessionFile = makeSessionFile("foreground.jsonl");
		const result = annotateResumeGuidance(makeResult({ mode: "single", results: [child({ sessionFile })] }));
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", `child output\nRevive: subagent({ action: "resume", id: "run-1", message: "..." })`);
		assert.equal(result.details.runId, "run-1");
	});

	it("reports unavailable when a foreground child persisted no session", () => {
		const result = annotateResumeGuidance(makeResult({ mode: "single", results: [child()] }));
		assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Resume: unavailable; no child session file was persisted\.$/);
	});

	it("leaves results that must not gain a trailer untouched", () => {
		const sessionFile = makeSessionFile("skipped.jsonl");
		const cases: Array<[string, AgentToolResult<Details>]> = [
			["live async launch", makeResult({ mode: "single", results: [child({ sessionFile })], asyncId: "run-1" })],
			["workflow", makeResult({ mode: "workflow", results: [child({ sessionFile })] })],
			["management", makeResult({ mode: "management", results: [child({ sessionFile })] })],
			["no children", makeResult({ mode: "single", results: [] })],
			["structured output", makeResult({ mode: "single", results: [child({ sessionFile, structuredOutputPath: "/tmp/out.json" })] })],
			["json payload", makeResult({ mode: "single", results: [child({ sessionFile })] }, '{"ok":true}')],
		];
		for (const [label, input] of cases) {
			assert.equal(annotateResumeGuidance(input).content[0]?.type === "text" ? (annotateResumeGuidance(input).content[0] as { text: string }).text : "", input.content[0]?.type === "text" ? input.content[0].text : "", label);
		}
		const failure = { ...makeResult({ mode: "single", results: [child({ sessionFile })] }), isError: true } as AgentToolResult<Details>;
		assert.equal(annotateResumeGuidance(failure).content[0]?.type === "text" ? (annotateResumeGuidance(failure).content[0] as { text: string }).text : "", "child output");
		assert.equal(annotateResumeGuidance(makeResult({ mode: "single", results: [child({ sessionFile })] }), { delegated: true }).content[0]?.type === "text" ? (annotateResumeGuidance(makeResult({ mode: "single", results: [child({ sessionFile })] }), { delegated: true }).content[0] as { text: string }).text : "", "child output");
	});

	it("explains a mission id passed to a run-id lookup", () => {
		assert.equal(asyncRunNotFoundMessage("deadbeef-0000-0000-0000-000000000000"), "Async run not found. Provide id or dir.");
		assert.equal(asyncRunNotFoundMessage(undefined), "Async run not found. Provide id or dir.");
		assert.equal(asyncRunNotFoundMessage("not-a-uuid"), "Async run not found. Provide id or dir.");

		const missionId = "35b46c3d-7a7e-4d84-bb9e-9754f0b1ee09";
		const missionDir = path.join(getAgentDir(), "missions", "projects", "project-key");
		fs.mkdirSync(missionDir, { recursive: true });
		fs.writeFileSync(path.join(missionDir, `${missionId}.json`), "{}", "utf-8");
		const message = asyncRunNotFoundMessage(missionId);
		assert.match(message, /^Async run not found\. Provide id or dir\. /);
		assert.match(message, /is a mission id, not a run id\./);
	});
});
