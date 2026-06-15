
import { throwIfAborted } from "../runtime";
import { computeLineHashes } from "./hash";
import {
	validateAnchorEdits,
	assertNoBareHashPrefixLines,
	maybeWarnSuspiciousUnicodeEscapePlaceholder,
	formatMismatchError,
	type ResolvedHashlineEdit,
	type NoopEdit,
	type HashlineEdit,
} from "./resolve";


type LineIndex = {
	fileLines: string[];
	lineStarts: number[];
	hasTerminalNewline: boolean;
};

export function buildLineIndex(content: string): LineIndex {
	const fileLines = content.split("\n");
	const lineStarts: number[] = [];
	let offset = 0;

	for (let index = 0; index < fileLines.length; index++) {
		lineStarts.push(offset);
		offset += fileLines[index]!.length;
		if (index < fileLines.length - 1) {
			offset += 1;
		}
	}

	return {
		fileLines,
		lineStarts,
		hasTerminalNewline: content.endsWith("\n"),
	};
}


type ResolvedEditSpan = {
	kind: "replace" | "insert";
	index: number;
	label: string;
	start: number;
	end: number;
	replacement: string;
	boundary?: number;
	insertMode?: "append-empty-origin" | "prepend-empty-origin";
};

function assertDoesNotEmptyFile(originalContent: string, result: string): void {
	if (originalContent.length > 0 && result.length === 0) {
		throw new Error(
			"[E_WOULD_EMPTY] Cannot empty a non-empty file via edit."
		);
	}
}

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

function throwEditConflict(
	left: { index: number; label: string },
	right: { index: number; label: string },
	reason: string,
): never {
	throw new Error(
		`[E_EDIT_CONFLICT] Edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}.`
	);
}

function computeInsertionBoundary(
	edit: Extract<ResolvedHashlineEdit, { op: "append" | "prepend" }>,
	lineIndex: LineIndex,
): number {
	switch (edit.op) {
		case "append": {
			const fileLineCount = lineIndex.fileLines.length;
			const eofBoundary =
				lineIndex.hasTerminalNewline && fileLineCount > 0
					? fileLineCount - 1
					: fileLineCount;
			return edit.pos
				? lineIndex.hasTerminalNewline && edit.pos.line === fileLineCount
					? eofBoundary
					: edit.pos.line
				: eofBoundary;
		}
		case "prepend":
			return edit.pos ? edit.pos.line - 1 : 0;
	}
}

function resolveEditToSpan(
	edit: ResolvedHashlineEdit,
	index: number,
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
	const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

	switch (edit.op) {
		case "replace": {
			const startLine = edit.start.line;
			const endLine = edit.end.line;
			const originalLines = fileLines.slice(startLine - 1, endLine);
			if (
				originalLines.length === edit.lines.length &&
				originalLines.every(
					(line, lineIndex) => line === edit.lines[lineIndex],
				)
			) {
				noopEdits.push({
					editIndex: index,
					loc: edit.start.hash,
					currentContent: originalLines.join("\n"),
				});
				return null;
			}

			if (edit.lines.length > 0) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
					replacement: edit.lines.join("\n"),
				};
			}

			if (startLine === 1 && endLine === fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: 0,
					end: content.length,
					replacement: "",
				};
			}

			if (endLine < fileLines.length) {
				return {
					kind: "replace",
					index,
					label: describeEdit(edit),
					start: lineStarts[startLine - 1]!,
					end: lineStarts[endLine]!,
					replacement: "",
				};
			}

			return {
				kind: "replace",
				index,
				label: describeEdit(edit),
				start: Math.max(0, lineStarts[startLine - 1]! - 1),
				end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
				replacement: "",
			};
		}
		case "append": {
			if (edit.lines.length === 0) {
				noopEdits.push({
					editIndex: index,
					loc: edit.pos ? edit.pos.hash : "EOF",
					currentContent: edit.pos
						? (fileLines[edit.pos.line - 1] ?? "")
						: "",
				});
				return null;
			}

			const insertedText = edit.lines.join("\n");
			if (content.length === 0) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: 0,
					end: 0,
					replacement: insertedText,
					boundary: computeInsertionBoundary(edit, lineIndex),
					insertMode: "append-empty-origin",
				};
			}

			if (!edit.pos) {
				return {
					kind: "insert",
					index,
					label: describeEdit(edit),
					start: content.length,
					end: content.length,
					replacement: hasTerminalNewline
						? `${insertedText}\n`
						: `\n${insertedText}`,
					boundary: computeInsertionBoundary(edit, lineIndex),
				};
			}

			const isSentinelAppend =
				hasTerminalNewline && edit.pos.line === fileLines.length;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start: isSentinelAppend
					? content.length
					: lineStarts[edit.pos.line - 1]! +
						fileLines[edit.pos.line - 1]!.length,
				end: isSentinelAppend
					? content.length
					: lineStarts[edit.pos.line - 1]! +
						fileLines[edit.pos.line - 1]!.length,
				replacement: isSentinelAppend
					? `${insertedText}\n`
					: `\n${insertedText}`,
				boundary: computeInsertionBoundary(edit, lineIndex),
			};
		}
		case "prepend": {
			if (edit.lines.length === 0) {
				noopEdits.push({
					editIndex: index,
					loc: edit.pos ? edit.pos.hash : "BOF",
					currentContent: edit.pos
						? (fileLines[edit.pos.line - 1] ?? "")
						: "",
				});
				return null;
			}
			const insertedText = edit.lines.join("\n");
			const start = edit.pos ? lineStarts[edit.pos.line - 1]! : 0;
			return {
				kind: "insert",
				index,
				label: describeEdit(edit),
				start,
				end: start,
				replacement:
					content.length === 0 ? insertedText : `${insertedText}\n`,
				boundary: computeInsertionBoundary(edit, lineIndex),
				...(content.length === 0
					? { insertMode: "prepend-empty-origin" as const }
					: {}),
			};
		}
	}
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
	for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
		const left = spans[leftIndex]!;
		for (
			let rightIndex = leftIndex + 1;
			rightIndex < spans.length;
			rightIndex++
		) {
			const right = spans[rightIndex]!;

			if (left.kind === "insert" && right.kind === "insert") {
				if (left.boundary === right.boundary) {
					throwEditConflict(
						left,
						right,
						"target the same insertion boundary",
					);
				}
				continue;
			}

			if (left.kind === "replace" && right.kind === "replace") {
				if (left.start < right.end && right.start < left.end) {
					throwEditConflict(
						left,
						right,
						"overlap on the same original line range",
					);
				}
				continue;
			}

			const replaceSpan = left.kind === "replace" ? left : right;
			const insertSpan = left.kind === "insert" ? left : right;
			if (
				insertSpan.start >= replaceSpan.start &&
				insertSpan.start < replaceSpan.end
			) {
				throwEditConflict(
					left,
					right,
					"cannot be applied together because one inserts inside a replaced original range",
				);
			}
		}
	}
}

function resolveEditSpans(
	edits: ResolvedHashlineEdit[],
	content: string,
	lineIndex: LineIndex,
	noopEdits: NoopEdit[],
	signal: AbortSignal | undefined,
): ResolvedEditSpan[] {
	const seenSpanKeys = new Set<string>();
	const resolvedSpans: ResolvedEditSpan[] = [];
	for (const [index, edit] of edits.entries()) {
		throwIfAborted(signal);
		const span = resolveEditToSpan(
			edit,
			index,
			content,
			lineIndex,
			noopEdits,
		);
		if (!span) {
			continue;
		}

		const spanKey =
			span.kind === "insert"
				? `insert:${span.boundary}:${span.replacement}`
				: `replace:${span.start}:${span.end}:${span.replacement}`;
		if (seenSpanKeys.has(spanKey)) {
			continue;
		}
		seenSpanKeys.add(spanKey);
		resolvedSpans.push(span);
	}

	assertNoConflictingSpans(resolvedSpans);

	return [...resolvedSpans].sort((left, right) => {
		if (right.end !== left.end) {
			return right.end - left.end;
		}
		if (left.kind !== right.kind) {
			return left.kind === "replace" ? -1 : 1;
		}
		if (left.kind === "insert" && right.kind === "insert") {
			return (
				(right.boundary ?? -1) - (left.boundary ?? -1) ||
				left.index - right.index
			);
		}
		return left.index - right.index;
	});
}

function assembleEditResult(
	content: string,
	spans: ResolvedEditSpan[],
	signal: AbortSignal | undefined,
): string {
	let result = content;
	for (const span of spans) {
		throwIfAborted(signal);
		const replacement =
			span.insertMode === "append-empty-origin"
				? result.length === 0
					? span.replacement
					: `\n${span.replacement}`
				: span.insertMode === "prepend-empty-origin"
					? result.length === 0
						? span.replacement
						: `${span.replacement}\n`
					: span.replacement;
		result =
			result.slice(0, span.start) + replacement + result.slice(span.end);
	}
	return result;
}


export function applyHashlineEdits(
	content: string,
	edits: import("./resolve").HashlineEdit[],
	signal?: AbortSignal,
	precomputedHashes?: string[],
	filePath?: string,
): {
	content: string;
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	warnings?: string[];
	noopEdits?: NoopEdit[];
} {
	throwIfAborted(signal);
	if (!edits.length)
		return {
			content,
			firstChangedLine: undefined,
			lastChangedLine: undefined,
		};

	// Normalize lines: [""] to lines: [] for deletion.
	edits = edits.map((edit) =>
		edit.op === "replace" &&
		edit.lines.length === 1 &&
		edit.lines[0] === ""
			? { ...edit, lines: [] }
			: edit,
	);

	const lineIndex = buildLineIndex(content);
	const fileHashes = precomputedHashes ?? computeLineHashes(content);
	const noopEdits: NoopEdit[] = [];
	const warnings: string[] = [];

	const { resolved, mismatches } = validateAnchorEdits(
		edits,
		lineIndex.fileLines,
		fileHashes,
		warnings,
		signal,
	);
	if (mismatches.length) {
		throw new Error(
			formatMismatchError(mismatches, lineIndex.fileLines, fileHashes),
		);
	}

	const barePrefixWarnings = assertNoBareHashPrefixLines(edits, lineIndex.fileLines, fileHashes, filePath);
	warnings.push(...barePrefixWarnings);
	maybeWarnSuspiciousUnicodeEscapePlaceholder(edits, warnings);

	const orderedSpans = resolveEditSpans(
		resolved,
		content,
		lineIndex,
		noopEdits,
		signal,
	);

	const result = assembleEditResult(content, orderedSpans, signal);
	assertDoesNotEmptyFile(content, result);
	const changedRange = computeChangedLineRange(content, result);

	return {
		content: result,
		firstChangedLine: changedRange?.firstChangedLine,
		lastChangedLine: changedRange?.lastChangedLine,
		...(warnings.length ? { warnings } : {}),
		...(noopEdits.length ? { noopEdits } : {}),
	};
}


const ANCHOR_CONTEXT_LINES = 2;
const ANCHOR_MAX_OUTPUT_LINES = 12;

export function computeAffectedLineRange(params: {
	firstChangedLine: number | undefined;
	lastChangedLine: number | undefined;
	resultLineCount: number;
	contextLines?: number;
	maxOutputLines?: number;
}): { start: number; end: number } | null {
	const {
		firstChangedLine,
		lastChangedLine,
		resultLineCount,
		contextLines = ANCHOR_CONTEXT_LINES,
		maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
	} = params;

	if (firstChangedLine === undefined || lastChangedLine === undefined) {
		return null;
	}

	if (resultLineCount === 0) {
		return null;
	}

	const start = Math.max(1, firstChangedLine - contextLines);
	const end = Math.min(resultLineCount, lastChangedLine + contextLines);

	if (end < start) {
		return null;
	}

	if (end - start + 1 > maxOutputLines) {
		return null;
	}

	return { start, end };
}

export function formatHashlineRegion(
	hashes: string[],
	lines: string[],
): string {
	if (hashes.length !== lines.length) {
		throw new Error(
			`formatHashlineRegion: hashes.length (${hashes.length}) must match lines.length (${lines.length}).`,
		);
	}
	return lines
		.map((line, index) => `${hashes[index]}│${line}`)
		.join("\n");
}


export function computeChangedLineRange(
	original: string,
	result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
	if (original === result) return null;

	function countVisibleLines(text: string): number {
		if (text.length === 0) {
			return 0;
		}
		const lines = text.split("\n");
		return text.endsWith("\n") ? lines.length - 1 : lines.length;
	}

	if (original.length === 0) {
		return {
			firstChangedLine: 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	if (result.startsWith(original) && original.endsWith("\n")) {
		return {
			firstChangedLine: countVisibleLines(original) + 1,
			lastChangedLine: countVisibleLines(result),
		};
	}

	let firstDiff = 0;
	const minLen = Math.min(original.length, result.length);
	while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
		firstDiff++;
	}
	if (firstDiff === minLen && original.length === result.length) return null;

	let lastOrig = original.length - 1;
	let lastRes = result.length - 1;
	while (
		lastOrig >= firstDiff &&
		lastRes >= firstDiff &&
		original[lastOrig] === result[lastRes]
	) {
		lastOrig--;
		lastRes--;
	}

	function indexToLine(charIdx: number, text: string): number {
		let line = 1;
		for (let i = 0; i < charIdx && i < text.length; i++) {
			if (text[i] === "\n") line++;
		}
		return line;
	}

	const firstChangedLine = indexToLine(firstDiff + 1, result);
	let lastChangedLine: number;
	if (lastRes < firstDiff) {
		lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
	} else if (
		firstDiff === 0 &&
		original.length > 0 &&
		result.endsWith(original)
	) {
		lastChangedLine = firstChangedLine;
	} else {
		lastChangedLine = indexToLine(lastRes + 1, result);
	}

	return { firstChangedLine, lastChangedLine };
}

