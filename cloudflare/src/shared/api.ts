// The JSON API's shapes are the frontend's: frontend/openapi.json, generated into
// frontend/src/api/types.gen.ts. Durable Objects return these where an endpoint passes their answer
// through, so the API keeps every field, enum value and limit.
//
// The request schemas (MessageIn, …) are zod schemas read with api/input.ts's `readBody`. The agents' shapes
// are already the contract's (contract/, `Agent` and `NewAgent`); the rest move there resource by resource.

export type {
	AccessOut,
	ActionOut,
	AllowedOut,
	AttachmentOut,
	ConnectionOut,
	ConnectorOut,
	ConversationDetail,
	ConversationOut,
	FolderChangesOut,
	FolderOut,
	FolderWarningsOut,
	GrantOut,
	KindOut,
	MessageIn,
	MessageOut,
	ResourceOut,
	RunOut,
} from "../../../frontend/src/api/types.gen.ts";

/** `POST /api/workspaces/{ws}/uploads` answers 201 with this. */
export interface UploadOut {
	id: string;
	/** The cleaned name. */
	name: string;
	size: number;
	/** Sniffed from the first 8 KiB, for display only. */
	media_type: string;
}
