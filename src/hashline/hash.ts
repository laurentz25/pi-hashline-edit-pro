
import * as XXH from "xxhashjs";


export const HASH_LENGTH = 4;

export const HASH_PREFIX = "#";

export const ANCHOR_LENGTH = HASH_PREFIX.length + HASH_LENGTH;

const HASH_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HASH_ALPHABET_BITS = 6;
const HASH_ALPHABET_MASK = (1 << HASH_ALPHABET_BITS) - 1;
const HASH_ALPHABET_REGEX_SAFE = HASH_ALPHABET.replace(/-/g, "\\-");
const HASH_ALPHABET_RE = new RegExp(`^[${HASH_ALPHABET_REGEX_SAFE}]+$`);
export const HASH_CHARS_CLASS = `${HASH_PREFIX}[${HASH_ALPHABET_REGEX_SAFE}]{${HASH_LENGTH}}`;

function hashToString(h: number): string {
	const totalBits = HASH_LENGTH * HASH_ALPHABET_BITS;
	const shift = 32 - totalBits;
	let n = h >>> shift;
	let out = "";
	for (let j = 0; j < HASH_LENGTH; j++) {
		out +=
			HASH_ALPHABET[
				(n >>> ((HASH_LENGTH - 1 - j) * HASH_ALPHABET_BITS)) &
					HASH_ALPHABET_MASK
			]!;
	}
	return HASH_PREFIX + out;
}

export const HASHLINE_PREFIX_RE = new RegExp(
	`^\\s*(?:>>>|>>)?\\s*${HASH_CHARS_CLASS}:`,
);
export const HASHLINE_PREFIX_PLUS_RE = new RegExp(
	`^\\+\\s*${HASH_CHARS_CLASS}:`,
);
export const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

export const HASHLINE_BARE_PREFIX_RE = new RegExp(`^\\s*(${HASH_CHARS_CLASS}):`);

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
	return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

const SYMBOL_DISCRIMINATOR = (lineNumber: number): string => `S${lineNumber}`;
const CONTENT_DISCRIMINATOR = (occurrence: number): string => `C${occurrence}`;

function canonicalizeLine(line: string): string {
	return line.replace(/\r/g, "").trimEnd();
}

function isSymbolOnly(canonical: string): boolean {
	return !RE_SIGNIFICANT.test(canonical);
}

export function computeLineHashes(content: string): string[] {
	const lines = content.split("\n");
	const hashes = new Array<string>(lines.length);
	const counts = new Map<string, number>();
	for (let i = 0; i < lines.length; i++) {
		const lineNumber = i + 1;
		const canonical = canonicalizeLine(lines[i]!);
		let discriminator: string;
		if (isSymbolOnly(canonical)) {
			discriminator = SYMBOL_DISCRIMINATOR(lineNumber);
		} else {
			const occurrence = (counts.get(canonical) ?? 0) + 1;
			counts.set(canonical, occurrence);
			discriminator = CONTENT_DISCRIMINATOR(occurrence);
		}
		hashes[i] = hashToString(xxh32(`${discriminator}:${canonical}`));
	}
	return hashes;
}

export function computeLineHash(idx: number, line: string): string {
	const canonical = canonicalizeLine(line);
	const discriminator = isSymbolOnly(canonical)
		? SYMBOL_DISCRIMINATOR(idx)
		: CONTENT_DISCRIMINATOR(1);
	return hashToString(xxh32(`${discriminator}:${canonical}`));
}

export const HASH_FORMAT = {
	prefix: HASH_PREFIX,
	length: HASH_LENGTH,
	anchorLength: ANCHOR_LENGTH,
	bitsPerChar: HASH_ALPHABET_BITS,
	alphabet: HASH_ALPHABET,
};


export { HASH_ALPHABET_RE };
