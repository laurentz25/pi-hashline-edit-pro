import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const replacePrompt = readFileSync(
	new URL("../../prompts/replace.md", import.meta.url),
	"utf-8",
);

// These assertions pin the model-facing surface of the replace tool. The prompt
// is the contract that tells the model how to express multi-region and
// non-conflicting edits. If a future refactor drops one of these load-bearing
// phrases, the model will silently lose guidance on the multi-region case or
// the three conflict rules. Tighten the assertions in the same PR that
// changes the prompt.
describe("prompts/replace.md (model-facing contract)", () => {
	it("declares the single-call multi-region pattern", () => {
		expect(replacePrompt).toMatch(/single `replace` call/i);
		expect(replacePrompt).toMatch(/Stack every region/i);
		expect(replacePrompt).toMatch(/same pre-edit read/i);
	});

	it("includes a worked multi-region example", () => {
		// The third example shows a delete + delete in one edits array.
		// The shape `replace ... lines: []` is the deletion form; the model
		// must see this end-to-end to use it confidently.
		expect(replacePrompt).toMatch(/Multiple regions in one call/i);
		expect(replacePrompt).toContain('"lines": []');
	});

	it("requires both start and end for replace", () => {
		// The runtime rejects replace ops that omit start or end.
		// The prompt must declare both required.
		expect(replacePrompt).toMatch(/`start` and `end` are required/i);
	});

	it("lists conflict rules under [E_EDIT_CONFLICT]", () => {
		// The runtime enforces overlap rules in assertNoConflictingSpans; the
		// prompt must declare them so the model discovers the constraint by
		// reading, not by trial-and-error.
		expect(replacePrompt).toContain("[E_EDIT_CONFLICT]");
		expect(replacePrompt).toMatch(/two `replace` ranges overlap/);
	});

	it("warns about the anchor budget and how to recover from it", () => {
		// The 12-line / 50KB cap triggers "Anchors omitted; use read..."; the
		// model needs to know to call read again when it sees that.
		expect(replacePrompt).toMatch(/Anchors omitted; use read/i);
	});

	it("documents the noop classification (no error on identical content)", () => {
		// When lines matches current content, the edit is classified noop and
		// the file is not modified. The model must not interpret this as an
		// error.
		expect(replacePrompt).toMatch(/Classification: noop/);
	});

	it("tells the model the wire format is bare HASH only (no |, no content, no whitespace)", () => {
		// The model sees "HASH|content" in read output but must pass back only
		// the 4 chars before the "|". The wire format is bare HASH; no punctuation,
		// no line content, no surrounding whitespace.
		expect(replacePrompt).toMatch(/wire format.*anchor only/i);
	});

	it("points to the post-replace Anchors block as a cheaper source of fresh hashes", () => {
		// The --- Anchors --- block on a successful replace has fresh hashes for the
		// changed region; using those instead of re-reading the whole file is a
		// significant token saving on chained replaces.
		expect(replacePrompt).toContain("--- Anchors ---");
	});

	it("documents the [E_STALE_ANCHOR] recovery path", () => {
		// The error response includes fresh `>>> HASH|content` lines; the model
		// must copy the HASH portion (not the `>>>` framing) and retry.
		expect(replacePrompt).toContain("[E_STALE_ANCHOR]");
		expect(replacePrompt).toMatch(/>>> HASH|content/);
	});

	it("documents auto-read after write", () => {
		// After a successful write, the extension auto-reads and provides
		// hashline anchors so the model can immediately use replace.
		expect(replacePrompt).toContain("--- Auto-read (hashline anchors) ---");
		expect(replacePrompt).toMatch(/seamless write → replace/);
	});
});

const readPrompt = readFileSync(
	new URL("../../prompts/read.md", import.meta.url),
	"utf-8",
);

// These assertions pin the model-facing surface of the read tool. The prompt
// is the contract that tells the model how to interpret the HASH:content output.
// If a future refactor drops one of these load-bearing phrases — especially the
// "-qkl"-style alphabet note — the model will silently lose the input-side guidance.
describe("prompts/read.md (model-facing contract)", () => {
	it("declares the HASH|content output format and the 4-char anchor", () => {
		expect(readPrompt).toMatch(/`HASH|content`/);
		expect(readPrompt).toMatch(/4 base64 characters/);
		expect(readPrompt).toMatch(/HASH/);
	});

	it("specifies the URL-safe base64 alphabet A-Za-z0-9-_", () => {
		// The alphabet must be declared so the model can recognize hashes that
		// start with characters that are unusual in identifiers (notably "-").
		expect(readPrompt).toContain("A-Za-z0-9-_");
	});

	it("preempts the '-qkl'-style hash by clarifying that - is a normal alphabet char", () => {
		// The runtime accepts any 4-char input from the alphabet, including hashes
		// that start with "-". Without this clarification, the model can mistake a
		// leading "-" for a diff-remove marker and refuse to pass the hash back.
		expect(readPrompt).toMatch(
			/URL-safe base64 alphabet/
		);
	});

	it("documents pagination via offset and nextOffset", () => {
		// Large files return a truncated preview plus a nextOffset; the model needs
		// to know to call read again with offset=nextOffset to continue.
		expect(readPrompt).toContain("nextOffset");
		expect(readPrompt).toContain("offset=nextOffset");
	});

	it("documents file-kind handling (text, image, binary, directory)", () => {
		// The HASH-line protocol only applies to text files. The model needs to
		// know images come back as visual attachments and binary/directory paths
		// are rejected.
		expect(readPrompt).toMatch(/Images? \(JPEG, PNG, GIF, WebP\)/);
		expect(readPrompt).toMatch(/Binary/);
		expect(readPrompt).toMatch(/directories/);
	});
});
