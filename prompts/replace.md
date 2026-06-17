Replace lines in a text file using `HASH` anchors copied verbatim from `read`.

Put all operations on one file in a single `replace` call. Stack every region into the `edits` array, even when they are far apart. Anchors within one call must all come from the same pre-edit read; the runtime applies them atomically against that one snapshot, so you do not adjust anchors for line-number shifts between edits in the same call.

Anchors are 4 characters (e.g. `aB3x`), alphabet `A-Za-z0-9-_`. The wire format for `start`/`end` is the anchor only — no line number, no trailing content, no line content.

Examples:

1. Single line replace:
```json
{ "path": "src/main.ts", "edits": [
  { "start": "MQXV", "end": "MQXV", "lines": ["const x = 1;"] }
] }
```

2. Range replace (3 lines → 3 new lines):
```json
{ "path": "src/main.ts", "edits": [
  { "start": "ZPMQ", "end": "VRWS", "lines": [
    "function greet(name) {",
    "  return `Hello, ${name}`;",
    "}"
  }
] }
```

3. Multiple regions in one call (delete two non-adjacent ranges):
```json
{ "path": "src/server.ts", "edits": [
  { "start": "aB3x", "end": "xY7q", "lines": [] },
  { "start": "MQXV", "end": "ZPMQ", "lines": [] }
] }
```

Rules:
- `start` and `end` are required. A single-line replace is `start=X, end=X`. To replace more than one line, set `end` to a different line's anchor.
- To delete a range, use `lines: []`.
- `start`, `end` are HASH anchors only (e.g. `aB3x`). Other forms are rejected with `[E_BAD_REF]`.
- `lines` is literal file content. No `HASH│` prefix, no leading `+`/`-` (those are read/diff metadata, not file content). Lines starting with 4 base64 chars + `│` are checked; if detected, the replace is rejected with `[E_BARE_HASH_PREFIX]`. For `.py` files, this becomes a `[W_BARE_HASH_PREFIX]` warning instead (Python syntax like `else:`, `except:` triggers the detector).
- Copy anchors from the most recent `read` of the file. Do not guess or construct them.
- All edits in one call must be non-conflicting. The runtime rejects with `[E_EDIT_CONFLICT]` if two `replace` ranges overlap. Fix: merge into one or split into a follow-up `replace` call.
- When building replace ranges, double-check that `start` is on the first line you want changed and `end` is on the last. If two edits would touch the same lines or adjacent lines, merge them into one replace with the combined new content.
- If `lines` matches the current content byte-for-byte, the replace is classified as `Classification: noop` (file unchanged, not an error).

On success (`changed` mode, default), the response text contains an `--- Anchors ---` block with fresh `HASH│content` for the changed region (2 lines of context, capped at ~12 lines / 50 KB). Use those for nearby follow-up replaces instead of re-reading. If the response says `Anchors omitted; use read for subsequent replaces`, the region was too large — call `read` again. For distant follow-ups, or on any error, call `read` again. `full` and `ranges` modes put previews in `details`; the model only needs what's in the text.

Errors are text starting with a bracketed code (e.g. `[E_BAD_SHAPE]`, `[E_STALE_ANCHOR]`, `[E_BAD_OP]`, `[E_INVALID_PATCH]`, `[E_LEGACY_SHAPE]`, `[E_EDIT_CONFLICT]`, `[E_BAD_REF]`, `[E_AMBIGUOUS_ANCHOR]`, `[E_BARE_HASH_PREFIX]`, `[E_WOULD_EMPTY]`). The message tells you what to retry; stale-anchor errors include `>>> HASH│content` lines, ready to copy.

The legacy `oldText`/`newText` shape (top-level) is rejected with `[E_LEGACY_SHAPE]`. Use hash-anchored replaces instead.

Auto-read after write:
- After a successful `write`, the result includes a `--- Auto-read (hashline anchors) ---` block with `HASH│content` for the written file.
- Use those anchors directly for `replace` calls without a separate `read`.
- This enables a seamless write → replace workflow with no extra tool calls.
