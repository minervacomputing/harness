// lib/markdown.ts: readable text from HTML, for Gmail's HTML parts and Google Calendar's descriptions, without
// active or embedded content, in linear time on hostile markup.

import { expect, test } from "vitest";
import { htmlToText } from "../../src/lib/markdown.ts";

test("pages become readable text without active content", () => {
	const page = `<html><head><title> The  Title </title><style>p{}</style></head><body>
    <nav><a href="/home">Home</a></nav>
    <h1>Heading</h1><p>Some <b>bold</b> and <a href="https://example.com/docs (1)">a link</a>.</p>
    <script>steal()</script><iframe src="https://evil.example.org"></iframe>
    <ul><li>one</li><li>two<ol><li>inner</li></ol></li></ul>
    <pre>  indented
    code</pre>
    <img src="https://evil.example.org/leak?d=secret" alt="A cat">
    <a href="javascript:alert(1)">bad</a>
    <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <footer>Footer</footer></body></html>`;
	const text = htmlToText(page);
	expect(text.startsWith("# Heading")).toBe(true);
	expect(text).toContain("Some **bold** and [a link](https://example.com/docs%20%281%29).");
	expect(text).toContain("- one\n- two\n  1. inner");
	expect(text).toContain("```\n  indented\n    code\n```");
	expect(text).toContain("[image: A cat]");
	expect(text).not.toContain("leak");
	expect(text).toContain("bad");
	expect(text).not.toContain("javascript");
	expect(text).toContain("A | B\n1 | 2");
	for (const dropped of ["Title", "steal", "evil.example.org", "Home", "Footer", "p{}"]) expect(text, dropped).not.toContain(dropped);
});

test("hostile markup is converted in linear time", () => {
	expect(htmlToText('<a href="https://example.com/"><script>')).toBe("");
	expect(htmlToText('<a href="https://example.com/">x<script>')).toBe("[x](https://example.com/)");
	const n = 50_000;
	for (const page of [
		`${'<a href="https://example.com/">'.repeat(n)}x${"</a>".repeat(n)}`,
		`${"<svg>".repeat(n)}<math>${"</svg>".repeat(n)}text`,
		`${"<svg><math>".repeat(n)}${"</math>".repeat(n)}${"</svg>".repeat(n)}`,
		`${"<ul><li>".repeat(n)}x`,
	]) {
		const begun = performance.now();
		htmlToText(page);
		expect(performance.now() - begun, page.slice(0, 20)).toBeLessThan(3000);
	}
	expect(htmlToText('<a href="https://example.com/a">one <a href="https://example.com/b">two</a></a>')).toBe("[one](https://example.com/a)[two](https://example.com/b)");
});

test("active and embedded content stays out however the markup is written", () => {
	for (const page of [
		"<SCRIPT>steal()</script>ok",
		"<script/>steal()</script>ok",
		"<style>p{}</style >ok",
		"<noembed><b>steal()</b></noembed>ok",
		"<svg><text>steal()</text></svg>ok",
		"<svg/>ok",
		"<!-- steal() -->ok<![CDATA[steal()]]>",
		"<template><p>steal()</p></template>ok",
	]) {
		expect(htmlToText(page), page).toBe("ok");
	}
	expect(htmlToText("ok<script>steal()</script")).toBe("ok");
	expect(htmlToText("ok<script>steal()</script steal()")).toBe("ok");
	for (const href of ["&#x6a;avascript:steal()", "java&#9;script:steal()", " data:text/html,x", "//evil.example.org:99999/"]) {
		expect(htmlToText(`<a href="${href}">label</a>`), href).toBe("label");
	}
	expect(htmlToText('<img src="https://evil.example.org/x.png"><image src="https://evil.example.org/y.png">')).toBe("");
	expect(htmlToText('<a href="/rel">a</a> <a href="https://example.com/x">b</a>')).toBe("a [b](https://example.com/x)");
});
