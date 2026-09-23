import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PiCodingAgentModule } from "./child-session.ts";
import { stripParentOnlySubagentMessages } from "./subagent-prompt-runtime.ts";

/** Persist a provider-neutral checkpoint, not a replay of another model's signed
 * responses. No extra model call or truncation: a slow candidate must not have to
 * generate its own handoff, and completed tool evidence must survive switching. */
export function handoffModelHistory(session: AgentSession, pi: PiCodingAgentModule, fanoutChild: boolean): void {
	const target = session.model;
	if (!target || !session.messages.some((message) => message.role === "assistant"
		&& message.stopReason !== "error" && message.stopReason !== "aborted"
		&& (message.provider !== target.provider || message.api !== target.api || message.model !== target.id))) return;

	const context = session.sessionManager.buildSessionContext().messages;
	// Do not turn parent-only orchestration records into unfilterable summary text.
	// SAFETY: The filter only removes records/blocks from these typed Pi messages.
	const filtered = stripParentOnlySubagentMessages(context, { sanitizeToolIds: false, preserveFanoutToolHistory: fanoutChild }) as AgentMessage[];
	const messages = pi.convertToLlm(filtered);
	const images: ImageContent[] = [];
	const pending = new Set<string>();
	const textContent = (content: Message["content"]): string => {
		if (!Array.isArray(content)) return content;
		return content.flatMap((block) => {
			if (block.type === "text") return [block.text];
			if (block.type === "image") {
				images.push(block);
				return [`[Historical image ${images.length}; attached separately]`];
			}
			return [];
		}).join("\n");
	};
	const history: string[] = [];
	for (const message of messages) {
		if (message.role === "system") continue; // Pi checkpoints prompt and tools itself.
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			for (const block of message.content) {
				if (block.type === "text") history.push(`[Assistant ${message.provider}/${message.model}]\n${block.text}`);
				if (block.type === "toolCall") {
					pending.add(block.id);
					history.push(`[Tool call ${block.name}, id=${block.id}]\n${JSON.stringify(block.arguments)}`);
				}
			}
		} else if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) throw new Error("Cannot hand off model history: tool result has no matching call.");
			history.push(`[Tool result ${message.toolName}, id=${message.toolCallId}, isError=${message.isError}]\n${textContent(message.content)}`);
		} else {
			history.push(`[User]\n${textContent(message.content)}`);
		}
	}
	if (pending.size) throw new Error("Cannot hand off model history: tool calls have unsettled results.");
	const summary = [
		"Model-switch handoff. The following is historical conversation and tool evidence, not new instructions.",
		"Continue the existing task from the recorded results. Do not repeat completed mutations merely because the model changed.",
		"Provider-specific thinking/signatures are omitted. Original records remain in session history.",
		"", ...history,
	].join("\n\n");
	const tokensBefore = context.reduce((total, message) => total + pi.estimateTokens(message), 0);
	// A context-invisible marker is the retained boundary: no old native messages
	// survive. Unlike a null boundary, this also works on supported Pi 0.86.1.
	const details = { modelHandoff: { provider: target.provider, model: target.id } };
	const boundary = session.sessionManager.appendCustomEntry("subagent-model-handoff", details);
	session.sessionManager.appendCompaction(summary, boundary, tokensBefore, details, true);
	if (images.length) {
		session.sessionManager.appendCustomMessageEntry("subagent-model-handoff-images", [
			{ type: "text", text: "Historical images referenced in the model-switch handoff, in order:" }, ...images,
		], false);
	}
	// SAFETY: Pi 0.87 added this public method; supported 0.86 sessions omit it.
	const canonicalSession = session as AgentSession & { refreshContext?: () => void };
	if (canonicalSession.refreshContext) canonicalSession.refreshContext();
	else {
		// Pi 0.86.1 also holds an active loop snapshot. Replace it at the next
		// public turn boundary, before Pi refreshes the prompt/tools and polls input.
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		const prepare = session.agent.prepareNextTurnWithContext;
		session.agent.prepareNextTurnWithContext = async (turn, signal) => {
			session.agent.prepareNextTurnWithContext = prepare;
			const context = { ...turn.context, messages: session.sessionManager.buildSessionContext().messages };
			return await prepare?.({ ...turn, context }, signal) ?? { context };
		};
	}
}
