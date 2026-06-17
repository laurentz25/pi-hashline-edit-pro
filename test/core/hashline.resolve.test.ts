import { describe, expect, it } from "vitest";
import {
	resolveEditAnchors,
	type Anchor,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("resolveEditAnchors", () => {
	it("resolves replace with start + end", () => {
		const edits: HashlineToolEdit[] = [
			{ start: "ZZPM", end: "PPWV", lines: ["a", "b"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]).toHaveProperty("start");
		expect(resolved[0]).toHaveProperty("end");
	});

	it("resolves a 1-line replace (start == end)", () => {
		const edits: HashlineToolEdit[] = [
			{ start: "MQXV", end: "MQXV", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		const r = resolved[0] as {
			start: Anchor;
			end: Anchor;
			lines: string[];
		};
		expect(r.start.hash).toBe("MQXV");
		expect(r.end.hash).toBe("MQXV");
	});

	it("rejects replace with end but no start", () => {
		const edits: HashlineToolEdit[] = [
			{ end: "MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires a "start" anchor/i,
		);
	});

	it("throws on replace with no anchors", () => {
		const edits: HashlineToolEdit[] = [{ lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires a "start" anchor/i,
		);
	});

	it("rejects replace with start but no end", () => {
		const edits: HashlineToolEdit[] = [
			{ start: "MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires an "end" anchor/i,
		);
	});

	it("throws on malformed start for replace", () => {
		const edits: HashlineToolEdit[] = [
			{ start: "not-valid", end: "not-valid", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("throws on malformed end for replace with valid start", () => {
		const edits: HashlineToolEdit[] = [
			{ start: "MQXV", end: "garbage", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("rejects string lines input", () => {
		const edits: HashlineToolEdit[] = [
			{
				start: "ZZPM",
				end: "ZZPM",
				lines: "hello\nworld\n",
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("rejects null lines input", () => {
		const edits: HashlineToolEdit[] = [
			{
				start: "ZZPM",
				end: "ZZPM",
				lines: null,
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("rejects unknown fields", () => {
		const edits = [{ start: "ZZPM", end: "ZZPM", lines: ["x"], extra: true }] as any;
		expect(() => resolveEditAnchors(edits)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing lines", () => {
		const edits = [{ start: "ZZPM", end: "ZZPM" }] as any;
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires a "lines" field/i,
		);
	});
});
