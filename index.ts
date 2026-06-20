import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { Box, Image, type ImageTheme, Spacer, Text } from "@earendil-works/pi-tui";
import { readFile } from "fs/promises";
import { access as fsAccess, constants } from "fs/promises";
import { join, isAbsolute } from "path";
import { computeLineHashes, formatHashlineRegion } from "./src/hashline";
import { registerReplaceTool } from "./src/replace";
import { registerReadTool, formatHashlineReadPreview } from "./src/read";
import { normalizeToLF, stripBom } from "./src/replace-diff";
import { loadFileKindAndText } from "./src/file-kind";
import { resolveToCwd } from "./src/path-utils";
import { getVisibleLines } from "./src/utils";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerReplaceTool(pi);

  // ── Custom message renderer for "read" type ──
  // For images: renders an Image component (same approach as built-in read tool).
  // For text: returns undefined so CustomMessageComponent falls back to Markdown.
  pi.registerMessageRenderer("read", (message, options, theme) => {
    const path = ((message.details as { path?: string } | undefined)?.path) ?? "";

    // Collapsed: show just [read] path — matches ctrl+o toggle behavior
    if (!options.expanded) {
      const label = theme.fg("customMessageLabel", `\x1b[1m[read]\x1b[22m`);
      const pathStr = theme.fg("customMessageText", path || "<file>");
      return new Text(`${label} ${pathStr}`, 0, 0);
    }

    // Expanded: extract image from content array
    const contentArr = Array.isArray(message.content) ? message.content : [];
    const imagePart = contentArr.find(
      (c): c is { type: "image"; data: string; mimeType: string } => c.type === "image",
    );
    if (!imagePart) {
      // Text file — fall through to default Markdown rendering
      return undefined;
    }

    // Image file: text note + Image component
    const textNote = contentArr
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const container = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

    const label = theme.fg("customMessageLabel", `\x1b[1m[read]\x1b[22m`);
    container.addChild(new Text(label, 0, 0));
    container.addChild(new Spacer(1));

    if (textNote) {
      container.addChild(new Text(textNote, 0, 0));
      container.addChild(new Spacer(1));
    }

    const imgTheme: ImageTheme = {
      fallbackColor: (s) => theme.fg("toolOutput", s),
    };
    container.addChild(new Image(imagePart.data, imagePart.mimeType, imgTheme));

    return container;
  });

  // ── /read command: read file with hashline anchors and add to chat ──
  pi.registerCommand("read", {
    description: "Read a file with hashline anchors and add to chat (usage: /read @<path>)",
    handler: async (args, ctx) => {
      const rawPath = args.trim().replace(/^@/, "");
      if (!rawPath) {
        ctx.ui.notify("Usage: /read @<path>", "warning");
        return;
      }

      const absolutePath = resolveToCwd(rawPath, ctx.cwd);

      // Check if file exists and is readable
      try {
        await fsAccess(absolutePath, constants.R_OK);
      } catch {
        ctx.ui.notify(`File not found: ${rawPath}`, "error");
        return;
      }

      // Classify file type — reuse the same detection as the read tool
      const file = await loadFileKindAndText(absolutePath);
      if (file.kind === "directory") {
        ctx.ui.notify(`Path is a directory: ${rawPath}`, "error");
        return;
      }
      if (file.kind === "binary") {
        ctx.ui.notify(`Binary file: ${rawPath} (${file.description})`, "error");
        return;
      }

      if (file.kind === "image") {
        // ── Image path: delegate to Pi's built-in read tool for ──
        // detection + resize, then store the base64 data in details
        // for the custom message renderer to display via Image TUI component.
        const builtinRead = createReadTool(ctx.cwd);
        const result = await builtinRead.execute("cmd_read", { path: rawPath }, ctx.signal);

        // Extract text note and image data from tool result
        const textParts: string[] = [];
        let imageData: string | undefined;
        let mimeType: string | undefined;
        for (const part of result.content) {
          if (part.type === "text") {
            textParts.push(part.text);
          } else if (part.type === "image") {
            imageData = part.data;
            mimeType = part.mimeType;
          }
        }

        // Include image data in content (TextContent | ImageContent)[] so
        // convertToLlm passes it to the LLM (not just TUI rendering).
        const annotation = textParts.join("\n").trim();
        const msgContent: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = [{ type: "text", text: `${rawPath}:\n${annotation}` }];
        if (imageData && mimeType) {
          msgContent.push({ type: "image", data: imageData, mimeType });
        }

        pi.sendMessage(
          {
            customType: "read",
            content: msgContent,
            display: true,
            details: { path: rawPath },
          },
          { triggerTurn: false },
        );
        return;
      }

      // ── Text path: hashline formatting ──
      const normalized = normalizeToLF(stripBom(file.text).text);
      const fileHashes = computeLineHashes(normalized);
      const preview = formatHashlineReadPreview(normalized, {}, fileHashes);

      const text =
        file.hadUtf8DecodeErrors === true
          ? `${preview.text}\n\n[Non-UTF-8 bytes shown as U+FFFD; editing rewrites the file as UTF-8.]`
          : preview.text;

      // Wrap in fenced code block to prevent Markdown from collapsing
      // lines or interpreting # / │ as formatting.
      const codeBlock = rawPath + ":\n```\n" + text + "\n```";

      pi.sendMessage(
        {
          customType: "read",
          content: codeBlock,
          display: true,
          details: { path: rawPath },
        },
        { triggerTurn: false },
      );
    },
  });

  // Disable the built-in `edit` tool so the model uses `replace` instead.
  pi.on("session_start", async (_event, ctx) => {
    const active = pi.getActiveTools();
    pi.setActiveTools(active.filter((t) => t !== "edit"));
  });

  // Auto-read after write state - controlled by PI_HASHLINE_AUTO_READ env var (default: disabled).
  // Can be toggled at runtime via /toggle-auto-read command.
  const autoReadValue = process.env.PI_HASHLINE_AUTO_READ;
  let autoReadEnabled = autoReadValue === "1" || autoReadValue === "true";

  // Register toggle-auto-read command
  pi.registerCommand("toggle-auto-read", {
    description: "Toggle automatic hashline anchors after write operations",
    handler: async (_args, ctx) => {
      autoReadEnabled = !autoReadEnabled;
      const state = autoReadEnabled ? "enabled" : "disabled";
      ctx.ui.notify(`Auto-read after write: ${state}`, "info");
    },
  });

  // Auto-read after write handler - always registered, but checks the flag
  pi.on("tool_result", async (event, ctx) => {
    if (!autoReadEnabled) return;
    if (event.toolName !== "write" || event.isError) return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const absolutePath = isAbsolute(filePath) ? filePath : join(ctx.cwd, filePath);
      const content = await readFile(absolutePath, "utf-8");

      // Normalize and compute hashline output
      const normalized = normalizeToLF(content);
      const visibleLines = getVisibleLines(normalized);

      if (visibleLines.length === 0) return;

      // Truncate to a reasonable limit to avoid excessive token usage
      const MAX_LINES = 2000;
      const truncated = visibleLines.length > MAX_LINES;
      const displayLines = truncated ? visibleLines.slice(0, MAX_LINES) : visibleLines;

      const hashes = computeLineHashes(normalized);
      const selectedHashes = hashes.slice(0, displayLines.length);
      const hashlineOutput = formatHashlineRegion(selectedHashes, displayLines);

      // Add pagination hint if truncated
      const paginationHint = truncated
        ? `\n\n[Showing lines 1-${MAX_LINES} of ${visibleLines.length}. Use offset=${MAX_LINES + 1} to continue.]`
        : "";

      if (hashlineOutput) {
        return {
          content: [
            ...(event.content ?? []),
            { type: "text", text: `\n\n--- Auto-read (hashline anchors) ---\n${hashlineOutput}${paginationHint}` },
          ],
        };
      }
    } catch {
      // Auto-read failure should not affect write result
    }
  });

  const debugValue = process.env.PI_HASHLINE_DEBUG;
  if (debugValue === "1" || debugValue === "true") {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("Hashline Edit mode active", "info");
    });
  }
}
