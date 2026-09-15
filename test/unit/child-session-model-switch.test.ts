import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createDefaultChildSessionFactory,
	type ChildSessionEvent,
	type ChildSessionLaunch,
	type PiCodingAgentModule,
} from "../../src/runs/shared/child-session.ts";

interface PiCodingAgentTestFixture {
	ModelRuntime: { create(): Promise<object> };
	SettingsManager: { create(): object };
	DefaultResourceLoader: abstract new (...args: never[]) => object;
	SessionManager: { inMemory(): object };
	resolveCliModel(input: { cliModel: string }): object;
	createAgentSession(input: { model?: { maxTokens?: number } }): Promise<{ session: object }>;
}

function asPiCodingAgentModule(value: PiCodingAgentTestFixture): PiCodingAgentModule {
	// SAFETY: Callers provide test fixtures implementing every Pi module member exercised by these tests.
	return value as PiCodingAgentModule;
}

function fixture(checkpointRole: "user" | "toolResult" = "user", resolvedMaxTokens?: number) {
	const listeners = new Set<(event: ChildSessionEvent) => void>();
	const modelChanges: Array<[string, string]> = [];
	const createdModels: Array<{ maxTokens?: number }> = [];
	const thinkingChanges: string[] = [];
	const agentListeners = new Set<(event: ChildSessionEvent) => void | Promise<void>>();
	const prompts: string[] = [];
	const navigations: string[] = [];
	let continuations = 0;
	let leafId: string | null = "input";
	let releaseNavigation: (() => void) | undefined;
	let navigationGate: Promise<void> | undefined;
	let releaseModelChange: (() => void) | undefined;
	let modelChangeGate: Promise<void> | undefined;
	let markModelChangeStarted: (() => void) | undefined;
	const modelChangeStarted = new Promise<void>((resolve) => { markModelChangeStarted = resolve; });
	const entries = new Map([
		["input", { type: "message", message: { role: checkpointRole, content: [] } }],
	]);
	const state = {
		model: { provider: "test", id: "slow" },
		thinkingLevel: "off",
		tools: [],
	};
	const sessionManager = {
		getLeafId: () => leafId,
		getEntry: (id: string) => entries.get(id),
		appendModelChange(provider: string, id: string) { modelChanges.push([provider, id]); },
		appendThinkingLevelChange(level: string) { thinkingChanges.push(level); },
	};
	const session = {
		agent: {
			state,
			hasQueuedMessages: () => false,
			async continue() { continuations += 1; },
			subscribe(listener: (event: ChildSessionEvent) => void | Promise<void>) {
				agentListeners.add(listener);
				return () => agentListeners.delete(listener);
			},
		},
		sessionManager,
		bindExtensions: async () => {},
		dispose() {},
		extensionRunner: { hasHandlers: () => false },
		subscribe(listener: (event: ChildSessionEvent) => void) { listeners.add(listener); return () => listeners.delete(listener); },
		async prompt(text: string) { prompts.push(text); },
		async abort() {},
		async steer() {},
		async followUp() {},
		async navigateTree(targetId: string) {
			navigations.push(targetId);
			await navigationGate;
			leafId = targetId;
			return checkpointRole === "user" ? { editorText: "Task: retry me", cancelled: false } : { cancelled: false };
		},
		async setModel(model: typeof state.model) {
			markModelChangeStarted?.();
			await modelChangeGate;
			state.model = model;
			modelChanges.push([model.provider, model.id]);
			if (state.thinkingLevel !== "medium") {
				state.thinkingLevel = "medium";
				thinkingChanges.push("medium");
			}
		},
		setThinkingLevel(level: string) {
			if (state.thinkingLevel === level) return;
			state.thinkingLevel = level;
			thinkingChanges.push(level);
		},
		messages: [],
		sessionId: "switch-test",
		get model() { return state.model; },
	};
	const pi = asPiCodingAgentModule({
		ModelRuntime: { create: async () => ({}) },
		SettingsManager: { create: () => ({}) },
		DefaultResourceLoader: class { async reload() {} },
		SessionManager: { inMemory: () => sessionManager },
		resolveCliModel: ({ cliModel }: { cliModel: string }) => {
			const [reference, thinkingLevel] = cliModel.split(":");
			const [provider, id] = reference!.split("/");
			const model = {
				provider,
				id,
				reasoning: true,
			};
			if (resolvedMaxTokens !== undefined) Object.assign(model, { maxTokens: resolvedMaxTokens });
			const resolved = { model };
			if (thinkingLevel) Object.assign(resolved, { thinkingLevel });
			return resolved;
		},
		createAgentSession: async (input: { model?: { maxTokens?: number } }) => {
			if (input.model) createdModels.push(input.model);
			return { session };
		},
	});
	return {
		pi,
		state,
		modelChanges,
		createdModels,
		thinkingChanges,
		prompts,
		navigations,
		get continuations() { return continuations; },
		emit(event: ChildSessionEvent) { for (const listener of listeners) listener(event); },
		async emitAgent(event: ChildSessionEvent) {
			for (const listener of listeners) listener(event);
			for (const listener of agentListeners) await listener(event);
		},
		setLeaf(id: string | null) { leafId = id; },
		pauseNavigation() {
			navigationGate = new Promise<void>((resolve) => { releaseNavigation = resolve; });
			return () => releaseNavigation?.();
		},
		pauseModelChange() {
			modelChangeGate = new Promise<void>((resolve) => { releaseModelChange = resolve; });
			return () => releaseModelChange?.();
		},
		modelChangeStarted,
	};
}

// SAFETY: The fixture runtime supplies every runtime field read by child-session creation.
const launchRuntime = { fanoutChild: false, depth: 1, waitTool: { enabled: false }, fast: false } as ChildSessionLaunch["runtime"];

const launch: ChildSessionLaunch = {
	cwd: process.cwd(),
	storage: { kind: "memory" },
	model: "test/slow",
	extensionPaths: [],
	ambientExtensions: false,
	hooks: [],
	noSkills: true,
	noContextFiles: true,
	runtime: launchRuntime,
};

describe("default child model switching", () => {
	it("caps a bounded internal child request without changing ordinary launches", async () => {
		const seen = fixture("user", 4_096);
		await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create({ ...launch, maxOutputTokens: 64 });

		assert.equal(seen.createdModels[0]?.maxTokens, 64);
	});

	it("changes only the child runtime model and preserves the thinking suffix", async () => {
		const seen = fixture();
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);

		await child.switchModelForNextResponse!("test/fast:high");

		assert.deepEqual(seen.state.model, { provider: "test", id: "fast", reasoning: true });
		assert.equal(seen.state.thinkingLevel, "high");
		assert.deepEqual(seen.modelChanges, [["test", "fast"]]);
		assert.deepEqual(seen.thinkingChanges, ["medium", "high"]);
		assert.equal(child.modelId, "test/fast");
	});

	it("restores the configured default thinking when the next candidate has no suffix", async () => {
		const seen = fixture();
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);

		await child.switchModelForNextResponse!("test/fast:high");
		await child.switchModelForNextResponse!("test/default-thinking");

		assert.equal(seen.state.thinkingLevel, "medium");
		assert.deepEqual(seen.thinkingChanges, ["medium", "high", "medium"]);
	});

	it("holds the next agent turn until Pi's public model switch finishes", async () => {
		const seen = fixture();
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		const releaseModelChange = seen.pauseModelChange();
		child.subscribe((event) => {
			if (event.type === "turn_end") void child.switchModelForNextResponse!("test/fast");
		});
		let turnEndFinished = false;
		const turnEnd = seen.emitAgent({ type: "turn_end" }).then(() => { turnEndFinished = true; });
		await Promise.resolve();

		assert.equal(turnEndFinished, false);
		assert.equal(seen.state.model.id, "slow");
		releaseModelChange();
		await turnEnd;
		assert.equal(seen.state.model.id, "fast");
	});

	it("abandons an aborted response branch and replays its user input on the replacement model", async () => {
		const seen = fixture("user");
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		seen.emit({ type: "turn_start" });
		seen.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		seen.setLeaf("aborted-assistant");

		await child.retryCurrentResponseWithModel!("test/fast");

		assert.deepEqual(seen.navigations, ["input"]);
		assert.deepEqual(seen.prompts, ["Task: retry me"]);
		assert.equal(seen.continuations, 0);
		assert.deepEqual(seen.state.model, { provider: "test", id: "fast", reasoning: true });
	});

	it("continues from a retained tool result when retrying a later response", async () => {
		const seen = fixture("toolResult");
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		seen.emit({ type: "turn_start" });
		seen.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		seen.setLeaf("aborted-assistant");

		await child.retryCurrentResponseWithModel!("test/fast");

		assert.deepEqual(seen.navigations, ["input"]);
		assert.deepEqual(seen.prompts, []);
		assert.equal(seen.continuations, 1);
	});

	it("does not change model or restart generation when the lifecycle guard closes during navigation", async () => {
		const seen = fixture("user");
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		seen.emit({ type: "turn_start" });
		seen.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		seen.setLeaf("aborted-assistant");
		const releaseNavigation = seen.pauseNavigation();
		let canContinue = true;

		const retry = child.retryCurrentResponseWithModel!("test/fast", () => canContinue);
		assert.deepEqual(seen.navigations, ["input"]);
		canContinue = false;
		releaseNavigation();
		await retry;

		assert.deepEqual(seen.state.model, { provider: "test", id: "slow" });
		assert.deepEqual(seen.modelChanges, []);
		assert.deepEqual(seen.prompts, []);
		assert.equal(seen.continuations, 0);
	});

	it("does not restart generation when the lifecycle guard closes during an async model change", async () => {
		const seen = fixture("user");
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		seen.emit({ type: "turn_start" });
		seen.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		seen.setLeaf("aborted-assistant");
		const releaseModelChange = seen.pauseModelChange();
		let canContinue = true;

		const retry = child.retryCurrentResponseWithModel!("test/fast", () => canContinue);
		await seen.modelChangeStarted;
		canContinue = false;
		releaseModelChange();
		await retry;

		assert.deepEqual(seen.state.model, { provider: "test", id: "fast", reasoning: true });
		assert.deepEqual(seen.prompts, []);
		assert.equal(seen.continuations, 0);
	});

	it("captures the first-response checkpoint only after the user input is persisted", async () => {
		const seen = fixture("user");
		seen.setLeaf(null);
		const child = await createDefaultChildSessionFactory({ loadPiCodingAgent: async () => seen.pi }).create(launch);
		seen.emit({ type: "turn_start" });
		seen.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "Task: retry me" }] } });
		seen.setLeaf("input");
		await Promise.resolve();
		seen.setLeaf("aborted-assistant");

		await child.retryCurrentResponseWithModel!("test/fast");

		assert.deepEqual(seen.navigations, ["input"]);
		assert.deepEqual(seen.prompts, ["Task: retry me"]);
	});
});
