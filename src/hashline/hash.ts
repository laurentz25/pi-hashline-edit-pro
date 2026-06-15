/**
 * Hash computation — xxHash32-based line hashing with occurrence-aware
 * discriminators.
 *
 * This module owns the hash constants, the xxHash32 wrapper, and the
 * per-line hash computation functions. Every other module that needs
 * line hashes goes through `computeLineHashes` (full-file) or
 * `computeLineHash` (single-line helper).
 */

import * as XXH from "xxhashjs";

// ─── Constants ──────────────────────────────────────────────────────────

/**
 * Hash length in characters. The original `pi-hashline-edit` uses 2 chars of
 * a 16-char alphabet (8 bits / 256 buckets); this fork uses 4 chars of a
 * 64-char alphabet (24 bits / 16 777 216 buckets). With HASH_LENGTH=4, the
 * birthday paradox stays out of practical concern for any realistic file
 * size. Bumping to 5 is a one-line change here if you want to push the
 * threshold further; the cost is one more char per anchor in the `read`
 * output.
 */
export const HASH_LENGTH = 4;

/** Prefix marker for hash anchors. Every anchor starts with `#` so the hash */
/** format is `#` + HASH_LENGTH base64 chars (e.g. `#aB3x`, `#4yN-`). */
export const HASH_PREFIX = "#";

/** Total wire-format length of an anchor: prefix + hash body. */
export const ANCHOR_LENGTH = HASH_PREFIX.length + HASH_LENGTH;

/**
 * URL-safe base64 alphabet: A–Z, a–z, 0–9, `-`, `_`. 64 distinct chars
 * giving 6 bits per hash character. No exclusions, no human-readability
 * heuristics — the consumer is an LLM that tokenizes, not a human that
 * squints at pixel glyphs. The `-` and `_` are at the end of the string
 * so any character class built from this alphabet (e.g. `[${HASH_ALPHABET}]`)
 * treats them as literal rather than as range operators.
 */
const HASH_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_ALPHABET_BITS = 6;
const HASH_ALPHABET_MASK = (1 << HASH_ALPHABET_BITS) - 1;
// `-` must be escaped when used inside a regex character class — otherwise it
// forms a range with the preceding char (`9-_` spans ASCII 57–95, which
// silently swallows the literal `-`). The `_` is always literal.
const HASH_ALPHABET_REGEX_SAFE = HASH_ALPHABET.replace(/-/g, "\\-");
const HASH_ALPHABET_RE = new RegExp(`^[${HASH_ALPHABET_REGEX_SAFE}]+$`);
export const HASH_CHARS_CLASS = `${HASH_PREFIX}[${HASH_ALPHABET_REGEX_SAFE}]{${HASH_LENGTH}}`;

/**
 * Encode the top `HASH_LENGTH * 6` bits of a 32-bit hash value as a
 * `HASH_LENGTH`-char string in the URL-safe base64 alphabet.
 *
 * The 0.2.0/0.3.0 releases pre-computed this mapping as a `DICT` lookup
 * table. At 3 chars that was 262 144 entries × 3 chars = ~1 MB of static
 * memory; at 4 chars it would be 16 777 216 entries × 4 chars = ~450 MB
 * and a multi-second module load. So we now compute the string inline.
 * The per-line cost is one xxHash32 call plus `HASH_LENGTH` small string
 * concatenations, which is still nanoseconds — this is called once per
 * line in `computeLineHashes`, not on a hot path.
 */
function hashToString(h: number): string {
	const totalBits = HASH_LENGTH * HASH_ALPHABET_BITS;
	const shift = 32 - totalBits;
	let n = h >>> shift;
	let out = "";
	for (let j = 0; j < HASH_LENGTH; j++) {
		// Build left-to-right: the first iteration writes the high-order
		// 6 bits, the last writes the low-order 6 bits.
		out +=
			HASH_ALPHABET[
				(n >>> ((HASH_LENGTH - 1 - j) * HASH_ALPHABET_BITS)) &
					HASH_ALPHABET_MASK
			]!;
	}
	return HASH_PREFIX + out;
}

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
export const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*${HASH_CHARS_CLASS}:`,
);
export const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*${HASH_CHARS_CLASS}:`,
);
export const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

/**
 * Bare hashline prefix: a `#` + HASH_LENGTH-char hash followed by ":" with
 * no "LINE#" part (e.g. "#KKZ:### heading", "#TPN:text", "#TJZ:"). Capture
 * group 1 is the full anchor (including `#` prefix).
 *
 * This is the partial-hash failure mode from issue #24: the model copies a
 * hash it saw in `read` output into the line content but drops the rest
 * of the rendered `#HASH:content` form. The anchor (prefix + HASH_LENGTH chars
 * + ":") is matched by this regex, then `assertNoBareHashPrefixLines` rejects
 * the edit with `[E_BARE_HASH_PREFIX]` so the model gets actionable feedback
 * instead of a silent correctness bug.
 */
export const HASHLINE_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CHARS_CLASS}):`);

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

/**
 * Discriminator prefixes for the occurrence-aware hash space.
 *
 * `S${lineNumber}` puts symbol-only lines (lone `}`, etc.) into a namespace
 * keyed by line number, so the same `}` on different lines never collides.
 *
 * `C${occurrence}` puts content lines into a namespace keyed by the running
 * occurrence count of that canonical content, so the same `import {...}` on
 * different lines never collides either. This is the key behavioural change
 * from the upstream 2-char hash: identical content now hashes to different
 * values at different positions, so the model can target a specific
 * occurrence without resorting to `offset` + a small `limit` window.
 */
const SYMBOL_DISCRIMINATOR = (lineNumber: number): string => `S${lineNumber}`;
const CONTENT_DISCRIMINATOR = (occurrence: number): string => `C${occurrence}`;

function canonicalizeLine(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

function isSymbolOnly(canonical: string): boolean {
	return !RE_SIGNIFICANT.test(canonical);
}

/**
 * Compute hashes for every line of the file.
 *
 * Returns an array of length `lines.length`, where index `i` is the hash of
 * line `i + 1` (1-indexed). Two lines with the same canonical content get
 * different hashes based on which occurrence they are.
 *
 * The runtime always works from a precomputed array so that all validation,
 * formatting, and error-message code paths see the same hash for a given line.
 * The standalone `computeLineHash(idx, line)` helper below is kept for
 * single-line use (e.g. diff-preview formatting) where occurrence context
 * is not available; it treats the input as a 1st-occurrence content line.
 */
export function computeLineHashes(content: string): string[] {
	const lines = content.split("\n");
	const hashes = new Array<string>(lines.length);
	const counts = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		const canonical = canonicalizeLine(lines[i]!);
		let discriminator: string;
		if (isSymbolOnly(canonical)) {
			discriminator = SYMBOL_DISCRIMINATOR(lineNumber);
		} else {
			const occurrence = (counts.get(canonical) ?? 0) + 1;
			counts.set(canonical, occurrence);
			discriminator = CONTENT_DISCRIMINATOR(occurrence);
		}
		hashes[i] = hashToString(xxh32(`${discriminator}:${canonical}`));
	}
	return hashes;
}

/**
 * Single-line hash for callers that don't have the full file context.
 *
 * This treats the input as a 1st-occurrence content line (or, for symbol-only
 * lines, as the line at index `idx`). It is the right answer for diff-preview
 * formatting and for tests that build anchors one line at a time, but it is
 * NOT the same as the hash that `computeLineHashes` would produce for the
 * same line in a file with duplicate content. Production validation always
 * uses `computeLineHashes` + per-line lookup.
 */
export function computeLineHash(idx: number, line: string): string {
	const canonical = canonicalizeLine(line);
	const discriminator = isSymbolOnly(canonical)
		? SYMBOL_DISCRIMINATOR(idx)
		: CONTENT_DISCRIMINATOR(1);
	return hashToString(xxh32(`${discriminator}:${canonical}`));
}

/** Exported for tests and for downstream tools that want to mirror the format. */
export const HASH_FORMAT = {
	prefix: HASH_PREFIX,
	length: HASH_LENGTH,
	anchorLength: ANCHOR_LENGTH,
	bitsPerChar: HASH_ALPHABET_BITS,
	alphabet: HASH_ALPHABET,
};


/** Re-export HASH_ALPHABET_RE for parse module */
export { HASH_ALPHABET_RE };
