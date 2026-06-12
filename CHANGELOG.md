# Changelog

## Unreleased

### Breaking — `replace` op now requires `start` + `end`; `pos` is rejected on `replace`

The `replace` op in the edit tool wire format is now an explicit inclusive line range. The previous single-anchor shape `{op: "replace", pos: X, lines: [...]}` is no longer accepted.

- New shape: `{op: "replace", start: "HASH", end: "HASH", lines: [...]}`. Both `start` and `end` are required bare 4-character hashes. A single-line replace is `start=X, end=X`.
- `pos` on a `replace` op is rejected with `[E_BAD_OP]` and a clear message naming `start` as the replacement. The runtime does not silently fold `pos` to `start` — this matches the strict-semantics policy that rejected the legacy `oldText`/`newText` shape in 0.5.0.
- `append` and `prepend` are unchanged: they continue to use the optional `pos` field (omit for file-boundary insertion at EOF/BOF).
- Error messages that referenced `requires a "pos" anchor string` now reference `requires a "start" anchor string` and `requires an "end" anchor string`.
- The `single-anchor replace receives multiple lines (likely missing end)` warning is gone: there is no single-anchor replace anymore, so the warning no longer applies.
- Stale-anchor error messages now list both `start` and `end` of each stale edit (so a `replace` with `start=X, end=X` reports 2 stale anchors, not 1). Tests that asserted on the count were updated.
- `HashlineEdit` and `ResolvedHashlineEdit` types in `src/hashline.ts` no longer have `pos` on the `replace` variant — they have `start` and `end` (both required). `HashlineToolEdit` (the wire-format input type) has `start?` in addition to `pos?` and `end?`; the per-op constraints in `assertEditItem` are the source of truth.
- `src/edit.ts` TypeBox schema updated: `hashlineEditItemSchema` declares `start`, `end`, and `pos` as separate optional fields with op-specific descriptions. `additionalProperties: false` still applies; the per-op validation in `assertEditItem` provides the precise error message.
- `prompts/edit.md` rewritten to reflect the new shape: both examples and the op grammar. `prompts/read.md` clarified that a HASH from read goes into `start`/`end` (for `replace`) or `pos` (for `append`/`prepend`).
- `AGENTS.md` updated: the architecture guardrail now states "`replace` uses `start` + `end`; `append`/`prepend` use `pos`" instead of "`pos` and `end` accept only a 4-character HASH".
- All test fixtures that used `{op: "replace", pos: X, lines: [...]}` rewritten to `{op: "replace", start: X, end: X, lines: [...]}` (or to range form where appropriate). Two new tests in `test/core/hashline.resolve.test.ts` cover the new failure paths: `rejects replace with start but no end` and `rejects replace with the legacy 'pos' field`. `test/extension/prompts.test.ts` gained an assertion for "both anchors are required" and "do NOT use the `pos` field".

### Notes

- This is a breaking change for any model that was emitting `{op: "replace", pos: X, ...}`. The model will see `[E_BAD_OP]` and the error message will tell it the new shape on the next turn. No data loss.
- The runtime did not auto-upgrade via a normalization layer (e.g. silently fold `pos` → `start`) because the project's strict-semantics policy is to reject legacy shapes with clear errors rather than patch them, mirroring the 0.5.0 treatment of `oldText`/`newText`.


### Docs — multi-region edits made explicit in the edit tool prompt

The model-facing `prompts/edit.md` was tightened around the multi-region case (delete N ranges, add M anchors, all in one `edit` call). The runtime already supported this — `assertNoConflictingSpans` enforces non-overlap, and `test/integration/stale-position-compound.test.ts` exercises it — but the prompt only showed single-region examples, so the model had to discover the multi-region shape by trial.

- New third example: a delete + delete + prepend in one `edits` array.
- All three conflict rules surfaced under `[E_EDIT_CONFLICT]`: overlapping `replace` ranges, two inserts at the same boundary, and an insert inside a replaced range. Previously only the first was in the prompt.
- `prepend` clarified as the op for "insert between line N-1 and N" (anchor on N). This is the only way to express an insert-between-lines with the current op set; models coming from `oldText`/`newText` often try to express it as "replace N with [new, old]" which strict semantics rejects.
- Anchor-budget cap (~12 lines / 50 KB) and the "Anchors omitted; use read" recovery path now in the prompt instead of only in the response.
- `noop` classification documented in the prompt so the model does not interpret "Classification: noop" as an error.
- New `test/extension/prompts.test.ts` pins the load-bearing phrases so a future refactor cannot silently regress the model-facing contract.


### Docs — read tool prompt mirrors edit tool's depth on hash handling

`prompts/read.md` was 1 line. The model had to infer the HASH shape, alphabet, wire-format rules, pagination, and stale-anchor recovery from examples and trial. `prompts/edit.md` (see previous entry) was tightened to spell all of this out for the *output* side, but the *input* side stayed implicit. This release brings the read prompt to the same depth, so the model is preemptive rather than discover-by-error on the input side too.

- HASH shape declared: 4 characters from the URL-safe base64 alphabet `A-Za-z0-9-_`, with explicit clarification that a HASH may start with `-` (a normal alphabet char, not a diff-remove marker — closes the failure mode the user just hit on `-qkl`).
- HASH → edit rules: copy exactly the 4 chars before the `:`; do not include `:`, content, or surrounding whitespace. The no-marker rule (`+`/`-`/`>>>`) lives in the edit prompt, where it belongs.
- Pagination: `offset`/`nextOffset` documented so the model knows how to continue reading a truncated file.
- Cheap refresh: the post-edit `--- Anchors ---` block called out as a cheaper source of fresh HASHes than re-reading the whole file.
- Error recovery: `[E_STALE_ANCHOR]` response format explained (the `>>> HASH:content` lines are how the model gets fresh hashes after a stale anchor).
- File kinds: text/image/binary/directory handling documented.

`prompts/read-guidelines.md` was expanded from 1 bullet to 3, covering the most common input-side mistakes the model might make. The no-marker bullet was kept out of the read side — that rule is in `edit.md`.

`test/extension/prompts.test.ts` gained a new `describe` block with 8 assertions on the load-bearing phrases in the read prompt, so a future refactor cannot silently regress the model-facing contract on the input side either.

## 0.5.0 — legacy `replace_text` removed

The legacy native edit shape (top-level `oldText`/`newText` aliases and `op: "replace_text"`) is no longer supported. Any incoming request using that shape is rejected with `[E_LEGACY_SHAPE]`. Hash-anchored `replace` / `append` / `prepend` are now the only path.

This is the change that fixed the user's `[E_NO_MATCH] replace_text found no exact unique match` failures in production. The legacy shape is what the model emits when it falls back to Pi's native edit contract (or to its own training-time default), and it's brittle on real-world whitespace/Unicode drift between the model's `oldText` and the actual file content. The hash-anchored shape derives identity from the line content itself, so the same failure mode is structurally impossible.

- `op: "replace_text"` and the top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect are rejected at the validation layer with `[E_LEGACY_SHAPE]`. The error message tells the model exactly what to do: call `read` first, copy the `HASH:content` prefix into `pos` of a `{op: "replace", pos, lines}` entry, and put the new content in `lines`.

- The `HashlineEdit` type no longer includes the `replace_text` variant. Engine code paths for it are removed (`resolveEditAnchors`, `describeEdit`, `cloneHashlineEdit`, `resolveEditToSpan`, `validateAnchorEdits`).
- The normalization layer in `src/edit-normalize.ts` is reduced to its essential dialect handling: `file_path` → `path` alias, and `edits` array as a JSON string. The legacy `oldText`/`newText` folding and `op: "replace_text"` backfill are removed.
- Test files `test/tools/edit.replace-text.test.ts` and `test/tools/edit.compatibility.test.ts` are deleted; the surviving tests use hash-anchored replace.
- `prompts/edit.md` no longer advertises `replace_text` as an option, and explicitly tells the model the legacy shape is rejected.

### Notes
- This is a breaking change for any model that was depending on the legacy shape. The model will see `[E_LEGACY_SHAPE]` and the error message will tell it the right shape on the next turn. No data loss.
- A previous 0.5.0-pre iteration added a `PI_HASHLINE_REQUIRE_ANCHORED` flag with auto-upgrade behavior. That approach was rejected: the user wanted the legacy path gone entirely, not auto-upgraded. The flag and auto-upgrade code are not in this release.

## 0.4.0 — 4-character hash

The hash length goes from 3 to 4 characters. Combined with the 64-character URL-safe base64 alphabet (unchanged from 0.3.0), this gives **24 bits of entropy per anchor (16 777 216 buckets)**, up from 18 bits (262 144 buckets) in 0.3.0. Birthday-paradox collisions are effectively nullified at any realistic file size: for a 1 000-line file the expected collision count is ~0.03, for a 10 000-line file ~3, for a 100 000-line file ~300.

### Changes from 0.3.0
- `HASH_LENGTH` in `src/hashline.ts` raised from 3 to 4.
- The DICT lookup table (which pre-computed the hash string for each xxHash32 output prefix) was removed. At 3 chars it was 262 144 entries × 3 chars = ~1 MB of static memory; at 4 chars it would have been 16 777 216 entries × 4 chars ≈ 450 MB and a multi-second module load. The hash is now computed inline from the xxHash32 output via the new `hashToString(h)` helper. Per-line cost: one xxHash32 call plus 4 small string concatenations — still nanoseconds, and `computeLineHashes` runs once per file, not on a hot path.
- `HASH_BUCKETS` and `HASH_SHIFT` constants removed (they only made sense for the DICT).
- `HASH_FORMAT` export updated to drop the `buckets` field.
- All test fixtures updated from 3-char to 4-char hashes. The display-prefix regex fixture (`# Note: keep me`) was updated to `# keep me` to avoid the 4-char length matching `Note:` as a hash prefix.
- Structure-outline scanner in `src/edit-response.ts` and structure-detect regexes in test files updated to match the new 4-char length.

### Notes
- Wire-compatible at the protocol level (still `LINE#HASH:`), but the *literal* hash strings for any given file will differ. Re-running a model session across an upgrade will see stale anchors on the first edit; `read` will refresh them.

## 0.3.0 — URL-safe base64 alphabet

The alphabet used for hash output is now the 64-character URL-safe base64 set: `A-Za-z0-9-_`. The previous 16-character hand-curated alphabet was designed to be unambiguous to a human reader (no hex digits, no vowels, no visually confusable letters). The consumer here is an LLM that tokenizes, not a human that squints at pixel glyphs, so the human-readability heuristics don't apply and the full 64 chars give maximum entropy per position.

Combined with the existing 3-character hash length, this gives **18 bits of entropy per anchor (262 144 buckets)** — up from 12 bits (4 096 buckets) in 0.2.0. For a 1 000-line file, the expected number of pure birthday-paradox collisions is ~2, down from ~120. For a 5 000-line file, ~40, down from ~3 800. The remaining collisions are still eliminated by the occurrence-aware discriminator scheme from 0.2.0 for content-duplicate lines.

### Changes from 0.2.0
- `HASH_ALPHABET` in `src/hashline.ts` changed from `ZPMQVRWSNKTXJBYH` (16 chars, 4 bits/char) to `A-Za-z0-9-_` (64 chars, 6 bits/char).
- `HASH_BUCKETS` grew from 4 096 to 262 144 entries. `DICT` table uses ~1 MB of static memory (up from 16 KB). Module load takes a few hundred ms on a cold start.
- `HASH_ALPHABET_REGEX_SAFE` derived constant escapes the `-` in the alphabet for use in regex character classes (otherwise `9-_` would silently form an ASCII range from `9` to `_` and the literal `-` would not be matched).
- The bare-prefix detector's count-based trigger (`suspects.length >= 2`) was removed. With 64 chars the regex `^\s*[A-Za-z0-9_-]{3}:` matches too much legitimate code (`let:`, `var:`, `200:`, `404:`) for the count-based trigger to be useful. The detector now fires only on the strong signal: a suspect's prefix matches a real file-line hash.
- The structure-outline scanner in `src/edit-response.ts` was using a `[A-Z]{3}` regex to identify hashline lines; updated to `[A-Za-z0-9_-]{3}`.

### Notes
- Wire-compatible with 0.2.0 at the protocol level (still `LINE#HASH:`), but the *literal* hash strings for any given file will differ. Re-running a model session across an upgrade will see stale anchors on the first edit; `read` will refresh them.

## 0.2.0 — occurrence-aware hashes

The big behavioral change in this release: **hashes are no longer a pure function of line content.** The hash for line N is derived from a discriminator + the canonical line content, where the discriminator encodes the line's *position context*:

- Symbol-only lines (no alphanumeric content): `S{lineNumber}` is mixed into the xxHash input.
- Content lines: `C{occurrence}` is mixed in, where `occurrence` is the running count of that exact content earlier in the file.

This means two `import {...}` statements at different lines hash to different values, two `}` braces at different lines hash to different values, and the model can target a specific occurrence of repeated content with a single `LINE#HASH` anchor — no more `offset` + small `limit` window to disambiguate.

### Changes from 0.1.0
- New `computeLineHashes(content): string[]` exports the full per-line hash array. Production code (read preview, edit validation, mismatch retry block, diff preview, response builders) all consume this array instead of computing per-line hashes independently. There is no path where a hash the model sees in `read` output can disagree with what the edit tool will compute.
- `computeLineHash(idx, line)` is now a backward-compat single-line helper. It treats the input as a 1st-occurrence content line; only `edit-diff.ts` uses it for diff-preview formatting.
- `formatHashlineRegion(hashes, lines, startLine)` now takes precomputed hashes as the first argument.
- `applyHashlineEdits(content, edits, signal, precomputedHashes?)` takes an optional precomputed hash array.
- The fuzzy `textHint` anchor-validation path no longer checks that the hint's computed hash matches the supplied hash (that check no longer makes sense with occurrence-aware hashes). It now trusts the hint's *content* match alone, and logs a warning. The old test for "rejects fuzzy textHint when hash is arbitrary" was updated to exercise the only failure mode that still works: the hint content must also differ from the current line.
- `src/edit.ts` now computes the post-edit hash array once and threads it into the response builders, eliminating redundant work across `buildChangedResponse` / `buildFullResponse` / `buildRangesResponse`.
- New tests in `test/core/hashline.hash.test.ts` exercise the occurrence-aware property: identical content at different positions gets different hashes, the model can target a specific occurrence with a single anchor, and stale-anchor retry messages show fresh hashes for all neighboring lines (including the other occurrence of duplicated content).
- `AGENTS.md` and `README.md` updated to document the new behavior, including measured unique-hash counts before/after.

### Why this is the better default

The previous 2-char and 3-char hashes still left content-duplicate lines colliding. The 0.1.0 README documented this as an "inherent property of content-hashing" that the user had to work around with `offset` + small `limit` windows. The 0.2.0 design eliminates the duplication source by making the hash position-aware, while preserving the wire format (`LINE#HASH`).

### Notes
- Wire-compatible with 0.1.0 at the protocol level, but the *literal* hash strings for any given file will differ. Re-running the same model session across an upgrade will see stale anchors on the first edit; `read` will refresh them.
- Not published to npm yet; install from a local checkout.

## 0.1.0 — initial release

Forked from [pi-hashline-edit v0.7.0](https://github.com/RimuruW/pi-hashline-edit). All semantics, error codes, prompts, and tests preserved; only the hash length was changed.

### Changes from upstream
- `HASH_LENGTH` in `src/hashline.ts` raised from 2 to 3.
- `DICT` lookup table grew from 256 to 4 096 entries.
- All regexes updated to match the longer hash (e.g. `HASHLINE_PREFIX_RE`, `HASHLINE_BARE_PREFIX_RE`).
- All error messages updated to mention "3 characters" instead of "2 characters".
- `parseAnchorRef` and `parseLineRef` length checks updated to `!== HASH_LENGTH`.
- All test fixtures updated to use 3-character placeholder hashes.
- `AGENTS.md` rewritten to describe the strict-semantics policy and the rationale for the length bump.
- `README.md` rewritten to document the difference from the upstream fork and when to prefer either.
- `prompts/edit.md` examples updated to use 3-character hashes.

### Notes
- Wire-compatible with upstream at the conceptual level, but the *literal* hash strings differ. Tools, prompts, and tests from upstream will not work as-is.
- Not published to npm yet; install from a local checkout.
