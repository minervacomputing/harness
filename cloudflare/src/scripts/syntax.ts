// The script's syntax, checked in the conversation before anything is loaded (plan: Code mode; spikes:
// code mode). The platform's loader reports a syntax error without a position ("Unexpected end of
// input"), and code such as `return 1 }\n…` would end the wrapper's function early and run the rest as
// module code, so acorn (8.19.0, MIT) parses the module the guest gets (scripts/prelude.ts) and requires its
// one function to end where the wrapper's does. A failure is reported with acorn's words and the code's own
// line and column, from a parse of the code alone where that fails too, since that position is the one the
// model wrote.

import { type Node, parse } from "acorn";
import { SCRIPT_PREFIX, SCRIPT_SUFFIX, scriptModule } from "./prelude.ts";

interface AcornError extends SyntaxError {
	loc?: { line: number; column: number };
}

const SCRIPT = { ecmaVersion: "latest", sourceType: "script", allowHashBang: false } as const;
const BODY = { ...SCRIPT, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true } as const;

/** What a script fails with: `SyntaxError: <message> (<line>:<column>)` as its stack. */
export interface SyntaxFailure {
	message: string;
	stack: string;
}

function failure(error: unknown, shift = 0): SyntaxFailure {
	const thrown = error as AcornError;
	const text = (thrown instanceof Error ? thrown.message : String(error)).replace(/ \(\d+:\d+\)$/, "");
	const loc = thrown?.loc;
	// On the first line the code follows the wrapper's prefix.
	const where = loc ? ` (${loc.line}:${loc.line === 1 ? Math.max(0, loc.column - shift) : loc.column})` : "";
	const message = `${text}${where}`;
	return { message, stack: `SyntaxError: ${message}` };
}

/** Null when the code is a complete function body, else what the script fails with. */
export function syntaxError(code: string): SyntaxFailure | null {
	const wrapped = scriptModule(code);
	let program: Node | null = null;
	let wrappedError: unknown = null;
	try {
		program = parse(wrapped, SCRIPT);
	} catch (error) {
		wrappedError = error;
	}
	if (program && isWholeFunction(program, code.length)) return null;
	try {
		parse(code, BODY);
	} catch (error) {
		return failure(error);
	}
	if (wrappedError) return failure(wrappedError, SCRIPT_PREFIX.length);
	return { message: "The code must be the body of one function.", stack: "SyntaxError: The code must be the body of one function." };
}

type Any = Node & { [key: string]: unknown };

/** `module.exports = function (…) { return async (tools, console) => {<code>\n}; };`, the arrow's block exactly the code's. */
function isWholeFunction(program: Node, codeLength: number): boolean {
	const body = (program as Any).body as Any[];
	if (body.length !== 1) return false;
	const statement = body[0] as Any;
	const assignment = statement.expression as Any | undefined;
	if (statement.type !== "ExpressionStatement" || assignment?.type !== "AssignmentExpression") return false;
	const factory = assignment.right as Any;
	if (factory.type !== "FunctionExpression" || factory.async === true) return false;
	const inner = (factory.body as Any).body as Any[];
	if (inner.length !== 1 || inner[0]?.type !== "ReturnStatement") return false;
	const arrow = inner[0].argument as Any | null;
	if (arrow?.type !== "ArrowFunctionExpression" || arrow.async !== true) return false;
	const block = arrow.body as Any;
	if (block.type !== "BlockStatement") return false;
	// The block opens at the prefix's last character and closes at the suffix's first "}".
	return block.start === SCRIPT_PREFIX.length - 1 && block.end === SCRIPT_PREFIX.length + codeLength + SCRIPT_SUFFIX.indexOf("}") + 1;
}
