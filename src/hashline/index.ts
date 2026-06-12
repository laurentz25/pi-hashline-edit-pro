/**
 * Hashline engine — hash-anchored line editing.
 *
 * Forked from pi-hashline-edit (MIT, github.com/RimuruW/pi-hashline-edit),
 * which was vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 *
 * This fork preserves the strict semantics of the original (no silent
 * relocation, no autocorrection heuristics, no fuzzy fallback) and uses a
 * 4-character hash over a 64-character URL-safe base64 alphabet, giving
 * 24 bits of entropy (16 777 216 buckets) per anchor. Birthday-paradox
 * collisions become effectively zero for any realistic file size. The
 * alphabet is sized for an LLM consumer, not a human reader — the model
 * tokenizes, it does not squint at pixel glyphs.
 *
 * Anchor format: a bare hash alone (`aB3x`). The line number is no longer
 * part of the wire format, and no content may follow the hash either. The
 * model never has to type a line number; the runtime resolves each hash to
 * a line via the file's precomputed hash array.
 *
 * On a hash collision (two different lines happen to have the same hash
 * — extremely rare at 24 bits) the anchor is rejected with
 * `[E_AMBIGUOUS_ANCHOR]`. The model is expected to disambiguate by calling
 * `read` again to get fresh hashes.
 */

// Re-export everything from sub-modules to preserve the public API surface.
// Consumers should import from "./hashline" (this index) and get the same
// symbols as before the split.

export {
	// Hash computation
	HASH_LENGTH,
	HASH_FORMAT,
	HASH_CHARS_CLASS,
	HASHLINE_PREFIX_RE,
	HASHLINE_PREFIX_PLUS_RE,
	DIFF_MINUS_RE,
	HASHLINE_BARE_PREFIX_RE,
	computeLineHashes,
	computeLineHash,
} from "./hash";

export {
	// Parsing
	parseHashRef,
	hashlineParseText,
	type Anchor,
} from "./parse";

export {
	// Resolution and validation
	type ResolvedAnchor,
	type HashlineEdit,
	type ResolvedHashlineEdit,
	type HashlineToolEdit,
	type NoopEdit,
	resolveEditAnchors,
	validateAnchorEdits,
	assertNoBareHashPrefixLines,
	formatMismatchError,
} from "./resolve";

export {
	// Application
	buildLineIndex,
	applyHashlineEdits,
	computeAffectedLineRange,
	formatHashlineRegion,
	computeChangedLineRange,
} from "./apply";
