import { describe, expect, it } from "vitest";
import { readFile } from "fs/promises";
import Ajv from "ajv";
import {
	assertEditRequest,
	hashlineEditToolSchema,
	registerEditTool,
} from "../../src/edit";
import { computeLineHash } from "../../src/hashline";
import { makeFakePiRegistry, withTempFile } from "../support/fixtures";
import register from "../../index";

describe("assertEditRequest", () => {
	it("rejects unknown or unsupported root fields", () => {
		expect(() =>
			assertEditRequest({ path: "a.ts", legacy_field: [] } as any),
		).toThrow(/unknown or unsupported fields/i);
	});

	it("rejects top-level oldText/newText with E_LEGACY_SHAPE", () => {
		// The legacy native edit shape is no longer supported — hash-anchored
		// edits are the only path. The runtime throws a clear error pointing
		// the model to the right shape on the next turn.
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				oldText: "before",
				newText: "after",
			} as any),
		).toThrow(/E_LEGACY_SHAPE/);
	});

	it("rejects top-level old_text/new_text with E_LEGACY_SHAPE", () => {
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				old_text: "before",
				new_text: "after",
			} as any),
		).toThrow(/E_LEGACY_SHAPE/);
	});

	it("requires returnRanges when returnMode is ranges", () => {
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				returnMode: "ranges",
				edits: [{ op: "replace", start: "ZZPM", end: "ZZPM", lines: ["x"] }],
			} as any),
		).toThrow(/returnRanges/i);
	});

	it("rejects returnRanges outside ranges returnMode", () => {
		expect(() =>
			assertEditRequest({
				path: "a.ts",
				returnMode: "changed",
				returnRanges: [{ start: 1, end: 2 }],
				edits: [{ op: "replace", start: "ZZPM", end: "ZZPM", lines: ["x"] }],
			} as any),
		).toThrow(/returnRanges/i);
	});
});

describe("registerEditTool", () => {
	it("publishes a schema that validates strict hashline payloads", () => {
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile(hashlineEditToolSchema as any);

		expect(
			validate({
				path: "a.ts",
				edits: [{ op: "replace", start: "ZZPM", end: "ZZPM", lines: ["x"] }],
			}),
		).toBe(true);
	});

	it("publishes a schema with no legacy top-level text-replace fields", () => {
		const ajv = new Ajv({ allErrors: true });
		const validate = ajv.compile(hashlineEditToolSchema as any);

		// Legacy top-level fields are not part of the schema at all; AJV
		// rejects them as additional properties.
		expect(
			validate({ path: "a.ts", oldText: "before", newText: "after" }),
		).toBe(false);

		const props = (hashlineEditToolSchema as any).properties;
		expect(props.oldText).toBeUndefined();
		expect(props.newText).toBeUndefined();
		expect(props.old_text).toBeUndefined();
		expect(props.new_text).toBeUndefined();
	});

	it("publishes a top-level object schema for pi tool registration", () => {
		expect((hashlineEditToolSchema as any).type).toBe("object");
		expect((hashlineEditToolSchema as any).anyOf).toBeUndefined();
	});

	it("prepareArguments passes hash-anchored requests through unchanged", () => {
		let registered:
			| {
					parameters?: any;
					prepareArguments?: (args: unknown) => unknown;
			  }
			| undefined;
		const pi = {
			registerTool(tool: {
				parameters?: any;
				prepareArguments?: (args: unknown) => unknown;
			}) {
				registered = tool;
			},
		} as any;

		registerEditTool(pi);

		expect(registered?.parameters).toEqual(hashlineEditToolSchema);
		expect(typeof registered?.prepareArguments).toBe("function");

		// Hash-anchored requests pass through with no transformation. The
		// legacy top-level oldText/newText shape is NOT folded (the
		// normalization layer is gone) — those would now reach validation
		// and be rejected with E_LEGACY_SHAPE.
		const result = registered?.prepareArguments?.({
			path: "a.ts",
			edits: [{ op: "replace", start: "ZZPM", end: "ZZPM", lines: ["x"] }],
		});
		expect(result).toEqual({
			path: "a.ts",
			edits: [{ op: "replace", start: "ZZPM", end: "ZZPM", lines: ["x"] }],
		});
	});

	it("rejects malformed null lines during direct execute without modifying the file", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\n", async ({ cwd, path }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			await expect(
				editTool.execute(
					"e1",
					{
						path: "sample.txt",
						edits: [
							{
								op: "replace", start: `${computeLineHash(1, "aaa")}:aaa`, end: `${computeLineHash(1, "aaa")}:aaa`, lines: null,
							},
						],
					},
					undefined,
					undefined,
					{ cwd } as any,
				),
			).rejects.toThrow(/lines" must be a string array/i);

			expect(await readFile(path, "utf-8")).toBe("aaa\nbbb\n");
		});
	});

	it("validates direct execute path before resolving mutation target", async () => {
		const { pi, getTool } = makeFakePiRegistry();
		register(pi);
		const editTool = getTool("edit");

		await expect(
			editTool.execute(
				"e1",
				{ edits: [{ op: "append", lines: ["x"] }] },
				undefined,
				undefined,
				{ cwd: process.cwd() } as any,
			),
		).rejects.toThrow(/requires a non-empty "path" string/i);
	});

	it("renders details diff while keeping diff out of LLM-visible text", async () => {
		await withTempFile("sample.txt", "aaa\nbbb\nccc\n", async ({ cwd }) => {
			const { pi, getTool } = makeFakePiRegistry();
			register(pi);
			const editTool = getTool("edit");

			const editArgs = {
				path: "sample.txt",
				edits: [
					{
						op: "replace", start: computeLineHash(2, "bbb"), end: computeLineHash(2, "bbb"), lines: ["BBB"],
					},
				],
			};

			const result = await editTool.execute(
				"e1",
				editArgs,
				undefined,
				undefined,
				{ cwd } as any,
			);

			expect(typeof editTool.renderResult).toBe("function");

			const component = editTool.renderResult(
				result,
				{ expanded: false, isPartial: false },
				{
					bold: (text: string) => text,
					fg: (token: string, text: string) => `[${token}]${text}[/${token}]`,
				},
				{
					args: editArgs,
					isError: false,
					lastComponent: undefined,
				} as any,
			) as { render: (width: number) => string[] };

			const rendered = component.render(200).join("\n");

			expect(rendered).not.toContain("Changes: +1 -1");
			expect(rendered).not.toContain("Diff preview:");
			expect(rendered).not.toContain("```diff");
			expect(rendered).toContain(`+${computeLineHash(2, "BBB")}:BBB`);
			expect(rendered).not.toContain("Updated sample.txt");
			expect(rendered).not.toContain("```text");
		expect(result.details?.diff).toContain(`+${computeLineHash(2, "BBB")}`);
		});
	});
});
