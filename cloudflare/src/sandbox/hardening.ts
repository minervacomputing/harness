// Hardening and its verification (ARCHITECTURE.md: The sandbox lifecycle). One root exec with `set -eu` makes the
// container fit for the agent: a tmpfs `/workspace` of the folder's limits owned by uid 1000, a tmpfs
// `/tmp` mounted noexec with the commands' HOME and MPLCONFIGDIR in it, the agent cgroup with its process
// and memory limits, and `/` remounted read-only. It prints the step it starts before each, so a failure
// names its step. A second root exec reports what holds afterwards, and this module decides from those
// facts alone, in the Durable Object: any check that fails, or a report it cannot read, destroys the
// container. A third, parking, leaves a container as a fresh one hardened and hydrated would be, for the
// conversation's next run. When a parked container retires, a fourth archives its folder onto the root disk, which a
// snapshot keeps, and a fifth extracts the archive into the folder of a container restored from that snapshot.
// Values are arguments of the scripts, never interpolated into them.

import { parseJson } from "../lib/json.ts";
import { sha256Hex } from "../lib/hash.ts";
import {
	AGENT_GID,
	AGENT_UID,
	AGENT_WRITABLE,
	FOLDER_ARCHIVE,
	FOLDER_ARCHIVE_DIR,
	FOLDER_EXTRACT,
	HOME,
	MPLCONFIGDIR,
	PYTHON,
	type SandboxSpec,
	SNAPSHOT_BYTES,
	SNAPSHOT_FILES,
	TMP,
	WORKSPACE,
	workspaceBytes,
} from "./constants.ts";

/**
 * One root exec with `set -eu`: tmpfs `/workspace` (size, nr_inodes, uid 1000), tmpfs `/tmp` noexec,
 * `/tmp/home` and `/tmp/matplotlib` owned by uid 1000 (bash's HOME and MPLCONFIGDIR), the
 * cgroup `/sys/fs/cgroup/agent` with pids.max and memory.max (SandboxSpec), `mount -o remount,ro /`. Any
 * failure destroys the container and fails the turn.
 */
export interface HardeningReport {
	ok: boolean;
	failed: "workspace" | "tmp" | "home_dirs" | "cgroup" | "readonly_root" | null;
	output: string;
}

/**
 * A second exec checks each postcondition; any failure, or any doubt, destroys the container: the mounts'
 * options and sizes, `/tmp` not executable, the home directories owned by uid 1000, `/` read-only,
 * `pids.max` and `memory.max` equal to the spec's, and that the dropped wrapper reports no capabilities
 * and `NoNewPrivs: 1`.
 */
export interface VerificationReport {
	ok: boolean;
	checks: {
		name: "workspace_mount" | "tmp_noexec" | "home_dirs" | "root_readonly" | "cgroup_limits" | "dropped_privileges";
		ok: boolean;
		detail: string;
	}[];
}

export type HardeningStep = Exclude<HardeningReport["failed"], null>;
const STEPS: readonly HardeningStep[] = ["workspace", "tmp", "home_dirs", "cgroup", "readonly_root"];

const HARDEN = [
	"set -eu",
	"size=$0 inodes=$1 tmp=$2 pids=$3 memory=$4 cgroup=$5 uid=$6 gid=$7 workspace=$8 tmpdir=$9 home=${10} mpl=${11}",
	"step() { printf 'step %s\\n' \"$1\"; }",
	"step workspace",
	'mount -t tmpfs -o "size=$size,nr_inodes=$inodes,uid=$uid,gid=$gid,mode=0755,nosuid,nodev" tmpfs "$workspace"',
	"step tmp",
	'mount -t tmpfs -o "size=$tmp,mode=1777,noexec,nosuid,nodev" tmpfs "$tmpdir"',
	"step home_dirs",
	'install -d -o "$uid" -g "$gid" -m 0755 "$home" "$mpl"',
	"step cgroup",
	// On the platform the parent is the VM's root cgroup. In a local container (workerd's, under Docker) it is
	// the container's own cgroup, mounted read-only and holding its processes, which cgroup v2 forbids from
	// giving children controllers: remount it, move its processes to a leaf, then enable pids and memory.
	'parent="${cgroup%/*}"',
	'[ -w "$parent/cgroup.procs" ] || mount -o remount,rw "$parent"',
	'if ! echo "+pids +memory" > "$parent/cgroup.subtree_control" 2>/dev/null; then',
	'  mkdir -p "$parent/init"',
	"  for attempt in 1 2 3 4 5; do",
	'    while read -r pid; do echo "$pid" > "$parent/init/cgroup.procs" 2>/dev/null || true; done < "$parent/cgroup.procs"',
	'    echo "+pids +memory" > "$parent/cgroup.subtree_control" 2>/dev/null && break',
	"  done",
	'  echo "+pids +memory" > "$parent/cgroup.subtree_control"',
	"fi",
	'mkdir "$cgroup"',
	'echo "$pids" > "$cgroup/pids.max"',
	'echo "$memory" > "$cgroup/memory.max"',
	"step readonly_root",
	"mount -o remount,ro /",
	"step done",
].join("\n");

/** The hardening exec's argv, as root. */
export function hardeningArgv(spec: SandboxSpec, cgroup: string): string[] {
	return [
		"/bin/bash",
		"-c",
		HARDEN,
		String(workspaceBytes(spec.folderBytes)),
		String(spec.folderEntries + 1),
		String(spec.tmpBytes),
		String(spec.pidsMax),
		String(spec.memoryBytes),
		cgroup,
		String(AGENT_UID),
		String(AGENT_GID),
		WORKSPACE,
		TMP,
		HOME,
		MPLCONFIGDIR,
	];
}

/**
 * What a container was started and hardened with: the SHA-256 of the image's name and the hardening exec's argv,
 * which holds the script and every limit. A parked container is acquired, and a snapshot restored, only for a run
 * whose spec gives the same with the image the class starts now, so a deploy that replaced the image retires both.
 */
export function hardeningDigest(spec: SandboxSpec, cgroup: string, image: string): Promise<string> {
	return sha256Hex([image, ...hardeningArgv(spec, cgroup)].join("\0"));
}

/** The park exec's exit status when a regular file in the folder has more than one link. */
export const PARK_LINKED = 3;

// Parking, as root with `set -eu`, once the run's last checkpoint saved the folder. The agent's processes are killed
// until its cgroup is empty, as `killStrays` does. A hard link fails it: hydration never makes one, and the scan
// cannot see it. What a checkpoint never keeps goes: entries in the folder that are neither regular files nor
// directories (found without following links), and whatever the agent left in `/tmp`, the other places it can
// write (AGENT_WRITABLE) and System V IPC. Modes become hydration's, directories 0755 and files 0755 or 0644 by
// their owner's execute bit (`00755` clears a directory's set-group-ID bit, which `0755` keeps), changed only where
// they differ, so the scan's index still vouches for the other files. Then the home directories are made again.
const PARK = [
	"set -eu",
	"cgroup=$0 workspace=$1 tmpdir=$2 home=$3 mpl=$4 uid=$5 gid=$6 linked=$7",
	"shift 7",
	'for i in $(seq 100); do echo 1 > "$cgroup/cgroup.kill"; grep -qx \'populated 0\' "$cgroup/cgroup.events" && break; [ "$i" -lt 100 ] || exit 1; sleep 0.05; done',
	'[ -z "$(find -P "$workspace" -type f -links +1 -print -quit)" ] || exit "$linked"',
	'find -P "$workspace" -mindepth 1 ! -type f ! -type d -delete',
	'find -P "$workspace" -type d ! -perm 0755 -exec chmod 00755 {} +',
	'find -P "$workspace" -type f -perm -u=x ! -perm 0755 -exec chmod 0755 {} +',
	'find -P "$workspace" -type f ! -perm -u=x ! -perm 0644 -exec chmod 0644 {} +',
	'for place in "$tmpdir" "$@"; do [ ! -d "$place" ] || find -P "$place" -mindepth 1 -delete; done',
	"ipcrm --all",
	'install -d -o "$uid" -g "$gid" -m 0755 "$home" "$mpl"',
].join("\n");

/** The park exec's argv, as root. */
export function parkArgv(cgroup: string): string[] {
	return ["/bin/bash", "-c", PARK, cgroup, WORKSPACE, TMP, HOME, MPLCONFIGDIR, String(AGENT_UID), String(AGENT_GID), String(PARK_LINKED), ...AGENT_WRITABLE];
}

/** The retire exec's exit status when the folder is too small to be worth a snapshot (SNAPSHOT_FILES, SNAPSHOT_BYTES). */
export const RETIRE_SMALL = 3;

// The retire, as root, on a parked container, which admitted nothing since parking refused work in flight: no
// helper or file operation runs. The agent's processes are killed until its cgroup is empty. A folder under both
// thresholds ends it with its own status. Anything parking does not leave fails it, since the archive must hold what
// hydration would write: an entry neither a regular file nor a directory, a file with more than one link, a
// directory not 0755 or a file neither 0644 nor 0755. Then root's tar archives the folder into a directory made
// afresh on the root disk, so nothing deleted rides along, storing no extended attributes, ACLs or links between
// files and keeping modes and modification times to the nanosecond; the archive is root's alone. `/` is synced and
// made read-only again so the snapshot finds the disk clean.
const RETIRE = [
	"set -eu -o pipefail",
	"cgroup=$0 workspace=$1 dir=$2 archive=$3 files=$4 bytes=$5 small=$6",
	'for i in $(seq 100); do echo 1 > "$cgroup/cgroup.kill"; grep -qx \'populated 0\' "$cgroup/cgroup.events" && break; [ "$i" -lt 100 ] || exit 1; sleep 0.05; done',
	"counted=$(find -P \"$workspace\" -type f -printf '%s\\n' | awk '{ n++; s += $1 } END { printf \"%d %.0f\\n\", n, s }')",
	'read -r count total <<< "$counted"',
	'[ "$count" -ge "$files" ] || [ "$total" -ge "$bytes" ] || exit "$small"',
	'odd=$(find -P "$workspace" \\( ! -type f ! -type d -o -type f -links +1 -o -type f ! -perm 0644 ! -perm 0755 -o -type d ! -perm 0755 \\) -print -quit)',
	"[ -z \"$odd\" ] || { echo 'The folder holds an entry parking does not leave.' >&2; exit 1; }",
	"mount -o remount,rw /",
	'rm -rf "$dir"',
	'mkdir -m 0700 "$dir"',
	"umask 077",
	'tar -c -f "$archive" --format=pax --hard-dereference --no-xattrs --no-acls --no-selinux -C "$workspace" .',
	"sync",
	"mount -o remount,ro /",
].join("\n");

/** The retire exec's argv, as root. */
export function retireArgv(cgroup: string): string[] {
	return ["/bin/bash", "-c", RETIRE, cgroup, WORKSPACE, FOLDER_ARCHIVE_DIR, FOLDER_ARCHIVE, String(SNAPSHOT_FILES), String(SNAPSHOT_BYTES), String(RETIRE_SMALL)];
}

// The seed, as root, on a container restored from a snapshot and hardened: the archive the retire wrote goes to the
// wrapped argv that follows, hydration's own extraction (FOLDER_EXTRACT), so the agent's tar writes the folder as
// hydration does, its files the agent's, with the archive's modes and times.
export const SEED = ["set -eu", "archive=$0", '"$@" < "$archive"'].join("\n");

/** The seed exec's argv, as root: `wrapped` is the wrapper's argv of FOLDER_EXTRACT. */
export function seedArgv(wrapped: string[]): string[] {
	return ["/bin/bash", "-c", SEED, FOLDER_ARCHIVE, ...wrapped];
}

/**
 * The format of a snapshot's archive: the SHA-256 of the scripts that write and read it. A snapshot is restored only
 * with the format it was taken in, so changing either script retires every older snapshot with nothing to bump.
 */
export function snapshotFormat(): Promise<string> {
	return sha256Hex([RETIRE, SEED, ...FOLDER_EXTRACT].join("\0"));
}

/** The report of a hardening exec from its exit status and output: the step that failed is the last one it started. */
export function hardeningReport(exitCode: number, stdout: string, stderr: string): HardeningReport {
	const started = [...stdout.matchAll(/^step (\S+)$/gm)].map((match) => match[1] as string);
	const output = `${stdout}${stderr}`.slice(-4000);
	if (exitCode === 0 && started.at(-1) === "done") return { ok: true, failed: null, output };
	const last = started.at(-1);
	const failed = (STEPS as readonly string[]).includes(last ?? "") ? (last as HardeningStep) : "workspace";
	return { ok: false, failed, output };
}

// The facts the verification reports, gathered as root by Python in isolated mode: the mount table, the
// home directories, the cgroup's limits, whether a script in /tmp runs and a file in /etc can be written,
// and what a command started through the wrapper sees of itself.
const FACTS = `
import errno, json, os, stat, subprocess, sys
cgroup, wrapper = sys.argv[1], sys.argv[2:]
facts = {}
def attempt(name, function):
    try:
        facts[name] = function()
    except OSError as error:
        facts[name] = errno.errorcode.get(error.errno, str(error.errno))
    except Exception as error:
        facts[name] = "error: " + type(error).__name__
with open("/proc/self/mountinfo") as file:
    facts["mountinfo"] = file.read()
def directory(path):
    st = os.lstat(path)
    return {"dir": stat.S_ISDIR(st.st_mode), "uid": st.st_uid, "gid": st.st_gid, "mode": stat.S_IMODE(st.st_mode)}
for path in (${JSON.stringify(HOME)}, ${JSON.stringify(MPLCONFIGDIR)}):
    attempt(path, lambda path=path: directory(path))
def read(path):
    with open(path) as file:
        return file.read().strip()
attempt(${JSON.stringify(TMP)}, lambda: directory(${JSON.stringify(TMP)}))
attempt("pids.max", lambda: read(cgroup + "/pids.max"))
attempt("memory.max", lambda: read(cgroup + "/memory.max"))
def run_in_tmp():
    # In a directory of root's own with a random name, so nothing the agent left in /tmp (a link, say, after
    # a restart) can be what root writes or runs.
    import shutil, tempfile
    directory = tempfile.mkdtemp(prefix=".minerva-verify-", dir=${JSON.stringify(TMP)})
    try:
        path = os.path.join(directory, "probe.sh")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
        os.write(fd, b"#!/bin/sh\\nexit 0\\n")
        os.close(fd)
        subprocess.run([path], timeout=10)
        return "ran"
    finally:
        shutil.rmtree(directory, ignore_errors=True)
attempt("tmp_exec", run_in_tmp)
def write_etc():
    with open("/etc/.minerva-verify", "w") as file:
        file.write("x")
    os.remove("/etc/.minerva-verify")
    return "written"
attempt("etc_write", write_etc)
def dropped():
    result = subprocess.run(wrapper, capture_output=True, timeout=20)
    return {"exit": result.returncode, "stdout": result.stdout.decode("utf-8", "replace")[:20000]}
attempt("dropped", dropped)
sys.stdout.write(json.dumps(facts))
`;

/** The verification exec's argv, as root: the wrapper argv runs `cat /proc/self/status` and `/proc/self/cgroup` as the agent. */
export function verificationArgv(cgroup: string, wrapped: string[]): string[] {
	return [PYTHON, "-I", "-S", "-c", FACTS, cgroup, ...wrapped];
}

/** The command the verification runs through the wrapper. */
export const DROPPED_PROBE = "cat /proc/self/status; echo ---; cat /proc/self/cgroup";

interface Mount {
	point: string;
	options: string[];
	fstype: string;
	superOptions: string[];
}

/** The mounts of a mountinfo text, by their mount points (octal escapes decoded). */
export function mounts(mountinfo: string): Mount[] {
	const out: Mount[] = [];
	for (const line of mountinfo.split("\n")) {
		const fields = line.split(" ");
		const separator = fields.indexOf("-");
		if (separator < 6) continue;
		out.push({
			point: (fields[4] ?? "").replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
			options: (fields[5] ?? "").split(","),
			fstype: fields[separator + 1] ?? "",
			superOptions: (fields[separator + 3] ?? "").split(","),
		});
	}
	return out;
}

/** The mount in effect at `point`: the last one listed there, which hides any below it. */
function top(all: Mount[], point: string): Mount | string {
	return all.filter((mount) => mount.point === point).at(-1) ?? `nothing mounted at ${point}`;
}

function has(list: string[], ...wanted: string[]): boolean {
	return wanted.every((option) => list.includes(option));
}

const CAPABILITIES = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];

/** Whether a reported directory fact is a directory of that owner, group and mode. */
function isDirectory(value: unknown, uid: number, gid: number, mode: number): boolean {
	const entry = value as { dir?: unknown; uid?: unknown; gid?: unknown; mode?: unknown } | undefined;
	return typeof entry === "object" && entry !== null && entry.dir === true && entry.uid === uid && entry.gid === gid && entry.mode === mode;
}

/** The relative cgroup path a process in `cgroup` reports in /proc/self/cgroup. */
export function cgroupLine(cgroup: string): string {
	return `0::${cgroup.replace(/^\/sys\/fs\/cgroup/, "") || "/"}`;
}

/** Decides each postcondition from the verification's facts (`VerificationReport`). */
export function verificationReport(spec: SandboxSpec, cgroup: string, exitCode: number, stdout: string): VerificationReport {
	let facts: { [name: string]: unknown };
	try {
		const parsed = parseJson(stdout);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new TypeError("not an object");
		facts = parsed;
	} catch {
		return { ok: false, checks: [{ name: "workspace_mount", ok: false, detail: `The verification's report is unreadable (exit ${exitCode}).` }] };
	}
	const checks: VerificationReport["checks"] = [];
	const check = (name: VerificationReport["checks"][number]["name"], ok: boolean, detail: string) => checks.push({ name, ok, detail: detail.slice(0, 500) });
	const all = typeof facts.mountinfo === "string" ? mounts(facts.mountinfo) : [];

	const workspace = top(all, WORKSPACE);
	if (typeof workspace === "string") check("workspace_mount", false, workspace);
	else {
		const size = `size=${workspaceBytes(spec.folderBytes) / 1024}k`;
		const ok =
			workspace.fstype === "tmpfs" &&
			has(workspace.options, "rw", "nosuid", "nodev") &&
			!workspace.options.includes("noexec") &&
			has(workspace.superOptions, size, `nr_inodes=${spec.folderEntries + 1}`, `uid=${AGENT_UID}`, `gid=${AGENT_GID}`, "mode=755");
		check("workspace_mount", ok, `${workspace.fstype} ${workspace.options.join(",")} ${workspace.superOptions.join(",")}`);
	}

	const tmp = top(all, TMP);
	if (typeof tmp === "string") check("tmp_noexec", false, tmp);
	else {
		const ok =
			tmp.fstype === "tmpfs" &&
			has(tmp.options, "rw", "noexec", "nosuid", "nodev") &&
			// The kernel lists tmpfs's mode only when it is not the default 1777; the directory says it.
			has(tmp.superOptions, `size=${spec.tmpBytes / 1024}k`) &&
			isDirectory(facts[TMP], 0, 0, 0o1777) &&
			facts.tmp_exec === "EACCES";
		check("tmp_noexec", ok, `${tmp.fstype} ${tmp.options.join(",")} ${tmp.superOptions.join(",")}; a script there: ${String(facts.tmp_exec)}`);
	}

	const homes = [HOME, MPLCONFIGDIR].map((path) => [path, facts[path]] as const);
	const homesOk = homes.every(([, value]) => isDirectory(value, AGENT_UID, AGENT_GID, 0o755));
	check("home_dirs", homesOk, homes.map(([path, value]) => `${path}: ${JSON.stringify(value)}`).join("; "));

	const root = top(all, "/");
	const rootOk = typeof root !== "string" && root.options.includes("ro") && facts.etc_write === "EROFS";
	check("root_readonly", rootOk, `${typeof root === "string" ? root : root.options.join(",")}; writing /etc: ${String(facts.etc_write)}`);

	const limitsOk = facts["pids.max"] === String(spec.pidsMax) && facts["memory.max"] === String(spec.memoryBytes);
	check("cgroup_limits", limitsOk, `pids.max ${String(facts["pids.max"])}, memory.max ${String(facts["memory.max"])}`);

	const dropped = facts.dropped as { exit?: unknown; stdout?: unknown } | undefined;
	let droppedOk = false;
	let droppedDetail = JSON.stringify(dropped ?? null);
	if (typeof dropped === "object" && dropped !== null && dropped.exit === 0 && typeof dropped.stdout === "string" && dropped.stdout.startsWith("\u0006")) {
		const [status = "", cgroupText = ""] = dropped.stdout.slice(1).split("\n---\n");
		const field = (name: string) => status.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1]?.trim() ?? null;
		const ids = (name: string) => (field(name) ?? "").split(/\s+/);
		const capabilities = CAPABILITIES.map((name) => field(name));
		droppedOk =
			ids("Uid").length === 4 &&
			ids("Uid").every((id) => id === String(AGENT_UID)) &&
			ids("Gid").every((id) => id === String(AGENT_GID)) &&
			(field("Groups") ?? "x") === "" &&
			capabilities.every((value) => value === "0000000000000000") &&
			field("NoNewPrivs") === "1" &&
			cgroupText.trim() === cgroupLine(cgroup);
		droppedDetail = `Uid ${field("Uid")}; Gid ${field("Gid")}; Groups ${field("Groups")}; ${CAPABILITIES.map((name, i) => `${name} ${capabilities[i]}`).join(" ")}; NoNewPrivs ${field("NoNewPrivs")}; ${cgroupText.trim()}`;
	}
	check("dropped_privileges", droppedOk, droppedDetail);

	return { ok: exitCode === 0 && checks.every((entry) => entry.ok), checks };
}
