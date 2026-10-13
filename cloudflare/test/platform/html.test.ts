// HTML to text in workerd, which production runs in: htmlparser2's tokenizer and the readers built on it.
// test/unit covers the policies; this checks that they run the same here.

import { expect, test } from "vitest";
import { read as intercomText } from "../../src/connectors/intercom/html.ts";
import { read as teamsText } from "../../src/connectors/teams/html.ts";
import { htmlToText } from "../../src/lib/markdown.ts";

test("pages, Teams and Intercom messages are read as text in workerd", () => {
	expect(htmlToText('<title>T</title><p>a &amp; <a href="/x">b</a></p><script>c</script><img src="https://evil.example.org/">', "https://example.com/")).toEqual([
		"a & [b](https://example.com/x)",
		"T",
	]);
	expect(teamsText('<p>hi <at id="9">SECRET</at> <a href="https://teams.micro&#1;soft.com/x">SECRET</a></p><blockquote>SECRET', "html", [])).toBe(
		"hi @[channel] [Teams link]\n[quoted message]",
	);
	expect(intercomText('<p>see <a href="&#x6a;avascript:x">SECRET</a></p><xmp><a href="/x">SECRET</a>')).toBe("see [Intercom link]");
});
