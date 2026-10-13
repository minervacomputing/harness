// Records for tool inputs. zod's `z.record` skips a "__proto__" key without a word (and would make a
// transformed key that becomes "__proto__" the result's prototype), so inputs use `record` instead: the
// same record, which refuses the keys "__proto__", "constructor" and "prototype" and limits how many
// keys it takes, both before any value is validated. gateway/registry.ts refuses `z.record` in inputs.

import { z } from "zod";
import * as core from "zod/v4/core";

/** Keys a record refuses rather than drops or assigns. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export interface RecordLimits {
	min?: number;
	max?: number;
}

type RecordDef = core.$ZodRecordDef & RecordLimits;

// An assertion function must be called through a name with an explicit type.
const ZodRecord: core.$constructor<z.ZodRecord> = z.ZodRecord;

const SafeRecord: core.$constructor<z.ZodRecord, RecordDef> = core.$constructor("MinervaRecord", (inst, def: RecordDef) => {
	ZodRecord.init(inst, def);
	const parse = inst._zod.parse;
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (typeof input !== "object" || input === null || Array.isArray(input)) return parse(payload, ctx);
		const keys = Object.keys(input);
		let refused = false;
		for (const key of keys.filter((key) => RESERVED_KEYS.has(key))) {
			payload.issues.push({ code: "custom", message: `The key "${key}" is not allowed`, path: [key], input, inst });
			refused = true;
		}
		if (def.max !== undefined && keys.length > def.max) {
			payload.issues.push({ code: "too_big", origin: "object", maximum: def.max, inclusive: true, message: `Too big: expected at most ${def.max} keys`, input, inst });
			refused = true;
		}
		if (def.min !== undefined && keys.length < def.min) {
			payload.issues.push({ code: "too_small", origin: "object", minimum: def.min, inclusive: true, message: `Too small: expected at least ${def.min} keys`, input, inst });
			refused = true;
		}
		return refused ? payload : parse(payload, ctx);
	};
	const process = inst._zod.processJSONSchema;
	inst._zod.processJSONSchema = (ctx, json, params) => {
		process?.(ctx, json, params);
		if (def.min !== undefined) json.minProperties = def.min;
		if (def.max !== undefined) json.maxProperties = def.max;
	};
});

/** A record of string keys and `value`s, with at least `min` and at most `max` keys. */
export function record<V extends z.ZodType>(value: V, limits: RecordLimits = {}): z.ZodRecord<z.ZodString, V> {
	return new SafeRecord({ type: "record", keyType: z.string(), valueType: value, ...limits }) as unknown as z.ZodRecord<z.ZodString, V>;
}

/** Whether a schema is `record`'s, rather than zod's own record. */
export function isRecord(schema: core.$ZodType): boolean {
	return schema instanceof SafeRecord;
}
