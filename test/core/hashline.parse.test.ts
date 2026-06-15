import { describe, expect, it } from "vitest";
import { hashlineParseText, parseHashRef } from "../../src/hashline";

describe("parseHashRef", () => {
	it("parses a hash anchor without # prefix", () => {
		const ref = parseHashRef("aB3x");
		expect(ref).toEqual({ hash: "aB3x" });
	});

	it("rejects trailing content after the anchor", () => {
		// The wire format is anchor only. No content may follow.
		expect(() => parseHashRef("aB3x:const x = 1;")).toThrow(
			/Expected a 4-character base64 anchor/,
		);
	});

	it("rejects leading >>> markers (strict mode: no marker stripping)", () => {
		// The wire format is the bare anchor. A `>>> ` prefix from a
		// stale-anchor retry block is not part of the wire format and is rejected;
		// the model must copy just the anchor, not the surrounding retry-block framing.
		expect(() => parseHashRef(">>> aB3x")).toThrow(/E_BAD_REF/);
	});

	it("rejects + and - diff markers (strict mode: anchor only)", () => {
		expect(() => parseHashRef("+aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-aB3x")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("-#aB3x")).toThrow(/E_BAD_REF/);
	});

	it("accepts a hash that starts with - in the body (alphabet char, not a marker)", () => {
		// The URL-safe base64 alphabet is A-Za-z0-9-_, so the hash body can
		// legitimately begin with "-". E.g. `#-qkl` is a valid anchor.
		expect(parseHashRef("-qkl")).toEqual({ hash: "-qkl" });
		expect(parseHashRef("-_-a")).toEqual({ hash: "-_-a" });
		expect(parseHashRef("----")).toEqual({ hash: "----" });
	});

	it("rejects + as a hash body character (not in alphabet)", () => {
		// "+" is not in the URL-safe base64 alphabet
		expect(() => parseHashRef("+qkl")).toThrow(/E_BAD_REF/);
		expect(() => parseHashRef("#+qkl")).toThrow(/E_BAD_REF/);
	});

	it("rejects malformed anchors with E_BAD_REF", () => {
		expect(() => parseHashRef("invalid")).toThrow(/^\[E_BAD_REF\]/);
	});

	it("rejects legacy LINE#HASH format", () => {
		expect(() => parseHashRef("5aB3x")).toThrow(
			/Use the hash alone/,
		);
	});

	it("rejects wrong-length anchors", () => {
		// Too short (missing prefix or body chars)
		// Too short (missing body chars)
		expect(() => parseHashRef("aB3")).toThrow(/E_BAD_REF/);
		// Too long
		expect(() => parseHashRef("aB3xX")).toThrow(/E_BAD_REF/);
		// Too long
		expect(() => parseHashRef("#aB3xX")).toThrow(/E_BAD_REF/);
	});

	it("rejects anchors with invalid alphabet", () => {
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

	it("rejects array input that contains HASH| prefixes", () => {
		// The +HASH| form is unambiguous diff metadata and
		// always rejected on shape alone.
		// always rejected on shape alone.
		expect(() => hashlineParseText(["+aB3x│foo", "+xYp9│bar"])).toThrow(
			/^\[E_INVALID_PATCH\]/,
		);
	});

	it("rejects diff-preview hunks with + and context hash prefixes", () => {
		expect(() =>
				hashlineParseText([" aB3x│keep", "+xYp9│new", " mNo3│after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects diff-preview deletion rows", () => {
		expect(() =>
				hashlineParseText([" aB3x│keep", "-10    old", " xYp9│after"]),
		).toThrow(/^\[E_INVALID_PATCH\]/);
	});

	it("rejects string-form rendered diff hunks", () => {
		const input = " aB3x│keep\n-10    old\n+xYp9│new\n mNo3│after";
		expect(() => hashlineParseText(input)).toThrow(/^\[E_INVALID_PATCH\]/);
	});
});
