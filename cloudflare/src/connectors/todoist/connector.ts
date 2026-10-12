// Todoist, ported from backend/connectors/todoist/connector.py: the smallest whole connector, one flat
// kind (projects, with wildcard grants) and OAuth with dynamic client registration (connectors 12.1).
//
// - Tasks are read and created in projects; a task's project is its resource. `get_task` only learns the
//   project by fetching the task, so it fetches in prepare, and a task that is missing or forbidden is
//   refused as an ungranted one, so a refusal does not reveal whether it exists.
// - A created task's record carries the project Todoist put it in, and is filtered by that project.
// - Searching uses Todoist's filter query, which is account wide: the results are kept to the project.
// - Discovery lists Todoist's own pages, or, with a search, every project (at most 20 pages), whose names
//   are matched case-folded as Python folds (lib/casefold.ts).
//
// The registration request, the token exchange and the refresh are the generic OAuth flow's
// (workspace/credentials.ts; the authorize and registration steps come with the API); this declares their
// endpoints, its one scope and the defaults it relies on (form-encoded token requests with the client in
// the body, PKCE).

import { z } from "zod";
import type { Binding, Connector, DiscoveryItem, Prepared, ScopedRecord } from "../../contracts/connectors.ts";
import { OperationError, defineOperation, denied } from "../../gateway/connector.ts";
import { strippedStr } from "../../lib/schema.ts";
import { pythonStrip } from "../../lib/text.ts";
import { casefold } from "../../lib/casefold.ts";
import { TodoistClient, type TodoistTask } from "./client.ts";
import { extend } from "../../lib/arrays.ts";

export const PROJECT = "project";
export const MAX_PROJECT_PAGES = 20;
export const TOO_MANY_PROJECTS = "This Todoist account has more projects than Minerva can list.";

/**
 * Inputs carry Pydantic's titles, each field's ("project_id" is "Project Id") and the model's at the root,
 * so the input schema the model sees is today's, and arguments that are not an object are refused with
 * the model's name, as Pydantic refuses them.
 */
const ObjectId = (title: string) => strippedStr({ min: 1, max: 160 }).regex(/^[A-Za-z0-9_-]+$/).meta({ title });
/** Todoist's filter operators, which a search must not use: replaced with spaces (connector.py `_prepare_list_tasks`). */
const FILTER_OPERATORS = /[&|!()#@,\\]/g;

function clientOf(binding: Binding): TodoistClient {
	return binding.client as TodoistClient;
}

/** `_task`: a task as the agent sees it, on the project Todoist says it is in. */
function taskRecord(binding: Binding, task: TodoistTask): ScopedRecord {
	return {
		resource: binding.resource(PROJECT, task.project_id),
		data: {
			id: task.id,
			project_id: task.project_id,
			title: task.content,
			description: task.description,
			priority: task.priority,
			// Python's `or`: an empty string falls back to the date.
			due: task.due ? task.due.string || task.due.date : null,
			completed: task.checked,
		},
	};
}

/** Every project of the account, following Todoist's cursor for at most MAX_PROJECT_PAGES pages. */
async function allProjects(client: TodoistClient): Promise<DiscoveryItem[]> {
	const items: DiscoveryItem[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
		const { results, next_cursor } = await client.projects(cursor);
		extend(items, results.map((project) => ({ id: project.id, name: project.name })));
		if (!next_cursor) return items;
		cursor = next_cursor;
	}
	throw new OperationError("PROVIDER_LIMIT", TOO_MANY_PROJECTS);
}

const ListProjects = z.strictObject({}).meta({ title: "ListProjects" });

const LIST_PROJECTS = defineOperation<z.output<typeof ListProjects>>({
	name: "list_projects",
	title: "List projects",
	description: "List the Todoist projects you may access.",
	input: ListProjects,
	needs: [[PROJECT, "read"]],
	async prepare(binding): Promise<Prepared> {
		return {
			requirements: [{ enumerate: PROJECT, action: "read" }],
			async execute() {
				const projects = await allProjects(clientOf(binding));
				return { records: projects.map((project) => ({ resource: binding.resource(PROJECT, project.id), data: { id: project.id, name: project.name } })) };
			},
		};
	},
});

const ListTasks = z
	.strictObject({
		project_id: ObjectId("Project Id"),
		search: strippedStr({ min: 1, max: 200 }).nullable().default(null).meta({ title: "Search" }),
		limit: z.int().min(1).max(50).default(30).meta({ title: "Limit" }),
		cursor: strippedStr({ max: 300 }).nullable().default(null).meta({ title: "Cursor" }),
	})
	.meta({ title: "ListTasks" });

const LIST_TASKS = defineOperation<z.output<typeof ListTasks>>({
	name: "list_tasks",
	title: "List tasks",
	description:
		"List active tasks in one project you may read. Optionally filter by search text. " +
		"To get the next page, repeat the call with identical arguments plus the returned next_cursor.",
	input: ListTasks,
	needs: [[PROJECT, "read"]],
	paginated: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: binding.resource(PROJECT, data.project_id), action: "read" }],
			async execute() {
				const client = clientOf(binding);
				const options = { cursor: data.cursor, limit: data.limit };
				let tasks: TodoistTask[];
				let next: string | null;
				if (data.search) {
					// Stripped as Python's `str.strip()` strips, after the input's own stripping (lib/schema.ts).
					const text = pythonStrip(data.search.replace(FILTER_OPERATORS, " "));
					const page = await client.filterTasks(`search: ${text}`, options);
					// The filter is account wide.
					tasks = page.results.filter((task) => task.project_id === data.project_id);
					next = page.next_cursor;
				} else {
					const page = await client.tasks(data.project_id, options);
					tasks = page.results;
					next = page.next_cursor;
				}
				return { records: tasks.map((task) => taskRecord(binding, task)), nextCursor: next };
			},
		};
	},
});

const GetTask = z.strictObject({ task_id: ObjectId("Task Id") }).meta({ title: "GetTask" });

const GET_TASK = defineOperation<z.output<typeof GetTask>>({
	name: "get_task",
	title: "Get a task",
	description: "Read one task by ID. Its project must be readable for you.",
	input: GetTask,
	needs: [[PROJECT, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		// The task's project is only known after fetching it. The backend sees the task; the agent only
		// receives it if that project is allowed. Failures look like denials so existence is not revealed.
		let task: TodoistTask;
		try {
			task = await clientOf(binding).task(data.task_id);
		} catch (error) {
			if (error instanceof OperationError && (error.code === "NOT_FOUND" || error.code === "PROVIDER_FORBIDDEN")) throw denied();
			throw error;
		}
		if (task.id !== data.task_id) throw denied();
		return {
			requirements: [{ need: binding.resource(PROJECT, task.project_id), action: "read" }],
			async execute() {
				return { records: [taskRecord(binding, task)] };
			},
		};
	},
});

const CreateTask = z
	.strictObject({ project_id: ObjectId("Project Id"), title: strippedStr({ min: 1, max: 300 }).meta({ title: "Title" }) })
	.meta({ title: "CreateTask" });

const CREATE_TASK = defineOperation<z.output<typeof CreateTask>>({
	name: "create_task",
	title: "Create a task",
	description: "Create one task in a project where you have create permission. Give an explicit project_id and title.",
	input: CreateTask,
	needs: [[PROJECT, "create"]],
	mutates: true,
	async prepare(binding, data): Promise<Prepared> {
		return {
			requirements: [{ need: binding.resource(PROJECT, data.project_id), action: "create" }],
			async execute() {
				// The record carries the project Todoist actually used; the executor filters it by that.
				const task = await clientOf(binding).createTask(data.project_id, data.title);
				return { records: [taskRecord(binding, task)] };
			},
		};
	},
});

/** A fresh declaration; the registry freezes the one it is given. */
export function todoistConnector(): Connector<TodoistClient> {
	return {
		slug: "todoist",
		name: "Todoist",
		kinds: [{ id: PROJECT, label: "Project", actions: ["read", "create"], wildcard: true }],
		actions: [
			{ id: "read", label: "Read tasks" },
			{ id: "create", label: "Create tasks", requires: "read" },
		],
		auth: {
			type: "oauth2",
			app: "todoist",
			authorizeUrl: "https://app.todoist.com/oauth/authorize",
			tokenUrl: "https://api.todoist.com/oauth/access_token",
			scopes: ["data:read_write"],
			registrationUrl: "https://api.todoist.com/oauth/register",
		},
		operations: [LIST_PROJECTS, LIST_TASKS, GET_TASK, CREATE_TASK],

		client(accessToken, io) {
			return new TodoistClient(accessToken, io);
		},

		async account(client) {
			const user = await client.user();
			return { id: user.id, label: user.full_name || user.email || "Todoist" };
		},

		async discover(client, _kind, { query, cursor }) {
			if (query) {
				const text = casefold(query);
				return { items: (await allProjects(client)).filter((project) => casefold(project.name).includes(text)), nextCursor: null };
			}
			const page = await client.projects(cursor);
			return { items: page.results.map((project) => ({ id: project.id, name: project.name })), nextCursor: page.next_cursor };
		},

		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			// A Map, then Object.fromEntries: an id such as "__proto__" stays a key, and a repeated id keeps its
			// first place and its last name, as a dict does.
			const names = new Map<string, string>();
			for (const project of await allProjects(client)) if (wanted.has(project.id)) names.set(project.id, project.name);
			return Object.fromEntries(names);
		},
	};
}
