import type { ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import { generationDeltaText } from "./model-performance.ts";
import type { ModelPerformanceProbeExecutor } from "./model-performance-probe.ts";

const PROBE_SYSTEM_PROMPT = "Generate only the requested probe text. Do not call tools or explain the task.";

/** Run a bounded performance probe in an isolated, tool-free child session. */
export function createChildSessionModelPerformanceProbeExecutor(
	factory: ChildSessionFactory,
	launchTemplate: ChildSessionLaunch,
): ModelPerformanceProbeExecutor {
	return async ({ candidate, signal, prompt, maxEstimatedTokens, onDelta }) => {
		const probeLaunch: ChildSessionLaunch = {
			cwd: launchTemplate.cwd,
			storage: { kind: "memory" },
			model: candidate,
			maxOutputTokens: maxEstimatedTokens,
			tools: [],
			extensionPaths: [],
			ambientExtensions: false,
			hooks: [],
			noSkills: true,
			noContextFiles: true,
			systemPrompt: PROBE_SYSTEM_PROMPT,
			runtime: launchTemplate.runtime,
		};
		if (launchTemplate.processEnv) probeLaunch.processEnv = { ...launchTemplate.processEnv };
		if (launchTemplate.onExtensionError) probeLaunch.onExtensionError = launchTemplate.onExtensionError;
		const session = await factory.create(probeLaunch);
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_update") return;
			const delta = generationDeltaText(event.assistantMessageEvent);
			if (delta) onDelta(delta);
		});
		const abort = () => { void session.abort().catch(() => {}); };
		signal.addEventListener("abort", abort, { once: true });
		try {
			if (signal.aborted) {
				await session.abort().catch(() => {});
				return;
			}
			try {
				await session.prompt(prompt);
			} catch (error) {
				if (!signal.aborted) throw error;
			}
			const terminal = session.messages.at(-1);
			if (!signal.aborted && terminal?.role === "assistant"
				&& (terminal.stopReason === "error" || terminal.stopReason === "aborted")) {
				throw new Error(terminal.errorMessage || `Model performance probe stopped with ${terminal.stopReason}.`);
			}
		} finally {
			signal.removeEventListener("abort", abort);
			unsubscribe();
			await session.dispose();
		}
	};
}
