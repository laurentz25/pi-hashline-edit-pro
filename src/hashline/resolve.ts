/**
 * Resolution — anchor resolution, edit validation, and mismatch formatting.
 *
 * This module owns the logic that resolves hash anchors to line numbers,
 * validates edit structure, and formats mismatch errors. It is the bridge
 * between the parsed edit requests and the apply pipeline.
 */

import { throwIfAborted } from "../runtime";
import { HASH_LENGTH, HASHLINE_BARE_PREFIX_RE } from "./hash";
import { parseHashRef, hashlineParseText, type Anchor } from "./parse";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * The internal, post-resolution representation of an anchor. After
 * `validateAnchorEdits` has resolved the hash to a line, the resulting
 * `ResolvedAnchor` carries the line number plus whether the hash matched
 * exactly (vs. falling back to no-anchor-found / not-found).
 */
export type ResolvedAnchor = {
	line: number;
	hash: string;
	hashMatched: boolean;
};

export type HashlineEdit =
	| { op: "replace"; start: Anchor; end: Anchor; lines: string[] }
	| { op: "append"; pos?: Anchor; lines: string[] }
	| { op: "prepend"; pos?: Anchor; lines: string[] };

/**
 * A `HashlineEdit` with all anchors resolved to line numbers. This is
 * the shape consumed by `resolveEditToSpan` and the rest of the apply
 * pipeline.
 */
export type ResolvedHashlineEdit =
	| {
			op: "replace";
			start: ResolvedAnchor;
			end: ResolvedAnchor;
			lines: string[];
	  }
	| { op: "append"; pos?: ResolvedAnchor; lines: string[] }
	| { op: "prepend"; pos?: ResolvedAnchor; lines: string[] };

interface HashMismatch {
	ref: Anchor;
	kind: "not_found" | "ambiguous";
	candidates?: number[];
}

export interface NoopEdit {
	editIndex: number;
	loc: string;
	currentContent: string;
}

/**
 * Schema-level edit as received from the tool layer.
 *
 * `pos` is the anchor for `append`/`prepend`; `start` and `end` are the
 * inclusive range anchors for `replace`. `lines` is canonicalized to an array.
 *
 * The `oldText` and `newText` fields are legacy — they exist on this type
 * only because `normalizeEditRequest` may pass them through before
 * `assertEditRequest` rejects them with `[E_LEGACY_SHAPE]`. They are
 * never accepted by the edit pipeline. Do not use them in new code.
 */
export type HashlineToolEdit = {
	op: string;
	pos?: string;
	start?: string;
	end?: string;
	lines?: string[];
	/** @deprecated Legacy field — rejected with [E_LEGACY_SHAPE] at validation time. */
	oldText?: string;
	/** @deprecated Legacy field — rejected with [E_LEGACY_SHAPE] at validation time. */
	newText?: string;
};

// ─── Anchor resolution ──────────────────────────────────────────────────

/**
 * Resolve an `Anchor` to a specific line in the file.
 *
 * Returns a `ResolvedAnchor` on success. Returns an error object on:
 *   - `not_found`: no line in the file has this hash
 *   - `ambiguous`: the hash matches multiple lines (the model must
 *     re-read to disambiguate; the runtime does not accept a
 *     `HASH:content` disambiguator on the wire)
 */
function resolveAnchor(
	ref: Anchor,
	fileLines: string[],
	fileHashes: string[],
): ResolvedAnchor | HashMismatch {
	const hashMatches: number[] = [];
	for (let i = 0; i < fileHashes.length; i++) {
		if (fileHashes[i] === ref.hash) hashMatches.push(i + 1);
	}
	if (hashMatches.length === 0) {
		return { ref, kind: "not_found" };
	}
	if (hashMatches.length === 1) {
		return {
			line: hashMatches[0]!,
			hash: ref.hash,
			hashMatched: true,
		};
	}
	return { ref, kind: "ambiguous", candidates: hashMatches };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

export function formatMismatchError(
	mismatches: HashMismatch[],
	fileLines: string[],
	fileHashes: string[],
): string {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`formatMismatchError: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const out: string[] = [];
	const notFound = mismatches.filter((m) => m.kind === "not_found");
	const ambiguous = mismatches.filter((m) => m.kind === "ambiguous");

	if (notFound.length > 0) {
		const refList = notFound.map((m) => `"${m.ref.hash}"`).join(", ");
		out.push(
			`[E_STALE_ANCHOR] ${notFound.length} stale anchor${notFound.length > 1 ? "s" : ""}: ${refList}. Re-read the file to refresh.`
		);
	}
	if (ambiguous.length > 0) {
		if (out.length > 0) out.push("");
		out.push(
			`[E_AMBIGUOUS_ANCHOR] ${ambiguous.length} ambiguous anchor${ambiguous.length > 1 ? "s" : ""}. Re-read the file to refresh.`
		);
		for (const m of ambiguous) {
			const sample = (m.candidates ?? []).slice(0, 5);
			const more =
				(m.candidates?.length ?? 0) > sample.length
					? `, ... (+${(m.candidates?.length ?? 0) - sample.length} more)`
					: "";
			const lines = sample
				.map((line) => {
					const content = fileLines[line - 1] ?? "";
					return `    ${line}: ${fileHashes[line - 1]}:${content}`;
				})
				.join("\n");
			out.push(
				`  Hash "${m.ref.hash}" matches lines ${sample.join(", ")}${more}.\n${lines}`,
			);
		}
	}

	out.push("");
	out.push("Current state (first lines):");
	const sampleSize = Math.min(fileLines.length, 5);
	for (let i = 0; i < sampleSize; i++) {
		out.push(`>>> ${fileHashes[i]}:${fileLines[i]}`);
	}
	if (fileLines.length > sampleSize) {
		out.push(`... ${fileLines.length - sampleSize} more.`);
	}

	return out.join("\n");
}

// ─── Edit structure validation ──────────────────────────────────────────

/**
 * Validate + parse flat tool-schema edits into typed internal representations.
 *
 * This is the single source of truth for per-edit structural validation (shape,
 * op constraints, field types) and anchor parsing. `assertEditRequest` validates
 * only the request envelope (path, returnMode, etc.) and delegates here for
 * edit payload validation.
 *
 * Strict: provided anchors must parse successfully. Missing anchors are
 * fine for append (→ EOF) and prepend (→ BOF), but a malformed anchor
 * that was explicitly supplied is always an error.
 *
 * - replace + start + end → range replace (both anchors required; for a
 *   single-line replace, set start = end = the line's hash)
 * - append + pos → append after that anchor
 * - prepend + pos → prepend before that anchor
 * - no anchors → file-level append/prepend (only for those ops)
 */
const ITEM_KEYS = new Set(["op", "pos", "start", "end", "lines"]);
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

function assertEditItem(edit: Record<string, unknown>, index: number): void {
	const unknownKeys = Object.keys(edit).filter((key) => !ITEM_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`Edit ${index} contains unknown or unsupported fields: ${unknownKeys.join(", ")}.`,
		);
	}

	if (typeof edit.op !== "string") {
		throw new Error(`Edit ${index} requires an "op" string.`);
	}
	if (
		edit.op !== "replace" &&
		edit.op !== "append" &&
		edit.op !== "prepend"
	) {
		throw new Error(
			`[E_BAD_OP] Edit ${index} uses unknown op "${edit.op}". Expected "replace", "append", or "prepend".`,
		);
	}
	if ("pos" in edit && typeof edit.pos !== "string") {
		throw new Error(
			`Edit ${index} field "pos" must be a string when provided.`,
		);
	}
	if ("start" in edit && typeof edit.start !== "string") {
		throw new Error(
			`Edit ${index} field "start" must be a string when provided.`,
		);
	}
	if ("end" in edit && typeof edit.end !== "string") {
		throw new Error(`Edit ${index} field "end" must be a string when provided.`);
	}
	if (!("lines" in edit)) {
		throw new Error(`Edit ${index} requires a "lines" field.`);
	}
	if ("lines" in edit && !isStringArray(edit.lines)) {
		throw new Error(`Edit ${index} field "lines" must be a string array.`);
	}
	if (edit.op === "replace") {
		if ("pos" in edit) {
			throw new Error(
				`[E_BAD_OP] Edit ${index} op "replace" uses "pos" — use "start" instead.`
			);
		}
		if (typeof edit.start !== "string") {
			throw new Error(
				`[E_BAD_OP] Edit ${index} with op "replace" requires a "start" anchor string.`,
			);
		}
		if (typeof edit.end !== "string") {
			throw new Error(
				`[E_BAD_OP] Edit ${index} with op "replace" requires an "end" anchor string.`,
			);
		}
	}

	if ((edit.op === "append" || edit.op === "prepend") && "end" in edit) {
		throw new Error(
			`[E_BAD_OP] Edit ${index} op "${edit.op}" does not support "end". Use "pos" or omit.`
		);
	}
}

export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
	const result: HashlineEdit[] = [];
	for (const [index, edit] of edits.entries()) {
		assertEditItem(edit as Record<string, unknown>, index);

		const op = edit.op;
		switch (op) {
			case "replace": {
				// Normalize `lines: [""]` (a single empty string) to `lines: []`
				// (deletion). The "lines.length > 0" branch in resolveEditToSpan
				// preserves the trailing newline of the last replaced line, so a
				// single-element empty array would leave that newline behind and
				// produce an extra blank line. Models commonly emit `[""]` to
				// mean "delete this", and the deletion branch handles the
				// trailing newline correctly. Note: this is `replace`-only;
				// `append`/`prepend` legitimately use `[""]` to insert a blank
				// line.
				const replaceLines = hashlineParseText(edit.lines ?? null);
				const normalizedLines =
					replaceLines.length === 1 && replaceLines[0] === ""
						? []
						: replaceLines;
				result.push({
					op: "replace",
					start: parseHashRef(edit.start!),
					end: parseHashRef(edit.end!),
					lines: normalizedLines,
				});
				break;
			}
			case "append": {
				result.push({
					op: "append",
					...(edit.pos ? { pos: parseHashRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines ?? null),
				});
				break;
			}
			case "prepend": {
				result.push({
					op: "prepend",
					...(edit.pos ? { pos: parseHashRef(edit.pos) } : {}),
					lines: hashlineParseText(edit.lines ?? null),
				});
				break;
			}
		}
	}
	return result;
}

// ─── Anchor validation ──────────────────────────────────────────────────

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
	edits: HashlineEdit[],
	warnings: string[],
): void {
	for (const edit of edits) {
		if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
			warnings.push(
				"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
			);
		}
	}
}

/**
 * Reject edit content that starts with a bare hash prefix. Companion to
 * `assertNoDisplayPrefixes`, which rejects the unambiguous `+HASH:` form at
 * the parse stage; this catches the bare `HASH:` form (after optional leading
 * whitespace) at the apply stage. The first 5 characters of every `lines`
 * entry are checked: 4 alphabet characters (A–Z, a–z, 0–9, `-`, `_`)
 * followed by `:`.
 *
 * Bare `HASH:` prefixes in `lines` are almost always a model mistake — the
 * model copied the hash prefix from a `read` output but dropped the rest of
 * the rendered `HASH:content` form. We reject with `[E_BARE_HASH_PREFIX]`
 * rather than warn, because a stray hash in the file content is a silent
 * correctness bug (the line is written verbatim, no autocorrection) and
 * because the cost of a false positive is small: the model can rephrase the
 * line (e.g. quote it, escape the colon, or use a different identifier
 * shape) and retry.
 *
 * The error message lists the offending lines, the suspect hash prefix for
 * each, and whether any of them collide with a real file-line hash. A
 * collision is a strong signal that the model was reading a `HASH:content`
 * line and copied only the prefix.
 */
export function assertNoBareHashPrefixLines(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
	filePath?: string,
): string[] {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`assertNoBareHashPrefixLines: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	// Collect bare-prefix suspects up front: regex only. Almost every edit has
	// none, so this lets the common path bail before paying for file hashes.
	const suspects: { line: string; hash: string; editIndex: number; lineIndex: number }[] = [];
	for (let editIndex = 0; editIndex < edits.length; editIndex++) {
		const edit = edits[editIndex]!;
		for (let lineIndex = 0; lineIndex < edit.lines.length; lineIndex++) {
			const line = edit.lines[lineIndex]!;
			const match = line.match(HASHLINE_BARE_PREFIX_RE);
			if (match) suspects.push({ line, hash: match[1]!, editIndex, lineIndex });
		}
	}
	if (suspects.length === 0) return [];

	const isPython = filePath?.endsWith('.py');
	const fileHashSet = new Set(fileHashes);
	const matched = suspects.filter((s) => fileHashSet.has(s.hash));
	const matchedCount = matched.length;
	const exampleLine = `${suspects[0]!.hash}:${suspects[0]!.line}`;

	// For Python files, return a warning instead of throwing — Python uses
	// `else:`, `except:`, `elif:` etc. which trigger the bare-prefix detector.
	if (isPython) {
		const hint = matchedCount > 0
			? `${matchedCount} prefix(es) match file line hashes.`
			: `None match file line hashes — likely Python syntax.`;
		return [`[W_BARE_HASH_PREFIX] ${suspects.length} edit line(s) start with a hash-like prefix (e.g. ${JSON.stringify(exampleLine)}). ${hint}`];
	}

	const linesHint =
		matchedCount === 0
			? `None match file line hashes.`
			: `${matchedCount} match file line hashes — likely a copied hash.`;

	throw new Error(
		`[E_BARE_HASH_PREFIX] ${suspects.length} edit line(s) start with a hash-like prefix (e.g. ${JSON.stringify(exampleLine)}). ${linesHint} Use literal file content in "lines" — never paste HASH:content from read output.`
	);
}

/**
 * Validate + resolve hash-anchored edits against the current file content.
 *
 * For each anchor, the runtime:
 *   1. Looks up the hash in the file's precomputed hash array.
 *   2. If the hash uniquely matches a line, use it.
 *   3. If the hash matches multiple lines (rare at 24 bits, but possible),
 *      this is `[E_AMBIGUOUS_ANCHOR]` — the model must re-read to refresh.
 *   4. If the hash doesn't match any line, this is `[E_STALE_ANCHOR]`.
 *
 * Boundary / single-anchor / range warnings are appended to `warnings`.
 */
export function validateAnchorEdits(
	edits: HashlineEdit[],
	fileLines: string[],
	fileHashes: string[],
	warnings: string[],
	signal: AbortSignal | undefined,
): { resolved: ResolvedHashlineEdit[]; mismatches: HashMismatch[] } {
	if (fileHashes.length !== fileLines.length) {
		throw new Error(
			`validateAnchorEdits: fileHashes.length (${fileHashes.length}) must match fileLines.length (${fileLines.length}).`,
		);
	}
	const resolved: ResolvedHashlineEdit[] = [];
	const mismatches: HashMismatch[] = [];

	const tryResolve = (ref: Anchor): ResolvedAnchor | undefined => {
		const result = resolveAnchor(ref, fileLines, fileHashes);
		if ("kind" in result) {
			mismatches.push(result);
			return undefined;
		}
		return result;
	};

	function describeEdit(edit: ResolvedHashlineEdit): string {
		switch (edit.op) {
			case "replace":
				return `replace ${edit.start.hash}-${edit.end.hash}`;
			case "append":
				return edit.pos ? `append after ${edit.pos.hash}` : "append at EOF";
			case "prepend":
				return edit.pos ? `prepend before ${edit.pos.hash}` : "prepend at BOF";
		}
	}

	for (const edit of edits) {
		throwIfAborted(signal);
		switch (edit.op) {
			case "replace": {
				const startResolved = tryResolve(edit.start);
				const endResolved = tryResolve(edit.end);
				if (!startResolved || !endResolved) {
					continue;
				}
				if (startResolved.line > endResolved.line) {
					throw new Error(
						`[E_BAD_OP] Range start line ${startResolved.line} must be <= end line ${endResolved.line} (anchors ${edit.start.hash} and ${edit.end.hash}).`,
					);
				}
				const endLine = endResolved.line;
				const nextLine = fileLines[endLine];
				const replacementLastLine = edit.lines.at(-1)?.trim();
				if (
					nextLine !== undefined &&
					replacementLastLine &&
					/[\p{L}\p{N}]/u.test(replacementLastLine) &&
					replacementLastLine === nextLine.trim()
				) {
					const resolvedEdit: ResolvedHashlineEdit = {
						op: "replace",
						start: startResolved,
						end: endResolved,
						lines: edit.lines,
					};
					warnings.push(
						`Potential boundary duplication after ${describeEdit(resolvedEdit)}: the replacement ends with a line that matches the next surviving line after trim.`,
					);
				}
				const prevLine = fileLines[startResolved.line - 2];
				const replacementFirstLine = edit.lines[0]?.trim();
				if (
					prevLine !== undefined &&
					replacementFirstLine &&
					/[\p{L}\p{N}]/u.test(replacementFirstLine) &&
					replacementFirstLine === prevLine.trim()
				) {
					const resolvedEdit: ResolvedHashlineEdit = {
						op: "replace",
						start: startResolved,
						end: endResolved,
						lines: edit.lines,
					};
					warnings.push(
						`Potential boundary duplication before ${describeEdit(resolvedEdit)}: the replacement starts with a line that matches the preceding surviving line after trim.`,
					);
				}
				resolved.push({
					op: "replace",
					start: startResolved,
					end: endResolved,
					lines: edit.lines,
				});
				break;
			}
			case "append": {
				let posResolved: ResolvedAnchor | undefined;
				if (edit.pos) {
					const r = tryResolve(edit.pos);
					if (!r) continue;
					posResolved = r;
				}
				if (edit.lines.length === 0) {
					throw new Error(
						"[E_BAD_OP] Append with empty lines payload. Provide content to insert or remove the edit.",
					);
				}
				resolved.push({
					op: "append",
					...(posResolved ? { pos: posResolved } : {}),
					lines: edit.lines,
				});
				break;
			}
			case "prepend": {
				let posResolved: ResolvedAnchor | undefined;
				if (edit.pos) {
					const r = tryResolve(edit.pos);
					if (!r) continue;
					posResolved = r;
				}
				if (edit.lines.length === 0) {
					throw new Error(
						"[E_BAD_OP] Prepend with empty lines payload. Provide content to insert or remove the edit.",
					);
				}
				resolved.push({
					op: "prepend",
					...(posResolved ? { pos: posResolved } : {}),
					lines: edit.lines,
				});
				break;
			}
		}
	}

	return { resolved, mismatches };
}

// Re-export for apply module
export { maybeWarnSuspiciousUnicodeEscapePlaceholder };
