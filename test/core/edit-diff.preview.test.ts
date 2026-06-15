import { describe, expect, it } from "vitest";
import { buildCompactHashlineDiffPreview, generateDiffString } from "../../src/edit-diff";

describe("generateDiffString", () => {
	it("adds hash hints for context and addition lines and pads deletion lines to align the '│' column", () => {
		const result = generateDiffString("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
		const diff = result.diff;
		// Marker + (optional hash) + "│" + content. The marker is 1 char; the
		// hash (when present) is 4 chars, so the "│" sits in column 5 (0-indexed)
		// hash (when present) is 4 chars, so the ":" sits in column 5 (0-indexed)
		// for context and addition lines. Removed lines have no hash, so they are
		// padded with 4 spaces of "ghost hash" so the "│" stays in the same column
		// and removed-line content lines up with the surrounding context.
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{4}│alpha$/m);
		expect(diff).toMatch(/^\+[A-Za-z0-9_\-]{4}│BETA$/m);
		expect(diff).toMatch(/^- {4}│beta$/m);
		expect(diff).toMatch(/^ [A-Za-z0-9_\-]{4}│gamma$/m);
	});

	it("keeps the '│' column aligned across context, addition, and deletion lines", () => {
		// Realistic-ish snippet: drop a log line, rewrite the return. The test asserts
		// that every line in the diff places its "│" at exactly the same column
		// index, so the diff reads as a tidy aligned table rather than a ragged
		// stack. The console.log prints the full diff to the test output so the
		// alignment is visible at a glance.
		const before = [
			"function greet(name) {",
			"  console.log('old')",
			"  return 'hi'",
			"}",
		].join("\n");
		const after = [
			"function greet(name) {",
			"  return `Hello, ${name}`",
			"}",
		].join("\n");

		const { diff } = generateDiffString(before, after);
		// eslint-disable-next-line no-console
		console.log("\n--- generateDiffString output ---\n" + diff + "\n----------------------------------");

		// Every line should be: 1-char marker + 4-char hash-or-padding + '│' + content.
		// The "│" therefore lives at index 5 on every line.
		const lines = diff.split("\n");
		const colonColumns = lines.map((line) => line.indexOf("│"));
		expect(colonColumns).toEqual(lines.map(() => 5));

		// Spot-check the shape of each line type.
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{4}│function greet\(name\) \{$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {4}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{4}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{4}│\}$/));
		expect(lines).toContainEqual(expect.stringMatching(/^- {4}│ {2}console\.log\('old'\)$/));
		expect(lines).toContainEqual(expect.stringMatching(/^\+[A-Za-z0-9_\-]{4}│ {2}return `Hello, \$\{name\}`$/));
		expect(lines).toContainEqual(expect.stringMatching(/^ [A-Za-z0-9_\-]{4}│\}$/));
	});
});

describe("buildCompactHashlineDiffPreview", () => {
	it("collapses long unchanged runs and counts add/remove lines", () => {
		const diff = [
			" 1 ctx-a",
			" 2 ctx-b",
			" 3 ctx-c",
			" 4 ctx-d",
			"+5 added",
			"-6 removed",
			" 7 tail-a",
			" 8 tail-b",
			" 9 tail-c",
		].join("\n");

		const preview = buildCompactHashlineDiffPreview(diff);

		expect(preview.preview).toContain("... 2 more unchanged lines");
		expect(preview.addedLines).toBe(1);
		expect(preview.removedLines).toBe(1);
	});
});
