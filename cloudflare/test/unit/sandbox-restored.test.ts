// The check of a restored container's folder against the plan (src/sandbox/folder.ts `restoredDifference`): any
// difference a scan can see fails it, and it names the first path and field. The whole restore, seed included,
// runs against the real image in sandbox-local.test.ts.

import { describe, expect, test } from "vitest";
import type { HydratePlan } from "../../src/sandbox/folder.ts";
import { restoredDifference } from "../../src/sandbox/folder.ts";
import type { ScanResult } from "../../src/sandbox/scan.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);

const PLAN: HydratePlan = {
	versionId: "0199b000-0000-7000-8000-0000000000a1",
	files: [
		{ path: "a.txt", sha256: A, size: 3, mode: 0o644, mtime: 1000, key: "k/a" },
		{ path: "d/run.sh", sha256: B, size: 5, mode: 0o755, mtime: 2000, key: "k/b" },
	],
	dirs: ["empty"],
};

type Scanned = Extract<ScanResult, { ok: true }>;

/** The scan of a folder that is exactly the plan. */
const SCANNED: Scanned = {
	ok: true,
	manifest: {
		files: [
			{ path: "a.txt", sha256: A, mode: 0o644, mtime: 1000 },
			{ path: "d/run.sh", sha256: B, mode: 0o755, mtime: 2000 },
		],
		dirs: ["empty"],
	},
	sizes: { "a.txt": 3, "d/run.sh": 5 },
	warnings: { total: 0, items: [] },
};

/** The scan with the first file changed by `change`. */
function changed(change: Partial<Scanned["manifest"]["files"][number]>): Scanned {
	const [first, ...rest] = SCANNED.manifest.files;
	return { ...SCANNED, manifest: { ...SCANNED.manifest, files: [{ ...(first as Scanned["manifest"]["files"][number]), ...change }, ...rest] } };
}

describe("restoredDifference", () => {
	test("a folder that is the plan has none", () => {
		expect(restoredDifference(PLAN, SCANNED)).toBeNull();
	});

	const cases: { name: string; scanned: Scanned; difference: { path: string; field: string } }[] = [
		{
			name: "an extra file",
			scanned: { ...SCANNED, manifest: { ...SCANNED.manifest, files: [...SCANNED.manifest.files, { path: "stray.txt", sha256: A, mode: 0o644, mtime: 1000 }] }, sizes: { ...SCANNED.sizes, "stray.txt": 3 } },
			difference: { path: "stray.txt", field: "extra file" },
		},
		{ name: "a missing file", scanned: { ...SCANNED, manifest: { ...SCANNED.manifest, files: SCANNED.manifest.files.slice(0, 1) } }, difference: { path: "d/run.sh", field: "missing file" } },
		{ name: "a changed byte", scanned: changed({ sha256: B }), difference: { path: "a.txt", field: "sha256" } },
		{ name: "the execute bit", scanned: changed({ mode: 0o755 }), difference: { path: "a.txt", field: "mode" } },
		{ name: "the mtime", scanned: changed({ mtime: 1001 }), difference: { path: "a.txt", field: "mtime" } },
		{ name: "the size", scanned: { ...SCANNED, sizes: { ...SCANNED.sizes, "a.txt": 4 } }, difference: { path: "a.txt", field: "size" } },
		{ name: "another empty directory", scanned: { ...SCANNED, manifest: { ...SCANNED.manifest, dirs: ["empty", "other"] } }, difference: { path: "other", field: "extra directory" } },
		{ name: "a missing empty directory", scanned: { ...SCANNED, manifest: { ...SCANNED.manifest, dirs: [] } }, difference: { path: "empty", field: "missing directory" } },
		{ name: "a warning", scanned: { ...SCANNED, warnings: { total: 1, items: [{ path: "link", reason: "symlink" }] } }, difference: { path: "link", field: "symlink" } },
	];

	test.each(cases)("$name differs", ({ scanned, difference }) => {
		expect(restoredDifference(PLAN, scanned)).toEqual(difference);
	});
});
