export const SESSION_FAST_MODE_SNAPSHOT_VERSION = 1 as const;

export interface SessionFastModeSnapshot {
	version: typeof SESSION_FAST_MODE_SNAPSHOT_VERSION;
	enabled: boolean;
	modelIds: string[];
}

export class SessionFastModePolicy {
	#modelIds: Set<string>;
	#enabled: boolean;
	#listeners = new Set<(snapshot: SessionFastModeSnapshot) => void>();

	constructor(modelIds: readonly string[], enabled = false) {
		this.#modelIds = new Set(modelIds);
		this.#enabled = enabled;
	}

	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#emit();
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	isEligible(modelId: string | undefined): boolean {
		return Boolean(modelId && this.#modelIds.has(modelId));
	}

	snapshot(): SessionFastModeSnapshot {
		return {
			version: SESSION_FAST_MODE_SNAPSHOT_VERSION,
			enabled: this.#enabled,
			modelIds: [...this.#modelIds],
		};
	}

	applySnapshot(snapshot: SessionFastModeSnapshot): void {
		const modelIds = new Set(snapshot.modelIds);
		const unchanged = this.#enabled === snapshot.enabled
			&& modelIds.size === this.#modelIds.size
			&& [...modelIds].every((modelId) => this.#modelIds.has(modelId));
		if (unchanged) return;
		this.#enabled = snapshot.enabled;
		this.#modelIds = modelIds;
		this.#emit();
	}

	subscribe(listener: (snapshot: SessionFastModeSnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	rewriteProviderRequest(payload: unknown, modelId: string | undefined): unknown {
		if (!this.#enabled || !this.isEligible(modelId)) return payload;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
		return { ...payload, service_tier: "priority" };
	}

	#emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.#listeners) listener(snapshot);
	}
}
