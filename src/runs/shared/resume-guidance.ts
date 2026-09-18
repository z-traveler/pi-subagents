import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../shared/utils.ts";
import type { Details } from "../../shared/types.ts";

export const ASYNC_RUN_NOT_FOUND_MESSAGE = "Async run not found. Provide id or dir.";
const RESUME_UNAVAILABLE_NO_SESSION = "Resume: unavailable; no child session file was persisted.";
const RESUME_UNAVAILABLE_STOPPED = "Resume: unavailable; stopped runs are not resumable. Start a new run instead.";
const MISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasExistingSessionFile(value: unknown): value is string {
	return typeof value === "string" && fs.existsSync(value);
}

/**
 * One resume hint line for a run's children. Shared by `status`, intercom result
 * delivery, and the foreground tool result so every surface names the same
 * revive call instead of each formatting its own copy.
 */
export function formatResumeGuidance(runId: string | undefined, children: Array<{ agent?: unknown; sessionFile?: unknown; runId?: unknown; workflowKey?: unknown; status?: unknown; activityState?: unknown }>, fallbackSessionFile?: unknown, options: { stopped?: boolean } = {}): string {
	if (options.stopped) return RESUME_UNAVAILABLE_STOPPED;
	const knownChildren = children
		.map((child, index) => ({ child, index }))
		.filter(({ child }) => typeof child.agent === "string");
	if (!runId || knownChildren.length === 0) return RESUME_UNAVAILABLE_NO_SESSION;
	const workflowChildren = knownChildren.filter(({ child }) => typeof child.runId === "string" && child.runId.trim() && hasExistingSessionFile(child.sessionFile));
	const supervisorDetachedWorkflowChildren = workflowChildren.filter(({ child }) => child.status === "paused" && child.activityState === "needs_attention");
	const resumableWorkflowChildren = workflowChildren.filter(({ child }) => !(child.status === "paused" && child.activityState === "needs_attention"));
	if (workflowChildren.length > 0) {
		return [
			...supervisorDetachedWorkflowChildren.map(({ child }) => `Recovery workflow child${typeof child.workflowKey === "string" && child.workflowKey.trim() ? ` '${child.workflowKey}'` : ""}: reply to the supervisor request first, then wait with bg_wait({ id: "${child.runId}" }). Use subagent({ action: "status", id: "${child.runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.`),
			...resumableWorkflowChildren.map(({ child }) => `Revive workflow child${typeof child.workflowKey === "string" && child.workflowKey.trim() ? ` '${child.workflowKey}'` : ""}: subagent({ action: "resume", id: "${child.runId}", message: "..." })`),
		].join("\n");
	}
	const singleSessionFile = knownChildren[0]?.child.sessionFile ?? fallbackSessionFile;
	if (children.length === 1 && knownChildren.length === 1 && hasExistingSessionFile(singleSessionFile)) {
		return `Revive: subagent({ action: "resume", id: "${runId}", message: "..." })`;
	}
	const childWithSession = knownChildren.find(({ child }) => hasExistingSessionFile(child.sessionFile));
	if (childWithSession) {
		return `Revive child: subagent({ action: "resume", id: "${runId}", index: ${childWithSession.index}, message: "..." })`;
	}
	return RESUME_UNAVAILABLE_NO_SESSION;
}

/**
 * Append the resume hint to a launch result the model can see. Live async
 * launches, workflows, management results, delegated (nested) results, and
 * machine-readable payloads already carry their own identity or must stay
 * parseable, so they are left untouched.
 */
export function annotateResumeGuidance(result: AgentToolResult<Details>, options: { delegated?: boolean } = {}): AgentToolResult<Details> {
	if (result.isError === true || options.delegated === true) return result;
	const details = result.details;
	if (!details || details.asyncId !== undefined || details.background === true) return result;
	if (details.mode === "workflow" || details.mode === "management") return result;
	if (details.results.length === 0) return result;
	if (details.results.some((child) => child.structuredOutputPath !== undefined)) return result;
	const lastTextIndex = result.content.findLastIndex((item) => item.type === "text");
	if (lastTextIndex < 0) return result;
	const lastText = (result.content[lastTextIndex] as { type: "text"; text: string }).text;
	if (isJsonText(lastText)) return result;
	const guidance = formatResumeGuidance(details.runId, details.results.map((child) => ({ agent: child.agent, sessionFile: child.sessionFile })));
	return {
		...result,
		content: result.content.map((item, index) => index === lastTextIndex && item.type === "text" ? { ...item, text: `${item.text}\n${guidance}` } : item),
	};
}

function isJsonText(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * `resume` and `status` accept a run id, and a result trailer also prints a
 * mission id in the same UUID shape. Recovering from that mix-up is worth one
 * read-only store scan on the error path only.
 */
export function asyncRunNotFoundMessage(requestedId?: string): string {
	if (requestedId && isKnownMissionId(requestedId)) {
		return `${ASYNC_RUN_NOT_FOUND_MESSAGE} '${requestedId}' is a mission id, not a run id. Run ids come from a launch result, a completion card, children.list, or subagent({ action: "status", id: "..." }).`;
	}
	return ASYNC_RUN_NOT_FOUND_MESSAGE;
}

function isKnownMissionId(missionId: string): boolean {
	if (!MISSION_ID_PATTERN.test(missionId)) return false;
	const projectsDir = path.join(getAgentDir(), "missions", "projects");
	let projectKeys: string[];
	try {
		projectKeys = fs.readdirSync(projectsDir);
	} catch {
		return false;
	}
	return projectKeys.some((key) => fs.existsSync(path.join(projectsDir, key, `${missionId}.json`)));
}
