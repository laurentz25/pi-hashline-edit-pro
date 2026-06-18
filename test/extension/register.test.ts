import { describe, expect, it } from "vitest";
import register from "../../index";

describe("extension registration", () => {
  it("registers the read and replace tools", () => {
    const toolNames: string[] = [];
    const eventNames: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        toolNames.push(tool.name);
      },
      on(name: string) {
        eventNames.push(name);
      },
    } as any;

    register(pi);

    expect(toolNames.sort()).toEqual(["read", "replace"]);
		// tool_result is registered for auto-read-after-write behavior only when enabled
		expect(eventNames).toEqual(["session_start"]);
});
});
