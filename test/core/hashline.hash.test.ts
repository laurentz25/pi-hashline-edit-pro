import { describe, expect, it } from "vitest";
import {
	applyHashlineEdits,
	computeLineHash,
	computeLineHashes,
	hashlineParseText,
} from "../../src/hashline";

describe("computeLineHash", () => {
	it("returns a 4-character string from the URL-safe base64 alphabet", () => {
		const hash = computeLineHash(1, "hello");
		expect(hash).toHaveLength(4);
		expect(hash).toMatch(/^[A-Za-z0-9_\-]{4}$/);
	});

	it("trims trailing whitespace without collapsing internal spaces", () => {
		expect(computeLineHash(1, "a\t")).toBe(computeLineHash(1, "a"));
		expect(computeLineHash(1, "a  b")).not.toBe(computeLineHash(1, "a b"));
	});

	it("strips trailing CR", () => {
		expect(computeLineHash(1, "hello\r")).toBe(computeLineHash(1, "hello"));
	});

	it("treats all lines uniformly via occurrence-based discrimination", () => {
		const h1 = computeLineHash(1, "}");
		const h10 = computeLineHash(10, "}");
		expect(h1).toMatch(/^[A-Za-z0-9_\-]{4}$/);
		// computeLineHash treats every input as 1st occurrence, so same content → same hash
		expect(h1).toBe(h10);
	});

	it("does NOT mix line index for lines with alphanumeric content", () => {
		expect(computeLineHash(1, "function foo()")).toBe(
			computeLineHash(99, "function foo()"),
		);
	});
});

describe("strict hashline contract", () => {
	it("preserves internal spaces when hashing", () => {
		expect(computeLineHash(1, "a b")).not.toBe(computeLineHash(1, "ab"));
	});

	it("trims trailing spaces when hashing", () => {
		expect(computeLineHash(1, "value  ")).toBe(computeLineHash(1, "value"));
	});

	it("preserves explicit blank trailing line in array input", () => {
		expect(hashlineParseText(["alpha", ""])).toEqual(["alpha", ""]);
	});

	it("rejects stale anchors instead of relocating by hash", () => {
		const content = ["a", "INSERTED", "b", "target", "c"].join("\n");
		// The model hands us a hash that doesn't appear in the current file —
		// either it was copied from a previous read or fabricated. Strict
		// semantics: we throw, we never silently relocate to a "close enough"
		// line by content.
		const stale = {
			op: "replace", start: { hash: "ZZZZ" }, end: { hash: "ZZZZ" }, lines: ["updated"],
		} as any;

		expect(() => applyHashlineEdits(content, [stale])).toThrow(/stale anchor/);
	});
});

describe("occurrence-aware hashline", () => {
	it("returns one hash per line, indexed 0-based by line number", () => {
		const hashes = computeLineHashes("alpha\nbeta\ngamma");
		expect(hashes).toHaveLength(3);
		expect(hashes[0]).toMatch(/^[A-Za-z0-9_\-]{4}$/);
		expect(hashes[1]).toMatch(/^[A-Za-z0-9_\-]{4}$/);
		expect(hashes[2]).toMatch(/^[A-Za-z0-9_\-]{4}$/);
	});

	it("assigns different hashes to identical content at different positions", () => {
		const file = [
			"import { foo } from 'bar';",
			"import { baz } from 'qux';",
			"import { foo } from 'bar';", // identical to line 1
		].join("\n");
		const hashes = computeLineHashes(file);
		expect(hashes[0]).not.toBe(hashes[2]); // the key property
		expect(hashes[0]).not.toBe(hashes[1]);
		expect(hashes[1]).not.toBe(hashes[2]);
	});

	it("assigns different hashes to symbol-only lines at different positions", () => {
		const file = [
			"function a() {",
			"  return 1;",
			"}",
			"function b() {",
			"  return 2;",
			"}",
		].join("\n");
		const hashes = computeLineHashes(file);
		// Lines 3 and 6 are both lone `}` — they should still get different hashes.
		expect(hashes[2]).not.toBe(hashes[5]);
	});

	it("lets the edit tool target a specific occurrence when content is duplicated", () => {
		const file = [
			"const x = 1;",
			"const y = 2;",
			"const x = 1;", // identical to line 1
		].join("\n");
		const hashes = computeLineHashes(file);
		// Edit only the second occurrence of "const x = 1;" (line 3, not line 1).
		const result = applyHashlineEdits(file, [
			{ op: "replace", start: { hash: hashes[2]! }, end: { hash: hashes[2]! }, lines: ["const x = 999;"] },
		]);
		expect(result.content).toBe("const x = 1;\nconst y = 2;\nconst x = 999;");
	});

	it("stale-anchor error shows the file's current state for context", () => {
		// The model wrote line 3's anchor with a stale hash. The error must show
		// the file's current hashes so the model can refresh.
		const file = ["const x = 1;", "const y = 2;", "const x = 1;"].join("\n");
		const staleHash = "ZZZZ";
		let caught: Error | undefined;
		try {
			applyHashlineEdits(file, [
				{ op: "replace", start: { hash: staleHash }, end: { hash: staleHash }, lines: ["X"] },
			]);
		} catch (e) {
			caught = e as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_STALE_ANCHOR/);
		// The current-state block shows fresh hashes for the file's lines.
		const freshHashes = computeLineHashes(file);
		expect(caught!.message).toContain(freshHashes[0]!);
		expect(caught!.message).toContain(freshHashes[1]!);
		expect(caught!.message).toContain(freshHashes[2]!);
		// Line 1 and line 3 have different hashes (occurrence-aware).
		expect(freshHashes[0]).not.toBe(freshHashes[2]);
	});

	it("rejects an ambiguous hash with [E_AMBIGUOUS_ANCHOR] (synthetic collision)", () => {
		// Two genuinely different content lines happen to produce the same hash
		// extremely rarely at 24 bits (probability ~1/16M per pair). We can't
		// realistically force a collision with xxHash32, so we inject a
		// precomputed hash array via applyHashlineEdits's `precomputedHashes`
		// parameter — the same hook the read tool uses to thread the hash array it
		// showed the model through validation. We replace line 3's hash with line 1's,
		// so the resolver sees two distinct lines sharing one hash.
		const file = "alpha\nbeta\ngamma\ndelta";
		const realHashes = computeLineHashes(file);
		const forgedHashes = [...realHashes];
		forgedHashes[2] = realHashes[0]!; // line 3 (index 2) now matches line 1's hash

		const sharedHash = realHashes[0]!;

		let caught: Error | undefined;
		try {
			applyHashlineEdits(
				file,
				[
					{ op: "replace", start: { hash: sharedHash }, end: { hash: sharedHash }, lines: ["X"] },
				],
				undefined,
				forgedHashes,
			);
		} catch (error) {
			caught = error as Error;
		}
		expect(caught).toBeDefined();
		expect(caught!.message).toMatch(/E_AMBIGUOUS_ANCHOR/);
		// The error must list both candidate line numbers so the model can
		// disambiguate by re-reading — the wire format does not accept a content
		// disambiguator on the anchor.
		expect(caught!.message).toMatch(/matches lines 1, 3/);
		expect(caught!.message).toContain(`${realHashes[0]!}│alpha`);
		expect(caught!.message).toContain(`${realHashes[0]!}│gamma`);
	});
});
