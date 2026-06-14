import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "fs/promises";
import { join, isAbsolute } from "path";
import { computeLineHashes, formatHashlineRegion } from "./src/hashline";
import { registerEditTool } from "./src/edit";
import { registerReadTool } from "./src/read";

export default function (pi: ExtensionAPI): void {
  registerReadTool(pi);
  registerEditTool(pi);

  // Auto-read after write: append hashline read output to write results
  // so the model immediately has anchors for subsequent edits.
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" || event.isError) return;

    const filePath = (event.input as Record<string, unknown>)?.path;
    if (typeof filePath !== "string") return;

    try {
      const absolutePath = isAbsolute(filePath) ? filePath : join(ctx.cwd, filePath);
      const content = await readFile(absolutePath, "utf-8");

      // Normalize and compute hashline output
      const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = normalized.split("\n");
      const visibleLines = normalized.endsWith("\n") ? lines.slice(0, -1) : lines;

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
