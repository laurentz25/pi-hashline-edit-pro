# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored line-editing workflow. Strict semantics, no silent relocation, no autocorrection, no fuzzy fallback. 4-character content hashes over a 64-character URL-safe base64 alphabet give 24 bits of entropy per anchor, so collisions are effectively zero in any realistic file.

Fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW. The strict-semantics policy is unchanged. This fork extends the upstream design in two ways: a 4-character hash length and an occurrence-aware discriminator that makes identical content at different positions hash to different values.

Every line returned by `read` carries a short content hash. Edits reference those hashes instead of raw text, so the tool can detect stale context and reject outdated changes before they reach the file.

## Why fork?

The original uses 2-character hashes of a 16-character alphabet, with the hash being a pure function of line content. That's 8 bits / 256 buckets, and two byte-identical lines (e.g. repeated `import` statements, repeated `}`) always share a hash because the hash is `xxHash32(content)`.

This fork makes two changes that compound:

1. **Bump hash length to 4 characters** of the 64-char URL-safe base64 alphabet. That gives 24 bits / 16 777 216 buckets. Birthday-paradox collisions are effectively nullified for any realistic file.
2. **Make the hash occurrence-aware.** The hash for line N is `xxHash32("C{occurrence}:{content}")` where `occurrence` is the running count of that content string earlier in the file. Symbol-only lines use `"S{lineNumber}"` as the discriminator. Two `import {...}` statements at different positions now hash to different values, so the model can target a specific occurrence without resorting to `offset` + a small `limit` window.

## Installation

From npm:

```bash
pi install npm:pi-hashline-edit-pro
```

From a local checkout:

```bash
pi install /path/to/pi-hashline-edit-pro
```

## How It Works

### `read` -- tagged line output

Text files are returned with a `HASH│content` prefix on every line. The line number is not part of the wire format, only the 4-character hash followed by the `│` separator and the line content. Example output for the source below:

```js
function hello() {
  console.log("world");
}
```

would be returned as:

```text
0qH3│function hello() {
szJr│  console.log("world");
_zlP│}
```

- `HASH` is a 4-character content hash from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3x`).

Optional parameters:

- `offset` -- start reading from this line number (1-indexed).
- `limit` -- maximum number of lines to return.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments and do not participate in the hashline protocol. Binary and directory paths are rejected with a descriptive error. Empty files return an advisory suggesting `prepend`/`append` instead of a synthetic anchor.

### `edit` -- hash-anchored modifications

Edits use the `HASH│content` anchors from `read` output to target lines precisely:

```json
{
  "path": "src/main.ts",
  "edits": [
    { "op": "replace", "start": "ve7o", "end": "ve7o", "lines": ["  console.log('hashline');"] }
  ]
}
```

| Op | Purpose | Fields |
|---|---|---|
| `replace` | Replace the inclusive range `start`..`end`. To replace a single line, set `start` = `end`. | `start` required, `end` required, `lines` |
| `append` | Insert lines after `pos`. Omit `pos` to append at EOF. | `pos` optional, `lines` |
| `prepend` | Insert lines before `pos`. Omit `pos` to prepend at BOF. | `pos` optional, `lines` |

- **Request structure validation.** The request envelope (path, edits, returnMode, returnRanges) and individual edit items are validated before any file I/O. Unknown fields, missing required fields, invalid types, and malformed anchors are rejected with `[E_BAD_SHAPE]` or `[E_BAD_OP]`.
- **Legacy dialect rejected.** The native top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect and `op: "replace_text"` are rejected with `[E_LEGACY_SHAPE]`. The error message tells the model to call `read` first and send `{op:"replace", start:"<HASH>", end:"<HASH>", lines:[...]}` (or `append`/`prepend` with `pos`).

All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so line numbers stay consistent across operations.

### Chained edits

After a successful edit, the result text contains an `--- Anchors ---` block with fresh `HASH│content` references for the changed region. These can be used directly in the next `edit` call on the same file without a full re-read, provided the next edit targets the same or nearby lines. For distant changes, use `read` first.

### Auto-read after write

After a successful `write`, the extension automatically reads the file and appends a `--- Auto-read (hashline anchors) ---` block to the result. This gives the model immediate `HASH│content` anchors for the newly written file without requiring a separate `read` call. The workflow becomes:

1. `write` a file, result includes hashline anchors
2. `edit` using those anchors directly

For large files (>2000 lines), the auto-read output is truncated with a pagination hint. Use `read` with `offset` to see more.

### Diff for the host

The post-edit diff (with `+`/`-` markers and new `HASH│content` anchors) is exposed to the host UI via `details.diff`. It is intentionally not in the LLM-visible text. The model only needs the fresh anchors in `text` to chain follow-up edits, and re-emitting the diff would cost extra tokens.

## Design Decisions

- **Stale anchors fail.** A hash mismatch means the file has changed since the last `read`. The error includes fresh `>>> HASH│content` lines for the affected region. The model copies the HASH portion and retries.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Strict patch content.** If `lines` contains `+HASH│` display prefixes (or `-N   ` diff rows), the edit is rejected with `[E_INVALID_PATCH]`. Bare `HASH│` content (the first 5 chars of a `lines` entry looking like 4 base64 chars + `│`) is also rejected with `[E_BARE_HASH_PREFIX]`. When the suspect's prefix happens to match a real file-line anchor, the error message flags that as strong evidence the model copied an anchor from the read output.
- **Legacy dialect rejected.** The native top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect and `op: "replace_text"` are rejected with `[E_LEGACY_SHAPE]`. The error message tells the model to call `read` first and send `{op:"replace", start:"<HASH>", end:"<HASH>", lines:[...]}` (or `append`/`prepend` with `pos`).
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated without replacing the symlink. Hard-linked files are updated in place to preserve the shared inode. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by the canonical write target, so concurrent edits through different symlink paths still serialize onto the same underlying file.

## Hashing

Hashes are computed with [xxhash-wasm](https://github.com/jungomi/xxhash-wasm) (xxHash32 via WebAssembly), then mapped to a 4-character string from the URL-safe base64 alphabet `A-Za-z0-9-_`. That's 64 distinct characters, 6 bits per position, 24 bits of entropy per anchor.

The alphabet is sized for an LLM consumer. The model tokenizes, it doesn't squint at pixel glyphs, so the human-readability heuristics used by smaller hand-curated alphabets (no G/L/I/O because they look like digits, no vowels so the hash doesn't accidentally spell a word, no hex digits so it can't be confused with `0xFF`) don't apply. The full 64 chars give maximum entropy per character, with case and digits included.

Hashes are occurrence-aware: a discriminator prefix is mixed into the xxHash input before the line content. Symbol-only lines (lone `}`, etc.) use `S{lineNumber}` as the discriminator; content lines use `C{occurrence}` where `occurrence` is the running count of that canonical content earlier in the file. This way:

- `}` on line 5 and `}` on line 17 hash differently (different `S{...}` prefix).
- `import { foo } from 'bar';` on line 3 and the same string on line 47 hash differently (different `C{...}` prefix, 1 vs 2).

The runtime always precomputes the full per-line hash array for a file via `computeLineHashes(content)`, then looks up by line number during validation and during `read` / `edit` response formatting. There is no per-line recomputation that could disagree with what the model saw in its last read.

`HASH_LENGTH` and `HASH_ALPHABET` are constants at the top of `src/hashline/hash.ts`; bump the length to 5 if you ever need even more entropy.

### Bare-prefix detector

With the `│` delimiter format, the bare-prefix detector regex `^\s*[A-Za-z0-9_\-]{4}│` is highly specific. It only matches lines starting with exactly 4 base64 chars and `│`. This eliminates false positives from common code patterns like `init:`, `data:`, `else:`, etc. The detector rejects edit lines matching this pattern with `[E_BARE_HASH_PREFIX]` to prevent the model from accidentally pasting hash anchors into file content.

## Development

Requires [Node.js](https://nodejs.org) and npm.

```bash
npm install
npm test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW) -- original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357) -- original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
