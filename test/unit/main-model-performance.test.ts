import assert from "node:assert/strict";
import test from "node:test";
import {
	MainModelPerformanceRuntime,
	formatMainModelPerformanceAdvisory,
	registerMainModelPerformanceAdvisory,
	resolveMainModelPerformanceRoute,
	type MainModelPerformanceAdvisoryDetails,
} from "../../src/extension/main-model-performance.ts";
import {
	DEFAULT_MODEL_PERFORMANCE_CONFIG,
	type ModelPerformanceCacheKey,
	type ModelPerformanceObservation,
} from "../../src/runs/shared/model-performance.ts";

const models = [
	{ provider: "cliproxy", id: "fast-a", fullId: "cliproxy/fast-a" },
	{ provider: "cliproxy", id: "fast-b", fullId: "cliproxy/fast-b" },
	{ provider: "cliproxy", id: "smart-a", fullId: "cliproxy/smart-a" },
];

test("maps the main model to exactly one model class while ignoring thinking", () => {
	const unique = resolveMainModelPerformanceRoute({
		currentModel: { provider: "cliproxy", id: "fast-a" },
		modelPools: {
			fast: ["cliproxy/fast-a:high", "cliproxy/fast-b"],
			smart: ["cliproxy/smart-a"],
		},
		availableModels: models,
	});
	assert.equal(unique?.modelClass, "fast");
	assert.deepEqual(unique?.currentCandidates, ["cliproxy/fast-a:high"]);

	const ambiguous = resolveMainModelPerformanceRoute({
		currentModel: { provider: "cliproxy", id: "fast-a" },
		modelPools: {
			fast: ["cliproxy/fast-a", "cliproxy/fast-b"],
			cheap: ["cliproxy/fast-a"],
		},
		availableModels: models,
	});
	assert.equal(ambiguous, undefined);
});

test("a slow main response keeps running, emits one advisory, and warms alternatives", async () => {
	let now = 0;
	let scheduled: (() => void) | undefined;
	const advisories: Array<{ details: MainModelPerformanceAdvisoryDetails; durationMs: number }> = [];
	const probes: string[][] = [];
	const observations: ModelPerformanceObservation[] = [{
		candidate: "cliproxy/fast-b",
		recordedAt: 0,
		ttftMs: 250,
		estimatedTokensPerSecond: 40,
		source: "probe",
	}];
	const store = {
		read(_key: ModelPerformanceCacheKey) { return observations; },
		record() {},
		invalidate() {},
	};
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: (run) => {
			scheduled = run;
			return () => { scheduled = undefined; };
		},
		store,
		resolveSettings: () => ({
			modelPools: { fast: ["cliproxy/fast-a", "cliproxy/fast-b"] },
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
		display: (details, _context, durationMs) => advisories.push({ details, durationMs }),
		probe: ({ candidates }) => { probes.push([...candidates]); },
	});

	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	scheduled?.();
	scheduled?.();

	assert.equal(advisories.length, 1, "the same slow model must not reopen the advisory");
	assert.equal(advisories[0]?.durationMs, 30_000);
	assert.deepEqual(probes, [["cliproxy/fast-b"]]);
	assert.match(formatMainModelPerformanceAdvisory(advisories[0]!.details), /main model was not switched/i);
	assert.match(formatMainModelPerformanceAdvisory(advisories[0]!.details), /cliproxy\/fast-b/);
});

test("zero advisory duration suppresses the popup without disabling background probes", () => {
	let now = 0;
	let displays = 0;
	let probes = 0;
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: () => () => {},
		store: { read: () => [], record() {}, invalidate() {} },
		resolveSettings: () => ({
			modelPools: { fast: ["cliproxy/fast-a", "cliproxy/fast-b"] },
			modelPerformance: { ...DEFAULT_MODEL_PERFORMANCE_CONFIG, mainAdvisoryDurationMs: 0 },
		}),
		display: () => { displays++; },
		probe: () => { probes++; },
	});
	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	assert.equal(displays, 0);
	assert.equal(probes, 1);
});

test("records main workload throughput and invalidates an old sample on a first-token stall", () => {
	let now = 0;
	const recorded: ModelPerformanceObservation[] = [];
	const invalidated: string[] = [];
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: () => () => {},
		getThinkingLevel: () => "off",
		store: {
			read: () => [],
			record: (_key, observation) => { recorded.push(observation); },
			invalidate: (_key, candidate) => { invalidated.push(candidate); },
		},
		resolveSettings: () => ({
			modelPools: { fast: ["cliproxy/fast-a", "cliproxy/fast-b"] },
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
		display: () => {},
	});

	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	assert.deepEqual(invalidated, ["cliproxy/fast-a"]);

	runtime.endTurn();
	runtime.startTurn(ctx);
	now += 1_000;
	runtime.messageUpdate({ type: "text_delta", delta: "x".repeat(400) });
	now += 4_000;
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]?.candidate, "cliproxy/fast-a");
	assert.equal(recorded[0]?.source, "run");
	assert.equal(recorded[0]?.estimatedTokensPerSecond, 25);
});

test("does not attribute an actual low-thinking run to a high-thinking pool candidate", () => {
	let now = 0;
	const recorded: ModelPerformanceObservation[] = [];
	const invalidated: string[] = [];
	const displayed: MainModelPerformanceAdvisoryDetails[] = [];
	const probes: string[][] = [];
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: () => () => {},
		getThinkingLevel: () => "low",
		store: {
			read: () => [],
			record: (_key, observation) => { recorded.push(observation); },
			invalidate: (_key, candidate) => { invalidated.push(candidate); },
		},
		resolveSettings: () => ({
			modelPools: { fast: ["cliproxy/fast-a:high", "cliproxy/fast-b"] },
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
		display: (details) => { displayed.push(details); },
		probe: ({ candidates }) => { probes.push([...candidates]); },
	});

	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	assert.deepEqual(invalidated, []);
	assert.equal(displayed[0]?.recommendedModel, "cliproxy/fast-b");
	assert.deepEqual(probes, [["cliproxy/fast-b"]]);

	runtime.endTurn();
	runtime.startTurn(ctx);
	now += 1_000;
	runtime.messageUpdate({ type: "text_delta", delta: "x".repeat(400) });
	now += 4_000;
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.deepEqual(recorded, []);
});

test("a tolerably slow rolling rate is advisory and waits for the main response to finish", () => {
	let now = 0;
	const advisories: Array<{ assessment: string }> = [];
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: () => () => {},
		store: { read: () => [], record() {}, invalidate() {} },
		resolveSettings: () => ({ modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG }),
		display: (details) => { advisories.push(details); },
	});

	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	runtime.messageUpdate({ type: "thinking_delta", delta: "xxxx" });
	now = 15_000;
	runtime.messageUpdate({ type: "toolcall_delta", delta: "x".repeat(400) });
	now = 30_000;
	runtime.tick();
	assert.deepEqual(advisories.map(({ assessment }) => assessment), ["soft"]);

	now = 31_000;
	runtime.messageEnd({ role: "assistant", stopReason: "stop" });
	assert.equal(advisories.length, 1);
});

test("the registered Pi seam opens an Esc-dismissible advisory overlay without adding a card", () => {
	let now = 0;
	const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
	let overlay: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | undefined;
	let closed = 0;
	let appended = 0;
	let renderers = 0;
	let setModelCalls = 0;
	const pi = {
		on(name: string, handler: (event: any, ctx: any) => void) {
			const existing = handlers.get(name) ?? [];
			existing.push(handler);
			handlers.set(name, existing);
		},
		registerEntryRenderer() { renderers++; },
		registerCommand() {},
		appendEntry() { appended++; },
		getThinkingLevel() { return "off"; },
		setModel() { setModelCalls++; },
	};
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory: Function, options: { overlay?: boolean }) => {
				assert.equal(options.overlay, true);
				overlay = factory({}, {}, undefined, () => { closed++; overlay?.dispose?.(); });
				return Promise.resolve();
			},
		},
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	// SAFETY: the fake implements every ExtensionAPI member exercised by this registration seam.
	const runtime = registerMainModelPerformanceAdvisory(pi as never, {
		now: () => now,
		schedule: () => () => {},
		store: { read: () => [], record() {}, invalidate() {} },
		discover: () => ({
			modelPools: { fast: ["cliproxy/fast-a", "cliproxy/fast-b"] },
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
	});

	handlers.get("session_start")?.[0]?.({}, ctx);
	handlers.get("turn_start")?.[0]?.({}, ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();

	assert.match(overlay?.render(100).join("\n") ?? "", /Main model is responding slowly/);
	overlay?.handleInput("\u001b");
	assert.equal(closed, 1);
	assert.equal(appended, 0);
	assert.equal(renderers, 0);
	assert.equal(setModelCalls, 0, "main-agent monitoring must never change the model");
});

test("the main advisory overlay closes after its configured duration", async () => {
	let now = 0;
	let closed = 0;
	const pi = {
		on() {},
		registerCommand() {},
		getThinkingLevel() { return "off"; },
	};
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory: Function) => new Promise<void>((resolve) => {
				const overlay = factory({}, {}, undefined, () => { closed++; overlay.dispose?.(); resolve(); });
			}),
		},
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};
	const runtime = registerMainModelPerformanceAdvisory(pi as never, {
		now: () => now,
		schedule: () => () => {},
		store: { read: () => [], record() {}, invalidate() {} },
		discover: () => ({ modelPerformance: { ...DEFAULT_MODEL_PERFORMANCE_CONFIG, mainAdvisoryDurationMs: 5 } }),
	});
	runtime.startSession(ctx);
	runtime.startTurn(ctx);
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(closed, 1);
});

test("headless sessions stay silent and ambiguous class matches show only a generic UI advisory", () => {
	let now = 0;
	const displayed: MainModelPerformanceAdvisoryDetails[] = [];
	let probes = 0;
	const runtime = new MainModelPerformanceRuntime({
		now: () => now,
		schedule: () => () => {},
		store: { read: () => [], record() {}, invalidate() {} },
		resolveSettings: () => ({
			modelPools: {
				fast: ["cliproxy/fast-a", "cliproxy/fast-b"],
				cheap: ["cliproxy/fast-a", "cliproxy/smart-a"],
			},
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
		display: (details) => displayed.push(details),
		probe: () => { probes += 1; },
	});
	const base = {
		cwd: "/repo",
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
	};

	runtime.startSession({ ...base, hasUI: false });
	runtime.startTurn({ ...base, hasUI: false });
	now = DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	assert.equal(displayed.length, 0);
	assert.equal(probes, 0);

	runtime.startSession({ ...base, hasUI: true });
	runtime.startTurn({ ...base, hasUI: true });
	now += DEFAULT_MODEL_PERFORMANCE_CONFIG.firstTokenTimeoutMs;
	runtime.tick();
	assert.equal(displayed.length, 1);
	assert.equal(displayed[0]?.modelClass, undefined);
	assert.equal(displayed[0]?.recommendedModel, undefined);
	assert.match(formatMainModelPerformanceAdvisory(displayed[0]!), /does not map to exactly one configured model class/);
	assert.equal(probes, 0);
});

test("model performance command shows cached measurements and order for every class without scrolling", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		on() {},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		getThinkingLevel() { return "off"; },
	};
	const runtime = registerMainModelPerformanceAdvisory(pi as never, {
		store: {
			read: (key: ModelPerformanceCacheKey) => key.modelClass === "fast" ? [{
				candidate: "cliproxy/fast-b",
				recordedAt: 1_000,
				ttftMs: 250,
				estimatedTokensPerSecond: 40,
				source: "probe" as const,
			}] : [],
			record() {},
			invalidate() {},
		},
		discover: () => ({
			modelPools: { fast: ["cliproxy/fast-a", "cliproxy/fast-b"], smart: ["cliproxy/smart-a"] },
			modelPerformance: DEFAULT_MODEL_PERFORMANCE_CONFIG,
		}),
	});
	const ctx = {
		cwd: "/repo",
		hasUI: true,
		mode: "tui",
		model: { provider: "cliproxy", id: "fast-a" },
		modelRegistry: { getAvailable: () => models },
		ui: {
			custom: async (factory: Function, options: { overlay?: boolean }) => {
				assert.equal(options.overlay, true);
				let closed = false;
				const component = factory({}, {}, undefined, () => { closed = true; });
				const rendered = component.render(100).join("\n");
				assert.match(rendered, /fast/);
				assert.match(rendered, /cliproxy\/fast-b/);
				assert.match(rendered, /250ms TTFT.*40\.0 token\/s/);
				assert.match(rendered, /1\. cliproxy\/fast-b \[configured 2\]/);
				assert.match(rendered, /2\. cliproxy\/fast-a \[configured 1\]/);
				assert.match(rendered, /smart/);
				assert.match(rendered, /cliproxy\/smart-a.*unmeasured/);
			component.handleInput("j");
			assert.equal(component.render(100).join("\n"), rendered);
				component.handleInput("\u001b");
				assert.equal(closed, true);
			},
		},
	};
	runtime.startSession(ctx);
	const command = commands.get("subagents-model-performance");
	assert.ok(command);
	await command.handler("", ctx);
});
