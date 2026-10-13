// How the in-memory Microsoft Graph fakes of the connector tests read the requests they are sent.

/** One request a fake Graph received, read as its handler reads it. */
export interface Received {
	method: string;
	url: URL;
	host: string;
	/** The path with Graph's /v1.0 taken off. */
	path: string;
	/** The path as sent, still percent-encoded. */
	rawPath: string;
	/** The query's parameters, decoded; the last of a repeated one. */
	params: { [name: string]: string };
	headers: Headers;
	body: string;
	bytes: Uint8Array;
}

export async function received(input: RequestInfo | URL, init?: RequestInit): Promise<Received> {
	const request = new Request(input as RequestInfo, init);
	const url = new URL(request.url);
	const bytes = new Uint8Array(await request.arrayBuffer());
	const rawPath = url.pathname;
	return {
		method: request.method,
		url,
		host: url.hostname,
		path: decodeURIComponent(rawPath).replace(/^\/v1\.0/, ""),
		rawPath,
		params: Object.fromEntries(url.searchParams),
		headers: request.headers,
		body: new TextDecoder().decode(bytes),
		bytes,
	};
}
