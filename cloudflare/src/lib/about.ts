// What a Durable Object says about itself through `about()`, for platform and account checks: its class,
// the name and jurisdiction it was addressed with, and its schema steps (lib/sqlite.ts).

export interface About<Kind extends string> {
	kind: Kind;
	name: string | null;
	jurisdiction: string | null;
	migrations: number[];
}

export function identity(ctx: DurableObjectState): { name: string | null; jurisdiction: string | null } {
	return { name: ctx.id.name ?? null, jurisdiction: ctx.id.jurisdiction ?? null };
}
