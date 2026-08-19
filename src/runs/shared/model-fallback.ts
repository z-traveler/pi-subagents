import type { ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import type { ModelRoutingSnapshot, Usage } from "../../shared/types.ts";
import { checkModelScope, type ModelScopeConfig, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";
import { modelPoolDigest, type ModelPools, type ModelPoolSources } from "../../shared/model-routing.ts";
import { isMutatingBashCommand } from "./long-running-guard.ts";

export type { AvailableModelInfo };

interface ModelAttemptSummary {
	model: string;
	success: boolean;
	exitCode?: number | null;
	error?: string;
	usage?: Usage;
}

export function splitThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
	return {
		baseModel: model.substring(0, colonIdx),
		thinkingSuffix: model.substring(colonIdx),
	};
}

/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export const INHERIT_MODEL = "inherit";

/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
	provider: string;
	id: string;
}

export function normalizeParentModel(model: unknown): ParentModel | undefined {
	if (!model || typeof model !== "object") return undefined;
	const candidate = model as { provider?: unknown; id?: unknown };
	if (typeof candidate.provider !== "string" || typeof candidate.id !== "string") return undefined;
	if (!candidate.provider || !candidate.id) return undefined;
	return { provider: candidate.provider, id: candidate.id };
}

/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators. Pure.
 */
export function normalizeModelSegment(segment: string): string {
	return segment
		.toLowerCase()
		.replace(/[._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
	const yyyy = Number(year);
	const mm = Number(month);
	const dd = Number(day);
	return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing date stamp (`-20251001` or `-2025-10-01`) so dated and undated ids match. Pure. */
function stripTrailingDateStamp(segment: string): string {
	const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
	if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
	const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
	if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
	return segment;
}

function resolveBaseModelCandidate(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	if (baseModel.includes("/")) {
		const exact = availableModels.find((entry) => entry.fullId === baseModel);
		if (exact) return exact.fullId;
	} else {
		const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
		if (preferredProvider) {
			const preferredMatch = exactMatches.find((entry) => entry.provider === preferredProvider);
			if (preferredMatch) return preferredMatch.fullId;
		}
		if (exactMatches.length === 1) return exactMatches[0]!.fullId;
	}

	return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A qualified `provider/id`
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates). Pure.
 */
export function fuzzyResolveModel(
	baseModel: string,
	availableModels: AvailableModelInfo[],
	preferredProvider?: string,
): string | undefined {
	let queryProvider: string | undefined;
	let queryIdRaw = baseModel;
	const slashIdx = baseModel.indexOf("/");
	if (slashIdx !== -1) {
		queryProvider = normalizeModelSegment(baseModel.slice(0, slashIdx));
		queryIdRaw = baseModel.slice(slashIdx + 1);
	} else {
		const providerSeparators = [":", "."];
		for (const separator of providerSeparators) {
			const separatorIdx = baseModel.indexOf(separator);
			if (separatorIdx <= 0) continue;
			const providerPart = normalizeModelSegment(baseModel.slice(0, separatorIdx));
			if (!availableModels.some((entry) => normalizeModelSegment(entry.provider) === providerPart)) continue;
			queryProvider = providerPart;
			queryIdRaw = baseModel.slice(separatorIdx + 1);
			break;
		}
	}
	const queryId = normalizeModelSegment(queryIdRaw);
	const queryIdNoDate = stripTrailingDateStamp(queryId);

	const candidates = availableModels.filter((entry) => {
		const entryId = normalizeModelSegment(entry.id);
		if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
		if (queryProvider !== undefined && normalizeModelSegment(entry.provider) !== queryProvider) return false;
		return true;
	});
	if (candidates.length === 0) return undefined;
	if (preferredProvider) {
		const preferredProviderNorm = normalizeModelSegment(preferredProvider);
		const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === preferredProviderNorm);
		if (preferred) return preferred.fullId;
	}
	if (candidates.length === 1) return candidates[0]!.fullId;
	return undefined;
}

/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query. Pure.
 */
export function resolveModelCandidate(
	model: string | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string | undefined {
	if (!model) return undefined;
	if (!availableModels || availableModels.length === 0) return model;

	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;

	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	if (!thinkingSuffix) return model;
	const resolvedBase = resolveBaseModelCandidate(baseModel, availableModels, preferredProvider);
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	return model;
}

function resolveRequiredSubagentModelCandidate(
	model: string,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
): string {
	if (!availableModels || availableModels.length === 0) return model;
	const resolvedWhole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
	if (resolvedWhole) return resolvedWhole;
	const { baseModel, thinkingSuffix } = splitThinkingSuffix(model);
	const resolvedBase = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
	if (resolvedBase) return `${resolvedBase}${thinkingSuffix}`;
	throw new Error(`Unknown subagent model '${model}' in the active Pi model registry.`);
}

export interface ResolveSubagentModelOverrideOptions {
	/** When set with `enforce: true`, out-of-scope models are rejected. */
	scope?: ModelScopeConfig;
	/** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
	source?: ModelSource;
	/** Called for warn-severity violations instead of `console.warn`. */
	onWarn?: (violation: ModelScopeViolation) => void;
}

function defaultScopeWarn(violation: ModelScopeViolation): void {
	console.warn(`[pi-subagents] ${violation.message}`);
}

/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one,
 * unless strict scope enforcement makes inherited violations hard errors.
 */
export function resolveSubagentModelOverride(
	requestedModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: ResolveSubagentModelOverrideOptions,
): string | undefined {
	const trimmed = typeof requestedModel === "string" ? requestedModel.trim() : "";
	const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
	let resolved: string | undefined;
	if (explicit === undefined) {
		resolved = parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
	} else {
		resolved = resolveRequiredSubagentModelCandidate(explicit, availableModels, preferredProvider);
	}
	if (resolved && options?.scope?.enforce) {
		const source: ModelSource = explicit === undefined ? "inherited" : (options.source ?? "inherited");
		const violation = checkModelScope(resolved, options.scope, source);
		if (violation) {
			if (violation.severity === "error") throw new Error(violation.message);
			(options.onWarn ?? defaultScopeWarn)(violation);
		}
	}
	return resolved;
}

export function resolveEffectiveSubagentModel(
	explicitModel: string | boolean | undefined,
	agentModel: string | boolean | undefined,
	parentModel: ParentModel | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: Omit<ResolveSubagentModelOverrideOptions, "source">,
): string | undefined {
	const resolved = resolveSubagentModelOverride(
		explicitModel ?? agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: explicitModel !== undefined ? "explicit" : "inherited" },
	);
	if (resolved || explicitModel === undefined) return resolved;
	return resolveSubagentModelOverride(
		agentModel,
		parentModel,
		availableModels,
		preferredProvider,
		{ ...options, source: "inherited" },
	);
}

export interface BuildModelCandidatesOptions {
	/** Fallback models warn by default and throw when strict scope enforcement is enabled. */
	scope?: ModelScopeConfig;
	onWarn?: (violation: ModelScopeViolation) => void;
}

export type ModelClassSource = "per-run" | "agent-override" | "agent-frontmatter";

export interface ModelRoutingResolution {
	primaryModel?: string;
	modelCandidates: string[];
	requestedModelClass?: string;
	modelClassSource?: ModelClassSource;
	modelPoolDigest?: string;
}

export interface ResolveModelRoutingInput {
	explicitModel?: string;
	explicitModelClass?: string;
	agentModel?: string;
	agentFallbackModels?: string[];
	agentModelClass?: string;
	agentModelClassSource?: Exclude<ModelClassSource, "per-run">;
	modelPools?: ModelPools;
	modelPoolSources?: ModelPoolSources;
	parentModel?: ParentModel;
	availableModels?: AvailableModelInfo[];
	preferredProvider?: string;
	modelScope?: ModelScopeConfig;
}

export function toModelRoutingSnapshot(
	resolution: ModelRoutingResolution,
	candidates: string[] = resolution.modelCandidates,
): ModelRoutingSnapshot | undefined {
	if (!resolution.requestedModelClass || !resolution.modelClassSource || !resolution.modelPoolDigest) return undefined;
	return {
		modelClass: resolution.requestedModelClass,
		source: resolution.modelClassSource,
		poolDigest: resolution.modelPoolDigest,
		candidates: [...candidates],
	};
}

/** Resolve one launch's concrete ordered candidates without mutating the supplied config. */
export function resolveModelRouting(input: ResolveModelRoutingInput): ModelRoutingResolution {
	if (input.explicitModel !== undefined && input.explicitModelClass !== undefined) {
		throw new Error("A subagent launch cannot set both 'model' and 'modelClass'.");
	}
	const requestedModelClass = input.explicitModelClass ?? input.agentModelClass;
	const modelClassSource: ModelClassSource | undefined = input.explicitModelClass !== undefined
		? "per-run"
		: requestedModelClass !== undefined
			? input.agentModelClassSource ?? "agent-frontmatter"
			: undefined;
	const configuredPool = requestedModelClass ? input.modelPools?.[requestedModelClass] : undefined;
	const configuredPoolSource = requestedModelClass ? input.modelPoolSources?.[requestedModelClass] : undefined;
	const configuredPoolLabel = configuredPoolSource
		? ` from ${configuredPoolSource.scope} settings '${configuredPoolSource.path}'`
		: "";
	if (requestedModelClass && !configuredPool && (modelClassSource === "per-run" || modelClassSource === "agent-override")) {
		throw new Error(`Unknown subagent modelClass '${requestedModelClass}'; no matching subagents.modelPools entry is configured.`);
	}
	if (configuredPool) {
		let candidates: string[];
		try {
			candidates = buildModelCandidates(
				configuredPool[0],
				configuredPool.slice(1),
				input.availableModels,
				input.preferredProvider,
				{ scope: input.modelScope ? { ...input.modelScope, strict: true } : undefined },
			);
		} catch (error) {
			throw new Error(`Model pool '${requestedModelClass}'${configuredPoolLabel} is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (candidates.length !== configuredPool.length) {
			throw new Error(`Model pool '${requestedModelClass}'${configuredPoolLabel} contains candidates that resolve to the same model: ${configuredPool.join(", ")}.`);
		}
		return {
			primaryModel: candidates[0],
			modelCandidates: candidates,
			requestedModelClass,
			modelClassSource,
			modelPoolDigest: modelPoolDigest(requestedModelClass!, candidates),
		};
	}
	const primaryModel = resolveEffectiveSubagentModel(
		input.explicitModel,
		input.agentModel,
		input.parentModel,
		input.availableModels,
		input.preferredProvider,
		{ scope: input.modelScope },
	);
	return {
		primaryModel,
		modelCandidates: buildModelCandidates(
			primaryModel,
			input.agentFallbackModels,
			input.availableModels,
			input.preferredProvider,
			{ scope: input.modelScope },
		),
		...(requestedModelClass ? { requestedModelClass, modelClassSource } : {}),
	};
}

export function buildModelCandidates(
	primaryModel: string | undefined,
	fallbackModels: string[] | undefined,
	availableModels: AvailableModelInfo[] | undefined,
	preferredProvider?: string,
	options?: BuildModelCandidatesOptions,
): string[] {
	const seen = new Set<string>();
	const candidates: string[] = [];
	const rawCandidates = [primaryModel, ...(fallbackModels ?? [])];
	for (let index = 0; index < rawCandidates.length; index++) {
		const raw = rawCandidates[index];
		if (!raw) continue;
		const normalized = resolveRequiredSubagentModelCandidate(raw.trim(), availableModels, preferredProvider);
		if (!normalized || seen.has(normalized)) continue;
		if ((index > 0 || options?.scope?.strict === true) && options?.scope?.enforce) {
			const violation = checkModelScope(normalized, options.scope, "inherited");
			if (violation) {
				if (violation.severity === "error") throw new Error(violation.message);
				(options.onWarn ?? defaultScopeWarn)(violation);
			}
		}
		seen.add(normalized);
		candidates.push(normalized);
	}
	return candidates;
}

/**
 * Failures reported as `<tool> failed (exit N): ...` or `<tool> failed with
 * exit code N` come from a tool call inside the child's task, not from the
 * provider/model, however network-flavored their details read. Retrying a
 * different model cannot fix them and would rerun the whole task. Tool names
 * include namespaced forms like `mcp.server/write`.
 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

export type ModelFailureCategory = "transient" | "candidate-unavailable" | "failure-domain" | "context" | "policy" | "tool" | "control" | "unknown";
export type RetryEffectClass = "none" | "workspace" | "external-or-unknown";

const FAILURE_DOMAIN_PATTERNS = [/\b401\b/, /\b403\b/, /quota/i, /billing/i, /credit/i, /auth(?:entication)?/i, /unauthori[sz]ed/i, /forbidden/i, /api key/i, /token expired/i, /invalid key/i];
const CANDIDATE_UNAVAILABLE_PATTERNS = [/model.*unavailable/i, /model.*disabled/i, /model.*not found/i, /unknown model/i, /model.*(?:load|fail|error)/i, /cold.?start/i];
const CONTEXT_FAILURE_PATTERNS = [/context (?:window|length)/i, /maximum context/i, /too many tokens/i, /prompt.*too long/i];
const POLICY_FAILURE_PATTERNS = [/content policy/i, /safety policy/i, /policy refusal/i, /content moderation/i];
const TRANSIENT_FAILURE_PATTERNS = [
	/rate\s*limit/i, /too many requests/i, /\b408\b/, /\b409\b/, /\b429\b/, /provider.*unavailable/i, /overloaded/i,
	/service unavailable/i, /temporar(?:ily)? unavailable/i, /connection refused/i, /fetch failed/i,
	/network error/i, /socket hang up/i, /stream ended without finish_reason/i, /upstream/i,
	/timed? out/i, /timeout/i, /\b502\b/, /\b503\b/, /\b504\b/, /empty response/i, /no output/i,
];

export function classifyModelFailure(input: {
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	interrupted?: boolean;
	detached?: boolean;
	turnBudgetExceeded?: boolean;
	toolBudgetExceeded?: boolean;
	usageBudgetExceeded?: boolean;
	protocolError?: boolean;
	structuredOutputFailed?: boolean;
	acceptanceRejected?: boolean;
}): ModelFailureCategory {
	if (input.stopped || input.interrupted || input.detached || input.timedOut || input.turnBudgetExceeded || input.toolBudgetExceeded || input.usageBudgetExceeded) return "control";
	if (input.protocolError || input.structuredOutputFailed || input.acceptanceRejected) return "tool";
	const error = input.error?.trim();
	if (!error) return "unknown";
	if (TOOL_FAILURE_PREFIX.test(error)) return "tool";
	if (CONTEXT_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) return "context";
	if (POLICY_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) return "policy";
	if (FAILURE_DOMAIN_PATTERNS.some((pattern) => pattern.test(error))) return "failure-domain";
	if (CANDIDATE_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(error))) return "candidate-unavailable";
	if (TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(error))) return "transient";
	return "unknown";
}

const READ_ONLY_RETRY_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "rg"]);
const WORKSPACE_RETRY_TOOLS = new Set(["edit", "write", "apply_patch"]);
const EXTERNAL_BASH_EFFECT = /(?:^|[;&|()\s])(?:git\s+(?:(?:-[Cc]\s+\S+|--(?:git-dir|work-tree)=?\S*|--paginate)\s+)*push|(?:npm|pnpm|yarn)\s+(?:npm\s+)?publish|gh\s+release\s+(?:create|upload)|curl\b|wget\b|ssh\b|scp\b|rsync\b)/i;
const READ_ONLY_BASH_SEGMENT = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?::|true|false|cd|pwd|ls|find|rg|grep|glob|cat|head|tail|wc|sort|uniq|cut|tr|stat|readlink|realpath|test|\[|echo|printf|git\s+(?:(?:(?:-C|--git-dir|--work-tree)\s+\S+|(?:--git-dir|--work-tree)=\S+|--paginate)\s+)*(?:status|diff|log|show|rev-parse)\b)/i;

function bashCommandFromArgs(args: string | undefined): string {
	if (!args) return "";
	try {
		const parsed = JSON.parse(args) as unknown;
		const command = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>).command
			: undefined;
		if (typeof command === "string") return command;
	} catch {
		// Foreground progress stores a bounded command preview rather than JSON.
	}
	return args;
}

function splitBashCommandSegments(command: string): string[] {
	const segments: string[] = [];
	let current = "";
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	const flush = () => {
		const segment = current.trim();
		if (segment) segments.push(segment);
		current = "";
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && !inSingle) {
			current += char;
			escaped = true;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			current += char;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			current += char;
			continue;
		}
		if (!inSingle && !inDouble && (char === ";" || char === "|" || char === "&" || char === "\n" || char === "(" || char === ")")) {
			flush();
			if ((char === "|" || char === "&") && command[index + 1] === char) index++;
			continue;
		}
		current += char;
	}
	flush();
	return segments;
}

function hasShellCommandSubstitution(command: string): boolean {
	let inSingle = false;
	let inDouble = false;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && !inSingle) {
			escaped = true;
			continue;
		}
		if (char === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (char === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle) continue;
		if (char === "`" || (char === "$" && command[index + 1] === "(")) return true;
	}
	return false;
}

function classifyBashRetryEffect(command: string): RetryEffectClass {
	if (hasShellCommandSubstitution(command)) return "external-or-unknown";
	let workspace = false;
	const segments = splitBashCommandSegments(command);
	if (segments.length === 0) return "external-or-unknown";
	for (const segment of segments) {
		if (EXTERNAL_BASH_EFFECT.test(segment)) return "external-or-unknown";
		if (isMutatingBashCommand(segment)) {
			workspace = true;
			continue;
		}
		if (READ_ONLY_BASH_SEGMENT.test(segment)) continue;
		return "external-or-unknown";
	}
	return workspace ? "workspace" : "none";
}

export function classifyRetryEffects(input: {
	toolCount?: number;
	recentTools?: Array<{ tool: string; args?: string; endMs?: number }>;
	fileMutationAttempted?: boolean;
}): RetryEffectClass {
	const toolCount = input.toolCount ?? input.recentTools?.length ?? 0;
	const recentTools = input.recentTools ?? [];
	if (toolCount === 0 && !input.fileMutationAttempted) return "none";
	if (recentTools.length < toolCount) return "external-or-unknown";
	let workspace = input.fileMutationAttempted === true;
	for (const entry of recentTools) {
		const tool = entry.tool.trim().toLowerCase();
		if (WORKSPACE_RETRY_TOOLS.has(tool) || (tool === "cursor" && /\b(?:edit|write)\b/i.test(entry.args ?? ""))) {
			workspace = true;
			continue;
		}
		if (tool === "bash") {
			const command = bashCommandFromArgs(entry.args);
			const effect = classifyBashRetryEffect(command);
			if (effect === "external-or-unknown") return effect;
			if (effect === "workspace") workspace = true;
			continue;
		}
		if (READ_ONLY_RETRY_TOOLS.has(tool)) continue;
		return "external-or-unknown";
	}
	return workspace ? "workspace" : "none";
}

function modelProvider(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const { baseModel } = splitThinkingSuffix(model);
	const slash = baseModel.indexOf("/");
	return slash > 0 ? normalizeModelSegment(baseModel.slice(0, slash)) : undefined;
}

export type ModelFailoverDecision =
	| { retry: true; mode: "restart" | "resume" }
	| { retry: false; reason: string };

export function decideModelFailover(input: {
	category: ModelFailureCategory;
	currentModel?: string;
	nextModel?: string;
	effects: RetryEffectClass;
}): ModelFailoverDecision {
	if (!input.nextModel) return { retry: false, reason: "no-candidate" };
	if (input.effects === "external-or-unknown") return { retry: false, reason: "external-or-unknown-effects" };
	if (input.category !== "transient" && input.category !== "candidate-unavailable" && input.category !== "failure-domain") {
		return { retry: false, reason: input.category };
	}
	if (input.category === "failure-domain") {
		const currentProvider = modelProvider(input.currentModel);
		const nextProvider = modelProvider(input.nextModel);
		if (!currentProvider || !nextProvider || currentProvider === nextProvider) return { retry: false, reason: "same-failure-domain" };
	}
	return { retry: true, mode: input.effects === "workspace" ? "resume" : "restart" };
}

export function selectModelFailover(input: {
	category: ModelFailureCategory;
	currentModel?: string;
	candidates: string[];
	currentIndex: number;
	effects: RetryEffectClass;
}): { decision: ModelFailoverDecision; nextIndex?: number; skippedModels: string[]; failureDomain?: string } {
	let nextIndex = input.currentIndex + 1;
	const skippedModels: string[] = [];
	let decision = decideModelFailover({
		category: input.category,
		currentModel: input.currentModel,
		nextModel: input.candidates[nextIndex],
		effects: input.effects,
	});
	while (!decision.retry && input.category === "failure-domain" && decision.reason === "same-failure-domain" && nextIndex < input.candidates.length) {
		skippedModels.push(input.candidates[nextIndex]!);
		nextIndex += 1;
		decision = decideModelFailover({
			category: input.category,
			currentModel: input.currentModel,
			nextModel: input.candidates[nextIndex],
			effects: input.effects,
		});
	}
	return {
		decision,
		...(decision.retry ? { nextIndex } : {}),
		skippedModels,
		...(modelProvider(input.currentModel) ? { failureDomain: modelProvider(input.currentModel) } : {}),
	};
}

export function isRetryableModelFailure(error: string | undefined): boolean {
	const category = classifyModelFailure({ error });
	return category === "transient" || category === "candidate-unavailable" || category === "failure-domain";
}

export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
	const failure = attempt.error?.trim() || `exit ${attempt.exitCode ?? 1}`;
	return nextModel
		? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
		: `[fallback] ${attempt.model} failed: ${failure}.`;
}
