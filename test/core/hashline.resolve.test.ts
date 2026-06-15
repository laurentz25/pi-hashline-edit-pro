import { describe, expect, it } from "vitest";
import {
	resolveEditAnchors,
	type Anchor,
	type HashlineToolEdit,
} from "../../src/hashline";

describe("resolveEditAnchors", () => {
	it("resolves replace with start + end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", start: "#ZZPM", end: "#PPWV", lines: ["a", "b"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]!.op).toBe("replace");
		expect(resolved[0]).toHaveProperty("start");
		expect(resolved[0]).toHaveProperty("end");
	});

	it("resolves a 1-line replace (start == end)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", start: "#MQXV", end: "#MQXV", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved).toHaveLength(1);
		expect(resolved[0]!.op).toBe("replace");
		const r = resolved[0] as {
			op: "replace";
			start: Anchor;
			end: Anchor;
			lines: string[];
		};
		expect(r.start.hash).toBe("#MQXV");
		expect(r.end.hash).toBe("#MQXV");
	});

	it("rejects replace with end but no start", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", end: "#MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires a "start" anchor/i,
		);
	});

	it("throws on replace with no anchors", () => {
		const edits: HashlineToolEdit[] = [{ op: "replace", lines: ["new"] }];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires a "start" anchor/i,
		);
	});

	it("rejects replace with start but no end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", start: "#MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires an "end" anchor/i,
		);
	});

	it("rejects replace with the legacy 'pos' field", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", pos: "#MQXV", end: "#MQXV", lines: ["new"] } as any,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/uses "pos".*use "start"/i,
		);
	});

	it("throws on malformed pos for append (not silently degraded to EOF)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", pos: "garbage", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("throws on malformed pos for prepend (not silently degraded to BOF)", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", pos: "garbage", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("throws on malformed start for replace", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", start: "not-valid", end: "not-valid", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("throws on malformed end for replace with valid start", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "replace", start: "#MQXV", end: "garbage", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(/Invalid anchor/);
	});

	it("resolves append with pos", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", pos: "#MQXV", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0]!.op).toBe("append");
		const append = resolved[0] as {
			op: "append";
			pos?: Anchor;
			lines: string[];
		};
		expect(append.pos?.hash).toBe("#MQXV");
	});

	it("resolves append without pos (EOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "append", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0]!.op).toBe("append");
		const append = resolved[0] as {
			op: "append";
			pos?: Anchor;
			lines: string[];
		};
		expect(append.pos).toBeUndefined();
	});

	it("rejects append with end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "append", end: "#MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*append.*end/i,
		);
	});

	it("resolves prepend with pos", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", pos: "#MQXV", lines: ["new"] },
		];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0]!.op).toBe("prepend");
	});

	it("resolves prepend without pos (BOF)", () => {
		const edits: HashlineToolEdit[] = [{ op: "prepend", lines: ["new"] }];
		const resolved = resolveEditAnchors(edits);
		expect(resolved[0]!.op).toBe("prepend");
		const prepend = resolved[0] as {
			op: "prepend";
			pos?: Anchor;
			lines: string[];
		};
		expect(prepend.pos).toBeUndefined();
	});

	it("rejects prepend with end", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "prepend", end: "#MQXV", lines: ["new"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*prepend.*end/i,
		);
	});

	it("rejects string lines input", () => {
		const edits: HashlineToolEdit[] = [
			{
				op: "replace",
				start: "#ZZPM",
				end: "#ZZPM",
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
				op: "replace",
				start: "#ZZPM",
				end: "#ZZPM",
				lines: null,
			} as unknown as HashlineToolEdit,
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/lines" must be a string array/i,
		);
	});

	it("throws on unknown op", () => {
		const edits: HashlineToolEdit[] = [
			{ op: "something_weird", pos: "#ZZPM", lines: ["x"] },
		];
		expect(() => resolveEditAnchors(edits)).toThrow(
			/\[E_BAD_OP\].*unknown op.*something_weird/i,
		);
	});

	it("rejects missing op", () => {
		const edits = [{ pos: "#ZZPM", lines: ["x"] }] as any;
		expect(() => resolveEditAnchors(edits)).toThrow(
			/requires an "op" string/i,
		);
	});
});
