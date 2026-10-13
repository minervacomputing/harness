// `run_script`'s description (pi-codemode's, kept verbatim, since the model's use of it depends on it), with
// the differences this platform has, which it states (plan: Code mode): eval is not available and timers
// exist, computation is cut after 30 seconds, a guest may hold about 256 MB, and what a script printed
// since it last waited on a call or a timer is lost when it is stopped for either. The declarations are
// pi-codemode's rendering of the tools' schemas.

import { DEFAULT_INPUT_SCHEMA_MAX_CHARS, schemaToType, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import type { ToolDeclaration } from "../contracts/executor.ts";
import { CALLS_AT_ONCE, SCRIPT_CALLS_OPEN, SCRIPT_CPU_MS, SCRIPT_MEMORY_LABEL, SCRIPT_TIMEOUT_MS, STORE_BYTES } from "./limits.ts";

type CodemodeJsonSchema = Parameters<typeof schemaToType>[0];

/**
 * The tools as scripts see them. Every tool has the same result schema, so it is declared once as `Result`
 * instead of in each signature; only schemas with identical JSON share it.
 */
export function scriptDeclarations(tools: readonly ToolDeclaration[]): string {
	const shared = tools.find((tool) => tool.outputSchema)?.outputSchema;
	const members = tools.map((tool) => {
		const input = schemaToType(tool.inputSchema as CodemodeJsonSchema, { maxChars: DEFAULT_INPUT_SCHEMA_MAX_CHARS });
		const output =
			shared && JSON.stringify(tool.outputSchema) === JSON.stringify(shared)
				? "Result"
				: tool.outputSchema
					? schemaToType(tool.outputSchema as CodemodeJsonSchema)
					: "unknown";
		return `  ${toCodemodeIdentifier(tool.name)}(args: ${input}): Promise<${output}>;`;
	});
	const declared = `declare const tools: {\n${members.join("\n")}\n};`;
	return shared ? `type Result = ${schemaToType(shared as CodemodeJsonSchema)};\n\n${declared}` : declared;
}

/** The description, lines joined with "\n". */
export function scriptDescription(tools: readonly ToolDeclaration[]): string {
	return [
		"Run JavaScript that calls the tools declared below and returns a compact result.",
		"Prefer it for reads that page through long lists, repeat across many resources (each repository, calendar or database), or count, filter or total results. Start such reads inside the script, so their raw results never enter the conversation, and print only what the answer needs. Where you can, do the whole read in one script: list what you need, read each item and compute the answer. Call tools directly for one or two small reads whose results you want to see.",
		"The code is the body of an async function in a sandbox, so top-level await and return work. There is no network, file system or modules, and eval is not available. Timers exist, but `Date.now()` does not advance while the script computes.",
		"Call tools as `await tools.<name>(args)`. A call resolves to the object the tool returns and rejects with an Error when it fails or is refused.",
		"Await every call, for example with `await Promise.all(...)`: calls still running when the script ends are cancelled. A script that fails or stops does not undo the writes it made.",
		"Only what the script prints with `text(value)` or `console.log()`, and the value it returns, reach you. Tool results the script does not print do not.",
		"`count` is the number of items in that result, after leaving out what this run may not see, not a total. While a result has `next_cursor`, more items may follow, even after an empty page: call again with the same arguments plus `cursor: next_cursor`. `incomplete: true` means a provider or connector limit left something out; say so with any total. Item fields depend on the tool and are not declared. Rather than spending a script on looking at them, read the fields you expect, treat a missing one as unknown rather than empty, and also return the keys of one item, so a wrong guess shows in the same result.",
		`Each call is checked like a direct call. Up to ${CALLS_AT_ONCE} calls run at once, writes run one at a time, and at most ${SCRIPT_CALLS_OPEN} can wait, so start larger batches in parts.`,
		`A script stops after ${SCRIPT_TIMEOUT_MS / 1000} seconds, after ${SCRIPT_CPU_MS / 1000} seconds of computation, or sooner when the turn runs out of time, and it may use ${SCRIPT_MEMORY_LABEL} of memory; one stopped for computation or memory loses what it printed since it last waited on a tool call or a timer. \`store(key, value)\` and \`load(key)\` keep JSON values between scripts in this turn, up to ${STORE_BYTES / 1024 / 1024} MiB in all.`,
		"",
		"```js",
		"// Totals every page of a list; list_things stands for any tool with a cursor argument.",
		"const args = { /* the arguments of the list you want */ }",
		"let total = 0, incomplete = false, cursor",
		"do {",
		"  const page = await tools.list_things({ ...args, cursor })",
		"  total += page.count",
		"  if (page.incomplete) incomplete = true",
		"  cursor = page.next_cursor",
		"} while (cursor)",
		"return { total, incomplete }",
		"```",
		"",
		"```ts",
		scriptDeclarations(tools),
		"```",
	].join("\n");
}
