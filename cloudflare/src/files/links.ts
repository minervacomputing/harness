// Download links (ARCHITECTURE.md: Files, Downloads): the app signs one for a file the caller may download, and the
// download Worker (files-worker/) checks it and streams the object. A link is an HMAC
// with MINERVA_DOWNLOAD_KEY over the download origin, the workspace and its jurisdiction, the conversation,
// the version, the path, the user, the object's key and an expiry five minutes ahead. The key and the
// jurisdiction say what is served from which bucket, so they are signed with the rest. A link is a bearer
// capability until it expires: signing out does not revoke one already issued.
//
// Shared by both Workers, so it uses nothing but WebCrypto and lib/'s byte helpers.

import { base64url, utf8Strict } from "../lib/bytes.ts";
import { timingSafeEqual } from "../lib/hash.ts";
import { LINK_LIFETIME_MS } from "./limits.ts";

export const DOWNLOAD_PATH = "/download";

export interface DownloadLink {
	workspaceId: string;
	jurisdiction: "eu" | null;
	conversationId: string;
	versionId: string;
	path: string;
	userId: string;
	key: string;
	/** Seconds since the epoch. */
	expires: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OBJECT = /^[0-9a-f]{64}\/[0-9a-f]{32}$/;
const PURPOSE = "minerva-download/1";

/** What the HMAC covers, unambiguously: each field a JSON string, in a fixed order. */
function message(origin: string, link: DownloadLink): string {
	return `${PURPOSE}\n${JSON.stringify([origin, link.workspaceId, link.jurisdiction ?? "", link.conversationId, link.versionId, link.path, link.userId, link.key, String(link.expires)])}`;
}

async function signature(secret: string, origin: string, link: DownloadLink): Promise<string> {
	const key = await crypto.subtle.importKey("raw", utf8Strict(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Strict(message(origin, link)))), { pad: false });
}

/** A signed link on the download origin, good for five minutes from `now`. */
export async function signDownload(secret: string, origin: string, link: Omit<DownloadLink, "expires">, now = Date.now()): Promise<string> {
	const signed: DownloadLink = { ...link, expires: Math.floor((now + LINK_LIFETIME_MS) / 1000) };
	const query = new URLSearchParams({
		w: signed.workspaceId,
		...(signed.jurisdiction ? { j: signed.jurisdiction } : {}),
		c: signed.conversationId,
		v: signed.versionId,
		u: signed.userId,
		p: signed.path,
		k: signed.key,
		e: String(signed.expires),
		s: await signature(secret, origin, signed),
	});
	return `${origin}${DOWNLOAD_PATH}?${query}`;
}

/**
 * The link for a file `resolveDownload` found (the web API's download route): signed for the caller,
 * on the download origin, in the workspace's jurisdiction.
 */
export function downloadLinkFor(
	secret: string,
	origin: string,
	file: { workspace: { id: string; jurisdiction: "eu" | null }; conversationId: string; userId: string; target: { versionId: string; path: string; key: string } },
	now = Date.now(),
): Promise<string> {
	return signDownload(
		secret,
		origin,
		{
			workspaceId: file.workspace.id,
			jurisdiction: file.workspace.jurisdiction,
			conversationId: file.conversationId,
			versionId: file.target.versionId,
			path: file.target.path,
			userId: file.userId,
			key: file.target.key,
		},
		now,
	);
}

/**
 * The link a request carries, checked against the origin it arrived at: `unsigned` without a signature
 * (401, as for a request without a session), `invalid` for anything else wrong, expired included (404,
 * the same for every refusal).
 */
export async function verifyDownload(secret: string, url: URL, now = Date.now()): Promise<{ ok: true; link: DownloadLink } | { ok: false; reason: "unsigned" | "invalid" }> {
	const query = url.searchParams;
	const given = query.get("s");
	if (given === null || given === "") return { ok: false, reason: "unsigned" };
	const field = (name: string) => {
		const values = query.getAll(name);
		return values.length === 1 ? (values[0] as string) : null;
	};
	const w = field("w");
	const j = field("j");
	const c = field("c");
	const v = field("v");
	const u = field("u");
	const p = field("p");
	const k = field("k");
	const e = field("e");
	const invalid = { ok: false, reason: "invalid" } as const;
	if (query.getAll("s").length !== 1 || query.getAll("j").length > 1) return invalid;
	if (w === null || c === null || v === null || u === null || p === null || k === null || e === null) return invalid;
	if (![w, c, v, u].every((id) => UUID.test(id)) || (j !== null && j !== "eu") || !/^[0-9]{1,15}$/.test(e)) return invalid;
	const prefix = `blobs/${w}/${c}/`;
	if (!k.startsWith(prefix) || !OBJECT.test(k.slice(prefix.length)) || !p.isWellFormed()) return invalid;
	const link: DownloadLink = { workspaceId: w, jurisdiction: j === "eu" ? "eu" : null, conversationId: c, versionId: v, path: p, userId: u, key: k, expires: Number(e) };
	if (!timingSafeEqual(given, await signature(secret, url.origin, link))) return invalid;
	if (link.expires * 1000 < now) return invalid;
	return { ok: true, link };
}

/**
 * `attachment`, with the name: quoted (`\` and `"` escaped) when it is printable ASCII, else as
 * `filename*=utf-8''…`, its UTF-8 percent-encoded (RFC 8187), with no fallback.
 */
export function contentDisposition(name: string): string {
	if (name === "") return "attachment";
	if (/^[\x20-\x7e]*$/.test(name)) return `attachment; filename="${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	return `attachment; filename*=utf-8''${encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
