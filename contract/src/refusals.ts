// What the API answers when it refuses: a code, with its status. A code names one meaning and always has the
// same status; its text may vary. Every code the Worker can send is here, so the contract declares them all
// (errors.ts) and a declared error means our server answered. Better Auth's routes answer in their own format.

export const REFUSALS = {
  // Any request.
  UNAUTHORIZED: 401,
  CROSS_SITE: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_SERVER_ERROR: 500,
  // Bodies and query strings.
  INVALID_JSON: 400,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  VALIDATION_FAILED: 422,
  // The signed-in user's own account.
  /** The account already has a password; it is changed with the current one, or reset by email code. */
  PASSWORD_ALREADY_SET: 409,
  // The instance's setup and administration.
  INVALID_SETUP_KEY: 403,
  ALREADY_SET_UP: 409,
  INSTANCE_ADMINS_ONLY: 403,
  NO_SUCH_USER: 404,
  KEEP_ONE_ADMIN: 422,
  /** An admin's own two-factor is turned off with their password, not by the instance's administration. */
  OWN_TWO_FACTOR: 422,
  // Agents.
  CANNOT_CHANGE_AGENT: 403,
  CHOOSE_CONNECTIONS: 422,
  KEEP_ONE_AGENT: 422,
  /** The change was saved, but runs it stops have not all stopped yet: sending it again does nothing new. */
  RUNS_STILL_STOPPING: 503,
  // Connections and their access.
  UNKNOWN_PROVIDER: 404,
  WORKSPACE_ADMINS_ONLY: 403,
  WRONG_CONNECTION_METHOD: 422,
  UNKNOWN_ACTION: 422,
  CONNECTION_REMOVED: 422,
  DIFFERENT_ACCOUNT: 422,
  ALREADY_CONNECTED: 422,
  KEY_REFUSED: 422,
  INVALID_ACCESS_CHANGE: 422,
  UNKNOWN_RESOURCE_KIND: 422,
  CANNOT_BROWSE: 422,
  RESOURCE_NOT_VISIBLE: 422,
  INVALID_RESOURCE_ID: 422,
  INVALID_CURSOR: 422,
  RECONNECT_NEEDED: 502,
  PROVIDER_FAILED: 502,
  /** An OAuth connection that cannot be started now: the provider is not configured, or its registration failed. */
  CONNECT_UNAVAILABLE: 503,
  // Messages and run starts.
  INVALID_IDEMPOTENCY_KEY: 400,
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
  LENGTH_REQUIRED: 411,
  INVALID_CONTENT_LENGTH: 400,
  CONTENT_LENGTH_MISMATCH: 400,
  FILE_TOO_LARGE: 413,
  FILE_NAME_MISSING: 400,
  UPLOAD_TIMEOUT: 408,
  TOO_MANY_UPLOADS_AT_ONCE: 429,
  TOO_MANY_UPLOADS_WAITING: 429,
  WORKSPACE_FULL: 413,
} as const

export type RefusalCode = keyof typeof REFUSALS
