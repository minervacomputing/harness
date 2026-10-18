// Todoist: the smallest whole connector, one flat
// kind (projects, with wildcard grants) and OAuth with dynamic client registration.
//
// - Tasks are read and created in projects; a task's project is its resource. `get_task` only learns the
//   project by fetching the task, so it fetches in prepare, and a task that is missing or forbidden is
//   refused as an ungranted one, so a refusal does not reveal whether it exists.
// - A created task's record carries the project Todoist put it in, and is filtered by that project.
// - Searching uses Todoist's filter query, which is account wide: the results are kept to the project.
// - Discovery lists Todoist's own pages, or, with a search, every project (at most 20 pages), whose names
//   are matched ignoring case (`toLowerCase`).
//
// The registration request, the token exchange and the refresh are Laravel's generic OAuth flow, read from the
// catalog (internal/catalog.ts); this declares their endpoints, its one scope and the defaults it relies on
// (form-encoded token requests with the client in the body, PKCE).

import { z } from "zod";
import {
	type Binding,
	type Connector,
	type DiscoveryItem,
	OperationError,
	type Prepared,
	type ScopedRecord,
	defineOperation,
	denied,
} from "../../gateway/connector.ts";
import { TodoistClient, type TodoistTask } from "./client.ts";
import { extend } from "../../lib/arrays.ts";

export const PROJECT = "project";
export const MAX_PROJECT_PAGES = 20;
export const TOO_MANY_PROJECTS = "This Todoist account has more projects than Minerva can list.";

/** A Todoist project or task id. */
const objectId = () => z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
/** Todoist's filter operators, which a search must not use: replaced with spaces. */
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
			// An empty string falls back to the date.
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

const ListProjects = z.strictObject({});

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

const ListTasks = z.strictObject({
	project_id: objectId(),
	search: z.string().trim().min(1).max(200).nullable().default(null),
	limit: z.int().min(1).max(50).default(30),
	cursor: z.string().trim().max(300).nullable().default(null),
});

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
					// Filter operators become spaces, then the text is trimmed again.
					const text = data.search.replace(FILTER_OPERATORS, " ").trim();
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

const GetTask = z.strictObject({ task_id: objectId() });

const GET_TASK = defineOperation<z.output<typeof GetTask>>({
	name: "get_task",
	title: "Get a task",
	description: "Read one task by ID. Its project must be readable for you.",
	input: GetTask,
	needs: [[PROJECT, "read"]],
	async prepare(binding, data): Promise<Prepared> {
		// The task's project is only known after fetching it. Minerva sees the task; the agent only receives
		// it if that project is allowed. Failures look like denials so existence is not revealed.
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

const CreateTask = z.strictObject({ project_id: objectId(), title: z.string().trim().min(1).max(300) });

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
		// A project can belong to a team's workspace or to no one.
		tenancy: { kind: "unknown" },
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
				const text = query.toLowerCase();
				return { items: (await allProjects(client)).filter((project) => project.name.toLowerCase().includes(text)), nextCursor: null };
			}
			const page = await client.projects(cursor);
			return { items: page.results.map((project) => ({ id: project.id, name: project.name })), nextCursor: page.next_cursor };
		},

		async describe(client, _kind, ids) {
			const wanted = new Set(ids);
			// A Map, then Object.fromEntries: an id such as "__proto__" stays an own key.
			const names = new Map<string, string>();
			for (const project of await allProjects(client)) if (wanted.has(project.id)) names.set(project.id, project.name);
			return Object.fromEntries(names);
		},
	};
}
