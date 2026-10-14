// The one way anything the agent can influence runs in the sandbox (ARCHITECTURE.md: The sandbox lifecycle): a root
// shell that puts itself in the agent cgroup or exits 125, then drops to uid 1000 with no capabilities and
// no_new_privs and execs `timeout -k 5 <s>` and the command. The command, its working directory and its
// environment are arguments, never interpolated into the script. Privileges are dropped before the command's
// environment is installed (`setpriv … env -i …`), so no variable the caller passes (LD_PRELOAD, say) ever
// reaches a process that runs as root.
//
// The wrapper writes one byte to stdout before it execs the command, which nothing the agent runs can
// precede: ACK (0x06) once the command is admitted to the cgroup and found, or NAK (0x15) and a reason
// (`cwd`, `missing`, `denied`) when it could not start. No byte and exit status 125 is a failed admission,
// which a command's own `exit 125` cannot be mistaken for.

import { AGENT_GID, AGENT_UID, KILL_AFTER_SECONDS } from "./constants.ts";

export const ACK = 0x06;
export const NAK = 0x15;

const SCRIPT = [
	"set -u",
	'cgroup=$0 cwd=$1 seconds=$2 mode=$3 count=$4',
	"shift 4",
	'environment=("${@:1:count}")',
	'shift "$count"',
	'echo $$ > "$cgroup/cgroup.procs" || exit 125',
	"cd -- \"$cwd\" 2>/dev/null || { printf '\\025cwd\\n'; exit 126; }",
	'if [ "$mode" = argv ]; then',
	"  verdict=missing",
	'  case $1 in',
	'    */*) if [ -f "$1" ] && [ -x "$1" ]; then verdict=found; elif [ -e "$1" ]; then verdict=denied; fi ;;',
	"    *)",
	"      search=/usr/bin:/bin",
	'      for entry in "${environment[@]}"; do case $entry in PATH=*) search=${entry#PATH=} ;; esac; done',
	// Every component in order, empty ones (the working directory) and a trailing one included, as execvp.
	"      rest=$search",
	"      while :; do",
	'        directory=${rest%%:*}',
	'        candidate=${directory:-.}/$1',
	'        if [ -e "$candidate" ]; then',
	'          if [ -f "$candidate" ] && [ -x "$candidate" ]; then verdict=found; break; fi',
	"          verdict=denied",
	"        fi",
	'        [ "$rest" = "${rest#*:}" ] && break',
	'        rest=${rest#*:}',
	"      done ;;",
	"  esac",
	"  [ \"$verdict\" = found ] || { printf '\\025%s\\n' \"$verdict\"; exit 127; }",
	"fi",
	"printf '\\006'",
	`exec /usr/bin/setpriv --reuid=${AGENT_UID} --regid=${AGENT_GID} --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs -- /usr/bin/env -i -- "\${environment[@]}" /usr/bin/timeout -k ${KILL_AFTER_SECONDS} "$seconds" "$@"`,
].join("\n");

export interface WrappedCommand {
	/** A string runs through `/bin/bash -c`; an array runs its program directly, arguments unparsed. */
	command: string | readonly string[];
	cwd: string;
	env: { readonly [name: string]: string };
	/** Seconds until `timeout` stops the command; 0 for none. */
	timeoutSeconds: number;
}

/** A name a command's environment may hold: no `=` and no NUL, as `env` and execve need. */
export function validEnvironmentName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\u0000");
}

/** `seconds` as `timeout` reads it: a plain decimal, never an exponent. */
export function timeoutArgument(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) throw new RangeError("A timeout is a finite, non-negative number of seconds.");
	if (seconds === 0) return "0";
	if (Number.isInteger(seconds)) return BigInt(seconds).toString();
	const text = String(seconds);
	if (!/e/i.test(text)) return text;
	const fixed = seconds.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
	return fixed === "" ? "0" : fixed;
}

/** The argv of a wrapped command, for `container.exec` as root. */
export function wrapperArgv(cgroup: string, wrapped: WrappedCommand): string[] {
	const environment = Object.entries(wrapped.env).map(([name, value]) => {
		if (!validEnvironmentName(name) || value.includes("\u0000")) throw new TypeError(`Invalid environment variable ${JSON.stringify(name)}.`);
		return `${name}=${value}`;
	});
	const [mode, command] = typeof wrapped.command === "string" ? ["shell", ["/bin/bash", "-c", wrapped.command]] : ["argv", [...wrapped.command]];
	if (command.length === 0) throw new TypeError("An empty argv runs nothing.");
	if (command.some((argument) => argument.includes("\u0000"))) throw new TypeError("An argument holds a NUL character.");
	return ["/bin/bash", "-c", SCRIPT, cgroup, wrapped.cwd, timeoutArgument(wrapped.timeoutSeconds), mode, String(environment.length), ...environment, ...command];
}

/** What the wrapper's first byte said: started, could not start (with its reason), or nothing yet. */
export type Admission = { started: true } | { started: false; reason: "cwd" | "missing" | "denied" | "admission" };

/** Reads the wrapper's prefix from the first bytes of stdout; null while more bytes are needed. */
export function readAdmission(head: Uint8Array, ended: boolean): { admission: Admission; rest: Uint8Array } | null {
	if (head.length === 0) return ended ? { admission: { started: false, reason: "admission" }, rest: head } : null;
	if (head[0] === ACK) return { admission: { started: true }, rest: head.subarray(1) };
	if (head[0] !== NAK) return { admission: { started: false, reason: "admission" }, rest: head };
	const newline = head.indexOf(0x0a);
	if (newline === -1) return ended ? { admission: { started: false, reason: "admission" }, rest: head } : null;
	const word = new TextDecoder().decode(head.subarray(1, newline));
	const reason = word === "cwd" || word === "missing" || word === "denied" ? word : "admission";
	return { admission: { started: false, reason }, rest: head.subarray(newline + 1) };
}
