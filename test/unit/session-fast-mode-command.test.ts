import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSessionFastMode } from "../../src/extension/session-fast-mode.ts";

test("bare /fast toggles Session Fast routing for the next main-agent request", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notices: string[] = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) { commands.set(name, command); },
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
	};
	const ctx = {
		hasUI: true,
		model: { provider: "cliproxy", id: "gpt-5.6-sol" },
		sessionManager: { getBranch() { return []; } },
		ui: { notify(message: string) { notices.push(message); }, setStatus() {} },
	};

	registerSessionFastMode(pi as never, ["gpt-5.6-sol"]);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" } as never, ctx as never);
	await commands.get("fast")!.handler("", ctx as never);

	const request = { type: "before_provider_request", payload: { model: "gpt-5.6-sol" } };
	let payload: unknown = request.payload;
	for (const handler of handlers.get("before_provider_request") ?? []) {
		payload = await handler({ ...request, payload } as never, ctx as never) ?? payload;
	}
	assert.deepEqual(payload, { model: "gpt-5.6-sol", service_tier: "priority" });
	assert.deepEqual(entries, [{ type: "pi-subagents:session-fast-mode", data: { enabled: true } }]);
	assert.match(notices.at(-1) ?? "", /Fast mode: on/);
});

test("/fast on and off show or clear Session Fast in the HUD", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notices: string[] = [];
	const changed: unknown[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) { commands.set(name, command); },
		on() {},
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
	};
	const ctx = {
		hasUI: true,
		model: { provider: "cliproxy", id: "gpt-5.6-sol" },
		ui: {
			notify(message: string) { notices.push(message); },
			setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
		},
	};

	registerSessionFastMode(pi as never, ["gpt-5.6-sol"], { onChange: (snapshot) => changed.push(snapshot) });
	const command = commands.get("fast")!;
	await command.handler("on", ctx as never);
	await command.handler("status", ctx as never);
	await command.handler("off", ctx as never);

	assert.deepEqual(entries.map((entry) => entry.data), [{ enabled: true }, { enabled: false }]);
	assert.deepEqual(changed, [
		{ version: 1, enabled: true, modelIds: ["gpt-5.6-sol"] },
		{ version: 1, enabled: false, modelIds: ["gpt-5.6-sol"] },
	]);
	assert.deepEqual(notices.map((notice) => notice.match(/Fast mode: (on|off)/)?.[1]), ["on", "on", "off"]);
	assert.deepEqual(statuses.map(({ text }) => text), ["fast", undefined]);
	assert.ok(statuses[0]?.key);
	assert.equal(statuses[0]?.key, statuses[1]?.key);
});

test("/fast rejects unknown arguments without changing the session mode", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: never) => Promise<void> }>();
	const entries: unknown[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: never) => Promise<void> }) { commands.set(name, command); },
		on() {},
		appendEntry(_type: string, data: unknown) { entries.push(data); },
	};
	const ctx = {
		ui: { notify(message: string, level: string) { notices.push({ message, level }); } },
	};

	registerSessionFastMode(pi as never, ["gpt-5.6-sol"]);
	await commands.get("fast")!.handler("enable", ctx as never);

	assert.deepEqual(entries, []);
	assert.deepEqual(notices, [{ message: "Usage: /fast [on|off|status]", level: "error" }]);
});

test("session start restores the newest Fast mode entry on the active branch", async () => {
	const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const pi = {
		registerCommand() {},
		on(name: string, handler: (event: never, ctx: never) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry() {},
	};
	const ctx = {
		hasUI: true,
		model: { provider: "another-provider", id: "gpt-5.6-sol" },
		ui: {
			setStatus(key: string, text: string | undefined) { statuses.push({ key, text }); },
		},
		sessionManager: {
			getBranch() {
				return [
					{ type: "custom", customType: "pi-subagents:session-fast-mode", data: { enabled: false } },
					{ type: "custom", customType: "unrelated", data: { enabled: false } },
					{ type: "custom", customType: "pi-subagents:session-fast-mode", data: { enabled: true } },
				];
			},
		},
	};

	registerSessionFastMode(pi as never, ["gpt-5.6-sol"]);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "resume" } as never, ctx as never);
	const payload = { model: "gpt-5.6-sol" };
	const rewritten = await handlers.get("before_provider_request")?.[0]?.({ payload } as never, ctx as never);

	assert.deepEqual(rewritten, { model: "gpt-5.6-sol", service_tier: "priority" });
	assert.deepEqual(statuses.map(({ text }) => text), ["fast"]);
});
