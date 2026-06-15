# Repository Guidelines

## What this is

A fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) (MIT) that preserves the strict semantics of the original and makes two compounding changes:

1. **Hash format: 4 characters.** Combined with the alphabet change below, this gives 24 bits of entropy per anchor (16 777 216 buckets), up from 8 bits (256 buckets) in upstream. The 4-character anchors are compact and efficient.
2. **Alphabet: 16-char hand-curated → 64-char URL-safe base64.** The original alphabet excluded hex digits, vowels, and visually confusable letters to be friendly to a human reader. The consumer here is an LLM that tokenizes, not a human that squints at pixel glyphs — so the human-readability heuristics don't apply and the full 64 chars give max entropy per position.

The strict-semantics policy of the original is preserved verbatim. This fork is a parameter change, not a philosophy change.

## Project Structure & Module Organization

- `index.ts` is the extension entrypoint; it registers the custom `read`/`edit` tools.
- `src/` contains the implementation, split by responsibility: `read.ts`, `edit.ts`, `edit-normalize.ts`, `edit-diff.ts`, `edit-response.ts`, `edit-render.ts`, `file-kind.ts`, `fs-write.ts`, `snapshot.ts`, `utils.ts`, and small runtime/path helpers. The hashline engine is in `src/hashline/` with sub-modules: `hash.ts`, `parse.ts`, `resolve.ts`, `apply.ts`, and `index.ts` (re-exports).
- `prompts/` holds the Markdown prompt text loaded by the tools at runtime.
- `test/` mirrors the code layout: `core/` for hashline primitives, `tools/` for tool behavior, `extension/` for registration, `integration/` for end-to-end flows, and `support/fixtures.ts` for temp-file helpers.
- `assets/` is documentation media only.

## Build, Test, & Development Commands

- `npm install` — install dependencies.
- `npm test` — run the full test suite with `vitest`.
- `npm test -- test/tools` — run tool-facing tests while iterating on `read`/`edit` behavior.
- `npm test -- test/integration/strict-hashline-loop.test.ts` — run the strict hashline integration scenario.
- There is no separate build step today; Pi loads the TypeScript entrypoints directly from `index.ts`.

## Coding Style & Naming Conventions

- Use TypeScript with ESM imports, two-space indentation, double quotes, and semicolons to match the existing codebase.
- Keep modules narrow and named by responsibility (`fs-write.ts`, `edit-normalize.ts`).
- Export typed functions and use specific error paths; avoid broad refactors or speculative abstractions.
- No ESLint or Prettier config is checked in, so preserve local style and keep diffs tight.

## Testing Guidelines

- Write tests with `vitest` and place them under the matching `test/` subfolder.
- Name files `<feature>.test.ts`; group assertions around one behavior per `describe` block.
- Any change to anchor parsing, diff preview, request normalization, or atomic writes should include or update tests in the affected layer.
- New integration scenarios (e.g. compound edits, stale-position edge cases) go under `test/integration/` as standalone `<scenario>.test.ts` files.

## Commit & Pull Request Guidelines

- Follow the existing Conventional Commit pattern: `fix(hashline): ...`, `refactor(read, edit): ...`, `docs: ...`.
- Keep commits focused and imperative; separate behavior changes from documentation-only changes.
- PRs should summarize the user-visible effect, list the tests run, and include before/after snippets when tool output or prompts change.

## Architecture Guardrails

- Keep `read`, `edit`, prompt text, and tests in sync whenever the hashline format changes.
- Do not bypass `src/fs-write.ts`; atomic writes are part of the extension's safety guarantees.
- Preserve stale-anchor rejection semantics unless the change explicitly redesigns the protocol.
- Pi's built-in `edit` tool uses `{ path, edits: [{ oldText, newText }] }` text matching; this extension overrides it with hashline anchors. Model dialects that follow the native contract — top-level `oldText`/`newText` (or `old_text`/`new_text`), `edits` serialized as a JSON string, `file_path` alias — are converged onto the canonical `{ path, edits: [{ op, ... }] }` shape in one place: `normalizeEditRequest` (`src/edit-normalize.ts`), wired as the tool's `prepareArguments` hook and re-applied at the top of `execute()` / `computeEditPreview()` so the normalization does not depend on the hook having run. Keep all dialect handling there; `assertEditRequest` validates the canonical shape only. The published schema therefore does not declare the native top-level fields — they no longer exist by validation time. Normalization rewrites field shape only; it never touches hashline diff semantics (anchors, ranges, boundaries, `lines`). Edit items with `oldText`/`newText` and no `op` are NOT folded — they reach validation and are rejected with `[E_LEGACY_SHAPE]` so the model learns the canonical shape on the next turn.

## Strict semantics — non-negotiable

The design intent of this fork is identical to the original. If a change starts to drift the editor toward a lenient / autocorrecting tool, reject it.

- **Do not introduce autocorrection heuristics** (e.g. stripping duplicate boundary lines, converting `\t` escape sequences, normalizing smart quotes, normalizing en-dashes) into `applyHashlineEdits`. The policy is strict semantics: the model must produce correct diffs; the runtime must not silently patch them.
- **No fallback relocation.** Stale anchors fail loudly. We do not search for "close enough" lines, we do not accept any content after the hash on the wire, and we do not relocate anchors within a window. A mismatch is `[E_STALE_ANCHOR]` and the runtime returns fresh anchors for the affected lines; the model retries.
- **No `replace_text` op, no fuzzy fallback, no auto-upgrade.** The legacy `op: \"replace_text\"` is rejected with `[E_LEGACY_SHAPE]` in `assertEditItem`. The top-level `oldText`/`newText` dialect is rejected with `[E_LEGACY_SHAPE]` in `assertEditRequest`. There is no flag to re-enable the legacy path. If the model falls back to its training-time default and emits the legacy shape, the error message tells it exactly what to do: call `read` first, copy the HASH anchor into `start` and `end` of a `{op: \"replace\", start, end, lines}` entry, and put the new content in `lines`.
- **Request and edit-item validation use `[E_BAD_SHAPE]`.** Structural errors in the request envelope (unknown fields, missing required fields, invalid types) and in individual edit items (missing `op`, unknown fields, wrong field types) are rejected with `[E_BAD_SHAPE]`. This is distinct from `[E_BAD_OP]` (invalid operation value) and `[E_BAD_REF]` (malformed hash anchor). The error messages include the specific field or constraint that failed.
- **Wire format: `replace` uses `start` + `end`; `append`/`prepend` use `pos`.** The `start` and `end` fields of a `replace` op form an inclusive line range. Both anchors are required (a single-line replace is `start=X, end=X`). The `pos` field is the anchor for `append` and `prepend` only — it is rejected with `[E_BAD_OP]` on `replace` ops. The anchor (e.g. `aB3x`) is the entire wire format for all three fields: no line number, no `│content`, no disambiguator. Passing a `HASH│content` form is rejected with `[E_BAD_REF]` — the model must re-read and copy just the anchor.
- **One documented normalization: `lines: [""]` → `lines: []` for `replace`.** Models commonly emit `lines: [""]` to mean "delete this line" instead of the strictly correct `lines: []`. The non-empty-l span branch preserves the trailing newline of the last replaced line, so a single-element empty array would leave that newline behind as an extra blank line. The runtime normalizes this to `lines: []` (a true deletion) in `applyHashlineEdits` (and again in `resolveEditAnchors` for clarity at the tool layer). Multi-element empty arrays (e.g. `["", ""]`) are NOT collapsed — they legitimately mean "insert blank lines". `append`/`prepend` are not affected; there `[""]` still means "insert one blank line". This is the only input rewrite, and it has a single narrow trigger.

## Hash format — non-negotiable

The hash length, alphabet, and occurrence-aware discriminator are the divergence from the upstream fork, and they're the *point* of this fork. Treat them as a contract.

- `HASH_LENGTH` in `src/hashline/hash.ts` is the single source of truth for the hash body length (4 chars). `ANCHOR_LENGTH` (4) is the total wire-format length.
- `HASH_ALPHABET` is the URL-safe base64 alphabet: `A-Za-z0-9-_`. 64 distinct chars, 6 bits per position. The `-` is escaped when interpolated into a regex character class (`HASH_ALPHABET_REGEX_SAFE`) so it doesn't form an unintended range with the preceding digit.
- **Occurrence-aware discriminator.** Every hash mixes a discriminator into the xxHash input:
  - Symbol-only lines (no alphanumeric content): `S${lineNumber}:` is prepended. `}` on line 5 and `}` on line 17 hash differently.
  - Content lines: `C${occurrence}:` is prepended, where `occurrence` is the running count of that canonical content earlier in the file. The first `import {...}` line and the second hash to different values.
  - The discriminator goes into the *input* to xxHash32, not into the seed, so the two discriminator namespaces (`S` and `C`) and the per-occurrence variants land in independent hash subspaces.
- `computeLineHashes(content)` is the single source of truth for the hash array. It returns `string[]` indexed 0-based (so line N is at index N-1). Every other entry point (read preview, edit validation, mismatch retry block, diff preview, response builders) goes through this array. Never re-hash per line at a call site — that would produce a different answer than what the model saw in its last read.
- `computeLineHash(idx, line)` is a backward-compat single-line helper that treats the input as a 1st-occurrence content line. It is used only by `edit-diff.ts` for diff-preview formatting where the surrounding file context is not available. Production validation never calls it.
- If you bump `HASH_LENGTH`, update every test that constructs a fixture hash (grep for `toHaveLength(4)`, `[A-Za-z0-9_\\-]{4}`, and the test bodies in `test/core/hashline.parse.test.ts` and `test/core/hashline.resolve.test.ts`). The test suite is the contract for the wire format.
- If you change the discriminator scheme, you also need to update the test for "occurrence-aware hashline" in `test/core/hashline.hash.test.ts`, which exercises the per-occurrence uniqueness property.
- If you change the alphabet (e.g. to drop the `-` for some reason), grep for the literal alphabet in regex contexts: any test that does `expect(hash).toMatch(/^[A-Za-z0-9_\\-]{4}$/)` needs to be updated.

### Trade-off: the bare-prefix detector

The bare-prefix detector (`HASHLINE_BARE_PREFIX_RE`) rejects any edit line whose first 5 characters (after optional leading whitespace) are 4 alphabet chars + `│`. The `│` delimiter is distinctive and eliminates false positives from common code patterns like `init:`, `data:`, `else:`, etc. The error code `[E_BARE_HASH_PREFIX]` is distinct from `[E_INVALID_PATCH]` (which still catches the unambiguous `+HASH│` and `-N   ` diff-row forms at the parse stage). When a suspect's prefix happens to match a real file-line anchor, the error message calls that out — strong evidence the model was reading a `HASH│content` line and copied only the prefix.

## Tool output token-efficiency

The 4-character anchors are compact and efficient. Each anchor costs 4 characters of overhead per line — that adds up on large files but is the price of the collision resistance and unambiguous format.

Rules:

- `text` carries only what the model needs for its next step: the `--- Anchors ---` block (in `changed` mode), noop classification, warnings, error codes. Line counts (`added_lines`/`removed_lines`) go to `details.metrics`, not to `text`.
- Full diffs, structural outlines, range payloads, snapshot fingerprints, metrics — host UI only, route to `details`.
- Never duplicate in `text` what anchors already express. No fallback outlines, no usage boilerplate, no verbose headers.
- New output fields default to `details`; moving one into `text` needs a justification beyond "the LLM might want it".

## When to consider the upstream instead

This fork is not a strict improvement for every workload. The original 2-char, content-only hash is a better fit if:

- You mostly work with files under ~50 lines.
- Token efficiency in `read` output is more important than collision resistance.
- You would rather see the model re-read a few times than pay the per-line token tax.
- You need wire compatibility with another tool that expects the upstream hash values.

If that matches your workflow, install [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) instead. The protocol shapes are identical; only the hash length and the occurrence-aware discriminator differ. The prompts and tests in this repo are written for the 4-char + occurrence-aware format.
