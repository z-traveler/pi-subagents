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

	it("requests priority for GPT model IDs matched by a configured regex", () => {
		const policy = new SessionFastModePolicy(["/^gpt-/", "owner/model"], true);
		for (const modelId of ["gpt-6.1-sol", "gpt-6-luna", "owner/model"]) {
			const payload = { model: modelId, service_tier: "default" };
			assert.deepEqual(policy.rewriteProviderRequest(payload, modelId), {
				model: modelId,
				service_tier: "priority",
			});
			assert.equal(payload.service_tier, "default");
		}
		for (const modelId of ["claude-opus-5", "cliproxy/gpt-6.1-sol", "GPT-6.1-sol", "/^gpt-/", undefined]) {
			const payload = { service_tier: "default" };
			assert.equal(policy.rewriteProviderRequest(payload, modelId), payload);
		}
		policy.setEnabled(false);
		const payload = { model: "gpt-6.1-sol" };
		assert.equal(policy.rewriteProviderRequest(payload, "gpt-6.1-sol"), payload);
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

	it("transfers regex eligibility to another runtime and replaces it on policy updates", () => {
		const root = new SessionFastModePolicy(["/^gpt-/"]);
		root.setEnabled(true);
		const runner = new SessionFastModePolicy([]);

		runner.applySnapshot(root.snapshot());

		assert.deepEqual(runner.rewriteProviderRequest({ model: "gpt-6.1-sol" }, "gpt-6.1-sol"), {
			model: "gpt-6.1-sol",
			service_tier: "priority",
		});
		runner.applySnapshot({ version: 1, enabled: true, modelIds: ["/^claude-/"] });
		assert.equal(runner.isEligible("gpt-6.1-sol"), false);
		assert.equal(runner.isEligible("claude-opus-5"), true);
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
