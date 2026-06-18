import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHashes,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("strict edit input (no autocorrection)", () => {
	it("rejects bare HASH| prefix in content with E_BARE_HASH_PREFIX", () => {
		// The first 5 characters of an edit line are checked. If they look
		// like a 4-char hash followed by "|", the edit is rejected — even when
		// the prefix does not match any file-line hash. Bare HASH| in
		// content is almost always a model mistake (copying a hash prefix
		// from read output but dropping the rest of "HASH|content"), and
		// from read output but dropping the rest of "HASH:content"), and
		// strict rejection prevents a silent correctness bug in the file.
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ start: hashes[0]!, end: hashes[0]!, lines: [`${hashes[0]!}│foo`] },
		];
		let caught: Error | undefined;
		try {
			applyHashlineEdits(file, resolveEditAnchors(toolEdits));
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		// Error message lists the offending line and the suspect hash prefix.
		expect(caught!.message).toContain(`${hashes[0]!}│`);
		expect(caught!.message).toContain(`${hashes[0]!}│foo`);
		// The error message flags the case where the suspect matches a real
		// file-line hash (strong evidence the model copied a hash).
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects string lines before patch-prefix validation", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{
				start: hashes[0]!, end: hashes[0]!, lines: `+${hashes[0]!}:foo`,
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("rejects diff deletion rows in array form", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ start: hashes[0]!, end: hashes[0]!, lines: ["-1    foo"] },
		];
		expect(() => resolveEditAnchors(toolEdits)).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("accepts plain literal content unchanged", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ start: hashes[0]!, end: hashes[0]!, lines: ["bar"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]!.lines).toEqual(["bar"]);
	});

	it("preserves '#' comment lines that do not match the strict prefix", () => {
		const file = "foo\nbar";
		const hashes = computeLineHashes(file);
		const toolEdits: HashlineToolEdit[] = [
			{ start: hashes[0]!, end: hashes[0]!, lines: ["# keep me"] },
		];
		const resolved = resolveEditAnchors(toolEdits);
		expect(resolved[0]!.lines).toEqual(["# keep me"]);
	});
});

describe("partial hash prefixes copied into content (issue #24)", () => {
	// The bare-prefix detector matches HASH_LENGTH-char alphabet runs followed by "|".
	// With 4-char hashes, a real-content prefix like "TODO:foo" can sometimes be a
	// With 4-char hashes, a real-content prefix like "TODO:foo" can sometimes be a
	// real concern. The detector warns but never silently patches.
	const file = "alpha\nbeta\ngamma\ndelta";
	const hashes = computeLineHashes(file);
	const anchor = hashes[0]!;
	const betaHash = hashes[1]!;
	const gammaHash = hashes[2]!;

	function applyTool(toolEdits: HashlineToolEdit[]) {
		return applyHashlineEdits(file, resolveEditAnchors(toolEdits));
	}

	it("rejects with E_BARE_HASH_PREFIX when a bare prefix matches an existing file line hash", () => {
		// Use the real 4-char hash of line 2 ("beta") as a bare prefix. The
		// detector should reject, not warn, even when the prefix collides
		// with a real line hash. The error message should flag the match as
		// strong evidence the model copied a hash from the read output.
		let caught: Error | undefined;
		try {
			applyTool([
				{ start: anchor, end: anchor, lines: [`${betaHash}│### heading`, "real content"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${betaHash}│### heading`);
		expect(caught!.message).toMatch(/match file line hashes/);
	});

	it("rejects valid literal 'HHHH:' content when HHHH exists in the file hash set", () => {
		// Even when the suspect prefix matches a real file-line hash, the
		// edit is rejected. The literal "${gammaHash}:text" form is exactly
		// the shape the user wanted to ban (issue #24).
		let caught: Error | undefined;
		try {
			applyTool([
				{ start: anchor, end: anchor, lines: [`${gammaHash}│text`] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		expect(caught!.message).toContain(`${gammaHash}│text`);
	});

	it("rejects even when bare prefixes miss the file hash set (no 'strong signal' gate)", () => {
		// With the 64-char alphabet, the old "N suspects in this batch"
		// count-based trigger fired on basically every multi-line code edit
		// (let:, var:, 200:, 404:, ...), and the strong-signal gate only
		// warned on prefix-in-file-hash. The detector now rejects on shape
		// alone, so even "ZZZ:one" and "ZZP:two" (no match in the file)
		// are blocked. The error message is different: it tells the model
		// the prefix does not match any line hash, hinting that the content
		// might be a 3-char identifier that needs rephrasing.
		let caught: Error | undefined;
		try {
			applyTool([
			{ start: anchor, end: anchor, lines: ["ZZZ│one", "ZZP│two"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/^\[E_BARE_HASH_PREFIX\]/);
		// The error message notes the absence of a hash-set match — that
		// distinction helps the model decide whether to rephrase the
		// identifier or just look for a stale hash.
		expect(caught!.message).toMatch(/None match file line hashes/);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", () => {
		// "TS:" is 2 chars — too short to match the 3-char bare-prefix detector.
		const result = applyTool([
			{ start: anchor, end: anchor, lines: ["TS: TypeScript"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", () => {
		// Defensive: comment lines, diff markers, and short non-alphabet prefixes
		// must not trigger the bare-prefix warning. We use a single-line
		// replacement here so the unrelated "single-anchor replace got multiple
		// lines" warning does not fire and pollute the assertion.
		const result = applyTool([
			{ start: anchor, end: anchor, lines: ["# heading"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
	});
});
