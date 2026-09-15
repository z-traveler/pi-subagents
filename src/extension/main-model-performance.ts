import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, type Component } from "@earendil-works/pi-tui";
import { discoverAgents, type AgentDiscoveryResult } from "../agents/agents.ts";
import { resolveModelCandidate, type AvailableModelInfo } from "../runs/shared/model-fallback.ts";
import {
	createModelPerformanceCacheKey,
	DEFAULT_MODEL_PERFORMANCE_CONFIG,
	generationDeltaText,
	GenerationPerformanceMonitor,
	ModelPerformanceStore,
	rankModelCandidates,
	resolveModelPerformanceConfig,
	type ModelPerformanceCacheKey,
	type ModelPerformanceConfig,
	type ModelPerformanceObservation,
	type ThroughputAssessment,
} from "../runs/shared/model-performance.ts";
import { splitKnownThinkingSuffix, toModelInfo } from "../shared/model-info.ts";
import { modelPoolDigest, type ModelPools } from "../shared/model-routing.ts";

export const MAIN_MODEL_PERFORMANCE_ADVISORY_ENTRY_TYPE = "pi-subagents:main-model-performance-advisory";

export interface MainModelPerformanceRoute {
	modelClass: string;
	poolDigest: string;
	candidates: string[];
	currentCandidates: string[];
}

export interface MainModelPerformanceAdvisoryDetails {
	assessment: Exclude<ThroughputAssessment, "normal">;
	currentModel: string;
	modelClass?: string;
	recommendedModel?: string;
	ttftMs: number;
	estimatedTokensPerSecond?: number;
}

export interface MainPerformanceSettings {
	modelPools?: ModelPools;
	modelPerformance?: ModelPerformanceConfig;
}

export interface MainPerformanceContext {
	cwd: string;
	hasUI?: boolean;
	model?: { provider: string; id: string };
	modelRegistry: { getAvailable(): Array<Parameters<typeof toModelInfo>[0]> };
}

export interface ModelPerformanceStoreLike {
	read(key: ModelPerformanceCacheKey, ttlMs: number): ModelPerformanceObservation[];
	record(key: ModelPerformanceCacheKey, observation: ModelPerformanceObservation, ttlMs?: number): void;
	invalidate(key: ModelPerformanceCacheKey, candidate: string): void;
}

export interface MainModelPerformanceProbeRequest {
	key: ModelPerformanceCacheKey;
	candidates: readonly string[];
	config: ModelPerformanceConfig;
	context: MainPerformanceContext;
}

export interface MainModelPerformanceRuntimeOptions {
	now?: () => number;
	schedule?: (run: () => void, intervalMs: number) => () => void;
	store?: ModelPerformanceStoreLike;
	getThinkingLevel?: () => string | undefined;
	resolveSettings(context: MainPerformanceContext): MainPerformanceSettings;
	display(details: MainModelPerformanceAdvisoryDetails, context: MainPerformanceContext): void;
	probe?: (request: MainModelPerformanceProbeRequest) => void | Promise<void>;
}

interface ActiveTurn {
	context: MainPerformanceContext;
	config: ModelPerformanceConfig;
	currentModel: string;
	monitor: GenerationPerformanceMonitor;
	route?: MainModelPerformanceRoute;
	currentCandidate?: string;
	startedAt: number;
	degradation?: Exclude<ThroughputAssessment, "normal">;
	cancelTimer?: () => void;
}

function canonicalModelCandidates(
	candidates: readonly string[],
	availableModels: AvailableModelInfo[],
	preferredProvider: string,
): string[] {
	return candidates.map((candidate) => resolveModelCandidate(candidate, availableModels, preferredProvider) ?? candidate);
}

function baseModel(model: string): string {
	return splitKnownThinkingSuffix(model).baseModel;
}

function exactCurrentCandidate(route: MainModelPerformanceRoute, thinkingLevel: string | undefined): string | undefined {
	if (!thinkingLevel) return undefined;
	const matches = route.currentCandidates.filter((candidate) => {
		const suffix = splitKnownThinkingSuffix(candidate).thinkingSuffix;
		return (suffix ? suffix.slice(1) : "off") === thinkingLevel;
	});
	return matches.length === 1 ? matches[0] : undefined;
}

export function resolveMainModelPerformanceRoute(input: {
	currentModel: { provider: string; id: string };
	modelPools: ModelPools | undefined;
	availableModels: AvailableModelInfo[];
}): MainModelPerformanceRoute | undefined {
	const currentModel = `${input.currentModel.provider}/${input.currentModel.id}`;
	const matches: MainModelPerformanceRoute[] = [];
	for (const [modelClass, configuredCandidates] of Object.entries(input.modelPools ?? {})) {
		const candidates = canonicalModelCandidates(configuredCandidates, input.availableModels, input.currentModel.provider);
		const currentCandidates = candidates.filter((candidate) => baseModel(candidate) === currentModel);
		if (currentCandidates.length === 0) continue;
		matches.push({
			modelClass,
			poolDigest: modelPoolDigest(modelClass, candidates),
			candidates,
			currentCandidates,
		});
	}
	return matches.length === 1 ? matches[0] : undefined;
}

function successfulAssistantMessage(message: { role?: unknown; stopReason?: unknown }): boolean {
	return message.role === "assistant"
		&& (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse");
}

function cacheKey(route: MainModelPerformanceRoute): ModelPerformanceCacheKey {
	return createModelPerformanceCacheKey(route, route.candidates);
}

export class MainModelPerformanceRuntime {
	private readonly now: () => number;
	private readonly schedule: (run: () => void, intervalMs: number) => () => void;
	private readonly store: ModelPerformanceStoreLike;
	private readonly options: MainModelPerformanceRuntimeOptions;
	private readonly warnedModels = new Set<string>();
	private activeSession = false;
	private settings: MainPerformanceSettings = {};
	private turn?: ActiveTurn;

	constructor(options: MainModelPerformanceRuntimeOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? ((run, intervalMs) => {
			const timer = setInterval(run, intervalMs);
			timer.unref?.();
			return () => clearInterval(timer);
		});
		this.store = options.store ?? new ModelPerformanceStore();
	}

	startSession(context: MainPerformanceContext): void {
		this.stopTurn();
		this.warnedModels.clear();
		this.activeSession = context.hasUI === true;
		this.settings = {};
		if (!this.activeSession) return;
		try {
			this.settings = this.options.resolveSettings(context);
		} catch {
			// Performance monitoring must never prevent the interactive session from starting.
		}
	}

	startTurn(context: MainPerformanceContext): void {
		this.stopTurn();
		if (!this.activeSession || context.hasUI !== true || !context.model) return;
		try {
			const startedAt = this.now();
			const config = this.settings.modelPerformance ?? resolveModelPerformanceConfig();
			const availableModels = context.modelRegistry.getAvailable().map(toModelInfo);
			const route = resolveMainModelPerformanceRoute({
				currentModel: context.model,
				modelPools: this.settings.modelPools,
				availableModels,
			});
			const turn: ActiveTurn = {
				context,
				config,
				currentModel: `${context.model.provider}/${context.model.id}`,
				monitor: new GenerationPerformanceMonitor(config, startedAt),
				startedAt,
			};
			if (route) {
				turn.route = route;
				turn.currentCandidate = exactCurrentCandidate(route, this.options.getThinkingLevel?.());
			}
			turn.cancelTimer = this.schedule(
				() => this.tick(),
				Math.min(1_000, Math.max(10, config.firstTokenTimeoutMs)),
			);
			this.turn = turn;
		} catch {
			// Monitoring setup is best effort and cannot affect the main response.
		}
	}

	messageUpdate(event: { type?: unknown; delta?: unknown }): void {
		if (!this.turn) return;
		const delta = generationDeltaText(event);
		if (!delta) return;
		const now = this.now();
		this.turn.monitor.recordDelta(delta, now);
		this.assess(this.turn, now);
	}

	messageEnd(message: { role?: unknown; stopReason?: unknown }): void {
		const turn = this.turn;
		if (!turn || message.role !== "assistant") return;
		if (successfulAssistantMessage(message)) this.recordRunObservation(turn, this.now());
		this.stopTurn();
	}

	endTurn(): void {
		this.stopTurn();
	}

	endSession(): void {
		this.activeSession = false;
		this.stopTurn();
	}

	tick(): void {
		if (this.turn) this.assess(this.turn, this.now());
	}

	private assess(turn: ActiveTurn, at: number): void {
		const assessment = turn.monitor.assess(at);
		if (assessment === "normal" || turn.degradation) return;
		turn.degradation = assessment;
		const route = turn.route;
		if (route && turn.currentCandidate) {
			const sample = turn.monitor.complete(at);
			if (sample) {
				this.recordObservation(route, {
					candidate: turn.currentCandidate,
					recordedAt: at,
					ttftMs: sample.ttftMs,
					estimatedTokensPerSecond: sample.estimatedTokensPerSecond,
					source: "run",
				}, turn.config.cacheTtlMs);
			} else {
				try {
					this.store.invalidate(cacheKey(route), turn.currentCandidate);
				} catch {
					// Cache persistence is best effort and cannot affect the main response.
				}
			}
		}

		const alternatives = route
			? route.candidates.filter((candidate) => baseModel(candidate) !== turn.currentModel)
			: [];
		if (route && alternatives.length > 0) this.startProbe(turn, route, alternatives);

		const warningKey = turn.currentModel;
		if (this.warnedModels.has(warningKey)) return;
		this.warnedModels.add(warningKey);
		const sample = turn.monitor.complete(at);
		const recommendedModel = route && alternatives.length > 0
			? rankModelCandidates(alternatives, this.readObservations(route, turn.config.cacheTtlMs))[0]
			: undefined;
		try {
			const details: MainModelPerformanceAdvisoryDetails = {
				assessment,
				currentModel: turn.currentModel,
				ttftMs: sample?.ttftMs ?? at - turn.startedAt,
			};
			if (route) details.modelClass = route.modelClass;
			if (recommendedModel) details.recommendedModel = recommendedModel;
			if (sample) details.estimatedTokensPerSecond = sample.estimatedTokensPerSecond;
			this.options.display(details, turn.context);
		} catch {
			// Advisory rendering is best effort and cannot affect the main response.
		}
	}

	private startProbe(turn: ActiveTurn, route: MainModelPerformanceRoute, candidates: string[]): void {
		if (!this.options.probe) return;
		try {
			void Promise.resolve(this.options.probe({ key: cacheKey(route), candidates, config: turn.config, context: turn.context })).catch(() => {});
		} catch {
			// Probe failures are advisory and must not affect the main response.
		}
	}

	private recordRunObservation(turn: ActiveTurn, at: number): void {
		if (!turn.route || !turn.currentCandidate) return;
		const sample = turn.monitor.complete(at);
		if (!sample) return;
		this.recordObservation(turn.route, {
			candidate: turn.currentCandidate,
			recordedAt: at,
			ttftMs: sample.ttftMs,
			estimatedTokensPerSecond: sample.estimatedTokensPerSecond,
			source: "run",
		}, turn.config.cacheTtlMs);
	}

	private readObservations(route: MainModelPerformanceRoute, ttlMs: number): ModelPerformanceObservation[] {
		try {
			return this.store.read(cacheKey(route), ttlMs);
		} catch {
			return [];
		}
	}

	private recordObservation(route: MainModelPerformanceRoute, observation: ModelPerformanceObservation, ttlMs: number): void {
		try {
			this.store.record(cacheKey(route), observation, ttlMs);
		} catch {
			// Cache persistence is best effort and cannot affect the main response.
		}
	}

	private stopTurn(): void {
		this.turn?.cancelTimer?.();
		this.turn = undefined;
	}
}

export function formatMainModelPerformanceAdvisory(details: MainModelPerformanceAdvisoryDetails): string {
	const measurement = details.estimatedTokensPerSecond === undefined
		? `No generated output was observed for ${(details.ttftMs / 1_000).toFixed(1)}s.`
		: `Estimated generation throughput is ${details.estimatedTokensPerSecond.toFixed(1)} token/s.`;
	const recommendation = details.recommendedModel && details.modelClass
		? `Suggested ${details.modelClass} candidate: ${details.recommendedModel}.`
		: details.modelClass
			? `No other ${details.modelClass} candidate can be recommended from the current pool.`
			: "The current model does not map to exactly one configured model class, so no candidate is recommended.";
	return [
		"Main model is responding slowly",
		`Current model: ${details.currentModel}`,
		measurement,
		"The current response is continuing; pi-subagents did not interrupt or switch the main model.",
		recommendation,
	].join("\n");
}

function renderMainModelPerformanceAdvisory(
	entry: { data?: MainModelPerformanceAdvisoryDetails },
	options: { expanded: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Component | undefined {
	const details = entry.data;
	if (!details) return undefined;
	const lines = formatMainModelPerformanceAdvisory(details).split("\n");
	const container = new Container();
	container.addChild(new Text(theme.fg("warning", theme.bold(`⚠ ${lines[0]}`)), 0, 0));
	if (options.expanded) {
		container.addChild(new Spacer(1));
		for (const line of lines.slice(1)) container.addChild(new Text(theme.fg("dim", line), 0, 0));
	} else {
		const summary = details.recommendedModel
			? `  ⎿  consider ${details.recommendedModel}`
			: `  ⎿  ${lines[2]}`;
		container.addChild(new Text(theme.fg("dim", summary), 0, 0));
	}
	return container;
}

export interface RegisterMainModelPerformanceOptions {
	discover?: (cwd: string, preferredModelProvider?: string) => Pick<AgentDiscoveryResult, "modelPools" | "modelPerformance">;
	now?: () => number;
	schedule?: (run: () => void, intervalMs: number) => () => void;
	store?: ModelPerformanceStoreLike;
	probe?: (request: MainModelPerformanceProbeRequest) => void | Promise<void>;
}

export function registerMainModelPerformanceAdvisory(
	pi: ExtensionAPI,
	options: RegisterMainModelPerformanceOptions = {},
): MainModelPerformanceRuntime {
	pi.registerEntryRenderer<MainModelPerformanceAdvisoryDetails>(MAIN_MODEL_PERFORMANCE_ADVISORY_ENTRY_TYPE, renderMainModelPerformanceAdvisory);
	const discover = options.discover ?? ((cwd: string, provider?: string) => discoverAgents(cwd, "both", provider));
	const runtimeOptions: MainModelPerformanceRuntimeOptions = {
		resolveSettings: (context) => {
			const discovered = discover(context.cwd, context.model?.provider);
			return {
				modelPools: discovered.modelPools,
				modelPerformance: discovered.modelPerformance ?? DEFAULT_MODEL_PERFORMANCE_CONFIG,
			};
		},
		display: (details) => {
			pi.appendEntry(MAIN_MODEL_PERFORMANCE_ADVISORY_ENTRY_TYPE, details);
		},
	};
	if (options.now) runtimeOptions.now = options.now;
	if (options.schedule) runtimeOptions.schedule = options.schedule;
	if (options.store) runtimeOptions.store = options.store;
	if (options.probe) runtimeOptions.probe = options.probe;
	runtimeOptions.getThinkingLevel = () => pi.getThinkingLevel();
	const runtime = new MainModelPerformanceRuntime(runtimeOptions);

	pi.on("session_start", (_event, context) => runtime.startSession(context));
	pi.on("turn_start", (_event, context) => runtime.startTurn(context));
	pi.on("message_update", (event) => runtime.messageUpdate(event.assistantMessageEvent));
	pi.on("message_end", (event) => runtime.messageEnd(event.message));
	pi.on("turn_end", () => runtime.endTurn());
	pi.on("agent_end", () => runtime.endTurn());
	pi.on("session_shutdown", () => runtime.endSession());
	return runtime;
}
