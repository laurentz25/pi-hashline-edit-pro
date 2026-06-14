# pi-hashline-edit-pro

A [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in `read` and `edit` tools with a hash-anchored line-editing workflow. **Strict semantics** — no silent relocation, no autocorrection, no fuzzy fallback. **Higher-entropy anchors** — 4-character content hashes over a 64-character URL-safe base64 alphabet (24 bits / 16 777 216 buckets) so birthday-paradox collisions are effectively zero in any realistic file.

This is a fork of [pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) by RimuruW. The strict-semantics policy is unchanged. This fork extends the upstream design in two compounding ways: a 4-character hash length and an occurrence-aware discriminator that makes identical content at different positions hash to different values.

Every line returned by `read` carries a short content hash. Edits reference those hashes instead of raw text, so the tool can detect stale context and reject outdated changes before they reach the file.

## Why fork?

The original uses 2-character hashes of a 16-character alphabet, with the hash being a pure function of line content. That's 8 bits / 256 buckets, and two byte-identical lines (e.g. repeated `import` statements, repeated `}`) always share a hash because the hash is `xxHash32(content)`.

This fork makes **two** changes that compound:

1. **Bump hash length to 4 characters** of the 64-char URL-safe base64 alphabet → 24 bits / 16 777 216 buckets. Birthday-paradox collisions are effectively nullified for any realistic file.
2. **Make the hash occurrence-aware.** The hash for line N is `xxHash32("C{occurrence}:{content}")` where `occurrence` is the running count of that content string earlier in the file. Symbol-only lines use `"S{lineNumber}"` as the discriminator. Two `import {...}` statements at different positions now hash to different values, so the model can target a specific occurrence without resorting to `offset` + a small `limit` window.

Measured on the current files in this repo (unique line-hashes out of total visible lines, i.e. excluding the terminal empty line produced by a trailing newline):

| File | Lines | 2-char (upstream) | 4-char (this fork) |
|---|---:|---:|---:|
| `README.md` (prose) | 138 | 73 (53%) | 138 (100%) |
| `AGENTS.md` (prose) | 106 | 64 (60%) | 106 (100%) |
| `package.json` (data) | 54 | 42 (78%) | 54 (100%) |
| `src/edit.ts` (code) | 694 | 210 (30%) | 694 (100%) |
| `src/hashline.ts` (code) | 1 463 | 248 (17%) | 1 463 (100%) |

The 4-char / occurrence-aware hash gives ~100% unique anchors in these files. The 2-char / content-only hash leaves 47–83% collisions because repeated lines (a lone `}`, repeated `import {...}` statements, repeated punctuation) all share a hash. The remaining 0% on the 4-char side is the practical floor — birthday-paradox collisions between structurally different lines are rare enough to be invisible at these file sizes.

## Installation

```bash
# From npm (once published)
pi install npm:pi-hashline-edit-pro

# From a local checkout
pi install /path/to/pi-hashline-edit-pro
```

## How It Works

### `read` — tagged line output

Text files are returned with a `HASH:content` prefix on every line. The line number is no longer part of the wire format — only the 4-character hash followed by the line content. Example output for the source below; the hashes are the real xxHash-derived values for the file content shown:

```js
function hello() {
  console.log("world");
}
```

would be returned as:

```text
0qH3:function hello() {
szJr:  console.log("world");
_zlP:}
```

- `HASH` — 4-character content hash from the URL-safe base64 alphabet `A-Za-z0-9-_`.

Optional parameters:

- `offset` — start reading from this line number (1-indexed).
- `limit` — maximum number of lines to return.

Images (JPEG, PNG, GIF, WebP) are passed through as attachments and do not participate in the hashline protocol. Binary and directory paths are rejected with a descriptive error. Empty files return an advisory suggesting `prepend`/`append` instead of a synthetic anchor.

### `edit` — hash-anchored modifications

Edits use the `HASH:content` anchors from `read` output to target lines precisely:

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

The legacy `op: "replace_text"` (and the top-level `oldText`/`newText` dialect) is rejected with `[E_LEGACY_SHAPE]`. There is no fuzzy fallback, no auto-upgrade, and no "try to find it anyway" mode — those are exactly the failure modes this fork is designed to eliminate.

All edits in a single call validate against the same pre-edit snapshot and apply bottom-up, so line numbers stay consistent across operations.

### Chained edits

After a successful edit, the result text contains an `--- Anchors ---` block with fresh `HASH:content` references for the changed region. These can be used directly in the next `edit` call on the same file without a full re-read, provided the next edit targets the same or nearby lines. For distant changes, use `read` first.

### Auto-read after write

After a successful `write`, the extension automatically reads the file and appends a `--- Auto-read (hashline anchors) ---` block to the result. This gives the model immediate `HASH:content` anchors for the newly written file without requiring a separate `read` call. The workflow becomes:

1. `write` a file → result includes hashline anchors
2. `edit` using those anchors directly

For large files (>2000 lines), the auto-read output is truncated with a pagination hint. Use `read` with `offset` to see more.
### Diff for the host

The post-edit diff (with `+`/`-` markers and new `HASH:content` anchors) is exposed to the host UI via `details.diff`. It is intentionally **not** in the LLM-visible text — the model only needs the fresh anchors in `text` to chain follow-up edits, and re-emitting the diff would cost extra tokens.

## Design Decisions

- **Stale anchors fail.** A hash mismatch means the file has changed since the last `read`. The error includes fresh `>>> HASH:content` lines for the affected region; the model copies the HASH portion and retries.
- **No fallback relocation.** Mismatched anchors are never silently relocated to a "close enough" line. This trades convenience for correctness.
- **Strict patch content.** If `lines` contains `+HASH:` display prefixes (or `-N   ` diff rows), the edit is rejected with `[E_INVALID_PATCH]`. Bare `HASH:` content (the first 5 chars of a `lines` entry looking like a 4-char hash followed by `:`) is also rejected with `[E_BARE_HASH_PREFIX]` — issue #24. When the suspect's prefix happens to match a real file-line hash, the error message flags that as strong evidence the model copied a hash from the read output; the model should rephrase the line (quote it, escape the colon, or use a different identifier shape) and retry.
- **Legacy dialect rejected.** The native top-level `oldText`/`newText` (and `old_text`/`new_text`) dialect and `op: "replace_text"` are rejected with `[E_LEGACY_SHAPE]`. The error message tells the model to call `read` first and send `{op:"replace", start:"<HASH>", end:"<HASH>", lines:[...]}` (or `append`/`prepend` with `pos`).
- **Atomic writes.** Files are written via temp-file-then-rename to avoid corruption from interrupted writes. Symlink chains are resolved so the target file is updated without replacing the symlink. Hard-linked files are updated in place to preserve the shared inode. File permissions are preserved across atomic renames.
- **Per-file mutation queue.** Edits queue by the canonical write target, so concurrent edits through different symlink paths still serialize onto the same underlying file.

## Hashing

Hashes are computed with [xxhashjs](https://github.com/pierrec/js-xxhash) (xxHash32), then mapped to a 4-character string from the URL-safe base64 alphabet `A-Za-z0-9-_` — 64 distinct characters, 6 bits per position, **24 bits of entropy per anchor**.

The alphabet is sized for an LLM consumer. The model tokenizes — it doesn't squint at pixel glyphs — so the human-readability heuristics used by smaller hand-curated alphabets (no G/L/I/O because they look like digits, no vowels so the hash doesn't accidentally spell a word, no hex digits so it can't be confused with `0xFF`) don't apply. The full 64 chars give maximum entropy per character, with case and digits included.

Hashes are **occurrence-aware**: a discriminator prefix is mixed into the xxHash input before the line content. Symbol-only lines (lone `}`, etc.) use `S{lineNumber}` as the discriminator; content lines use `C{occurrence}` where `occurrence` is the running count of that canonical content earlier in the file. This way:

- `}` on line 5 and `}` on line 17 hash differently (different `S{...}` prefix).
- `import { foo } from 'bar';` on line 3 and the same string on line 47 hash differently (different `C{...}` prefix — 1 vs 2).

The runtime always precomputes the full per-line hash array for a file via `computeLineHashes(content)`, then looks up by line number during validation and during `read` / `edit` response formatting. There is no per-line recomputation that could disagree with what the model saw in its last read.

`HASH_LENGTH` and `HASH_ALPHABET` are constants at the top of `src/hashline.ts`; bump the length to 5 if you ever need even more entropy.

### Trade-off: the bare-prefix detector

With a 64-char alphabet, the regex `^\s*[A-Za-z0-9_-]{4}:` matches a LOT of code (any 4-char identifier followed by `:` — `todo:`, `done:`, `note:`, `init:`). The "did the model accidentally paste a hash into its content?" detector used to fire on a count-based heuristic (too noisy at 64 chars), then on a "strong signal" gate (the prefix matches a real file-line hash) and only warned, then escalated to a strict rejection. Today the first 5 characters of every `lines` entry are checked; if they look like a 4-char hash followed by `:`, the edit is rejected with `[E_BARE_HASH_PREFIX]`. The false-positive cost (rejecting `init:`, `data:`, etc.) is real but small: the model can rephrase the line (quote it, add a leading space, use a different identifier shape) and retry. The false-negative cost (a stray hash in the file) is silent and catastrophic.

## Development

Requires [Node.js](https://nodejs.org) and npm.

```bash
npm install
npm test
```

Set `PI_HASHLINE_DEBUG=1` to show an "active" notification at session start.

## Credits

- [RimuruW](https://github.com/RimuruW) — original `pi-hashline-edit` and the strict-semantics policy
- [can1357](https://github.com/can1357) — original [oh-my-pi](https://github.com/can1357/oh-my-pi) implementation and the hashline concept

## License

[MIT](LICENSE)
