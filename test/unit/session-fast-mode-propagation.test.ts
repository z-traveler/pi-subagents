import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import registerFanoutChildSubagentExtension, { createChildSafeState } from "../../src/extension/fanout-child.ts";
import { sessionFastModeSnapshotPath } from "../../src/runs/background/control-channel.ts";
import { SessionFastModePolicy } from "../../src/runs/shared/session-fast-mode.ts";
import { SUBAGENT_ASYNC_STARTED_EVENT } from "../../src/shared/types.ts";

test("a fanout child forwards the latest Session Fast snapshot to nested background runs", async () => {
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-fast-nested-"));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const tools: Array<{ name: string }> = [];
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: {
			on(name: string, handler: (payload: unknown) => void) {
				eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
				return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
			},
			emit(name: string, payload: unknown) {
				for (const handler of eventHandlers.get(name) ?? []) handler(payload);
			},
		},
		registerTool(tool: { name: string }) { tools.push(tool); },
		getAllTools() { return tools; },
		getSessionName() { return "coordinator"; },
	};
	const policy = new SessionFastModePolicy(["gpt-5.6-sol"]);
	const state = createChildSafeState();
	state.currentSessionId = "nested-session";
	try {
		registerFanoutChildSubagentExtension(pi as never, {
			fanoutChild: true,
			depth: 1,
			waitTool: { enabled: true },
			fast: false,
			runtimeState: state,
			sessionFastMode: policy,
		});
		const ctx = { sessionManager: { getSessionId: () => "nested-session" } };
		for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id: "nested-run",
			asyncDir,
			sessionId: "nested-session",
			agent: "worker",
		});

		assert.deepEqual(JSON.parse(fs.readFileSync(sessionFastModeSnapshotPath(asyncDir), "utf-8")), {
			version: 1,
			enabled: false,
			modelIds: ["gpt-5.6-sol"],
		});

		policy.setEnabled(true);

		assert.deepEqual(JSON.parse(fs.readFileSync(sessionFastModeSnapshotPath(asyncDir), "utf-8")), {
			version: 1,
			enabled: true,
			modelIds: ["gpt-5.6-sol"],
		});
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, {});
		fs.rmSync(asyncDir, { recursive: true, force: true });
	}
});
