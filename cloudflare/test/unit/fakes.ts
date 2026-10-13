// Test-only connectors that exercise the contract beyond what one real connector needs. `mixed` has two kinds (one without wildcards), an operation that needs
// different actions on two resources, and an operation gated by provider consent; `mode` switches it into
// deliberately broken declarations of requirements, which the executor must reject. `keyed`
// authenticates with an API key and acts on its account. The provider is an in-memory `FakeServer`; the
// executor's tests (step 2b) put it behind ProviderHttp and an injected `fetch`.

import { z } from "zod";
import type { Connector, DiscoveryPage, Operation, Prepared, ProviderClient, Requirement } from "../../src/contracts/connectors.ts";
import { ACCOUNT_KIND, OperationError, defineOperation } from "../../src/gateway/connector.ts";

export const FOLDER = "folder";
export const LABEL = "label";

const Id = () => z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/);

/** One in-memory provider. */
export class FakeServer {
	folders: { [id: string]: string } = { inbox: "Inbox", archive: "Archive", secret: "Secret" };
	labels: { [id: string]: string } = { red: "Red", blue: "Blue" };
	calls: [method: string, path: string][] = [];
	copies: { source: string; dest: string; name: string }[] = [];
	mode: "ok" | "omit-source" | "enumerate-write" | "foreign-record" = "ok";
}

export interface FakeClient extends ProviderClient {
	server: FakeServer;
	secret: string;
}

function fakeClient(server: FakeServer, secret: string): FakeClient {
	return { server, secret, close: async () => {} };
}

const ListInput = z.strictObject({});
const CopyFile = z.strictObject({ source: Id(), dest: Id(), name: z.string().trim().min(1).max(100) });

function mixedOperations(server: FakeServer): Operation<never>[] {
	return [
		defineOperation<z.output<typeof ListInput>>({
			name: "list_folders",
			title: "List folders",
			description: "Lists folders.",
			input: ListInput,
			needs: [[FOLDER, "read"]],
			async prepare(binding): Promise<Prepared> {
				return {
					requirements: [{ enumerate: FOLDER, action: "read" }],
					async execute() {
						server.calls.push(["GET", "/folders"]);
						const records = Object.entries(server.folders).map(([id, name]) => ({ resource: binding.resource(FOLDER, id), data: { id, name } }));
						if (server.mode === "foreign-record") {
							records.push({ resource: binding.resource(LABEL, "red"), data: { id: "red", name: "Red" } });
							records.push({ resource: { ...binding.resource(FOLDER, "inbox"), connectionId: "other" }, data: { id: "x", name: "x" } });
						}
						return { records };
					},
				};
			},
		}),
		defineOperation<z.output<typeof CopyFile>>({
			name: "copy_file",
			title: "Copy a file",
			description: "Copies a file from one folder into another.",
			input: CopyFile,
			needs: [
				[FOLDER, "read"],
				[FOLDER, "create"],
			],
			mutates: true,
			async prepare(binding, data): Promise<Prepared> {
				const source: Requirement = { need: binding.resource(FOLDER, data.source), action: "read" };
				const dest: Requirement = { need: binding.resource(FOLDER, data.dest), action: "create" };
				const requirements: Requirement[] =
					server.mode === "omit-source" ? [dest] : server.mode === "enumerate-write" ? [{ enumerate: FOLDER, action: "read" }, dest] : [source, dest];
				return {
					requirements,
					async execute() {
						server.calls.push(["POST", "/copies"]);
						server.copies.push({ ...data });
						return { records: [{ resource: binding.resource(FOLDER, data.dest), data: { id: `copy-${server.copies.length}`, ...data } }] };
					},
				};
			},
		}),
		defineOperation<z.output<typeof ListInput>>({
			name: "list_labels",
			title: "List labels",
			description: "Lists labels.",
			input: ListInput,
			needs: [[LABEL, "read"]],
			consent: [["labels"]],
			async prepare(binding): Promise<Prepared> {
				return {
					requirements: [{ enumerate: LABEL, action: "read" }],
					async execute() {
						server.calls.push(["GET", "/labels"]);
						return { records: Object.entries(server.labels).map(([id, name]) => ({ resource: binding.resource(LABEL, id), data: { id, name } })) };
					},
				};
			},
		}),
	];
}

export function mixedConnector(server = new FakeServer()): Connector<FakeClient> {
	return {
		slug: "mixed",
		name: "Mixed",
		kinds: [
			{ id: FOLDER, label: "Folder", actions: ["read", "create"], wildcard: true },
			{ id: LABEL, label: "Label", actions: ["read"] },
		],
		actions: [
			{ id: "read", label: "Read" },
			{ id: "create", label: "Create", requires: "read" },
		],
		auth: { type: "oauth2", app: "mixed", authorizeUrl: "https://mixed.example/authorize", tokenUrl: "https://mixed.example/token", scopes: ["files", "labels"] },
		operations: mixedOperations(server),
		client: (secret) => fakeClient(server, secret),
		async account(client) {
			client.server.calls.push(["GET", "/me"]);
			return { id: "acct-1", label: "Fake account" };
		},
		async discover(client, kind, { query }): Promise<DiscoveryPage> {
			client.server.calls.push(["GET", kind === FOLDER ? "/folders" : "/labels"]);
			const items = Object.entries(kind === FOLDER ? client.server.folders : client.server.labels).map(([id, name]) => ({ id, name }));
			return { items: query ? items.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())) : items };
		},
		async describe(client, kind, ids) {
			const page = await this.discover(client, kind, { query: null, cursor: null });
			return Object.fromEntries(page.items.filter((item) => ids.includes(item.id)).map((item) => [item.id, item.name]));
		},
	};
}

export interface Changes {
	[operation: string]: Partial<Operation<never>>;
}

/** The mixed connector with some attributes or operations replaced. */
export function variant(attrs: Partial<Connector<FakeClient>> & { changes?: Changes } = {}): Connector<FakeClient> {
	const { changes = {}, ...rest } = attrs;
	const connector = { ...mixedConnector(), ...rest };
	return { ...connector, operations: connector.operations.map((op) => ({ ...op, ...changes[op.name] })) };
}

const Whoami = z.strictObject({});

export function keyedConnector(server = new FakeServer()): Connector<FakeClient> {
	return {
		slug: "keyed",
		name: "Keyed",
		kinds: [{ id: ACCOUNT_KIND, label: "Account", actions: ["read"] }],
		actions: [{ id: "read", label: "Read" }],
		auth: { type: "api_key", label: "API key" },
		operations: [
			defineOperation<z.output<typeof Whoami>>({
				name: "whoami",
				title: "Who am I",
				description: "Shows the account.",
				input: Whoami,
				needs: [[ACCOUNT_KIND, "read"]],
				async prepare(binding): Promise<Prepared> {
					return {
						requirements: [{ need: binding.account(), action: "read" }],
						async execute() {
							server.calls.push(["GET", "/me"]);
							return { records: [{ resource: binding.account(), data: { id: "acct-1", name: "Fake account" } }] };
						},
					};
				},
			}),
		],
		client: (secret) => fakeClient(server, secret),
		async account(client) {
			client.server.calls.push(["GET", "/me"]);
			return { id: "acct-1", label: "Fake account" };
		},
		async discover() {
			throw new OperationError("NOT_SUPPORTED", "Nothing to discover.");
		},
		async describe() {
			return {};
		},
	};
}
