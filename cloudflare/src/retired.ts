// Classes the build keeps exporting with no code and no binding until 13c replaces them with deleted-class tombstones
// (docs/plans/chunk-13b-design.md): deployed instances still have their objects, and a deploy that dropped an export would
// change the namespaces, which `scripts/reset.ts` refuses.

import { DurableObject } from "cloudflare:workers";

/** Ends a leftover Workspace object's outbox, refresh or purge alarm quietly. */
export class Workspace extends DurableObject {
	alarm(): void {}
}

/** The test build's retired mailbox. */
export class FaultMailbox extends DurableObject {}
