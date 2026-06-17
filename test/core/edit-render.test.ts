import { describe, expect, it } from "vitest";
import {
	formatEditCall,
	formatPreviewDiff,
	formatResultDiff,
	colorDiffLines,
	getRenderedEditTextContent,
	extractRenderedWarnings,
	isAppliedChangedResult,
	buildAppliedChangedResultText,
	formatRenderedEditResultMarkdown,
	type ReplacePreview,
	type ReplaceRenderState,
	type FgTheme,
} from "../../src/replace-render";
import type { HashlineReplaceToolDetails } from "../../src/replace";

// Mock theme for testing
const mockTheme: FgTheme = {
	fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
};

const mockFullTheme = {
	...mockTheme,
	bold: (text: string) => `**${text}**`,
	italic: (text: string) => `*${text}*`,
	underline: (text: string) => `_${text}_`,
	strikethrough: (text: string) => `~${text}~`,
};

describe("colorDiffLines", () => {
	it("colors addition lines with success", () => {
		const lines = ["+added line", "context line", "-removed line"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toBe("[success]+added line[/success]");
		expect(result[1]).toBe("[dim]context line[/dim]");
		expect(result[2]).toBe("[error]-removed line[/error]");
	});

	it("does not color +++ or --- markers", () => {
		const lines = ["+++ header", "--- header"];
		const result = colorDiffLines(lines, mockTheme);
		expect(result[0]).toBe("[dim]+++ header[/dim]");
		expect(result[1]).toBe("[dim]--- header[/dim]");
	});
});

describe("formatPreviewDiff", () => {
	it("formats diff with truncation when not expanded", () => {
		const lines = Array.from({ length: 30 }, (_, i) => ` line${i}`);
		const diff = lines.join("\n");
		const result = formatPreviewDiff(diff, false, mockTheme);
		expect(result).toContain("...");
		expect(result).toContain("more diff lines");
	});

	it("shows more lines when expanded", () => {
		const lines = Array.from({ length: 30 }, (_, i) => ` line${i}`);
		const diff = lines.join("\n");
		const result = formatPreviewDiff(diff, true, mockTheme);
		expect(result).not.toContain("...");
	});
});

describe("formatResultDiff", () => {
	it("colors the entire diff", () => {
		const diff = "+added\n-removed\n context";
		const result = formatResultDiff(diff, mockTheme);
		expect(result).toContain("[success]+added[/success]");
		expect(result).toContain("[error]-removed[/error]");
		expect(result).toContain("[dim] context[/dim]");
	});
});

describe("formatEditCall", () => {
	it("formats edit call with path", () => {
		const args = { path: "src/main.ts", edits: [] };
		const state: ReplaceRenderState = {};
		const result = formatEditCall(args, state, false, mockFullTheme);
		expect(result).toContain("replace");
		expect(result).toContain("src/main.ts");
	});

	it("shows placeholder when no path", () => {
		const state: ReplaceRenderState = {};
		const result = formatEditCall(undefined, state, false, mockFullTheme);
		expect(result).toContain("replace");
		expect(result).toContain("...");
	});

	it("shows error preview", () => {
		const args = { path: "src/main.ts", edits: [] };
		const state: ReplaceRenderState = {
			preview: { error: "File not found" },
		};
		const result = formatEditCall(args, state, false, mockFullTheme);
		expect(result).toContain("File not found");
	});

	it("shows diff preview when available", () => {
		const args = { path: "src/main.ts", edits: [] };
		const state: ReplaceRenderState = {
			preview: { diff: "+added\n-removed" },
		};
		const result = formatEditCall(args, state, false, mockFullTheme);
		expect(result).toContain("+added");
	});
});

describe("getRenderedEditTextContent", () => {
	it("extracts text content from result", () => {
		const result = {
			content: [
				{ type: "text", text: "Hello world" },
				{ type: "image", url: "test.png" },
			],
		};
		expect(getRenderedEditTextContent(result)).toBe("Hello world");
	});

	it("returns undefined when no text content", () => {
		const result = {
			content: [{ type: "image", url: "test.png" }],
		};
		expect(getRenderedEditTextContent(result)).toBeUndefined();
	});

	it("returns undefined when content is missing", () => {
		expect(getRenderedEditTextContent({})).toBeUndefined();
	});
});

describe("extractRenderedWarnings", () => {
	it("extracts warnings block from text", () => {
		const text = "Some content\n\nWarnings:\nWarning 1\nWarning 2";
		const result = extractRenderedWarnings(text);
		expect(result).toContain("Warnings:");
		expect(result).toContain("Warning 1");
		expect(result).toContain("Warning 2");
	});

	it("returns undefined when no warnings", () => {
		const text = "Some content without warnings";
		expect(extractRenderedWarnings(text)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(extractRenderedWarnings(undefined)).toBeUndefined();
	});
});

describe("isAppliedChangedResult", () => {
	it("returns true for applied changed result", () => {
		const details: HashlineReplaceToolDetails = {
			diff: "+added",
			metrics: {
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 0,
				return_mode: "changed",
				classification: "applied",
				added_lines: 1,
				removed_lines: 0,
			},
		};
		expect(isAppliedChangedResult(details)).toBe(true);
	});

	it("returns false for noop result", () => {
		const details: HashlineReplaceToolDetails = {
			diff: "",
			classification: "noop",
		};
		expect(isAppliedChangedResult(details)).toBe(false);
	});

	it("returns false for full mode result", () => {
		const details: HashlineReplaceToolDetails = {
			diff: "+added",
			metrics: {
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 0,
				return_mode: "full",
				classification: "applied",
			},
		};
		expect(isAppliedChangedResult(details)).toBe(false);
	});

	it("returns false for undefined details", () => {
		expect(isAppliedChangedResult(undefined)).toBe(false);
	});
});

describe("formatRenderedEditResultMarkdown", () => {
	it("formats anchors block as code block", () => {
		const text = "--- Anchors ---\naB3x:line1\nMqXp:line2";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("#### Anchors");
		expect(result).toContain("```text");
		expect(result).toContain("aB3x:line1");
	});

	it("preserves plain text sections", () => {
		const text = "Updated file.ts\n\nSome other text";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("Updated file.ts");
		expect(result).toContain("Some other text");
	});

	it("handles multiple sections", () => {
		const text = "--- Anchors ---\naB3x:line1\n\nWarnings:\nTest warning";
		const result = formatRenderedEditResultMarkdown(text);
		expect(result).toContain("#### Anchors");
		expect(result).toContain("Warnings:");
	});

	it("handles empty text", () => {
		const result = formatRenderedEditResultMarkdown("");
		expect(result).toBe("");
	});
});

describe("buildAppliedChangedResultText", () => {
	it("builds text with diff when different from preview", () => {
		const text = "--- Anchors ---\naB3x:line1";
		const details: HashlineReplaceToolDetails = {
			diff: "+new line\n-old line",
			metrics: {
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 0,
				return_mode: "changed",
				classification: "applied",
				added_lines: 1,
				removed_lines: 1,
			},
		};
		const preview: ReplacePreview = { diff: "different diff" };
		const result = buildAppliedChangedResultText(text, details, preview, mockTheme);
		expect(result).toContain("+new line");
		expect(result).toContain("-old line");
	});

	it("returns undefined when no diff and no warnings", () => {
		const text = "--- Anchors ---\naB3x:line1";
		const details: HashlineReplaceToolDetails = {
			diff: "",
			metrics: {
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 0,
				return_mode: "changed",
				classification: "applied",
				added_lines: 0,
				removed_lines: 0,
			},
		};
		const result = buildAppliedChangedResultText(text, details, undefined, mockTheme);
		expect(result).toBeUndefined();
	});

	it("includes warnings when present", () => {
		const text = "--- Anchors ---\naB3x:line1\n\nWarnings:\nTest warning";
		const details: HashlineReplaceToolDetails = {
			diff: "",
			metrics: {
				edits_attempted: 1,
				edits_noop: 0,
				warnings: 1,
				return_mode: "changed",
				classification: "applied",
				added_lines: 0,
				removed_lines: 0,
			},
		};
		const result = buildAppliedChangedResultText(text, details, undefined, mockTheme);
		expect(result).toContain("Test warning");
	});
});
