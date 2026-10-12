// Provider responses read as Pydantic reads them into the Atlassian connectors' models (BaseModel in lax
// mode, `extra="ignore"`), so the same answers are accepted and refused: what does not fit is the
// provider's unexpected response. Not for tool inputs, which are strict (lib/schema.ts).
//
// - Fields are found by their camelCase alias first (`alias_generator=to_camel`), then by their own name
//   (`populate_by_name=True`); an alias present with null is null.
// - `str` takes strings only; `int` also takes a bool, an integral number and a decimal string (with spaces
//   around, underscores between digits and a fraction of at least one zero); `bool` also takes 0 and 1 and
//   the words Pydantic knows, in any ASCII case; a list takes an array; a nested model takes an object.
//   Checked against the models themselves (generate.py `models`).

import { z } from "zod";
import { laxBoolValue, laxIntValue } from "../../lib/lax.ts";

export { model } from "../../lib/lax.ts";

/** Pydantic's lax `int` (lib/lax.ts); Pydantic's ints are 64-bit when they come from a float. */
export const laxInt = z.preprocess((value) => laxIntValue(value, 2 ** 63) ?? Number.NaN, z.number());

/** Pydantic's lax `bool` (lib/lax.ts). */
export const laxBool = z.preprocess((value) => laxBoolValue(value) ?? value, z.boolean());

/** `str | None = None`. */
export const optionalStr = z.string().nullable().default(null);
