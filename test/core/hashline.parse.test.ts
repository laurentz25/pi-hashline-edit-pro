import { describe, expect, it } from "vitest";
import { hashlineParseText, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a bare HASH", () => {
		const ref = parseHashRef("aB3x");
		expect(ref).toEqual({ hash: "aB3x" });
	});

	it("rejects trailing content after the hash", () => {
		// The wire format is bare hash only. The `HASH:content` form from
		// earlier versions is gone — there is no textHint on the wire.
		expect(() => parseHashRef("aB3x:const x = 1;")).toThrow(
			/Expected a 4-character "HASH"/,
		);
		expect(() => parseHashRef("aB3x:")).toThrow(
			/Expected a 4-character "HASH"/,
		);
	});

	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		// The wire format is the bare 4-character hash. A `>>> ` prefix from a
		// stale-anchor retry block is not part of the wire format and is rejected;
		// the model must copy just the hash, not the surrounding retry-block framing.
		expect(() => parseHashRef(">>> aB3x")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: bare hash only)", () => {
		// `+` is not in the URL-safe base64 alphabet, so a 5-char input like `+aB3x`
		// is unambiguously a model mistake (a diff-add prefix leaked into the wire).
		// `-` IS in the alphabet, so a 5-char input like `-aB3x` is either a
		// model mistake (a diff-remove prefix) or a malformed hash (5 chars instead
		// of 4). Either way the strict wire format rejects it; the model must copy
		// exactly the 4 characters that appeared in `read` output.
		expect(() => parseHashRef("+aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-aB3x")).toThrow(/E_BAD_REF/);
	});

	it("accepts a 4-character hash that starts with - (alphabet char, not a marker)", () => {
		// Regression: the URL-safe base64 alphabet is A-Za-z0-9-_, so a hash can
		// legitimately begin with "-". The pre-fix code stripped the leading "-" as
		// if it were a diff-removal marker and rejected the remaining 3 chars as a
		// wrong-length hash. The strict path catches these.
		expect(parseHashRef("-qkl")).toEqual({ hash: "-qkl" });
		expect(parseHashRef("-_-a")).toEqual({ hash: "-_-a" });
		expect(parseHashRef("----")).toEqual({ hash: "----" });
	});

	it("rejects + as a hash first character (not in alphabet)", () => {
		// "+" is not in the URL-safe base64 alphabet, so a 4-char input starting
		expect(() => parseHashRef("+qkl")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5#aB3x")).toThrow(
			/Line numbers are no longer part of the anchor format/,
		);
	});

	it("rejects wrong-length hashes", () => {
		expect(() => parseHashRef("aB3")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("aB3xX")).toThrow(/E_BAD_REF/);

	});

	it("rejects hashes with invalid alphabet", () => {
		expect(() => parseHashRef("!@#$")).toThrow(/^\[E_BAD_REF\]/);
	});
});

describe("hashlineParseText", () => {
	it("returns [] for null", () => {
		expect(hashlineParseText(null)).toEqual([]);
	});

	it("splits string on newline", () => {
		expect(hashlineParseText("a\nb")).toEqual(["a", "b"]);
	});

	it("removes trailing blank line from string input", () => {
		expect(hashlineParseText("a\nb\n")).toEqual(["a", "b"]);
	});

	it("preserves a trailing whitespace-only content line in string input", () => {
		expect(hashlineParseText("a\nb\n  ")).toEqual(["a", "b", "  "]);
	});

	it("passes through array input verbatim", () => {
		const input = ["a", "b"];
		expect(hashlineParseText(input)).toEqual(input);
	});

	it("preserves '# keep me' comment lines (no autocorrection)", () => {
		expect(hashlineParseText(["# keep me"])).toEqual(["# keep me"]);
	});

	it("preserves literal '+' prefixed content (no autocorrection)", () => {
		expect(hashlineParseText(["+added"])).toEqual(["+added"]);
	});

	it("returns empty string as a single empty line for blank content", () => {
		expect(hashlineParseText("")).toEqual([""]);
	});

	it("rejects array input that contains HASH: prefixes", () => {
		// Bare "HASH:content" prefixes are ambiguous in the new design (the
		// format is also valid literal content; see warnBareHashPrefixLines).
		// The +HASH: form, on the other hand, is unambiguous diff metadata and
		// always rejected on shape alone.
		expect(() => hashlineParseText(["+aB3x:foo", "+xYp9:bar"])).toThrow(
			/^\[E_INVALID_PATCH\]/,
		);
	});

	it("rejects diff-preview hunks with + and context hash prefixes", () => {
		expect(() =>
			hashlineParseText([" aB3x:keep", "+xYp9:new", " mNo3:after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects diff-preview deletion rows", () => {
		expect(() =>
			hashlineParseText([" aB3x:keep", "-10    old", " xYp9:after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects string-form rendered diff hunks", () => {
		const input = " aB3x:keep\n-10    old\n+xYp9:new\n mNo3:after";
		expect(() => hashlineParseText(input)).toThrow(/^\[E_INVALID_PATCH\]/);
	});
});
