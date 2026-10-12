// The contracts are types, so these tests are checked by `tsc` (pnpm typecheck); the runtime part only
// keeps vitest from reporting an empty file.

import { expect, test } from "vitest";
import type {
	ConversationApi,
	ConversationDetail,
	ConversationView,
	EventOut,
	PostedOut,
	PostedView,
	RunEvent,
	RunOut,
	RunView,
	SandboxApi,
	ScriptsApi,
	WorkspaceApi,
} from "../../src/contracts/index.ts";

/** The methods whose result Workers' RPC cannot carry (its types would turn them into `never`). */
type Unserializable<T> = {
	[K in keyof T]: T[K] extends (...args: never[]) => Promise<infer R> ? (R extends Rpc.Serializable<R> ? never : K) : K;
}[keyof T];

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

export type SandboxIsRpcSafe = Assert<IsNever<Unserializable<SandboxApi>>>;
export type WorkspaceIsRpcSafe = Assert<IsNever<Unserializable<WorkspaceApi>>>;
export type ConversationIsRpcSafe = Assert<IsNever<Unserializable<ConversationApi>>>;
export type ScriptsAreRpcSafe = Assert<IsNever<Unserializable<ScriptsApi>>>;

/** What the API answers passes through unchanged: the typed views are the generated shapes. */
export type ViewsAreApiShapes = [
	Assert<RunEvent extends EventOut ? true : false>,
	Assert<RunView extends RunOut ? true : false>,
	Assert<ConversationView extends ConversationDetail ? true : false>,
	Assert<PostedView extends PostedOut ? true : false>,
];

test("contracts are checked by tsc", () => {
	expect(true).toBe(true);
});
