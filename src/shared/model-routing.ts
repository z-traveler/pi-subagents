import { createHash } from "node:crypto";

export const MODEL_CLASS_PATTERN = /^[a-z][a-z0-9-]*$/;

export type ModelPools = Record<string, string[]>;

export interface ModelPoolSource {
	scope: "user" | "project";
	path: string;
}

export type ModelPoolSources = Record<string, ModelPoolSource>;

export function parseModelClass(value: unknown, label: string): string {
	if (typeof value !== "string" || !MODEL_CLASS_PATTERN.test(value.trim())) {
		throw new Error(`${label} must be lowercase kebab-case and match ${MODEL_CLASS_PATTERN}.`);
	}
	return value.trim();
}

export function parseModelPools(value: unknown, filePath: string): ModelPools | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'modelPools'; expected an object.`);
	}
	const pools: ModelPools = {};
	for (const [rawName, rawCandidates] of Object.entries(value as Record<string, unknown>)) {
		const name = parseModelClass(rawName, `Model pool name '${rawName}' in '${filePath}'`);
		if (!Array.isArray(rawCandidates) || rawCandidates.length === 0) {
			throw new Error(`Model pool '${name}' in '${filePath}' must be a non-empty array of model strings.`);
		}
		const candidates = rawCandidates.map((candidate) => {
			if (typeof candidate !== "string" || !candidate.trim()) {
				throw new Error(`Model pool '${name}' in '${filePath}' must contain only non-empty model strings.`);
			}
			return candidate.trim();
		});
		if (new Set(candidates).size !== candidates.length) {
			throw new Error(`Model pool '${name}' in '${filePath}' contains duplicate candidates.`);
		}
		pools[name] = candidates;
	}
	return pools;
}

export function mergeModelPools(
	userPools: ModelPools | undefined,
	projectPools: ModelPools | undefined,
	userPath: string,
	projectPath: string | null,
): { pools?: ModelPools; sources?: ModelPoolSources } {
	if (!userPools && !projectPools) return {};
	const pools: ModelPools = {};
	const sources: ModelPoolSources = {};
	for (const [name, candidates] of Object.entries(userPools ?? {})) {
		pools[name] = [...candidates];
		sources[name] = { scope: "user", path: userPath };
	}
	for (const [name, candidates] of Object.entries(projectPools ?? {})) {
		pools[name] = [...candidates];
		sources[name] = { scope: "project", path: projectPath! };
	}
	return { pools, sources };
}

export function modelPoolDigest(modelClass: string, candidates: readonly string[]): string {
	return createHash("sha256").update(JSON.stringify({ modelClass, candidates })).digest("hex");
}
