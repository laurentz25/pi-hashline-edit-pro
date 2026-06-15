Read a text file. Each line is returned as `#HASH:content`. The HASH starts with `#` followed by 4 base64 characters before the first `:`; the content after is the line verbatim. Pass the HASH (e.g. `#aB3x`) into `edit`'s `start`/`end` (for `replace`) or `pos` (for `append`/`prepend`) — never include the line content.

HASH shape:
- 5 characters total: `#` prefix + 4 characters from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `#aB3x`, `#4yN-`, `#-qkl`).
- The line number is not part of the wire format. Anchor by HASH, never by reading a line number off the rendered output.

HASH → edit:
- Copy the full 5-character HASH (including the `#` prefix). Use that HASH as `start` or `end` (for `replace`) or `pos` (for `append`/`prepend`) in the next `edit` call.
- Do not include the `:`, the line content, or surrounding whitespace. The wire format for `start`/`end`/`pos` is the HASH only.

Pagination:
- Large files return a truncated preview with a `nextOffset` line. Call `read` again with `offset=nextOffset` to continue.
- For nearby follow-up edits, prefer the `--- Anchors ---` block from a previous `edit` call — fresh HASHes, cheaper than re-reading.
- Empty files return an advisory suggesting `prepend`/`append` instead of a synthetic anchor.

Error recovery:
- `[E_STALE_ANCHOR]` — the file changed since your last read. The error includes fresh `>>> #HASH:content` lines; copy the HASH portion (the `#` + 4 chars before `:`) and retry.
- `[E_BAD_REF]` — malformed HASH. Re-read and try again with a valid HASH anchor (e.g. `#aB3x`).

File kinds:
- Text files are returned as `#HASH:content` lines.
- Images (JPEG, PNG, GIF, WebP) are returned as visual attachments; the HASH-line protocol does not apply.
- Binary files and directories are rejected with a descriptive error.

Auto-read after write:
- After a successful `write`, the result includes a `--- Auto-read (hashline anchors) ---` block with `#HASH:content` for the written file.
- Use those anchors directly for `edit` calls without a separate `read`.
- The auto-read output follows the same format and rules as `read` output.
