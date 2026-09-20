import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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
import { renderFooter, renderHeader, row } from "../tui/render-helpers.ts";

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
	recommendedModelEstimatedTokensPerSecond?: number;
	recommendedModelThroughputAssessment?: ThroughputAssessment;
	ttftMs: number;
	estimatedTokensPerSecond?: number;
}

export interface MainModelPerformanceSnapshot {
	cacheTtlMs: number;
	hardTokensPerSecond: number;
	softTokensPerSecond: number;
	classes: Array<{
		modelClass: string;
		candidates: string[];
		observations: ModelPerformanceObservation[];
		rankedCandidates: string[];
	}>;
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
	display(details: MainModelPerformanceAdvisoryDetails, context: MainPerformanceContext, durationMs: number): void;
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

function assessObservedThroughput(
	tokensPerSecond: number,
	thresholds: Pick<ModelPerformanceConfig, "hardTokensPerSecond" | "softTokensPerSecond">,
): ThroughputAssessment {
	if (tokensPerSecond < thresholds.hardTokensPerSecond) return "hard";
	if (tokensPerSecond < thresholds.softTokensPerSecond) return "soft";
	return "normal";
}

function cacheKey(route: Pick<MainModelPerformanceRoute, "modelClass" | "poolDigest" | "candidates">): ModelPerformanceCacheKey {
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

	snapshot(context: MainPerformanceContext): MainModelPerformanceSnapshot {
		const availableModels = context.modelRegistry.getAvailable().map(toModelInfo);
		const config = this.settings.modelPerformance ?? DEFAULT_MODEL_PERFORMANCE_CONFIG;
		const classes = Object.entries(this.settings.modelPools ?? {}).map(([modelClass, configuredCandidates]) => {
			const candidates = canonicalModelCandidates(configuredCandidates, availableModels, context.model?.provider ?? "");
			const route = { modelClass, poolDigest: modelPoolDigest(modelClass, candidates), candidates };
			const observations = this.readObservations(route, config.cacheTtlMs);
			return { modelClass, candidates, observations, rankedCandidates: rankModelCandidates(candidates, observations) };
		});
		return {
			cacheTtlMs: config.cacheTtlMs,
			hardTokensPerSecond: config.hardTokensPerSecond,
			softTokensPerSecond: config.softTokensPerSecond,
			classes,
		};
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

		const durationMs = turn.config.mainAdvisoryDurationMs ?? 30_000;
		if (durationMs === 0) return;
		const warningKey = turn.currentModel;
		if (this.warnedModels.has(warningKey)) return;
		this.warnedModels.add(warningKey);
		const sample = turn.monitor.complete(at);
		const recommendationObservations = route && alternatives.length > 0
			? this.readObservations(route, turn.config.cacheTtlMs)
			: [];
		const recommendedModel = route && alternatives.length > 0
			? rankModelCandidates(alternatives, recommendationObservations)[0]
			: undefined;
		const recommendedObservation = recommendationObservations.find(({ candidate }) => candidate === recommendedModel);
		try {
			const details: MainModelPerformanceAdvisoryDetails = {
				assessment,
				currentModel: turn.currentModel,
				ttftMs: sample?.ttftMs ?? at - turn.startedAt,
			};
			if (route) details.modelClass = route.modelClass;
			if (recommendedModel) details.recommendedModel = recommendedModel;
			if (recommendedObservation) {
				details.recommendedModelEstimatedTokensPerSecond = recommendedObservation.estimatedTokensPerSecond;
				details.recommendedModelThroughputAssessment = assessObservedThroughput(
					recommendedObservation.estimatedTokensPerSecond,
					turn.config,
				);
			}
			if (sample) details.estimatedTokensPerSecond = sample.estimatedTokensPerSecond;
			this.options.display(details, turn.context, durationMs);
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

	private readObservations(route: Pick<MainModelPerformanceRoute, "modelClass" | "poolDigest" | "candidates">, ttlMs: number): ModelPerformanceObservation[] {
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
		? `Recommended ${details.modelClass} [${details.recommendedModelEstimatedTokensPerSecond === undefined ? "no fresh sample" : `${details.recommendedModelEstimatedTokensPerSecond.toFixed(1)} token/s`}]: ${details.recommendedModel}`
		: details.modelClass
			? `No other ${details.modelClass} candidate can be recommended from the current pool.`
			: "No suggestion: current model does not map to one configured model class.";
	return [
		"⚠ Main model is responding slowly",
		`Current model: ${details.currentModel}`,
		measurement,
		"Current response continues; the main model was not switched.",
		recommendation,
	].join("\n");
}

export function formatMainModelPerformanceReport(snapshot: MainModelPerformanceSnapshot): string[] {
	const ttl = snapshot.cacheTtlMs % 60_000 === 0
		? `${snapshot.cacheTtlMs / 60_000} min`
		: `${snapshot.cacheTtlMs / 1_000}s`;
	const lines = ["Model performance cache", `Order uses samples from last ${ttl}; otherwise settings order.`];
	if (snapshot.classes.length === 0) lines.push("No configured model classes.");
	for (const modelClass of snapshot.classes) {
		lines.push("", `${modelClass.modelClass}:`);
		const observations = new Map(modelClass.observations.map((observation) => [observation.candidate, observation]));
		for (const [index, candidate] of modelClass.rankedCandidates.entries()) {
			const observation = observations.get(candidate);
			const metric = observation
				? `${observation.ttftMs.toFixed(0)}ms TTFT · ${observation.estimatedTokensPerSecond.toFixed(1)} token/s · ${observation.source}`
				: "no fresh sample";
			lines.push(`  ${index + 1}. ${candidate} · ${metric}`);
		}
	}
	lines.push("", "Esc closes.");
	return lines;
}

type MainModelPerformanceOverlayPresentation =
	| { kind: "advisory"; details: MainModelPerformanceAdvisoryDetails }
	| { kind: "report"; snapshot: MainModelPerformanceSnapshot };

function styleLabeledValue(theme: Theme, line: string, label: string, valueColor: "accent" | "success"): string {
	if (!line.startsWith(label)) return theme.fg("text", line);
	return theme.fg("muted", label) + theme.fg(valueColor, line.slice(label.length));
}

function styleAdvisoryLine(theme: Theme, line: string, index: number, details: MainModelPerformanceAdvisoryDetails): string {
	if (index === 1) return styleLabeledValue(theme, line, "Current model: ", "accent");
	if (index === 2) return theme.fg(details.assessment === "hard" ? "error" : "warning", line);
	if (index === 3) {
		const reassurance = "Current response continues;";
		return theme.fg("success", reassurance) + theme.fg("muted", line.slice(reassurance.length));
	}
	if (index === 4 && details.recommendedModel && details.modelClass) {
		const rate = details.recommendedModelEstimatedTokensPerSecond;
		const assessment = details.recommendedModelThroughputAssessment;
		const rateText = rate === undefined ? "no fresh sample" : `${rate.toFixed(1)} token/s`;
		const rateColor = assessment === "hard" ? "error" : assessment === "soft" ? "warning" : assessment === "normal" ? "success" : "dim";
		return theme.fg("muted", "Recommended ")
			+ theme.fg("accent", details.modelClass)
			+ theme.fg("dim", " [")
			+ theme.fg(rateColor, rateText)
			+ theme.fg("dim", "]: ")
			+ theme.fg("accent", details.recommendedModel);
	}
	return theme.fg("warning", line);
}

function throughputColor(
	tokensPerSecond: number,
	snapshot: MainModelPerformanceSnapshot,
): "error" | "warning" | "success" {
	const assessment = assessObservedThroughput(tokensPerSecond, snapshot);
	return assessment === "hard" ? "error" : assessment === "soft" ? "warning" : "success";
}

function styleReportLine(theme: Theme, line: string, index: number, snapshot: MainModelPerformanceSnapshot): string {
	if (!line) return line;
	if (index === 1) return theme.fg("muted", line);
	if (line === "No configured model classes.") return theme.fg("warning", line);
	if (!line.startsWith("  ") && line.endsWith(":")) return theme.fg("accent", line);
	for (const modelClass of snapshot.classes) {
		const observations = new Map(modelClass.observations.map((observation) => [observation.candidate, observation]));
		for (const [candidateIndex, candidate] of modelClass.rankedCandidates.entries()) {
			const prefix = `  ${candidateIndex + 1}. ${candidate} · `;
			if (!line.startsWith(prefix)) continue;
			const rank = theme.fg("dim", `  ${candidateIndex + 1}. `);
			const model = theme.fg(candidateIndex === 0 ? "success" : "text", candidate);
			const separator = theme.fg("dim", " · ");
			const observation = observations.get(candidate);
			if (!observation) return rank + model + separator + theme.fg("dim", "no fresh sample");
			return rank
				+ model
				+ separator
				+ theme.fg("muted", `${observation.ttftMs.toFixed(0)}ms TTFT`)
				+ separator
				+ theme.fg(throughputColor(observation.estimatedTokensPerSecond, snapshot), `${observation.estimatedTokensPerSecond.toFixed(1)} token/s`)
				+ separator
				+ theme.fg("dim", observation.source);
		}
	}
	return theme.fg("text", line);
}

class MainModelPerformanceOverlay implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly presentation: MainModelPerformanceOverlayPresentation;
	private readonly timer?: ReturnType<typeof setTimeout>;
	private closed = false;

	constructor(
		lines: string[],
		theme: Theme,
		done: () => void,
		presentation: MainModelPerformanceOverlayPresentation,
		durationMs?: number,
	) {
		this.lines = lines;
		this.theme = theme;
		this.done = done;
		this.presentation = presentation;
		if (durationMs !== undefined) {
			this.timer = setTimeout(() => this.close(), durationMs);
			this.timer.unref?.();
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.close();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const panelWidth = Math.max(3, Math.floor(width));
		return [
			renderHeader(
				truncateToWidth(this.lines[0] ?? "", panelWidth - 2),
				panelWidth,
				this.theme,
				this.presentation.kind === "advisory" ? "warning" : "accent",
			),
			...this.lines.slice(1, -1).map((line, index) => row(
				this.presentation.kind === "advisory"
					? styleAdvisoryLine(this.theme, line, index + 1, this.presentation.details)
					: styleReportLine(this.theme, line, index + 1, this.presentation.snapshot),
				panelWidth,
				this.theme,
			)),
			renderFooter(this.lines.at(-1) ?? "", panelWidth, this.theme),
		];
	}

	dispose(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.done();
	}
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
	const discover = options.discover ?? ((cwd: string, provider?: string) => discoverAgents(cwd, "both", provider));
	const runtimeOptions: MainModelPerformanceRuntimeOptions = {
		resolveSettings: (context) => {
			const discovered = discover(context.cwd, context.model?.provider);
			return {
				modelPools: discovered.modelPools,
				modelPerformance: discovered.modelPerformance ?? DEFAULT_MODEL_PERFORMANCE_CONFIG,
			};
		},
		display: (details, context, durationMs) => {
			const uiContext = context as ExtensionContext;
			if (!uiContext.hasUI || uiContext.mode !== "tui") return;
			const lines = formatMainModelPerformanceAdvisory(details).split("\n");
			lines.push("Esc closes.");
			void uiContext.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new MainModelPerformanceOverlay(
					lines,
					theme,
					done,
					{ kind: "advisory", details },
					durationMs,
				),
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-right",
						width: 74,
						maxHeight: 6,
						margin: { top: 1, right: 2, bottom: 5, left: 1 },
					},
				},
			).catch(() => {});
		},
	};
	if (options.now) runtimeOptions.now = options.now;
	if (options.schedule) runtimeOptions.schedule = options.schedule;
	if (options.store) runtimeOptions.store = options.store;
	if (options.probe) runtimeOptions.probe = options.probe;
	runtimeOptions.getThinkingLevel = () => pi.getThinkingLevel();
	const runtime = new MainModelPerformanceRuntime(runtimeOptions);
	pi.registerCommand("subagents-model-performance", {
		description: "Inspect cached measurements and candidate order for every configured model class",
		handler: async (args, context) => {
			if (args.trim()) {
				context.ui.notify("Usage: /subagents-model-performance", "error");
				return;
			}
			if (!context.hasUI || context.mode !== "tui") {
				if (context.hasUI) context.ui.notify("Model performance overlay requires the Pi TUI.", "info");
				return;
			}
			const snapshot = runtime.snapshot(context);
			const lines = formatMainModelPerformanceReport(snapshot);
			await context.ui.custom<void>(
				(_tui, theme, _keybindings, done) => new MainModelPerformanceOverlay(
					lines,
					theme,
					done,
					{ kind: "report", snapshot },
				),
				{ overlay: true, overlayOptions: { anchor: "center", width: 96, maxHeight: "80%", margin: 2 } },
			);
		},
	});

	pi.on("session_start", (_event, context) => runtime.startSession(context));
	pi.on("turn_start", (_event, context) => runtime.startTurn(context));
	pi.on("message_update", (event) => runtime.messageUpdate(event.assistantMessageEvent));
	pi.on("message_end", (event) => runtime.messageEnd(event.message));
	pi.on("turn_end", () => runtime.endTurn());
	pi.on("agent_end", () => runtime.endTurn());
	pi.on("session_shutdown", () => runtime.endSession());
	return runtime;
}
