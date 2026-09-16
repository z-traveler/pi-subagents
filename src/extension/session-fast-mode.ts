import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionFastModePolicy, type SessionFastModeSnapshot } from "../runs/shared/session-fast-mode.ts";

export const SESSION_FAST_MODE_ENTRY_TYPE = "pi-subagents:session-fast-mode";
const SESSION_FAST_MODE_STATUS_KEY = SESSION_FAST_MODE_ENTRY_TYPE;

function syncSessionFastModeStatus(ctx: ExtensionContext, policy: SessionFastModePolicy): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(SESSION_FAST_MODE_STATUS_KEY, policy.enabled ? "fast" : undefined);
}

function restoredSessionFastMode(ctx: ExtensionContext): boolean {
	// Minimal hosts (and several test fixtures) expose no branch accessor; without branch
	// history there is no stored Session Fast state, which is the documented default.
	if (typeof ctx.sessionManager.getBranch !== "function") return false;
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "custom" || entry.customType !== SESSION_FAST_MODE_ENTRY_TYPE) continue;
		// SAFETY: session entries are untrusted; enabled is validated below before use.
		const enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled;
		if (typeof enabled === "boolean") return enabled;
	}
	return false;
}

function formatStatus(policy: SessionFastModePolicy, modelId: string | undefined): string {
	const mode = policy.enabled ? "on" : "off";
	if (!modelId) return `Fast mode: ${mode}.`;
	return `Fast mode: ${mode}; current model ${modelId} is ${policy.isEligible(modelId) ? "eligible" : "not eligible"}.`;
}

export function registerSessionFastMode(
	pi: ExtensionAPI,
	modelIds: readonly string[],
	options: { onChange?: (snapshot: SessionFastModeSnapshot) => void } = {},
): SessionFastModePolicy {
	const policy = new SessionFastModePolicy(modelIds);

	pi.on("session_start", (_event, ctx) => {
		policy.setEnabled(restoredSessionFastMode(ctx));
		syncSessionFastModeStatus(ctx, policy);
	});
	pi.on("before_provider_request", (event, ctx) => policy.rewriteProviderRequest(event.payload, ctx.model?.id));
	pi.registerCommand("fast", {
		description: "Toggle Session Fast routing, or set it with /fast on|off|status",
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command && command !== "on" && command !== "off" && command !== "status") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			if (command === "status") {
				ctx.ui.notify(formatStatus(policy, ctx.model?.id), "info");
				return;
			}
			const enabled = command === "on" ? true : command === "off" ? false : !policy.enabled;
			if (enabled !== policy.enabled) {
				policy.setEnabled(enabled);
				pi.appendEntry(SESSION_FAST_MODE_ENTRY_TYPE, { enabled });
				options.onChange?.(policy.snapshot());
			}
			syncSessionFastModeStatus(ctx, policy);
			ctx.ui.notify(formatStatus(policy, ctx.model?.id), "info");
		},
	});

	return policy;
}
