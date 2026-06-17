import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	computeLineHashes,
	resolveEditAnchors,
	type Anchor,
	type HashlineEdit,
	type HashlineToolEdit,
} from "../../src/hashline";

function makeTag(content: string, lineNum: number): Anchor {
	return { hash: computeLineHashes(content)[lineNum - 1]! };
}

describe("applyHashlineEdits — error handling", () => {
	it("throws on hash mismatch", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ start: { hash: "#XXPM" }, end: { hash: "#XXPM" }, lines: ["BBB"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(/E_STALE_ANCHOR/);
	});

	it("throws when the hash matches no line in the file", () => {
		const content = "aaa\nbbb";
		const edits: HashlineEdit[] = [
			{ start: { hash: "ZZPM" }, end: { hash: "ZZPM" }, lines: ["x"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/2 stale anchors: "ZZPM", "ZZPM"/,
		);
	});

	it("throws on range start > end", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 3), end: makeTag(content, 1),
				lines: ["x"],
			},
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/must be <= end line/,
		);
	});

	it("reports multiple mismatches at once", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ start: { hash: "#XXPM" }, end: { hash: "#XXPM" }, lines: ["A"] },
			{ start: { hash: "#YYWV" }, end: { hash: "#YYWV" }, lines: ["C"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/4 stale anchors/,
		);
	});

	it("lists stale anchor hashes in mismatch errors", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{ start: { hash: "#XXPM" }, end: { hash: "#XXPM" }, lines: ["A"] },
			{ start: { hash: "#YYWV" }, end: { hash: "#YYWV" }, lines: ["C"] },
		];
		expect(() => applyHashlineEdits(content, edits)).toThrow(
			/4 stale anchors: "#XXPM", "#XXPM", "#YYWV", "#YYWV"/,
		);
	});

	it("mismatch message contains actionable guidance", () => {
		expect(() =>
			applyHashlineEdits("aaa", [
				{
					start: { hash: "ZZPM" }, end: { hash: "ZZPM" }, lines: ["bbb"],
				} as any,
			]),
		).toThrow(/Call read\(\) to get fresh anchors/);
	});

	it("rejects overlapping replace ranges in one request", () => {
		const content = "aaa\nbbb\nccc\nddd";
		expect(() =>
			applyHashlineEdits(content, [
				{
					start: makeTag(content, 2), end: makeTag(content, 3),
					lines: ["X"],
				},
				{
					start: makeTag(content, 3), end: makeTag(content, 3), lines: ["Y"],
				},
			]),
		).toThrow(/E_EDIT_CONFLICT.*overlap.*same original line range/i);
	});
});

describe("applyHashlineEdits — heuristics", () => {
	it("preserves trailing boundary-looking lines in replacements", () => {
		const content = "if (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 1), end: makeTag(content, 2),
				lines: ["if (ok) {", "  runSafe();", "}"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("if (ok) {\n  runSafe();\n}\n}\nafter();");
		expect(result.warnings).toBeUndefined();
	});

	it("preserves leading boundary-looking lines in replacements", () => {
		const content = "before();\nif (ok) {\n  run();\n}\nafter();";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 2), end: makeTag(content, 3),
				lines: ["before();", "if (ok) {", "  runSafe();"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		// The runtime does not auto-correct the duplicated boundary line; the
		// replacement is applied verbatim. It does surface a non-blocking warning
		// so the model can notice a likely Variant-A boundary duplication.
		expect(result.content).toBe(
			"before();\nbefore();\nif (ok) {\n  runSafe();\n}\nafter();",
		);
		const hashes = computeLineHashes(content);
		expect(result.warnings).toEqual([
			`Potential boundary duplication before replace ${hashes[1]!}-${hashes[2]!}: the replacement starts with a line that matches the preceding surviving line after trim.`,
		]);
	});

	it("does not auto-correct escaped tab indentation", () => {
		const content = "root\n\tchild\n\t\tvalue\nend";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 3), end: makeTag(content, 3), lines: ["\\t\\treplaced"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("root\n\tchild\n\\t\\treplaced\nend");
		expect(result.warnings).toBeUndefined();
		expect(edits[0]).toEqual({
			start: makeTag(content, 3), end: makeTag(content, 3), lines: ["\\t\\treplaced"],
		});
	});

	it("warns on literal \\uDDDD without changing content", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 2), end: makeTag(content, 2), lines: ["\\uDDDD"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\n\\uDDDD\nccc");
		expect(result.warnings?.[0]).toContain("Detected literal \\uDDDD");
	});

	it("replaces a 1-line range with multiple lines (start == end, no warning)", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 2), end: makeTag(content, 2), lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		// A 1-line range accepts N replacement lines; no autocorrection.
		expect(result.content).toBe("aaa\nx1\nx2\nx3\nccc\nddd");
		expect(result.warnings?.some((w) => w.includes("Single-anchor replace"))).toBeFalsy();
	});

	it("does not warn when a single-anchor replace receives one line", () => {
		const content = "aaa\nbbb\nccc";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 2), end: makeTag(content, 2), lines: ["BBB"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nBBB\nccc");
		expect(result.warnings).toBeUndefined();
	});

	it("does not warn when end is supplied for a range replace", () => {
		const content = "aaa\nbbb\nccc\nddd";
		const edits: HashlineEdit[] = [
			{
				start: makeTag(content, 2), end: makeTag(content, 3),
				lines: ["x1", "x2", "x3"],
			},
		];
		const result = applyHashlineEdits(content, edits);
		expect(result.content).toBe("aaa\nx1\nx2\nx3\nddd");
		expect(
			result.warnings?.some((w) => w.includes("Single-anchor replace")) ??
				false,
		).toBe(false);
	});
});

describe("integration: resolveEditAnchors → applyHashlineEdits", () => {
	it("full pipeline: tool-schema edit → resolve → apply", () => {
		const content = "aaa\nbbb\nccc";
		const hash = computeLineHashes(content)[1]!;
		const toolEdits: HashlineToolEdit[] = [
			{ start: hash, end: hash, lines: ["BBB"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nBBB\nccc");
	});

	it("full pipeline: string lines are rejected", () => {
		const content = "aaa\nbbb\nccc";
		const hash = computeLineHashes(content)[1]!;
		const toolEdits: HashlineToolEdit[] = [
			{ start: hash, end: hash, lines: "BBB" } as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("full pipeline: null lines are rejected instead of deleting", () => {
		const content = "aaa\nbbb\nccc";
		const hash = computeLineHashes(content)[1]!;
		const toolEdits: HashlineToolEdit[] = [
			{ start: hash, end: hash, lines: null } as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("full pipeline: hashline-prefixed array lines are rejected (no autocorrection)", () => {
		const content = "aaa\nbbb\nccc";
		const hash = computeLineHashes(content)[1]!;
		// In the new format, the line number is gone from the wire protocol,
		// so a "2#HHHH:" prefix inside `lines` would never be produced by
		// read output — it can only come from a confused model. The
		// `+HHHH:` form (diff-style addition) is what assertNoDisplayPrefixes
		// catches on shape alone, and it remains rejected.
		const toolEdits: HashlineToolEdit[] = [
			{ start: hash, end: hash, lines: [`+${hash}│BBB`] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("full pipeline: copied diff-preview hunks are rejected (no autocorrection)", () => {
		const content = "aaa\nbbb\nccc";
		const hashes = computeLineHashes(content);
		const start = hashes[0]!;
		const end = hashes[2]!;
		const replacement = [
			` ${hashes[0]!}:aaa`,
			"-2    bbb",
			`+${hashes[1]!}:BBB`,
			` ${hashes[2]!}:ccc`,
		];
		const toolEdits: HashlineToolEdit[] = [
			{ start: start, end, lines: replacement },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("full pipeline: tool-level lines:[\"\"] is normalized to a delete (no extra blank line)", () => {
		// Models commonly emit `lines: [""]` to mean "delete this line". The
		// tool-level pipeline must collapse that to `lines: []` so the apply
		// layer's deletion branch (which correctly handles trailing newlines)
		// runs. Otherwise the original trailing newline of the last replaced
		// line is left behind as an extra blank line.
		const content = "aaa\nbbb\nccc\n";
		const hash = computeLineHashes(content)[1]!;
		const toolEdits: HashlineToolEdit[] = [
			{ start: hash, end: hash, lines: [""] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		const result = applyHashlineEdits(content, resolved);
		expect(result.content).toBe("aaa\nccc\n");
	});
});
