import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { buildAgentMemoryInjection } from "../agents/agent-memory.ts";
import { discoverAgents, resolveAgentName, type AgentConfig } from "../agents/agents.ts";
import { buildSkillInjection, resolveSkills } from "../agents/skills.ts";
import { resolveMcpDirectToolNames } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { findModelInfo, THINKING_LEVELS, toModelInfo } from "../shared/model-info.ts";

const MAIN_AGENT_ENTRY_TYPE = "pi-subagents:main-agent";

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function restoredMainAgentName(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== MAIN_AGENT_ENTRY_TYPE) continue;
		const name = (entry.data as { name?: unknown } | undefined)?.name;
		if (typeof name === "string" && name.trim().length > 0) return name;
	}
	return undefined;
}

interface MainAgentPromptEvent {
	systemPrompt: string;
	systemPromptOptions?: {
		appendSystemPrompt?: string;
		cwd: string;
		contextFiles?: Array<{ path: string; content: string }>;
		skills?: Skill[];
	};
}

function appendProjectContext(prompt: string, contextFiles: Array<{ path: string; content: string }>): string {
	if (contextFiles.length === 0) return prompt;
	let result = `${prompt}\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n`;
	for (const contextFile of contextFiles) {
		result += `<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>\n\n`;
	}
	return `${result}</project_context>\n`;
}

function stripProjectContext(prompt: string): string {
	return prompt.replace(/\n{0,2}<project_context>[\s\S]*?<\/project_context>\n?/u, "\n\n");
}

function stripSkillsCatalog(prompt: string): string {
	return prompt.replace(
		/\n{0,2}The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>\n?/u,
		"\n\n",
	);
}

export function composeMainAgentPrompt(
	agent: Pick<AgentConfig, "inheritProjectContext" | "inheritSkills" | "systemPrompt" | "systemPromptMode" | "tools">
		& Partial<Pick<AgentConfig, "filePath" | "memory" | "skillPath" | "skills">>,
	event: MainAgentPromptEvent,
): string {
	const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
	let selectedSkillInjection = "";
	if (agent.skills?.length) {
		const selected = resolveSkills(
			agent.skills,
			cwd,
			agent.skillPath,
			agent.filePath ? path.dirname(agent.filePath) : cwd,
		);
		if (selected.missing.length > 0) throw new Error(`Main agent skills not found: ${selected.missing.join(", ")}.`);
		selectedSkillInjection = buildSkillInjection(selected.resolved, "main agent");
	}
	const memoryInjection = agent.memory ? buildAgentMemoryInjection(agent as AgentConfig, cwd) : "";

	if (agent.systemPromptMode === "append") {
		let prompt = event.systemPrompt;
		if (!agent.inheritProjectContext) prompt = stripProjectContext(prompt);
		if (!agent.inheritSkills) prompt = stripSkillsCatalog(prompt);
		return [prompt.replace(/\n{3,}/g, "\n\n"), agent.systemPrompt, selectedSkillInjection, memoryInjection].filter(Boolean).join("\n\n");
	}

	const options = event.systemPromptOptions;
	let prompt = agent.systemPrompt;
	if (!options) return prompt;
	if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
	if (agent.inheritProjectContext) prompt = appendProjectContext(prompt, options.contextFiles ?? []);
	if (agent.inheritSkills && (agent.tools === undefined || agent.tools.includes("read"))) {
		prompt += formatSkillsForPrompt(options.skills ?? []);
	}
	if (selectedSkillInjection) prompt += `\n\n${selectedSkillInjection}`;
	if (memoryInjection) prompt += `\n\n${memoryInjection}`;
	return `${prompt}\nCurrent working directory: ${options.cwd.replace(/\\/g, "/")}`;
}

async function applyMainAgent(pi: ExtensionAPI, ctx: ExtensionContext, agent: AgentConfig): Promise<void> {
	if (agent.model) {
		const modelInfo = findModelInfo(
			agent.model,
			ctx.modelRegistry.getAvailable().map(toModelInfo),
			ctx.model?.provider,
		);
		const model = modelInfo ? ctx.modelRegistry.find(modelInfo.provider, modelInfo.id) : undefined;
		if (!modelInfo || !model) throw new Error(`Main agent '${agent.name}' model '${agent.model}' is not available.`);
		if (!await pi.setModel(model)) throw new Error(`Main agent '${agent.name}' model '${modelInfo.fullId}' is not authenticated.`);
	}
	if (agent.thinking !== undefined) {
		const thinking = agent.thinking === false
			? "off"
			: THINKING_LEVELS.find((level) => level === agent.thinking);
		if (!thinking) throw new Error(`Main agent '${agent.name}' has unsupported thinking level '${agent.thinking}'.`);
		pi.setThinkingLevel(thinking);
	}
	if (agent.tools !== undefined || agent.mcpDirectTools !== undefined) {
		pi.setActiveTools([
			...(agent.tools ?? []),
			...resolveMcpDirectToolNames(agent.mcpDirectTools, ctx.cwd),
		]);
	}
	pi.appendEntry(MAIN_AGENT_ENTRY_TYPE, { name: agent.name });
}

export function registerNamedMainAgent(pi: ExtensionAPI): void {
	let activeAgent: AgentConfig | undefined;
	let startupError: Error | undefined;

	pi.registerFlag("agent", {
		type: "string",
		description: "Launch the main session as a declared agent (for example, --agent leader).",
	});

	pi.on("session_start", async (event, ctx) => {
		activeAgent = undefined;
		startupError = undefined;
		const flag = pi.getFlag("agent");
		const requested = typeof flag === "string" && flag.trim().length > 0
			? flag
			: event.reason === "resume" || event.reason === "reload"
				? restoredMainAgentName(ctx)
				: undefined;
		if (!requested) return;

		try {
			const resolution = resolveAgentName(requested, discoverAgents(ctx.cwd, "both").agents);
			if (resolution.error) throw new Error(resolution.error);
			if (!resolution.agent) throw new Error(`Main agent '${requested}' was not found.`);

			await applyMainAgent(pi, ctx, resolution.agent);
			activeAgent = resolution.agent;
		} catch (error) {
			startupError = error instanceof Error ? error : new Error(String(error));
			if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
			else ctx.shutdown();
			throw startupError;
		}
	});

	pi.on("input", () => startupError ? { action: "handled" } : { action: "continue" });

	pi.on("before_agent_start", (event) => {
		if (!activeAgent) return undefined;
		return { systemPrompt: composeMainAgentPrompt(activeAgent, event) };
	});
}
