// The JSON API's shapes are the frontend's: frontend/openapi.json, generated into
// frontend/src/api/types.gen.ts. Durable Objects return these where an endpoint passes their answer
// through, so the API keeps every field, enum value and limit.
//
// The request schemas (AgentIn, MessageIn, AccessChangesIn, …) are zod schemas read with
// api/input.ts's `readBody`.

export type {
	AccessChangesIn,
	AccessOut,
	ActionOut,
	AgentIn,
	AgentOut,
	AllowedOut,
	AttachmentOut,
	AuthorizeOut,
	ChangedFileOut,
	ChangeIn,
	ConnectionOut,
	ConnectorOut,
	ConversationDetail,
	ConversationOut,
	EventOut,
	FolderChangesOut,
	FolderFileOut,
	FolderOut,
	FolderWarningOut,
	FolderWarningsOut,
	GrantOut,
	KindOut,
	MeOut,
	MessageIn,
	MessageOut,
	PostedOut,
	ResourceOut,
	ResourcePageOut,
	RunOut,
	UserOut,
	WorkspaceOut,
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
