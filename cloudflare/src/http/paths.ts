// Path patterns shared by the router and the route modules (kept apart from router.ts, which imports the
// route modules: an import back from them would see these before they are defined).

/** A path parameter that only matches a lowercase hyphenated UUID, as the API writes ids. */
export const UUID = "{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}";

/** The raw upload: its body is the file, and it checks CSRF after the session (router.ts CHECKED_LATER). */
export const UPLOAD_ROUTE = `/api/workspaces/:workspace${UUID}/uploads`;
