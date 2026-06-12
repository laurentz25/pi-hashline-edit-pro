import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

const editPrompt = readFileSync(
	new URL("../../prompts/edit.md", import.meta.url),
	"utf-8",
);

// These assertions pin the model-facing surface of the edit tool. The prompt
// is the contract that tells the model how to express multi-region and
// non-conflicting edits. If a future refactor drops one of these load-bearing
// phrases, the model will silently lose guidance on the multi-region case or
// the three conflict rules. Tighten the assertions in the same PR that
// changes the prompt.
describe("prompts/edit.md (model-facing contract)", () => {
	it("declares the single-call multi-region pattern", () => {
		expect(editPrompt).toMatch(/single `edit` call/i);
		expect(editPrompt).toMatch(/Stack every region/i);
		expect(editPrompt).toMatch(/same pre-edit read/i);
	});

	it("includes a worked multi-region example", () => {
		// The third example shows a delete + delete + prepend in one edits array.
		// The shape `replace ... lines: []` is the deletion form; the model
		// must see this end-to-end to use it confidently.
		expect(editPrompt).toMatch(/Multiple regions in one call/i);
		expect(editPrompt).toContain('"op": "replace"');
		expect(editPrompt).toContain('"lines": []');
		expect(editPrompt).toContain('"op": "prepend"');
	});

	it("requires both start and end for replace (rejects single-anchor)", () => {
		// The runtime rejects replace ops that omit end or use the old `pos` field.
		// The prompt must declare both required.
		expect(editPrompt).toMatch(/both anchors are required/i);
		expect(editPrompt).toMatch(/do NOT use the `pos` field/i);
	});

	it("lists all three conflict rules under [E_EDIT_CONFLICT]", () => {
		// The runtime enforces three rules in assertNoConflictingSpans; the
		// discover-by-error.
		expect(editPrompt).toContain("[E_EDIT_CONFLICT]");
		expect(editPrompt).toMatch(/two `replace` ranges overlap/);
		expect(editPrompt).toMatch(/same insertion boundary/);
		expect(editPrompt).toMatch(/falls inside a `replace` range/);
	});

	it("clarifies prepend for insert-between-lines", () => {
		// `prepend` at anchor N is the only op that inserts between N-1 and N.
		// Models coming from oldText/newText often try to express this as
		// "replace N with [new, old]" which is rejected; preempt that here.
		expect(editPrompt).toMatch(/between line N-1 and N/i);
	});

	it("warns about the anchor budget and how to recover from it", () => {
		// The 12-line / 50KB cap triggers "Anchors omitted; use read..."; the
		// model needs to know to call read again when it sees that.
		expect(editPrompt).toMatch(/Anchors omitted; use read/i);
	});

	it("documents the noop classification (no error on identical content)", () => {
		// When lines matches current content, the edit is classified noop and
		// the file is not modified. The model must not interpret this as an
		// error.
		expect(editPrompt).toMatch(/Classification: noop/);
	});
const readPrompt = readFileSync(
	new URL("../../prompts/read.md", import.meta.url),
	"utf-8",
);

// These assertions pin the model-facing surface of the read tool. The prompt
// is the contract that tells the model how to interpret the HASH:content output
// and how to feed those HASHes back into edit. If a future refactor drops one
// of these load-bearing phrases — especially the "-qkl"-style alphabet note or
// the no-marker rule — the model will silently lose the input-side guidance.
// Tighten the assertions in the same PR that changes the prompt.
describe("prompts/read.md (model-facing contract)", () => {
	it("declares the HASH:content output format and the 4-char anchor", () => {
		expect(readPrompt).toMatch(/`HASH:content`/);
		expect(readPrompt).toMatch(/4 characters? before the first `:`/);
		expect(readPrompt).toMatch(/4-character HASH/);
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
			/can start with any of these characters, including `-`/,
		);
	});

	it("tells the model the wire format is bare HASH only (no :, no content, no whitespace)", () => {
		// The model sees "HASH:content" in read output but must pass back only
		// the 4 chars before the ":". The wire format is bare HASH; no punctuation,
		// no line content, no surrounding whitespace. The no-marker rule (don't paste
		// "+", "-", or ">>>" markers) is documented in the edit prompt, not here.
		expect(readPrompt).toMatch(/Do not include the `:`, the line content/);
		expect(readPrompt).toMatch(/wire format.*bare 4-character HASH/i);
	});
		// The model must know that a HASH from read goes into "start"/"end" for
		// replace and "pos" for append/prepend. The wire format is the same (a
		// bare 4-char hash) but the field name differs.
		expect(readPrompt).toMatch(/start.*end.*for `replace`/i);
		expect(readPrompt).toMatch(/`pos`.*for `append`\/`prepend`/i);
});

	it("documents pagination via offset and nextOffset", () => {
		// Large files return a truncated preview plus a nextOffset; the model needs
		// to know to call read again with offset=nextOffset to continue.
		expect(readPrompt).toContain("nextOffset");
		expect(readPrompt).toContain("offset=nextOffset");
	});

	it("points to the post-edit Anchors block as a cheaper source of fresh hashes", () => {
		// The --- Anchors --- block on a successful edit has fresh hashes for the
		// changed region; using those instead of re-reading the whole file is a
		// significant token saving on chained edits.
		expect(readPrompt).toContain("--- Anchors ---");
	});

	it("documents the [E_STALE_ANCHOR] recovery path", () => {
		// The error response includes fresh `>>> HASH:content` lines; the model
		// must copy the HASH portion (not the `>>>` framing) and retry.
		expect(readPrompt).toContain("[E_STALE_ANCHOR]");
		expect(readPrompt).toMatch(/>>> HASH:content/);
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
