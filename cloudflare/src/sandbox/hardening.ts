// Hardening and its verification (plan: The sandbox lifecycle). One root exec with `set -eu` makes the
// container fit for the agent: a tmpfs `/workspace` of the folder's limits owned by uid 1000, a tmpfs
// `/tmp` mounted noexec with the commands' HOME and MPLCONFIGDIR in it, the agent cgroup with its process
// and memory limits, and `/` remounted read-only. It prints the step it starts before each, so a failure
// names its step. A second root exec reports what holds afterwards, and this module decides from those
// facts alone, in the Durable Object: any check that fails, or a report it cannot read, destroys the
// container. Values are arguments of the scripts, never interpolated into them.

import { parseJson } from "../lib/json.ts";
import { AGENT_GID, AGENT_UID, HOME, MPLCONFIGDIR, PYTHON, type SandboxSpec, TMP, WORKSPACE, workspaceBytes } from "./constants.ts";

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
