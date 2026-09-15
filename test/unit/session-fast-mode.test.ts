import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionFastModePolicy } from "../../src/runs/shared/session-fast-mode.ts";

describe("session Fast routing", () => {
	it("requests priority for an eligible model ID without changing the request model", () => {
		const policy = new SessionFastModePolicy(["gpt-5.6-sol"], true);
		const payload = { model: "gpt-5.6-sol", input: [], service_tier: "default" };

		assert.deepEqual(policy.rewriteProviderRequest(payload, "gpt-5.6-sol"), {
			model: "gpt-5.6-sol",
			input: [],
			service_tier: "priority",
		});
		assert.deepEqual(payload, { model: "gpt-5.6-sol", input: [], service_tier: "default" });
	});

	it("applies a changed session mode to the next provider request", () => {
		const policy = new SessionFastModePolicy(["gpt-5.6-sol"]);
		const payload = { model: "gpt-5.6-sol" };
		assert.equal(policy.rewriteProviderRequest(payload, "gpt-5.6-sol"), payload);

		policy.setEnabled(true);

		assert.deepEqual(policy.rewriteProviderRequest(payload, "gpt-5.6-sol"), {
			model: "gpt-5.6-sol",
			service_tier: "priority",
		});
	});

	it("matches only the exact model ID and leaves unsupported models at the standard tier", () => {
		const policy = new SessionFastModePolicy(["gpt-5.6-sol"], true);
		const payload = { model: "gpt-5.6-sol-preview", service_tier: "default" };

		assert.equal(policy.rewriteProviderRequest(payload, "gpt-5.6-sol-preview"), payload);
		assert.equal(policy.rewriteProviderRequest(payload, "cliproxy/gpt-5.6-sol"), payload);
		assert.deepEqual(policy.rewriteProviderRequest(payload, "gpt-5.6-sol"), {
			model: "gpt-5.6-sol-preview",
			service_tier: "priority",
		});
	});

	it("transfers the current last-value policy to another runtime", () => {
		const root = new SessionFastModePolicy(["gpt-5.6-sol"]);
		root.setEnabled(true);
		const runner = new SessionFastModePolicy([]);

		runner.applySnapshot(root.snapshot());

		assert.deepEqual(runner.rewriteProviderRequest({ model: "gpt-5.6-sol" }, "gpt-5.6-sol"), {
			model: "gpt-5.6-sol",
			service_tier: "priority",
		});
	});

	it("notifies descendants only when the last-value snapshot changes", () => {
		const policy = new SessionFastModePolicy(["gpt-5.6-sol"]);
		const snapshots: ReturnType<SessionFastModePolicy["snapshot"]>[] = [];
		const unsubscribe = policy.subscribe((snapshot) => snapshots.push(snapshot));

		policy.setEnabled(false);
		policy.setEnabled(true);
		policy.setEnabled(true);
		policy.applySnapshot({ version: 1, enabled: false, modelIds: ["gpt-5.6-luna"] });
		unsubscribe();
		policy.setEnabled(true);

		assert.deepEqual(snapshots, [
			{ version: 1, enabled: true, modelIds: ["gpt-5.6-sol"] },
			{ version: 1, enabled: false, modelIds: ["gpt-5.6-luna"] },
		]);
	});
});
