// The JSON API's shapes are the frontend's: frontend/openapi.json, generated into
// frontend/src/api/types.gen.ts. Durable Objects return these where an endpoint passes their answer
// through, so the API keeps every field, enum value and limit (web-api 8, frontend 4).
//
// The request schemas (AgentIn, MessageIn, AccessChangesIn, …) are ported from Ninja's Pydantic models
// with lib/schema.ts's `str({min, max})`, which counts code points as `max_length` does (MessageIn's
// 20,000 characters, AgentIn's 120 and 8,000), and are read with http/body.ts's `readJson`.

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

/** `POST /api/workspaces/{ws}/uploads` answers 201 with this (web-api 10.5, files 9.1). */
export interface UploadOut {
	id: string;
	/** The cleaned name (files 9.2). */
	name: string;
	size: number;
	/** Sniffed from the first 8 KiB, for display only (files 9.3). */
	media_type: string;
}
