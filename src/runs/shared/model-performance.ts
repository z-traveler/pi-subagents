import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR, type ModelRoutingSnapshot } from "../../shared/types.ts";

export interface ModelPerformanceConfig {
	firstTokenTimeoutMs: number;
	hardTokensPerSecond: number;
	softTokensPerSecond: number;
	cacheTtlMs: number;
	mainAdvisoryDurationMs?: number;
}

export type ModelPerformanceConfigOverride = Partial<ModelPerformanceConfig>;

export const DEFAULT_MODEL_PERFORMANCE_CONFIG: Readonly<ModelPerformanceConfig> = Object.freeze({
	firstTokenTimeoutMs: 45_000,
	hardTokensPerSecond: 2,
	softTokensPerSecond: 8,
	cacheTtlMs: 300_000,
	mainAdvisoryDurationMs: 30_000,
});

const CONFIG_FIELDS = ["firstTokenTimeoutMs", "hardTokensPerSecond", "softTokensPerSecond", "cacheTtlMs", "mainAdvisoryDurationMs"] as const;

// Settings JSON is deliberately validated at this I/O boundary before it
// becomes ModelPerformanceConfigOverride.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type
export function parseModelPerformanceConfig(value: unknown, filePath: string): ModelPerformanceConfigOverride | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Subagent settings in '${filePath}' have invalid 'modelPerformance'; expected an object.`);
	}
	// SAFETY: The object/null/array checks above establish a property-bearing JSON object.
	const raw = value as Record<string, unknown>;
	for (const key of Object.keys(raw)) {
		if (!CONFIG_FIELDS.some((field) => field === key)) {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'modelPerformance.${key}'; unknown field.`);
		}
	}
	const parsed: ModelPerformanceConfigOverride = {};
	for (const field of CONFIG_FIELDS) {
		const candidate = raw[field];
		if (candidate === undefined) continue;
		if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || (field !== "mainAdvisoryDurationMs" && candidate === 0)) {
			throw new Error(`Subagent settings in '${filePath}' have invalid 'modelPerformance.${field}'; expected a finite ${field === "mainAdvisoryDurationMs" ? "nonnegative" : "positive"} number.`);
		}
		parsed[field] = candidate;
	}
	return parsed;
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type

export function resolveModelPerformanceConfig(
	user?: ModelPerformanceConfigOverride,
	project?: ModelPerformanceConfigOverride,
): ModelPerformanceConfig {
	const resolved = { ...DEFAULT_MODEL_PERFORMANCE_CONFIG, ...user, ...project };
	if (resolved.hardTokensPerSecond >= resolved.softTokensPerSecond) {
		throw new Error("modelPerformance hardTokensPerSecond must be less than softTokensPerSecond.");
	}
	return resolved;
}

export type ThroughputAssessment = "normal" | "soft" | "hard";

export interface GenerationPerformanceSample {
	ttftMs: number;
	estimatedTokensPerSecond: number;
	estimatedOutputTokens: number;
}

const HARD_RATE_WINDOW_MS = 20_000;
const SOFT_RATE_WINDOW_MS = 30_000;

export class GenerationPerformanceMonitor {
	private readonly samples: Array<{ at: number; characters: number }> = [];
	private readonly config: ModelPerformanceConfig;
	private readonly startedAt: number;
	private firstOutputAt?: number;
	private totalCharacters = 0;

	constructor(config: ModelPerformanceConfig, startedAt: number) {
		this.config = config;
		this.startedAt = startedAt;
	}

	recordDelta(delta: string, at: number): void {
		if (!delta) return;
		this.firstOutputAt ??= at;
		this.totalCharacters += delta.length;
		this.samples.push({ at, characters: delta.length });
		const oldestUseful = at - SOFT_RATE_WINDOW_MS;
		while (this.samples.length > 0 && this.samples[0]!.at <= oldestUseful) this.samples.shift();
	}

	assess(at: number): ThroughputAssessment {
		if (this.firstOutputAt === undefined) {
			return at - this.startedAt >= this.config.firstTokenTimeoutMs ? "hard" : "normal";
		}
		const streamingForMs = at - this.firstOutputAt;
		if (streamingForMs >= HARD_RATE_WINDOW_MS
			&& this.rateOverWindow(at, HARD_RATE_WINDOW_MS) < this.config.hardTokensPerSecond) return "hard";
		if (streamingForMs >= SOFT_RATE_WINDOW_MS
			&& this.rateOverWindow(at, SOFT_RATE_WINDOW_MS) < this.config.softTokensPerSecond) return "soft";
		return "normal";
	}

	complete(at: number): GenerationPerformanceSample | undefined {
		if (this.firstOutputAt === undefined) return undefined;
		const outputDurationMs = Math.max(1, at - this.firstOutputAt);
		const estimatedOutputTokens = this.totalCharacters / 4;
		return {
			ttftMs: this.firstOutputAt - this.startedAt,
			estimatedTokensPerSecond: estimatedOutputTokens * 1_000 / outputDurationMs,
			estimatedOutputTokens,
		};
	}

	private rateOverWindow(at: number, windowMs: number): number {
		const after = at - windowMs;
		let characters = 0;
		for (const sample of this.samples) if (sample.at > after) characters += sample.characters;
		return characters / 4 * 1_000 / windowMs;
	}
}

// Provider and child-session events are validated at this delta I/O boundary.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function generationDeltaText(event: unknown): string | undefined {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof
	if (!event || typeof event !== "object" || Array.isArray(event)) return undefined;
	// SAFETY: The object/null/array checks above make optional property reads safe.
	const candidate = event as { type?: unknown; delta?: unknown };
	if (candidate.type !== "text_delta" && candidate.type !== "thinking_delta" && candidate.type !== "toolcall_delta") return undefined;
	// oxlint-disable-next-line anti-slop/no-runtime-typeof
	return typeof candidate.delta === "string" && candidate.delta.length > 0 ? candidate.delta : undefined;
}

export interface ModelPerformanceSwitch {
	severity: "soft" | "hard";
	from: string;
	to: string;
}

export interface ModelPerformanceAssessment {
	level: ThroughputAssessment;
	switch?: ModelPerformanceSwitch;
}

export interface CompletedModelPerformanceResponse {
	sample?: GenerationPerformanceSample;
	switch?: ModelPerformanceSwitch;
}

export class ModelClassPerformanceTracker {
	private readonly candidates: readonly string[];
	private readonly config: ModelPerformanceConfig;
	private readonly observations: () => readonly ModelPerformanceObservation[];
	private readonly attempted = new Set<string>();
	private monitor?: GenerationPerformanceMonitor;
	private softObserved = false;
	private hardSwitchIssued = false;
	private current: string;

	constructor(options: {
		candidates: readonly string[];
		currentCandidate: string;
		attemptedCandidates?: readonly string[];
		config: ModelPerformanceConfig;
		observations?: () => readonly ModelPerformanceObservation[];
	}) {
		this.candidates = options.candidates;
		this.current = options.currentCandidate;
		this.config = options.config;
		this.observations = options.observations ?? (() => []);
		for (const candidate of options.attemptedCandidates ?? []) this.attempted.add(candidate);
		this.attempted.add(options.currentCandidate);
	}

	get currentCandidate(): string {
		return this.current;
	}

	startResponse(at: number): void {
		this.monitor = new GenerationPerformanceMonitor(this.config, at);
		this.softObserved = false;
		this.hardSwitchIssued = false;
	}

	recordDelta(delta: string, at: number): void {
		this.monitor?.recordDelta(delta, at);
	}

	assess(at: number): ModelPerformanceAssessment {
		const level = this.monitor?.assess(at) ?? "normal";
		if (level === "soft") this.softObserved = true;
		if (level !== "hard" || this.hardSwitchIssued) return { level };
		this.hardSwitchIssued = true;
		const switchAction = this.selectSwitch("hard");
		return switchAction ? { level, switch: switchAction } : { level };
	}

	completeResponse(at: number, willContinue: boolean): CompletedModelPerformanceResponse {
		const sample = this.monitor?.complete(at);
		const switchAction = !this.hardSwitchIssued && this.softObserved && willContinue
			? this.selectSwitch("soft")
			: undefined;
		this.monitor = undefined;
		const completed: CompletedModelPerformanceResponse = {};
		if (sample) completed.sample = sample;
		if (switchAction) completed.switch = switchAction;
		return completed;
	}

	private selectSwitch(severity: ModelPerformanceSwitch["severity"]): ModelPerformanceSwitch | undefined {
		const remaining = this.candidates.filter((candidate) => !this.attempted.has(candidate));
		const next = rankModelCandidates(remaining, this.observations())[0];
		if (!next) return undefined;
		const from = this.current;
		this.current = next;
		this.attempted.add(next);
		return { severity, from, to: next };
	}
}

export interface ModelPerformanceObservation {
	candidate: string;
	recordedAt: number;
	ttftMs: number;
	estimatedTokensPerSecond: number;
	source: "probe" | "run";
}

export interface ModelPerformanceCacheKey {
	modelClass: string;
	poolDigest: string;
	candidates: readonly string[];
	protocolVersion: number;
}

export const MODEL_PERFORMANCE_PROTOCOL_VERSION = 1;

export function createModelPerformanceCacheKey(
	routing: Pick<ModelRoutingSnapshot, "modelClass" | "poolDigest">,
	candidates: readonly string[],
): ModelPerformanceCacheKey {
	return {
		modelClass: routing.modelClass,
		poolDigest: routing.poolDigest,
		candidates: [...candidates].sort(),
		protocolVersion: MODEL_PERFORMANCE_PROTOCOL_VERSION,
	};
}

interface PersistedObservation {
	version: 1;
	keyDigest: string;
	observation: ModelPerformanceObservation;
	probeInvalidationEpoch?: string | null;
}

interface PersistedInvalidation {
	version: 1;
	keyDigest: string;
	candidate: string;
	epoch: string;
}

interface OwnedLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	hostname: string;
	processStartIdentity?: string;
}

// Persisted cache JSON is validated at this I/O boundary before use.
// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof
function validObservation(value: unknown): value is ModelPerformanceObservation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// SAFETY: The object/null/array checks above make optional observation reads safe.
	const entry = value as Partial<ModelPerformanceObservation>;
	return typeof entry.candidate === "string"
		&& typeof entry.recordedAt === "number" && Number.isFinite(entry.recordedAt)
		&& typeof entry.ttftMs === "number" && Number.isFinite(entry.ttftMs) && entry.ttftMs >= 0
		&& typeof entry.estimatedTokensPerSecond === "number" && Number.isFinite(entry.estimatedTokensPerSecond) && entry.estimatedTokensPerSecond > 0
		&& (entry.source === "probe" || entry.source === "run");
}

function validInvalidation(value: unknown, keyDigest: string, candidate: string): value is PersistedInvalidation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// SAFETY: The object/null/array checks above make persisted marker reads safe.
	const marker = value as Partial<PersistedInvalidation>;
	return marker.version === 1 && marker.keyDigest === keyDigest && marker.candidate === candidate
		&& typeof marker.epoch === "string" && marker.epoch.length > 0;
}

function validLeaseOwner(value: unknown, token: string): value is OwnedLeaseOwner {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// SAFETY: The object/null/array checks above make persisted lease-owner reads safe.
	const owner = value as Partial<OwnedLeaseOwner>;
	return owner.version === 1 && owner.token === token
		&& typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
		&& typeof owner.hostname === "string" && owner.hostname.length > 0
		&& (owner.processStartIdentity === undefined || typeof owner.processStartIdentity === "string");
}
// oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof

function digest(value: ModelPerformanceCacheKey | string): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const LEASE_OWNER_PREFIX = ".owner-";

function leaseOwnerPath(lockPath: string, owner: string): string {
	return path.join(lockPath, `${LEASE_OWNER_PREFIX}${owner}`);
}

function readOwnedLease(lockPath: string): { owner: OwnedLeaseOwner; updatedAt: number } | undefined {
	try {
		const ownerFile = fs.readdirSync(lockPath).find((entry) => entry.startsWith(LEASE_OWNER_PREFIX));
		if (!ownerFile) return undefined;
		const token = ownerFile.slice(LEASE_OWNER_PREFIX.length);
		const ownerPath = path.join(lockPath, ownerFile);
		const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath, "utf-8"));
		if (!validLeaseOwner(parsed, token)) return undefined;
		return { owner: parsed, updatedAt: fs.statSync(ownerPath).mtimeMs };
	} catch {
		return undefined;
	}
}

function releaseOwnedLease(lockPath: string, owner: string): void {
	const existing = readOwnedLease(lockPath);
	if (!existing || existing.owner.token !== owner) return;
	const releasedPath = `${lockPath}.released-${owner}`;
	try {
		fs.renameSync(lockPath, releasedPath);
	} catch {
		return;
	}
	try {
		fs.rmSync(releasedPath, { recursive: true, force: true });
	} catch {
		// The canonical path is already free; orphaned release tombstones do not block probes.
	}
}

function createOwnedLease(lockPath: string, owner: OwnedLeaseOwner, now: number): boolean {
	const candidatePath = `${lockPath}.candidate-${owner.token}`;
	try {
		fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
		fs.mkdirSync(candidatePath, { recursive: false, mode: 0o700 });
		const ownerPath = leaseOwnerPath(candidatePath, owner.token);
		fs.writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600 });
		fs.utimesSync(ownerPath, now / 1_000, now / 1_000);
		fs.renameSync(candidatePath, lockPath);
		return true;
	} catch {
		return false;
	} finally {
		try {
			fs.rmSync(candidatePath, { recursive: true, force: true });
		} catch {
			// Cache locking is best effort and must not fail model routing.
		}
	}
}

function processStartIdentity(pid: number): string | undefined {
	if (process.platform !== "linux") return undefined;
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const commandEnd = stat.lastIndexOf(")");
		if (commandEnd === -1) return undefined;
		const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
		const startTicks = fields[19];
		return startTicks ? `linux:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// SAFETY: Node process errors may carry the standard errno `code` field.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

function leaseOwnerIsDead(
	owner: OwnedLeaseOwner,
	hostname: string,
	isProcessAlive: (pid: number) => boolean | undefined,
	getProcessStartIdentity: (pid: number) => string | undefined,
): boolean {
	if (owner.hostname !== hostname) return false;
	const alive = isProcessAlive(owner.pid);
	if (alive === false) return true;
	if (alive !== true || !owner.processStartIdentity) return false;
	const currentIdentity = getProcessStartIdentity(owner.pid);
	return currentIdentity !== undefined && currentIdentity !== owner.processStartIdentity;
}

function claimOwnedLease(
	lockPath: string,
	leaseMs: number,
	now: number,
	owner: OwnedLeaseOwner,
	isProcessAlive: (pid: number) => boolean | undefined,
	getProcessStartIdentity: (pid: number) => string | undefined,
): string | undefined {
	if (createOwnedLease(lockPath, owner, now)) return owner.token;
	const existing = readOwnedLease(lockPath);
	if (!existing || existing.updatedAt + leaseMs > now
		|| !leaseOwnerIsDead(existing.owner, owner.hostname, isProcessAlive, getProcessStartIdentity)) return undefined;
	// The old token in this permanent destination fences contenders that observed
	// the same dead owner from renaming a subsequently created live lease (ABA).
	const stalePath = `${lockPath}.stale-${existing.owner.token}`;
	try {
		fs.renameSync(lockPath, stalePath);
	} catch {
		return undefined;
	}
	return createOwnedLease(lockPath, owner, now) ? owner.token : undefined;
}

export interface ModelPerformanceProbeSlotClaim {
	slot: number;
	owner: string;
}

export interface ModelPerformanceProbeGuard {
	candidate: string;
	keyDigest: string;
	invalidationEpoch: string | null;
}

export interface ModelPerformanceStoreOptions {
	rootDir?: string;
	now?: () => number;
	pid?: number;
	hostname?: string;
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
}

export class ModelPerformanceStore {
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly pid: number;
	private readonly hostname: string;
	private readonly processStartIdentity?: string;
	private readonly isProcessAlive: (pid: number) => boolean | undefined;
	private readonly getProcessStartIdentity: (pid: number) => string | undefined;
	private readonly probeClaims = new Map<string, string>();

	constructor(options: ModelPerformanceStoreOptions = {}) {
		this.rootDir = options.rootDir ?? path.join(TEMP_ROOT_DIR, "model-performance");
		this.now = options.now ?? Date.now;
		this.pid = options.pid ?? process.pid;
		this.hostname = options.hostname ?? os.hostname();
		this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
		this.getProcessStartIdentity = options.getProcessStartIdentity ?? processStartIdentity;
		this.processStartIdentity = options.processStartIdentity
			?? this.getProcessStartIdentity(this.pid)
			?? (this.pid === process.pid ? `runtime:${Math.round(Date.now() - process.uptime() * 1_000)}` : undefined);
	}

	read(key: ModelPerformanceCacheKey, ttlMs: number): ModelPerformanceObservation[] {
		const keyDigest = digest(key);
		const now = this.now();
		const observations: ModelPerformanceObservation[] = [];
		for (const candidate of key.candidates) {
			const run = this.readObservation(keyDigest, candidate, "run", ttlMs, now);
			const probe = this.readObservation(keyDigest, candidate, "probe", ttlMs, now);
			const observation = run ?? probe;
			if (observation) observations.push(observation);
		}
		return observations;
	}

	record(key: ModelPerformanceCacheKey, observation: ModelPerformanceObservation, _ttlMs = DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs): void {
		if (!key.candidates.includes(observation.candidate) || !validObservation(observation)) return;
		const keyDigest = digest(key);
		const probeInvalidationEpoch = observation.source === "probe"
			? this.readInvalidationEpoch(keyDigest, observation.candidate)
			: undefined;
		if (observation.source === "probe" && probeInvalidationEpoch === undefined) return;
		this.writeObservation(keyDigest, observation, probeInvalidationEpoch);
	}

	beginProbe(key: ModelPerformanceCacheKey, candidate: string): ModelPerformanceProbeGuard | undefined {
		if (!key.candidates.includes(candidate)) return undefined;
		const keyDigest = digest(key);
		const invalidationEpoch = this.readInvalidationEpoch(keyDigest, candidate);
		return invalidationEpoch === undefined ? undefined : { candidate, keyDigest, invalidationEpoch };
	}

	recordProbe(
		key: ModelPerformanceCacheKey,
		observation: ModelPerformanceObservation,
		guard: ModelPerformanceProbeGuard,
		_ttlMs = DEFAULT_MODEL_PERFORMANCE_CONFIG.cacheTtlMs,
	): boolean {
		if (observation.source !== "probe" || observation.candidate !== guard.candidate
			|| !key.candidates.includes(observation.candidate) || !validObservation(observation)
			|| digest(key) !== guard.keyDigest) return false;
		const currentEpoch = this.readInvalidationEpoch(guard.keyDigest, guard.candidate);
		if (currentEpoch === undefined || currentEpoch !== guard.invalidationEpoch) return false;
		if (!this.writeObservation(guard.keyDigest, observation, guard.invalidationEpoch)) return false;
		return this.readInvalidationEpoch(guard.keyDigest, guard.candidate) === guard.invalidationEpoch;
	}

	invalidate(key: ModelPerformanceCacheKey, candidate: string): void {
		if (!key.candidates.includes(candidate)) return;
		const keyDigest = digest(key);
		try {
			writePrivateAtomicJson(
				this.invalidationPath(keyDigest, candidate),
				{ version: 1, keyDigest, candidate, epoch: randomUUID() } satisfies PersistedInvalidation,
			);
		} catch {
			// Routing telemetry is best effort and must not fail the model response.
		}
		for (const source of ["run", "probe"] as const) {
			try {
				fs.rmSync(this.observationPath(keyDigest, candidate, source), { force: true });
			} catch {
				// Routing telemetry is best effort and must not fail the model response.
			}
		}
	}

	claimProbe(key: ModelPerformanceCacheKey, leaseMs: number): boolean {
		const keyDigest = digest(key);
		if (this.probeClaims.has(keyDigest)) return false;
		const owner = claimOwnedLease(
			this.probeLockPath(keyDigest),
			leaseMs,
			this.now(),
			this.createLeaseOwner(),
			this.isProcessAlive,
			this.getProcessStartIdentity,
		);
		if (!owner) return false;
		this.probeClaims.set(keyDigest, owner);
		return true;
	}

	releaseProbe(key: ModelPerformanceCacheKey): void {
		const keyDigest = digest(key);
		const owner = this.probeClaims.get(keyDigest);
		if (!owner) return;
		this.probeClaims.delete(keyDigest);
		releaseOwnedLease(this.probeLockPath(keyDigest), owner);
	}

	refreshProbe(key: ModelPerformanceCacheKey): boolean {
		const keyDigest = digest(key);
		const owner = this.probeClaims.get(keyDigest);
		return owner ? this.refreshOwnedLease(this.probeLockPath(keyDigest), owner) : false;
	}

	claimProbeSlot(leaseMs: number, concurrency: number): ModelPerformanceProbeSlotClaim | undefined {
		for (let slot = 0; slot < concurrency; slot++) {
			const owner = claimOwnedLease(
				this.probeSlotPath(slot),
				leaseMs,
				this.now(),
				this.createLeaseOwner(),
				this.isProcessAlive,
				this.getProcessStartIdentity,
			);
			if (owner) return { slot, owner };
		}
		return undefined;
	}

	refreshProbeSlot(claim: ModelPerformanceProbeSlotClaim): boolean {
		return this.refreshOwnedLease(this.probeSlotPath(claim.slot), claim.owner);
	}

	releaseProbeSlot(claim: ModelPerformanceProbeSlotClaim): void {
		releaseOwnedLease(this.probeSlotPath(claim.slot), claim.owner);
	}

	private readObservation(
		keyDigest: string,
		candidate: string,
		source: ModelPerformanceObservation["source"],
		ttlMs: number,
		now: number,
	): ModelPerformanceObservation | undefined {
		try {
			// SAFETY: The persisted payload remains partial until every field is validated below.
			const parsed = JSON.parse(fs.readFileSync(this.observationPath(keyDigest, candidate, source), "utf-8")) as Partial<PersistedObservation>;
			if (parsed.version !== 1 || parsed.keyDigest !== keyDigest || !validObservation(parsed.observation)) return undefined;
			if (parsed.observation.candidate !== candidate || parsed.observation.source !== source
				|| parsed.observation.recordedAt + ttlMs <= now) return undefined;
			if (source === "probe") {
				const persistedEpoch = parsed.probeInvalidationEpoch;
				// SAFETY: This validates the optional epoch decoded from persisted JSON.
				// oxlint-disable-next-line anti-slop/no-runtime-typeof
				if (persistedEpoch !== null && typeof persistedEpoch !== "string") return undefined;
				const currentEpoch = this.readInvalidationEpoch(keyDigest, candidate);
				if (currentEpoch === undefined || currentEpoch !== persistedEpoch) return undefined;
			}
			return parsed.observation;
		} catch {
			return undefined;
		}
	}

	private observationPath(keyDigest: string, candidate: string, source: ModelPerformanceObservation["source"]): string {
		return path.join(this.rootDir, keyDigest, `${digest(candidate)}.${source}.json`);
	}

	private invalidationPath(keyDigest: string, candidate: string): string {
		return path.join(this.rootDir, keyDigest, `${digest(candidate)}.invalidated.json`);
	}

	private readInvalidationEpoch(keyDigest: string, candidate: string): string | null | undefined {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.invalidationPath(keyDigest, candidate), "utf-8"));
			return validInvalidation(parsed, keyDigest, candidate) ? parsed.epoch : undefined;
		} catch (error) {
			// SAFETY: Node filesystem failures may carry the standard errno `code` field.
			return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
		}
	}

	private writeObservation(
		keyDigest: string,
		observation: ModelPerformanceObservation,
		probeInvalidationEpoch: string | null | undefined,
	): boolean {
		try {
			const persisted: PersistedObservation = { version: 1, keyDigest, observation };
			if (observation.source === "probe") persisted.probeInvalidationEpoch = probeInvalidationEpoch;
			writePrivateAtomicJson(
				this.observationPath(keyDigest, observation.candidate, observation.source),
				persisted,
			);
			return true;
		} catch {
			// Routing telemetry is best effort and must not fail the model response.
			return false;
		}
	}

	private refreshOwnedLease(lockPath: string, owner: string): boolean {
		try {
			const ownerPath = leaseOwnerPath(lockPath, owner);
			const now = this.now() / 1_000;
			fs.utimesSync(ownerPath, now, now);
			return true;
		} catch {
			return false;
		}
	}

	private createLeaseOwner(): OwnedLeaseOwner {
		const owner: OwnedLeaseOwner = {
			version: 1,
			token: randomUUID(),
			pid: this.pid,
			hostname: this.hostname,
		};
		if (this.processStartIdentity !== undefined) owner.processStartIdentity = this.processStartIdentity;
		return owner;
	}

	private probeLockPath(keyDigest: string): string {
		return path.join(this.rootDir, `${keyDigest}.probe.lock`);
	}

	private probeSlotPath(slot: number): string {
		return path.join(this.rootDir, ".probe-slots", `${slot}.lock`);
	}
}

const PREDICTED_OUTPUT_TOKENS = 128;

export function rankModelCandidates(
	candidates: readonly string[],
	observations: readonly ModelPerformanceObservation[],
): string[] {
	const byCandidate = new Map(observations.map((observation) => [observation.candidate, observation]));
	return candidates
		.map((candidate, index) => ({ candidate, index, observation: byCandidate.get(candidate) }))
		.sort((left, right) => {
			if (!left.observation && !right.observation) return left.index - right.index;
			if (!left.observation) return 1;
			if (!right.observation) return -1;
			const leftMs = left.observation.ttftMs + PREDICTED_OUTPUT_TOKENS / left.observation.estimatedTokensPerSecond * 1_000;
			const rightMs = right.observation.ttftMs + PREDICTED_OUTPUT_TOKENS / right.observation.estimatedTokensPerSecond * 1_000;
			return leftMs - rightMs || left.index - right.index;
		})
		.map(({ candidate }) => candidate);
}
