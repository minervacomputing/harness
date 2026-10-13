// minerva-fs (cloudflare/container/minerva/) in the image's own Python: its unit tests
// (container/tests/test_minerva_fs.py), and randomized comparisons of its manifest policy for a path and
// its display of a skipped path with the same rules stated in TypeScript below. Skipped without Docker or
// the image (`pnpm sandbox:image`).

import { describe, expect, test } from "vitest";
import { parseJson } from "../../src/lib/json.ts";
import { dockerReady, LOCAL_IMAGE } from "./sandbox-docker.ts";

interface Spawned {
	status: number | null;
	stdout: Uint8Array;
	stderr: Uint8Array;
}
const node = (globalThis as unknown as {
	process: { getBuiltinModule(id: "node:child_process"): { spawnSync(command: string, args: string[], options: { input?: Uint8Array; timeout: number; maxBuffer: number }): Spawned } };
}).process;
const CONTAINER = new URL("../../container/", import.meta.url).pathname;
const READY = dockerReady();
const decoder = new TextDecoder();

function python(args: string[], input?: string): { status: number | null; stdout: string; stderr: string } {
	const result = node.getBuiltinModule("node:child_process").spawnSync(
		"docker",
		["run", "--rm", ...(input === undefined ? [] : ["-i"]), "--network", "none", "--user", "1000:1000", "-w", "/tmp", "-e", "HOME=/tmp", "-v", `${CONTAINER}:/src:ro`, LOCAL_IMAGE, "/usr/bin/python3", "-I", ...args],
		{ ...(input === undefined ? {} : { input: new TextEncoder().encode(input) }), timeout: 300_000, maxBuffer: 256 * 1024 * 1024 },
	);
	return { status: result.status, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

/** A small deterministic generator, so a failure can be reproduced. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

// The manifest policy and the display of a skipped path.
const encoder = new TextEncoder();
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
function refusedName(name: string, pathBytes: number, depth: number): string | null {
	if (name === "" || name === "." || name === ".." || name.includes("/")) return "invalid_name";
	if (name.normalize("NFC") !== name || CONTROL.test(name)) return "invalid_name";
	if (encoder.encode(name).length > 255 || pathBytes > 1024) return "too_long";
	if (depth > 32) return "too_deep";
	return null;
}
function refusedPath(path: string): string | null {
	// Python cannot encode a lone surrogate, so it refuses the name; a scan never sees one, as its names
	// come from the file system's bytes.
	if (!path.isWellFormed()) return "invalid_name";
	let bytes = 0;
	for (const [index, segment] of path.split("/").entries()) {
		bytes += (index ? 1 : 0) + encoder.encode(segment).length;
		const reason = refusedName(segment, bytes, index + 1);
		if (reason) return reason;
	}
	return null;
}
function displayPath(key: Uint8Array): string {
	const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(key).replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
	if (text.length <= 1024) return text;
	let end = 1023;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

describe.skipIf(!READY)("minerva-fs in the image's Python", () => {
	test("its unit tests pass", { timeout: 300_000 }, () => {
		const result = python(["-m", "unittest", "discover", "-s", "/src/tests"]);
		expect(result.stderr).toMatch(/\nOK\n?$/);
		expect(result.status).toBe(0);
	});

	test("its manifest policy and display agree with the TypeScript rules", { timeout: 300_000 }, () => {
		const next = random(7);
		const pieces = [[0x0a], [0x0d, 0x0a], [0x61], [0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x98, 0x80], [0xef, 0xbb, 0xbf], [0xe2, 0x82], [0xff], [0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc0, 0xaf], [0x20]];
		const alphabet = ["a", "é", "é", "/", "//", ".", "..", "\t", "\u0085", "﻿", "😀", "\ud800", " ", "x".repeat(200), "é".repeat(130)];
		const paths: string[] = [];
		for (let i = 0; i < 600; i++) {
			let path = "";
			const length = 1 + Math.floor(next() * 8);
			for (let j = 0; j < length; j++) path += alphabet[Math.floor(next() * alphabet.length)];
			paths.push(path);
		}
		paths.push(Array.from({ length: 32 }, () => "d").join("/"), Array.from({ length: 33 }, () => "d").join("/"), "é".repeat(127), "x".repeat(256));
		const displays: Uint8Array[] = [];
		for (let i = 0; i < 300; i++) {
			const parts: number[] = [];
			const length = Math.floor(next() * (i < 20 ? 900 : 40));
			for (let j = 0; j < length; j++) parts.push(...(pieces[Math.floor(next() * pieces.length)] as number[]), ...(next() < 0.1 ? [0x09] : []));
			displays.push(Uint8Array.from(parts));
		}
		const cases = { paths, displays: displays.map(hex) };
		const result = python(["/src/tests/vectors.py"], JSON.stringify(cases));
		expect(result.stderr).toBe("");
		const answers = parseJson(result.stdout) as { paths: (string | null)[]; displays: string[] };
		expect(answers.paths).toEqual(paths.map(refusedPath));
		expect(answers.displays).toEqual(displays.map(displayPath));
	});
});
