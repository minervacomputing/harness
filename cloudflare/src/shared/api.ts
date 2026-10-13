// The JSON API's shapes for connections and their access are still the frontend's: frontend/openapi.json,
// generated into frontend/src/api/types.gen.ts. Durable Objects return these where an endpoint passes their
// answer through, so the API keeps every field, enum value and limit.
//
// The request schemas are zod schemas read with api/input.ts's `readBody`. Agents, conversations, messages,
// runs and files are already the contract's (contract/); the rest move there resource by resource.

export type { AccessOut, ActionOut, AllowedOut, ConnectionOut, ConnectorOut, GrantOut, KindOut, ResourceOut } from "../../../frontend/src/api/types.gen.ts";
