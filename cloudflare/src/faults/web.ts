// `web/get` for the account test of the Web connector's egress (test/account/web-egress.test.ts): an address
// parsed and fetched as `read_page` does (lib/sites.ts `parseUrl`, connectors/web/fetch.ts `Fetcher.get`),
// with the Worker's own fetch, so that what the platform refuses (private, loopback, link-local, CGNAT and
// metadata destinations, through any name and after any redirect) is measured on the account rather than
// assumed. Grants are not involved: a site another host redirects to comes back as `moved`, which the
// connector would authorize as a new address; the test asks for it again.

import { OperationError } from "../gateway/connector.ts";
import { Fetcher, Moved } from "../connectors/web/fetch.ts";
import { parseUrl } from "../lib/sites.ts";

/** What `Fetcher.get` made of `url`: the page (its first 500 characters), where it moved, or the owned error. */
export async function webGet(url: string): Promise<unknown> {
	const io = { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init), currentWrite: () => null, now: () => performance.now() };
	try {
		const parsed = parseUrl(url);
		const got = await new Fetcher(io).get(parsed);
		if (got instanceof Moved) return { moved: { text: got.target.text, href: got.target.href, host: got.target.host } };
		return { page: { text: got.url.text, href: got.url.href, status: got.status, form: got.form, start: got.text.slice(0, 500) } };
	} catch (error) {
		if (error instanceof OperationError) return { error: { code: error.code, message: error.message } };
		throw error;
	}
}
