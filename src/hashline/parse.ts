/**
 * Parsing — anchor parsing and edit content preprocessing.
 *
 * This module owns the wire-format parsing for hash anchors and the
 * content preprocessing that rejects display prefixes in edit payloads.
 */

import {
	ANCHOR_LENGTH,
	HASH_PREFIX,
	HASH_ALPHABET_RE,
	HASH_CHARS_CLASS,
	HASHLINE_PREFIX_PLUS_RE,
	DIFF_MINUS_RE,
} from "./hash";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * An anchor is just a hash. The hash is the entire wire format for `pos`
 * and `end` — the runtime looks it up in the file's precomputed hash array
 * to find the line. No content may follow the hash.
 */
export type Anchor = { hash: string };

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseHashRef(ref: string): string {
	const trimmed = ref.trim();

	if (!trimmed.length) {
		return `[E_BAD_REF] Invalid anchor. Expected a hash anchor like "#aB3x" (prefix "#" + 4 base64 chars).`;
	}

	// Detect the legacy "LINE#HASH" form (5#aB3x, 12#MQ, etc.) so we can
	// give a clear error pointing at the new format.
	if (/^\d+\s*#/.test(trimmed)) {
		return `[E_BAD_REF] Invalid anchor. Use the hash alone (e.g. "#aB3x") — no line numbers or trailing content.`;
	}

	return `[E_BAD_REF] Invalid anchor "${trimmed}". Expected a hash anchor like "#aB3x".`;
}

function parseAnchorRef(ref: string): Anchor {
	const trimmed = ref.trim();

	// Strict: the wire format is `#` + 4-character hash from the URL-safe base64
	// alphabet (A-Za-z0-9-_), copied verbatim from `read` output. The first
	// character of the hash body can be `-` (a valid alphabet char), so an anchor
	// like `#-qkl` is taken literally. No other form is tolerated: `+`/`-`/`>>>`
	// markers from diff contexts or stale-anchor retry blocks are rejected. The
	// model must copy just the anchor (prefix + 4 chars) with no surrounding
	// characters.
	if (
		trimmed.length === ANCHOR_LENGTH &&
		trimmed.startsWith(HASH_PREFIX) &&
		HASH_ALPHABET_RE.test(trimmed.slice(HASH_PREFIX.length))
	) {
		return { hash: trimmed };
	}

	throw new Error(diagnoseHashRef(ref));
}

/**
 * Parse a hash anchor. Accepts `#HASH` (e.g. `"#aB3x"`) only. The
 * `#HASH:content` disambiguator from earlier versions is gone — the anchor
 * is the entire wire format for `pos` and `end`, and no content may
 * follow it.
 *
 * Throws `[E_BAD_REF]` for malformed input.
 */
export const parseHashRef = parseAnchorRef;

// ─── Content preprocessing ──────────────────────────────────────────────

/**
 * Reject hashline display prefixes in edit payloads. Strict semantics: the
 * model must send literal file content for `lines`, not the rendered read /
 * diff form. Silent stripping is no longer performed — see AGENTS.md.
 *
 * This covers the unambiguous `+HASH:` / diff `+/-` forms, rejectable on
 * shape alone. The bare `HHHH:` variant (issue #24) is context-dependent and
 * lives in `assertNoBareHashPrefixLines`.
 *
 */
function assertNoDisplayPrefixes(lines: string[]): void {
	for (const line of lines) {
		if (!line.length) continue;
		if (
			HASHLINE_PREFIX_PLUS_RE.test(line) ||
			DIFF_MINUS_RE.test(line)
		) {
			throw new Error(
			`[E_INVALID_PATCH] "lines" must contain literal file content, not HASH: or diff prefixes. Offending line: ${JSON.stringify(line)}`
			);
		}
	}
}

/**
 * Parse replacement text into lines.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim so
 * explicitly provided blank lines remain intact. Display prefixes are
 * rejected by `assertNoDisplayPrefixes`, never silently stripped.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
	if (edit === null) return [];
	const lines =
		typeof edit === "string"
			? (edit.endsWith("\n") ? edit.slice(0, -1) : edit)
					.replaceAll("\r", "")
					.split("\n")
			: edit;
	assertNoDisplayPrefixes(lines);
	return lines;
}
