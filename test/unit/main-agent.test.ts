import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import registerSubagentExtension from "../../index.ts";
import { computeMcpServerHash } from "../../src/runs/shared/mcp-direct-tool-allowlist.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("registers --agent as the named main-agent entry point", () => {
	const flags = new Map<string, { type: string; description: string }>();
	const events = { on() { return () => {}; }, emit() {} };
	const pi = new Proxy({
		events,
		registerFlag(name: string, options: { type: string; description: string }) {
			flags.set(name, options);
		},
	}, {
		get(target, property) {
			if (property in target) return target[property as keyof typeof target];
			return () => undefined;
		},
	});

	registerSubagentExtension(pi as never);

	assert.deepEqual(flags.get("agent"), {
		type: "string",
		description: "Launch the main session as a declared agent (for example, --agent leader).",
	});
});

test("registers /fast as the root Session Fast command", () => {
	const commands = new Map<string, { description?: string }>();
	const events = { on() { return () => {}; }, emit() {} };
	const pi = new Proxy({
		events,
		registerCommand(name: string, options: { description?: string }) {
			commands.set(name, options);
		},
	}, {
		get(target, property) {
			if (property in target) return target[property as keyof typeof target];
			return () => undefined;
		},
	});

	registerSubagentExtension(pi as never);

	assert.match(commands.get("fast")?.description ?? "", /Toggle Session Fast routing/);
});

test("applies a declared agent to the main session", async () => {
	const modulePath = pathToFileURL(path.join(projectRoot, "src", "extension", "main-agent.ts")).href;
	const mainAgentModule = await import(modulePath);
	assert.equal(typeof mainAgentModule.registerNamedMainAgent, "function", "named main-agent runtime is not implemented");

	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "leader.md"), `---
name: leader
description: Coordinates work
aliases: lead
model: cliproxy/gpt-test
thinking: high
tools: read, subagent
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
---

Coordinate the work and verify the result.
`, "utf-8");

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const applied = {
			model: "",
			thinking: "",
			tools: [] as string[],
			sessionNames: [] as string[],
		};
		const registryModel = { provider: "cliproxy", id: "gpt-test" };
		const pi = {
			registerFlag() {},
			getFlag(name: string) { return name === "agent" ? "lead" : undefined; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			getAllTools() { return [{ name: "read" }, { name: "subagent" }, { name: "bash" }]; },
			async setModel(model: typeof registryModel) { applied.model = `${model.provider}/${model.id}`; return true; },
			setThinkingLevel(level: string) { applied.thinking = level; },
			setActiveTools(names: string[]) { applied.tools = names; },
			setSessionName(name: string) { applied.sessionNames.push(name); },
			appendEntry() {},
		};
		const ctx = {
			cwd: agentDir,
			hasUI: false,
			model: registryModel,
			modelRegistry: {
				getAvailable() { return [registryModel]; },
				find(provider: string, id: string) {
					return provider === registryModel.provider && id === registryModel.id ? registryModel : undefined;
			},
			},
			sessionManager: { getEntries() { return []; } },
		};

		mainAgentModule.registerNamedMainAgent(pi);
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ reason: "startup" }, ctx);
		}

		assert.equal(applied.model, "cliproxy/gpt-test");
		assert.equal(applied.thinking, "high");
		assert.deepEqual(applied.tools, ["read", "subagent"]);
		assert.deepEqual(applied.sessionNames, []);

		let prompt = "Pi base prompt with project instructions and skills.";
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const result = await handler({ systemPrompt: prompt }, ctx) as { systemPrompt?: string } | undefined;
			if (result?.systemPrompt) prompt = result.systemPrompt;
		}
		assert.equal(prompt, "Pi base prompt with project instructions and skills.\n\nCoordinate the work and verify the result.");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("rejects an unknown named main agent before applying configuration", async () => {
	const { registerNamedMainAgent } = await import("../../src/extension/main-agent.ts");
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let configurationApplied = false;
	let shutdownRequested = false;
	const pi = {
		registerFlag() {},
		getFlag(name: string) { return name === "agent" ? "missing" : undefined; },
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
		setModel() { configurationApplied = true; },
		setThinkingLevel() { configurationApplied = true; },
		setActiveTools() { configurationApplied = true; },
		setSessionName() { configurationApplied = true; },
		appendEntry() { configurationApplied = true; },
	};
	const ctx = {
		cwd: fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-missing-")),
		hasUI: true,
		shutdown() { shutdownRequested = true; },
		modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
		sessionManager: { getEntries() { return []; } },
	};
	try {
		registerNamedMainAgent(pi as never);
		const handler = handlers.get("session_start")?.[0];
		assert.ok(handler);
		await assert.rejects(
			() => handler({ reason: "startup" }, ctx),
			/Main agent 'missing' was not found/,
		);
		assert.equal(configurationApplied, false);
		assert.equal(shutdownRequested, true);
		assert.deepEqual(handlers.get("input")?.[0]?.({}, ctx), { action: "handled" });
	} finally {
		fs.rmSync(ctx.cwd, { recursive: true, force: true });
	}
});

test("rejects an unsupported named main-agent thinking level", async () => {
	const { registerNamedMainAgent } = await import("../../src/extension/main-agent.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-thinking-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "leader.md"), `---
name: leader
description: Coordinates work
thinking: impossible
---

Leader prompt.
`, "utf-8");
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let thinkingApplied = false;
		const pi = {
			registerFlag() {},
			getFlag() { return "leader"; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			setThinkingLevel() { thinkingApplied = true; },
			appendEntry() {},
		};
		const ctx = {
			cwd: agentDir,
			mode: "print",
			modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
			sessionManager: { getEntries() { return []; } },
		};

		registerNamedMainAgent(pi as never);
		const start = handlers.get("session_start")?.[0];
		assert.ok(start);
		await assert.rejects(
			() => start({ reason: "startup" }, ctx),
			/unsupported thinking level 'impossible'/,
		);
		assert.equal(thinkingApplied, false);
	} finally {
		process.exitCode = undefined;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("activates declared direct MCP tools in the main session", async () => {
	const { registerNamedMainAgent } = await import("../../src/extension/main-agent.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-mcp-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const server = { command: "mcp-server" };
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "researcher.md"), `---
name: researcher
description: Researches repositories
tools: read, mcp:github/search_repositories
---

Research the request.
`, "utf-8");
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
			mcpServers: { github: server },
		}), "utf-8");
		fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({
			version: 1,
			servers: {
				github: {
					configHash: computeMcpServerHash(server),
					tools: [{ name: "search_repositories" }],
					resources: [],
					cachedAt: Date.now(),
				},
			},
		}), "utf-8");

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let activeTools: string[] = [];
		const pi = {
			registerFlag() {},
			getFlag() { return "researcher"; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			setActiveTools(names: string[]) { activeTools = names; },
			appendEntry() {},
		};
		const ctx = {
			cwd: agentDir,
			modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
			sessionManager: { getEntries() { return []; } },
		};

		registerNamedMainAgent(pi as never);
		const start = handlers.get("session_start")?.[0];
		assert.ok(start);
		await start({ reason: "startup" }, ctx);
		assert.deepEqual(activeTools, ["read", "github_search_repositories"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("replace mode keeps opted-in project context and removes opted-out skills", async () => {
	const mainAgentModule = await import("../../src/extension/main-agent.ts");
	assert.equal(typeof mainAgentModule.composeMainAgentPrompt, "function", "main-agent prompt composition is not implemented");
	const prompt = mainAgentModule.composeMainAgentPrompt({
		name: "leader",
		systemPrompt: "Leader prompt.",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read"],
	}, {
		systemPrompt: "Pi base prompt with the global skills catalog.",
		systemPromptOptions: {
			cwd: "/repo",
			appendSystemPrompt: "Global append.",
			contextFiles: [{ path: "/repo/AGENTS.md", content: "Project rule." }],
			skills: [{
				name: "global-skill",
				description: "Global skill description",
				filePath: "/skills/global-skill/SKILL.md",
				disableModelInvocation: false,
			}],
		},
	});

	assert.equal(prompt, [
		"Leader prompt.",
		"",
		"Global append.",
		"",
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		"<project_instructions path=\"/repo/AGENTS.md\">",
		"Project rule.",
		"</project_instructions>",
		"",
		"</project_context>",
		"",
		"Current working directory: /repo",
	].join("\n"));
});

test("append mode removes project context and skills when the agent opts out", async () => {
	const { composeMainAgentPrompt } = await import("../../src/extension/main-agent.ts");
	const basePrompt = [
		"Pi base prompt.",
		"",
		"<project_context>",
		"Project-specific instructions and guidelines:",
		"<project_instructions path=\"/repo/AGENTS.md\">",
		"Project rule.",
		"</project_instructions>",
		"</project_context>",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"<available_skills>",
		"  <skill><name>global-skill</name></skill>",
		"</available_skills>",
		"Current working directory: /repo",
	].join("\n");

	const prompt = composeMainAgentPrompt({
		name: "isolated",
		systemPrompt: "Isolated agent prompt.",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
	}, {
		systemPrompt: basePrompt,
		systemPromptOptions: { cwd: "/repo" },
	});

	assert.equal(prompt, "Pi base prompt.\n\nCurrent working directory: /repo\n\nIsolated agent prompt.");
});

test("injects explicitly selected agent-local skills without inheriting the global catalog", async () => {
	const { composeMainAgentPrompt } = await import("../../src/extension/main-agent.ts");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-skill-"));
	try {
		const agentFile = path.join(root, "agents", "leader.md");
		const skillFile = path.join(root, "skills", "bdd", "SKILL.md");
		fs.mkdirSync(path.dirname(agentFile), { recursive: true });
		fs.mkdirSync(path.dirname(skillFile), { recursive: true });
		fs.writeFileSync(skillFile, `---
name: bdd
description: Write executable acceptance scenarios
---

# BDD
`, "utf-8");

		const prompt = composeMainAgentPrompt({
			name: "leader",
			filePath: agentFile,
			systemPrompt: "Leader prompt.",
			systemPromptMode: "append",
			inheritProjectContext: false,
			inheritSkills: false,
			skills: ["bdd"],
			skillPath: ["../skills"],
		}, {
			systemPrompt: "Pi base prompt.\nCurrent working directory: /repo",
			systemPromptOptions: { cwd: "/repo" },
		});

		assert.match(prompt, /<name>bdd<\/name>/);
		assert.match(prompt, /Write executable acceptance scenarios/);
		assert.match(prompt, new RegExp(skillFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(prompt, /global-skill/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("injects the selected agent memory into the main prompt", async () => {
	const { composeMainAgentPrompt } = await import("../../src/extension/main-agent.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-memory-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const memoryFile = path.join(agentDir, "agent-memory", "leader", "MEMORY.md");
		fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
		fs.writeFileSync(memoryFile, "Use BDD before implementation.\n", "utf-8");

		const prompt = composeMainAgentPrompt({
			name: "leader",
			description: "Coordinates work",
			filePath: path.join(agentDir, "agents", "leader.md"),
			source: "user",
			systemPrompt: "Leader prompt.",
			systemPromptMode: "append",
			inheritProjectContext: false,
			inheritSkills: false,
			tools: ["read"],
			memory: { scope: "user", path: "leader" },
		}, {
			systemPrompt: "Pi base prompt.",
			systemPromptOptions: { cwd: "/repo" },
		});

		assert.match(prompt, /# Persistent agent memory/);
		assert.match(prompt, /Use BDD before implementation\./);
		assert.match(prompt, /read-only, role-specific memory scope/);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("restores the named main agent when its session is resumed or reloaded", async () => {
	const { registerNamedMainAgent } = await import("../../src/extension/main-agent.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-resume-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "leader.md"), `---
name: leader
description: Coordinates work
systemPromptMode: append
inheritProjectContext: true
inheritSkills: true
---

Leader prompt.
`, "utf-8");

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const pi = {
			registerFlag() {},
			getFlag() { return undefined; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			appendEntry() {},
		};
		const ctx = {
			cwd: agentDir,
			modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
			sessionManager: {
				getEntries() {
					return [{ type: "custom", customType: "pi-subagents:main-agent", data: { name: "leader" } }];
				},
			},
		};

		registerNamedMainAgent(pi as never);
		const handler = handlers.get("session_start")?.[0];
		const beforeStart = handlers.get("before_agent_start")?.[0];
		assert.ok(handler);
		assert.ok(beforeStart);
		for (const reason of ["resume", "reload"]) {
			await handler({ reason }, ctx);
			assert.deepEqual(beforeStart({ systemPrompt: "Base prompt." }, ctx), {
				systemPrompt: "Base prompt.\n\nLeader prompt.",
			});
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("does not carry a named main agent into an unrelated session", async () => {
	const { registerNamedMainAgent } = await import("../../src/extension/main-agent.ts");
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-switch-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "leader.md"), `---
name: leader
description: Coordinates work
systemPromptMode: append
---

Leader prompt.
`, "utf-8");

		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		let requested: string | undefined = "leader";
		const pi = {
			registerFlag() {},
			getFlag() { return requested; },
			on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
				const current = handlers.get(name) ?? [];
				current.push(handler);
				handlers.set(name, current);
			},
			appendEntry() {},
		};
		const ctx = {
			cwd: agentDir,
			modelRegistry: { getAvailable() { return []; }, find() { return undefined; } },
			sessionManager: { getEntries() { return []; } },
		};

		registerNamedMainAgent(pi as never);
		const start = handlers.get("session_start")?.[0];
		const beforeStart = handlers.get("before_agent_start")?.[0];
		assert.ok(start);
		assert.ok(beforeStart);
		await start({ reason: "startup" }, ctx);
		assert.deepEqual(beforeStart({ systemPrompt: "Base prompt." }, ctx), {
			systemPrompt: "Base prompt.\n\nLeader prompt.",
		});

		requested = undefined;
		await start({ reason: "new" }, ctx);
		assert.equal(beforeStart({ systemPrompt: "Base prompt." }, ctx), undefined);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

test("does not propagate the named main-agent prompt into a different subagent", () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-child-"));
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-main-agent-project-"));
	try {
		fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "agents", "leader.md"), `---
name: leader
description: Coordinates work
tools: read, subagent
systemPromptMode: replace
---

LEADER_ONLY_PROMPT_MARKER
`, "utf-8");
		fs.writeFileSync(path.join(agentDir, "agents", "worker.md"), `---
name: worker
description: Performs focused work
tools: read
systemPromptMode: replace
completionGuard: false
---

WORKER_ONLY_PROMPT_MARKER
`, "utf-8");

		const script = String.raw`
			import assert from "node:assert/strict";
			import registerSubagentExtension from "./index.ts";
			import { createMockPi } from "./test/support/helpers.ts";

			const mockPi = createMockPi();
			mockPi.install();
			mockPi.onCall({ output: "done" });
			const handlers = new Map();
			const activeTools = [];
			let subagentTool;
			const events = { on() { return () => {}; }, emit() {} };
			const pi = new Proxy({
				events,
				registerFlag() {},
				getFlag(name) { return name === "agent" ? "leader" : undefined; },
				on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
				registerTool(tool) { if (tool.name === "subagent") subagentTool = tool; },
				registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
				getAllTools() { return ["read", "bash", "write", "edit", "grep", "find", "ls", "subagent"].map((name) => ({ name })); },
				getActiveTools() { return activeTools; },
				setActiveTools(names) { activeTools.splice(0, activeTools.length, ...names); },
				appendEntry() {},
				getSessionName() { return undefined; },
			}, { get(target, property) { return property in target ? target[property] : () => undefined; } });
			const model = { provider: "mock", id: "test-model", reasoning: true };
			const ctx = {
				cwd: ${JSON.stringify(projectDir)},
				hasUI: false,
				ui: {},
				model,
				modelRegistry: {
					getAvailable() { return [model]; },
					find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
				},
				sessionManager: {
					getSessionId() { return "named-main-agent-parent"; },
					getSessionFile() { return null; },
					getEntries() { return []; },
					getBranch() { return []; },
				},
			};

			try {
				registerSubagentExtension(pi);
				for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
				let parentPrompt = "Pi base prompt.";
				for (const handler of handlers.get("before_agent_start") ?? []) {
					const result = await handler({ systemPrompt: parentPrompt }, ctx);
					if (result?.systemPrompt) parentPrompt = result.systemPrompt;
				}
				assert.match(parentPrompt, /LEADER_ONLY_PROMPT_MARKER/);
				assert.ok(subagentTool, "subagent tool was not registered");
				const result = await subagentTool.execute(
					"named-main-agent-child",
					{ agent: "worker", task: "Inspect the assigned input.", async: false, context: "fresh", acceptance: false },
					new AbortController().signal,
					undefined,
					ctx,
				);
				assert.notEqual(result.isError, true, JSON.stringify(result.content));
				assert.equal(mockPi.sessions.length, 1);
				const launch = mockPi.sessions[0].launch;
				const childPrompt = launch.systemPrompt ?? launch.appendSystemPrompt ?? "";
				assert.match(childPrompt, /WORKER_ONLY_PROMPT_MARKER/);
				assert.doesNotMatch(childPrompt, /LEADER_ONLY_PROMPT_MARKER/);
			} finally {
				for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
				mockPi.uninstall();
			}
		`;
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
		delete env.PI_SUBAGENT_CHILD;
		execFileSync(
			process.execPath,
			["--experimental-strip-types", "--import", "./test/support/register-loader.mjs", "--input-type=module", "--eval", script],
			{ cwd: projectRoot, env, stdio: "pipe" },
		);
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(projectDir, { recursive: true, force: true });
	}
});
