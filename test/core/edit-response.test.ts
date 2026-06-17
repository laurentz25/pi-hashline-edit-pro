import { describe, expect, it } from "vitest";
import {
	buildNoopResponse,
	buildFullResponse,
	buildRangesResponse,
	buildChangedResponse,
	type NoopResponseInput,
	type SuccessResponseInput,
	type EditMeta,
} from "../../src/replace-response";
import { computeLineHash } from "../../src/hashline";

const baseEditMeta: EditMeta = {
	editsAttempted: 1,
	noopEditsCount: 0,
};

describe("buildNoopResponse", () => {
	it("returns noop classification in text for changed mode", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			noopEdits: undefined,
			originalNormalized: "line1\nline2\n",
			snapshotId: "v1|test|123|456",
			editMeta: baseEditMeta,
			warnings: undefined,
		};
		const result = buildNoopResponse(input);
		expect(result.content[0].text).toContain("No changes made");
		expect(result.content[0].text).toContain("noop");
		expect(result.details.classification).toBe("noop");
	});

	it("returns noop with full content preview for full mode", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			returnMode: "full",
			requestedReturnRanges: undefined,
			noopEdits: undefined,
			originalNormalized: "line1\nline2\n",
			snapshotId: "v1|test|123|456",
			editMeta: baseEditMeta,
			warnings: undefined,
		};
		const result = buildNoopResponse(input);
		expect(result.content[0].text).toContain("No changes made");
		expect(result.details.fullContent).toBeDefined();
		expect(result.details.fullContent.text).toContain("line1");
	});

	it("includes noop edit details when present", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			noopEdits: [
				{
					editIndex: 0,
					loc: computeLineHash(1, "line1"),
					currentContent: "line1",
				},
			],
			originalNormalized: "line1\nline2\n",
			snapshotId: "v1|test|123|456",
			editMeta: { ...baseEditMeta, noopEditsCount: 1 },
			warnings: undefined,
		};
		const result = buildNoopResponse(input);
		expect(result.content[0].text).toContain("Edit 0");
		expect(result.content[0].text).toContain("identical to current content");
	});

	it("includes warnings in details when present", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			noopEdits: undefined,
			originalNormalized: "line1\n",
			snapshotId: "v1|test|123|456",
			editMeta: baseEditMeta,
			warnings: ["Test warning"],
		};
		const result = buildNoopResponse(input);
		// Warnings are tracked in metrics for noop responses
		expect(result.details.metrics.warnings).toBe(1);
	});

	it("includes metrics in details", () => {
		const input: NoopResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			noopEdits: undefined,
			originalNormalized: "line1\n",
			snapshotId: "v1|test|123|456",
			editMeta: baseEditMeta,
			warnings: undefined,
		};
		const result = buildNoopResponse(input);
		expect(result.details.metrics).toBeDefined();
		expect(result.details.metrics.classification).toBe("noop");
		expect(result.details.metrics.edits_attempted).toBe(1);
	});
});

describe("buildChangedResponse", () => {
	it("returns anchors block in text", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			originalNormalized: "line1\nline2\nline3\n",
			result: "line1\nmodified\nline3\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChangedResponse(input);
		expect(result.content[0].text).toContain("--- Anchors ---");
		expect(result.content[0].text).toContain("modified");
	});

	it("returns diff in details but not in text", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			originalNormalized: "line1\nline2\n",
			result: "line1\nmodified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChangedResponse(input);
		expect(result.details.diff).toContain("+");
		expect(result.details.diff).toContain("modified");
		// Text should not contain the diff directly
		expect(result.content[0].text).not.toContain("+modified");
	});

	it("includes metrics with line counts", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			originalNormalized: "line1\nline2\nline3\n",
			result: "line1\nmodified\nline3\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildChangedResponse(input);
		expect(result.details.metrics.classification).toBe("applied");
		expect(result.details.metrics.return_mode).toBe("changed");
		expect(result.details.metrics.added_lines).toBeGreaterThanOrEqual(1);
	});

	it("omits anchors when region too large", () => {
		// Create a large file where the changed region exceeds the budget
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const original = lines.join("\n") + "\n";
		const modified = [...lines.slice(0, 50), "changed", ...lines.slice(51)].join("\n") + "\n";
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "changed",
			requestedReturnRanges: undefined,
			originalNormalized: original,
			result: modified,
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 51,
				lastChangedLine: 51,
			},
		};
		const result = buildChangedResponse(input);
		// With 2 lines of context, the range would be 49-53 (5 lines)
		// which is within limits, so anchors should be present
		expect(result.content[0].text).toContain("--- Anchors ---");
	});
});

describe("buildFullResponse", () => {
	it("returns full content in details", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "full",
			requestedReturnRanges: undefined,
			originalNormalized: "line1\nline2\n",
			result: "line1\nmodified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 2,
				lastChangedLine: 2,
			},
		};
		const result = buildFullResponse(input);
		expect(result.details.fullContent).toBeDefined();
		expect(result.details.fullContent.text).toContain("modified");
		expect(result.content[0].text).toContain("Updated");
	});

	it("includes structure outline when available", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "full",
			requestedReturnRanges: undefined,
			originalNormalized: "function foo() {\n  return 1;\n}\n",
			result: "function bar() {\n  return 2;\n}\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 1,
				lastChangedLine: 3,
			},
		};
		const result = buildFullResponse(input);
		expect(result.details.structureOutline).toBeDefined();
	});

	it("includes metrics", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "full",
			requestedReturnRanges: undefined,
			originalNormalized: "line1\n",
			result: "modified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 1,
				lastChangedLine: 1,
			},
		};
		const result = buildFullResponse(input);
		expect(result.details.metrics.classification).toBe("applied");
		expect(result.details.metrics.return_mode).toBe("full");
	});
});

describe("buildRangesResponse", () => {
	it("returns requested ranges in details", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "ranges",
			requestedReturnRanges: [{ start: 1, end: 2 }],
			originalNormalized: "line1\nline2\nline3\n",
			result: "modified\nline2\nline3\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 1,
				lastChangedLine: 1,
			},
		};
		const result = buildRangesResponse(input);
		expect(result.details.returnedRanges).toBeDefined();
		expect(result.details.returnedRanges.length).toBe(1);
		expect(result.content[0].text).toContain("Updated");
	});

	it("includes structure outline for ranges", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "ranges",
			requestedReturnRanges: [{ start: 1, end: 3 }],
			originalNormalized: "function foo() {\n  return 1;\n}\n",
			result: "function bar() {\n  return 2;\n}\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 1,
				lastChangedLine: 3,
			},
		};
		const result = buildRangesResponse(input);
		expect(result.details.structureOutline).toBeDefined();
	});

	it("includes metrics", () => {
		const input: SuccessResponseInput = {
			path: "src/main.ts",
			returnMode: "ranges",
			requestedReturnRanges: [{ start: 1, end: 1 }],
			originalNormalized: "line1\n",
			result: "modified\n",
			warnings: undefined,
			snapshotId: "v1|test|123|456",
			editMeta: {
				...baseEditMeta,
				firstChangedLine: 1,
				lastChangedLine: 1,
			},
		};
		const result = buildRangesResponse(input);
		expect(result.details.metrics.classification).toBe("applied");
		expect(result.details.metrics.return_mode).toBe("ranges");
	});
});
