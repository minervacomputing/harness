// What the API answers when it refuses: a code, with its status. A code names one meaning and always has the
// same status; its text may vary. Every code the Worker can send is here, so the contract declares them all
// (errors.ts) and a declared error means our server answered.

export const REFUSALS = {
  // Any request.
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_SERVER_ERROR: 500,
  // Bodies and query strings.
  INVALID_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  // Connections and their access.
  INVALID_RESOURCE_ID: 422,
  INVALID_CURSOR: 422,
  RECONNECT_NEEDED: 502,
  PROVIDER_FAILED: 502,
  // Messages and run starts.
  EMPTY_MESSAGE: 400,
  CONVERSATION_BUSY: 409,
  TOO_MANY_ATTACHMENTS: 400,
  ATTACHED_TWICE: 400,
  ATTACHMENT_UNAVAILABLE: 400,
  INVALID_ATTACHMENTS: 400,
  FOLDER_FULL: 413,
  // Uploads.
  WORKSPACE_FULL: 413,
} as const

export type RefusalCode = keyof typeof REFUSALS
