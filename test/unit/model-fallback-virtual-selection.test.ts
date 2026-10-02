import assert from "node:assert/strict";
import { it } from "node:test";
import { formatSubagentModelVerificationError as verifyFallback } from "../../src/runs/shared/model-fallback.ts";
import { formatSubagentModelVerificationError as verifySelection } from "../../src/runs/shared/model-resolution.ts";

it("keeps fallback verification aligned with upstream virtual-model selection checks", () => {
	const models = [{ provider: "router", id: "model", fullId: "router/model" }];
	assert.equal(verifyFallback("router/model:high", "physical/model", models, undefined, "router/model"), undefined);
	for (const selection of ["router/model", "other/model", "model"]) {
		const args = ["router/model:high", "physical/model", models, { "router/model": ["physical/model"] }, selection] as const;
		assert.equal(verifyFallback(...args), verifySelection(...args));
	}
});
