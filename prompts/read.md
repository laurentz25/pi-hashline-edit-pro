Read a text file. Each line is returned as `HASH│content`. The HASH is 4 base64 characters; the content after the `│` separator is the line verbatim.

HASH shape:
- 4 characters from the URL-safe base64 alphabet `A-Za-z0-9-_` (e.g. `aB3x`, `4yN-`, `-qkl`).
- The line number is not part of the wire format. Anchor by HASH, never by reading a line number off the rendered output.

Pagination:
- Large files return a truncated preview with a `nextOffset` line. Call `read` again with `offset=nextOffset` to continue.
- Empty files return an advisory suggesting using `replace` to insert content.

File kinds:
- Text files are returned as `HASH│content` lines.
- Images (JPEG, PNG, GIF, WebP) are returned as visual attachments; the HASH-line protocol does not apply.
- Binary files and directories are rejected with a descriptive error.

Non-UTF-8 bytes:
- Non-UTF-8 bytes are decoded as U+FFFD. The output is flagged when this happens; editing such a file rewrites the file as UTF-8. Recover the original encoding with `iconv` afterwards if it must survive.