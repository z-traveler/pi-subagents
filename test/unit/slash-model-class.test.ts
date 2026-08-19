import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInlineConfig } from "../../src/slash/slash-commands.ts";

describe("slash modelClass config", () => {
	it("parses a semantic model class independently from model", () => {
		assert.deepEqual(parseInlineConfig("modelClass=fast"), { modelClass: "fast" });
		assert.throws(() => parseInlineConfig("model=provider/id,modelClass=fast"), /both model and modelClass/);
	});
});
