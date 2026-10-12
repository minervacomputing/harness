// The RpcTarget a command's output comes back through (contracts/sandbox.ts ExecOutputSink): made in the
// calling object for each command and passed to the Sandbox's `exec`, which calls it as output arrives.

import { RpcTarget } from "cloudflare:workers";
import type { ExecOutputSink } from "../contracts/sandbox.ts";
import type { Delivered } from "./output.ts";

export class OutputSink extends RpcTarget implements ExecOutputSink {
	readonly #output: (chunk: Delivered) => void;

	constructor(output: (chunk: Delivered) => void) {
		super();
		this.#output = output;
	}

	output(chunk: Delivered): void {
		this.#output(chunk);
	}
}

export function outputSink(output: (chunk: Delivered) => void): ExecOutputSink {
	return new OutputSink(output);
}
