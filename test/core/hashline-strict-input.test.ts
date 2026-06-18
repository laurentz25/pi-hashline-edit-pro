import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHashes,
	resolveEditAnchors,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("strict edit input (no autocorrection)", () => {
	it("rejects bare HASH| prefix in content with E_BARE_HASH_PREFIX", () => {
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
	const file = "alpha\nbeta\ngamma\ndelta";
	const hashes = computeLineHashes(file);
	const anchor = hashes[0]!;
	const betaHash = hashes[1]!;
	const gammaHash = hashes[2]!;

	function applyTool(toolEdits: HashlineToolEdit[]) {
		return applyHashlineEdits(file, resolveEditAnchors(toolEdits));
	}

	it("rejects with E_BARE_HASH_PREFIX when a bare prefix matches an existing file line hash", () => {
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
		expect(caught!.message).toMatch(/None match file line hashes/);
	});

	it("accepts a single legit 'TS: TypeScript' line without warning", () => {
		const result = applyTool([
			{ start: anchor, end: anchor, lines: ["TS: TypeScript"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
		expect(result.content).toContain("TS: TypeScript");
	});

	it("does not false-positive on shorter valid-content prefixes like '#' or '+'", () => {
		const result = applyTool([
			{ start: anchor, end: anchor, lines: ["# heading"] },
		]);
		expect(result.warnings ?? []).toEqual([]);
	});
});
