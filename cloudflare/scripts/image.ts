// The sandbox's image for a deploy (cloudflare/README.md, The sandbox image): addressed by what container/ holds,
// built and pushed to the account's registry only when the registry lacks it, then passed to the build as a
// reference pinned to its digest, so that a deploy whose container/ did not change keeps the image the
// container application already runs and starts no rollout. cf's own build (a `dockerfile` image) pushes a
// new digest whenever Docker has no cache of the last build, as on every CI runner.
//
// Nothing here prints the account or the registry's host: the reference is `minerva-sandbox:<tag>@sha256:<digest>`,
// cf adds the rest when it deploys, and the output of the commands run here is redacted (scripts/run.ts).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_IMAGE_REFERENCE } from "./instance.ts";
import { CommandFailed, ROOT, hide, run } from "./run.ts";

/** container/, the whole of the image's Docker build context (it has no .dockerignore). */
export const CONTAINER_DIR = join(ROOT, "container");
const REPOSITORY = "minerva-sandbox";
/** Changed when what the tag covers changes, so that no old tag is taken for a new scheme's. */
const SCHEME = "minerva sandbox image 1";
const MANIFESTS = ["application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json"];

/**
 * The image's tag: a digest of every entry in the build context, by its path, a file's content and whether it is
 * executable. Empty directories count. Other permission bits do not: git records only the executable bit, and
 * the rest follow the umask of whoever checked out, so counting them would give one commit a tag per machine. A
 * symbolic link or other special entry throws: what it points to could change unseen.
 */
export function imageTag(dir: string = CONTAINER_DIR): string {
	const hash = createHash("sha256").update(`${SCHEME}\0`);
	const walk = (relative: string) => {
		for (const name of readdirSync(join(dir, relative)).sort()) {
			const path = relative ? `${relative}/${name}` : name;
			const stats = lstatSync(join(dir, path));
			if (stats.isDirectory()) {
				hash.update(`d ${path}\0`);
				walk(path);
			} else if (stats.isFile()) {
				const content = readFileSync(join(dir, path));
				hash.update(`f ${path} ${stats.mode & 0o100 ? "x" : "-"} ${content.length}\0`).update(content);
			} else {
				throw new CommandFailed(`${join(dir, path)} is not a plain file or directory: the sandbox image's build context holds only those.`);
			}
		}
	};
	walk("");
	return `${REPOSITORY}:${hash.digest("hex").slice(0, 24)}`;
}

interface Credentials {
	account_id: string;
	registry_host: string;
	username: string;
	password: string;
}

/**
 * Pull credentials for the account's registry, good for five minutes. cf's output is never printed, not even when
 * it fails, since it holds the password; the account and the password are hidden from every later output.
 */
function credentials(account: string): Credentials {
	const result = spawnSync("cf", ["containers", "registries", "credentials", "generate", "registry.cloudflare.com", "--expiration-minutes", "5", "--permissions", "pull"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	let parsed: Partial<Credentials> = {};
	try {
		parsed = JSON.parse(result.stdout ?? "") as Partial<Credentials>;
	} catch {
		// Reported below, without the output.
	}
	hide(parsed.password);
	if (result.status !== 0 || !parsed.username || !parsed.password || !parsed.registry_host) throw new CommandFailed(`cf could not generate credentials for the account's container registry (exit ${result.status ?? "none"}).`);
	if (parsed.account_id !== account) throw new CommandFailed("cf generated registry credentials for an account other than the one this deploy is pinned to.");
	return parsed as Credentials;
}

/** The digest the account's registry holds under a tag, or null when it has none. */
async function remoteDigest(tag: string, account: string): Promise<string | null> {
	const { registry_host: host, username, password } = credentials(account);
	const [repository, reference] = tag.split(":");
	const response = await fetch(`https://${host}/v2/${account}/${repository}/manifests/${reference}`, {
		method: "HEAD",
		headers: { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`, accept: MANIFESTS.join(", ") },
		signal: AbortSignal.timeout(30_000),
	});
	if (response.status === 404) return null;
	if (!response.ok) throw new CommandFailed(`The account's container registry answered ${response.status} when asked for ${tag}.`);
	const digest = response.headers.get("docker-content-digest") ?? "";
	if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new CommandFailed(`The account's container registry gave no valid digest for ${tag}.`);
	return digest;
}

/**
 * Makes sure the account's registry holds the image of container/ as it is now, and returns its reference for
 * MINERVA_SANDBOX_IMAGE. When the registry lacks the tag, the image is built for linux/amd64 and pushed, unless
 * another deploy pushed it meanwhile; a container/ that changed during the build stops the deploy. Two deploys
 * that build the same tag at once (no lock spans machines) both push, and the later digest wins the tag: each
 * deploy runs the digest it read, and the next deploy reads the tag's.
 */
export async function ensureImage(account: string): Promise<string> {
	hide(account);
	const tag = imageTag();
	let digest = await remoteDigest(tag, account);
	if (digest) {
		console.log(`Sandbox image ${tag} already exists remotely, skipping the build.`);
	} else {
		console.log(`Sandbox image ${tag} does not exist remotely: building it for linux/amd64 and pushing it.`);
		run("docker", ["build", "--platform", "linux/amd64", "--tag", tag, CONTAINER_DIR], { print: false });
		if (imageTag() !== tag) throw new CommandFailed(`${CONTAINER_DIR} changed during the image's build: run the deploy again.`);
		digest = await remoteDigest(tag, account);
		if (digest) console.log("Another deploy pushed it meanwhile: using that one.");
		else {
			run("cf", ["containers", "push", "--tag", tag], { print: false });
			digest = await remoteDigest(tag, account);
			if (!digest) throw new CommandFailed(`The account's container registry has no ${tag} after its push.`);
			console.log(`Pushed ${tag}.`);
		}
	}
	const reference = `${tag}@${digest}`;
	if (!SANDBOX_IMAGE_REFERENCE.test(reference)) throw new CommandFailed(`${reference} is not a sandbox image reference.`);
	return reference;
}
