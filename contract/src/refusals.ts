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
  // Agents.
  CANNOT_CHANGE_AGENT: 403,
  CHOOSE_CONNECTIONS: 422,
  KEEP_ONE_AGENT: 422,
  // Connections and their access.
  UNKNOWN_PROVIDER: 404,
  WORKSPACE_ADMINS_ONLY: 403,
  WRONG_CONNECTION_METHOD: 422,
  CONNECTION_REMOVED: 422,
  DIFFERENT_ACCOUNT: 422,
  ALREADY_CONNECTED: 422,
  INVALID_ACCESS_CHANGE: 422,
  INVALID_RESOURCE_ID: 422,
  INVALID_CURSOR: 422,
  RECONNECT_NEEDED: 502,
  PROVIDER_FAILED: 502,
  // Messages and run starts.
  IDEMPOTENCY_KEY_REUSED: 422,
  EMPTY_MESSAGE: 400,
  CONVERSATION_BUSY: 409,
  RUN_STOPPED: 409,
  /** The start failed and left nothing behind: the message may be sent again. */
  START_FAILED: 503,
  TOO_MANY_ATTACHMENTS: 400,
  ATTACHED_TWICE: 400,
  ATTACHMENT_UNAVAILABLE: 400,
  INVALID_ATTACHMENTS: 400,
  FOLDER_FULL: 413,
  // Uploads.
  TOO_MANY_UPLOADS_AT_ONCE: 429,
  TOO_MANY_UPLOADS_WAITING: 429,
  WORKSPACE_FULL: 413,
} as const

export type RefusalCode = keyof typeof REFUSALS
