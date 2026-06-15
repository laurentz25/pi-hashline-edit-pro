Patch a text file using `HASH` anchors copied verbatim from `read`.

Put all operations on one file in a single `edit` call. Stack every region into the `edits` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot, so you do not adjust anchors for line-number shifts between edits in the same call.

Anchors are 4 characters (e.g. `aB3x`), alphabet `A-Za-z0-9-_`. The wire format for `start`/`end`/`pos` is the anchor only — no line number, no trailing content, no line content.

Ops:
- `replace` — replace the inclusive range `start`..`end`. Both anchors are required. Single line: `start = end`. To delete a range, use `lines: []`. Do NOT use the `pos` field on `replace`; use `start`.
- `append` — insert `lines` after `pos`; omit `pos` to append at EOF.
- `prepend` — insert `lines` before `pos`; omit `pos` to prepend at BOF. Use `prepend` at an anchor to insert a new block between line N-1 and N (anchor on the line *after* the insertion point).

Examples:

1. Single line replace:
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "start": "MQXV", "end": "MQXV", "lines": ["const x = 1;"] }
] }
```

2. Range replace (3 lines → 3 new lines):
```json
{ "path": "src/main.ts", "edits": [
  { "op": "replace", "start": "ZPMQ", "end": "VRWS", "lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  }
] }
```

3. Multiple regions in one call (delete two non-adjacent ranges, insert before a third anchor):
```json
{ "path": "src/server.ts", "edits": [
  { "op": "replace", "start": "aB3x", "end": "xY7q", "lines": [] },
  { "op": "replace", "start": "MQXV", "end": "ZPMQ", "lines": [] },
  { "op": "prepend", "pos": "VRWS", "lines": ["// inserted before VRWS"] }
] }
```

Rules:
- `replace` requires both `start` and `end`. A single-line replace is `start=X, end=X`. To replace more than one line, set `end` to a different line's anchor.
- `start`, `end`, `pos` are HASH anchors only (e.g. `aB3x`). Other forms are rejected with `[E_BAD_REF]`.
- `lines` is literal file content. No `HASH│` prefix, no leading `+`/`-` (those are read/diff metadata, not file content). Lines starting with 4 base64 chars + `│` are checked; if detected, the edit is rejected with `[E_BARE_HASH_PREFIX]`. For `.py` files, this becomes a `[W_BARE_HASH_PREFIX]` warning instead (Python syntax like `else:`, `except:` triggers the detector).
- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
- All edits in one call must be non-conflicting. The runtime rejects with `[E_EDIT_CONFLICT]` if: two `replace` ranges overlap; two `append`/`prepend` target the same insertion boundary (e.g. two EOF appends on a newline-terminated file); or an `append`/`prepend` falls inside a `replace` range in the same call. Fix: merge into one, use different boundaries, or split into a follow-up `edit` call.
- If `lines` matches the current content byte-for-byte, the edit is classified as `Classification: noop` (file unchanged, not an error).

On success (`changed` mode, default), the response text contains an `--- Anchors ---` block with fresh `HASH│content` for the changed region (2 lines of context, capped at ~12 lines / 50 KB). Use those for nearby follow-up edits instead of re-reading. If the response says `Anchors omitted; use read for subsequent edits`, the region was too large — call `read` again. For distant follow-ups, or on any error, call `read` again. `full` and `ranges` modes put previews in `details`; the model only needs what's in the text.

Errors are text starting with a bracketed code (e.g. `[E_BAD_SHAPE]`, `[E_STALE_ANCHOR]`, `[E_BAD_OP]`, `[E_INVALID_PATCH]`, `[E_LEGACY_SHAPE]`, `[E_EDIT_CONFLICT]`, `[E_BAD_REF]`, `[E_AMBIGUOUS_ANCHOR]`, `[E_BARE_HASH_PREFIX]`, `[E_WOULD_EMPTY]`). The message tells you what to retry; stale-anchor errors include `>>> HASH│content` lines, ready to copy.

The legacy `oldText`/`newText` shape (top-level or as `op: "replace_text"`) is rejected with `[E_LEGACY_SHAPE]`. Use hash-anchored edits instead.

Auto-read after write:
- After a successful `write`, the result includes a `--- Auto-read (hashline anchors) ---` block with `HASH│content` for the written file.
- Use those anchors directly for `edit` calls without a separate `read`.
- This enables a seamless write → edit workflow with no extra tool calls.
