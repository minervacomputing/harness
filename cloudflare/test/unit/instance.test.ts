// The names of an instance (scripts/instance.ts): the rules a name must pass, and the one derivation of every
// resource name from it. The instances here are fixtures (`acme`); the last tests state the names today's flags
// give to ours, which must not change (production holds data under them).

import { describe, expect, test } from "vitest";
import { LOCAL_INSTANCES, MAX_NAME_LENGTH, RESERVED_SUFFIXES, instanceName, nameProblem, namesOf, todaysInstance } from "../../scripts/instance.ts";

describe("what an instance's name may be", () => {
	test.each(["acme", "a", "acme-2", "acme-prod", "a1b2", "eu", "files", "cm", "sandbox", "default-2", "defaults", "x-y-z", "acme-files-2"])("%s is accepted", (name) => {
		expect(nameProblem(name)).toBeNull();
		expect(instanceName(name)).toBe(name);
	});

	test.each([
		["nothing", ""],
		["upper case", "Acme"],
		["a leading digit", "1acme"],
		["a leading hyphen", "-acme"],
		["a trailing hyphen", "acme-"],
		["a double hyphen", "acme--prod"],
		["an underscore", "acme_prod"],
		["a dot", "acme.prod"],
		["a space", "acme prod"],
		["a slash", "acme/prod"],
		["a letter outside ASCII", "acmé"],
		["a newline", "acme\n"],
	])("%s is refused", (_case, name) => {
		expect(nameProblem(name)).not.toBeNull();
		expect(() => instanceName(name)).toThrow();
	});

	test("anything but a string is refused", () => {
		for (const value of [undefined, null, 1, {}, ["acme"]]) expect(nameProblem(value)).not.toBeNull();
	});

	test("at most 54 characters, so that the longest derived name fits the 63 of a Worker or a bucket", () => {
		const longest = `a${"b".repeat(MAX_NAME_LENGTH - 1)}`;
		expect(longest).toHaveLength(54);
		expect(nameProblem(longest)).toBeNull();
		expect(Object.values(namesOf(longest)).every((name) => name.length <= 63)).toBe(true);
		expect(namesOf(longest).bucketEu).toHaveLength(63);
		expect(nameProblem(`${longest}b`)).toMatch(/at most 54 characters/);
	});

	test.each(RESERVED_SUFFIXES)("a name cannot end in %s, which the derivation appends", (suffix) => {
		expect(nameProblem(`acme${suffix}`)).toBe(`An instance name cannot end in ${suffix}, which names the instance's own resources.`);
		// Only an ending: the suffix elsewhere in the name, or its word without the hyphen, is a name.
		expect(nameProblem(`acme${suffix}-2`)).toBeNull();
		expect(nameProblem(suffix.slice(1))).toBeNull();
	});

	test("an instance cannot be called default, the id of the gateway Cloudflare creates by itself", () => {
		expect(nameProblem("default")).toMatch(/cannot be named default/);
	});
});

describe("the names an instance owns", () => {
	test("each resource follows the instance's name", () => {
		expect(namesOf("acme")).toEqual({
			name: "acme",
			app: "acme",
			d1: "acme",
			gateway: "acme",
			download: "acme-files",
			bucket: "acme-files",
			bucketEu: "acme-files-eu",
			container: "acme-sandbox",
			lab: "acme-cm",
		});
	});

	test("a name that is not an instance's has no names", () => {
		expect(() => namesOf("acme-files")).toThrow(/cannot end in -files/);
		expect(() => namesOf("Acme")).toThrow();
		expect(() => namesOf("default")).toThrow();
	});

	test("two instances share no name of a kind, so one cannot reach the other's resources", () => {
		// The rules exist for this: acme-files would own the download Worker of acme, and acme-eu's buckets would
		// otherwise run into acme's. Each kind of resource has a namespace of its own.
		const instances = ["acme", "acme-eu", "acme-test", "acme-test-2", "acme-x", "files", "eu", "cm", "sandbox", "acme-files-2", "test", "acme2"];
		const kinds = [["app", "d1", "gateway"], ["download", "lab"], ["bucket", "bucketEu"], ["container"]] as const;
		for (const kind of kinds) {
			const owners = new Map<string, string>();
			for (const name of instances) {
				const names = namesOf(name);
				for (const key of kind) {
					const resource = names[key];
					const earlier = owners.get(resource);
					expect(earlier === undefined || earlier === name, `${resource} of ${name} (${key}) is also ${earlier}'s`).toBe(true);
					owners.set(resource, name);
				}
			}
		}
	});

	test("the Worker kinds do not collide either: the app, the download Worker and the lab", () => {
		const workers = new Map<string, string>();
		for (const name of ["acme", "acme-eu", "acme-test", "files", "cm"]) {
			for (const worker of [namesOf(name).app, namesOf(name).download, namesOf(name).lab]) {
				expect(workers.has(worker), `${worker} of ${name} is also ${workers.get(worker)}'s`).toBe(false);
				workers.set(worker, name);
			}
		}
	});
});

describe("the modes that reach no account", () => {
	test("have local names that are valid instance names, and are not one another's", () => {
		expect(LOCAL_INSTANCES).toEqual({ offline: "minerva-dev", test: "minerva-local" });
		for (const name of Object.values(LOCAL_INSTANCES)) expect(nameProblem(name)).toBeNull();
		expect(namesOf(LOCAL_INSTANCES.offline).bucket).toBe("minerva-dev-files");
		expect(namesOf(LOCAL_INSTANCES.test).container).toBe("minerva-local-sandbox");
	});
});

describe("today's two instances", () => {
	test("production keeps every name it holds data under", () => {
		expect(namesOf(todaysInstance(false))).toEqual({
			name: "minerva-cf",
			app: "minerva-cf",
			d1: "minerva-cf",
			gateway: "minerva-cf",
			download: "minerva-cf-files",
			bucket: "minerva-cf-files",
			bucketEu: "minerva-cf-files-eu",
			container: "minerva-cf-sandbox",
			lab: "minerva-cf-cm",
		});
	});

	test("the test instance keeps its data names; its download Worker and its lab are renamed", () => {
		expect(namesOf(todaysInstance(true))).toEqual({
			name: "minerva-cf-test",
			app: "minerva-cf-test",
			d1: "minerva-cf-test",
			gateway: "minerva-cf-test",
			download: "minerva-cf-test-files",
			bucket: "minerva-cf-test-files",
			bucketEu: "minerva-cf-test-files-eu",
			container: "minerva-cf-test-sandbox",
			lab: "minerva-cf-test-cm",
		});
	});
});
