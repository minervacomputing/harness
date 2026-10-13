// HubSpot's answers, under the names HubSpot sends. Fields not named here are dropped; a field of another
// type makes the answer unexpected. Record properties are kept in a Map, so a property named "__proto__"
// is an ordinary key.

import { z } from "zod";
import { isDict } from "../../lib/json.ts";

/** Property values: strings, or null for a property the record does not have. */
const PropertyMap = () =>
	z
		.custom<{ [name: string]: string | null }>((value) => isDict(value) && Object.values(value).every((item) => item === null || typeof item === "string"))
		.transform((value) => new Map(Object.entries(value)))
		.default(() => new Map());

export const Details = z.object({
	portalId: z.int(),
	portalName: z.string().nullable().default(null),
	uiDomain: z.string().nullable().default(null),
});
export type Details = z.infer<typeof Details>;

/** A CRM record. */
export const HubRecord = z.object({
	id: z.string(),
	properties: PropertyMap(),
	archived: z.boolean().default(false),
});
export type HubRecord = z.infer<typeof HubRecord>;

export const SearchPage = z.object({
	total: z.int().default(0),
	results: z.array(HubRecord).default([]),
	paging: z.object({ next: z.object({ after: z.string() }).nullable().default(null) }).nullable().default(null),
});
export type SearchPage = z.infer<typeof SearchPage>;

export const Batch = z.object({ results: z.array(HubRecord).default([]) });

const Stage = z.object({
	id: z.string(),
	label: z.string(),
	displayOrder: z.int().default(0),
	archived: z.boolean().default(false),
	metadata: PropertyMap(),
});

export const Pipeline = z.object({
	id: z.string(),
	label: z.string(),
	displayOrder: z.int().default(0),
	archived: z.boolean().default(false),
	stages: z.array(Stage).default([]),
});
export type Pipeline = z.infer<typeof Pipeline>;

export const Pipelines = z.object({ results: z.array(Pipeline).default([]) });

/** Sorted by display order, stable. */
export function byDisplayOrder<T extends { displayOrder: number }>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => a.displayOrder - b.displayOrder);
}
