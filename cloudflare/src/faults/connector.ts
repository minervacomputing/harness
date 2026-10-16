// The fake connector of the test build (src/faults/): "Notes", an OAuth provider with folders of notes,
// over ProviderHTTP against the FaultProvider object (provider.ts), so a call goes through the executor's
// whole pipeline, its write accounting and the ledger exactly as a real connector's would. `save_note`
// takes free-form details (`meta`), whose key order survives validation, so a retry spelled in another
// order reaches the write key as sent; `file_note` reads the note back after saving it, a second request
// of the same call. Never part of the production Worker: only src/faults/index.ts and the tests import it.

import { z } from "zod";
import { type Connector, type Prepared, type ProviderOutput, defineOperation } from "../gateway/connector.ts";
import { ProviderHTTP } from "../gateway/http.ts";
import type { Json } from "../lib/json.ts";
import { record } from "../lib/schema.ts";
import { FOLDER, NOTES } from "./world.ts";

/** The provider's origin: any `*.fake.invalid` request of the test build goes to its FaultProvider. */
export const NOTES_ORIGIN = "https://notes.fake.invalid";
export const NOTES_TOKEN_URL = `${NOTES_ORIGIN}/token`;

const Id = () => z.string().trim().min(1).max(40).regex(/^[a-z0-9-]+$/);
const ListNotes = z.strictObject({ folder: Id() });
const SaveNote = z.strictObject({ folder: Id(), title: z.string().trim().min(1).max(200), meta: record(z.string().trim().max(200), { max: 10 }).optional() });
const FileNote = z.strictObject({ folder: Id(), title: z.string().trim().min(1).max(200) });
const Notes = z.array(z.object({ id: z.string(), title: z.string() }));
const Note = z.object({ id: z.string(), title: z.string() });

export function notesConnector(): Connector<ProviderHTTP> {
	return {
		slug: NOTES,
		name: "Notes",
		kinds: [{ id: FOLDER, label: "Folder", actions: ["read", "create"], wildcard: true }],
		actions: [
			{ id: "read", label: "Read notes" },
			{ id: "create", label: "Create notes", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: NOTES,
			authorizeUrl: `${NOTES_ORIGIN}/authorize`,
			tokenUrl: NOTES_TOKEN_URL,
			scopes: ["notes"],
		},
		operations: [
			defineOperation<z.output<typeof ListNotes>>({
				name: "list_notes",
				title: "List notes",
				description: "Lists the notes in a folder. Folders are named like inbox or archive.",
				input: ListNotes,
				needs: [[FOLDER, "read"]],
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.resource(FOLDER, data.folder), action: "read" }],
						async execute(): Promise<ProviderOutput> {
							const notes = await http.parsed({ method: "GET", path: `/folders/${data.folder}/notes` }, Notes);
							return { records: notes.map((note) => ({ resource: binding.resource(FOLDER, data.folder), data: note as { [key: string]: Json } })) };
						},
					};
				},
			}),
			defineOperation<z.output<typeof SaveNote>>({
				name: "save_note",
				title: "Save a note",
				description: "Saves a new note with a title in a folder.",
				input: SaveNote,
				needs: [[FOLDER, "create"]],
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.resource(FOLDER, data.folder), action: "create" }],
						async execute(): Promise<ProviderOutput> {
							const body = { title: data.title, ...(data.meta ? { meta: data.meta as { [key: string]: Json } } : {}) };
							const note = await http.parsed({ method: "POST", path: `/folders/${data.folder}/notes`, json: body }, Note);
							return { records: [{ resource: binding.resource(FOLDER, data.folder), data: note as { [key: string]: Json } }] };
						},
					};
				},
			}),
			defineOperation<z.output<typeof FileNote>>({
				name: "file_note",
				title: "File a note",
				description: "Saves a new note with a title in a folder, then reads it back.",
				input: FileNote,
				needs: [[FOLDER, "create"]],
				mutates: true,
				async prepare(binding, data): Promise<Prepared> {
					const http = binding.client as ProviderHTTP;
					return {
						requirements: [{ need: binding.resource(FOLDER, data.folder), action: "create" }],
						async execute(): Promise<ProviderOutput> {
							const saved = await http.parsed({ method: "POST", path: `/folders/${data.folder}/notes`, json: { title: data.title } }, Note);
							const note = await http.parsed({ method: "GET", path: `/notes/${saved.id}` }, Note);
							return { records: [{ resource: binding.resource(FOLDER, data.folder), data: note as { [key: string]: Json } }] };
						},
					};
				},
			}),
		],
		// Five minutes per phase, not the 20 s default: the account's long-tool test holds a read across
		// several of PiHarness's 30 s heartbeats.
		client: (secret, io) => new ProviderHTTP(io, { provider: "Notes", baseUrl: NOTES_ORIGIN, headers: { Authorization: `Bearer ${secret}` }, timeout: 300 }),
		async account(http) {
			const me = (await http.json({ method: "GET", path: "/me" })) as { id: string; name: string };
			return { id: me.id, label: me.name };
		},
		async discover(http) {
			const items = (await http.json({ method: "GET", path: "/folders" })) as { id: string; name: string }[];
			return { items };
		},
		async describe(http, _kind, ids) {
			const items = (await http.json({ method: "GET", path: "/folders" })) as { id: string; name: string }[];
			return Object.fromEntries(items.filter((item) => ids.includes(item.id)).map((item) => [item.id, item.name]));
		},
	};
}
