/**
 * Single normalization layer that maps the dialects a model may emit onto the
 * canonical hashline edit request before validation runs.
 *
 * The only dialect we still absorb is the `file_path` → `path` alias and the
 * JSON-stringified `edits` array. Pi's native legacy `oldText`/`newText`
 * shape (whether top-level or as `op: "replace_text"`) is no longer
 * supported: the hashline protocol requires hash-anchored edits, and the
 * legacy text-matching path is what produces the
 * `[E_NO_MATCH] replace_text found no exact unique match` failure mode the
 * model hits on whitespace/Unicode drift. Any model that still emits the
 * legacy shape is rejected with a clear error in `assertEditItem` /
 * `assertEditRequest` so it learns the correct shape on the next turn.
 *
 * This runs as the tool's `prepareArguments` hook, which Pi executes before AJV
 * schema validation and before `execute()`. The output is plain enumerable data
 * (an `edits` array), so Pi's `structuredClone` of prepareArguments output keeps
 * every field.
 */

import { isRecord, hasOwn } from "./utils";

/**
 * Parse `edits` when a model serializes it as a JSON string instead of an array
 * (observed with some models, mirrors Pi's built-in edit handling).
 */
function coerceEditsArray(edits: unknown): unknown {
	if (typeof edits !== "string") {
		return edits;
	}
	try {
		const parsed: unknown = JSON.parse(edits);
		return Array.isArray(parsed) ? parsed : edits;
	} catch {
		return edits;
	}
}


/**
 * Normalize a raw edit-tool request into the canonical hashline shape.
 *
 * Returns the input unchanged when it is not an object, so malformed payloads
 * still reach validation and surface a precise error there.
 */
export function normalizeEditRequest(input: unknown): unknown {
	if (!isRecord(input)) {
		return input;
	}

	const record: Record<string, unknown> = { ...input };

	// file_path → path alias.
	if (typeof record.path !== "string" && typeof record.file_path === "string") {
		record.path = record.file_path;
		delete record.file_path;
	}

	const hasEditsField = hasOwn(record, "edits");

	// edits-as-JSON-string → array.
	if (hasEditsField) {
		record.edits = coerceEditsArray(record.edits);
	}

	return record;
}

