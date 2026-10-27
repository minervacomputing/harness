// The catalog Laravel reads (src/internal/catalog.ts), from the served connectors and from the fakes.

import { Catalog } from "@minerva/contract/internal";
import { expect, test } from "vitest";
import { CONNECTORS } from "../../src/connectors/catalog.ts";
import { priceTable, pricesVersion } from "../../src/budget/prices.ts";
import { askable } from "../../src/gateway/grants.ts";
import { Registry } from "../../src/gateway/registry.ts";
import { catalogOf } from "../../src/internal/catalog.ts";
import { keyedConnector, mixedConnector } from "./fakes.ts";

test("every served connector is in the catalog, as the contract declares it", async () => {
	const catalog = await catalogOf(await Registry.create(CONNECTORS));
	expect(Catalog.parse(catalog)).toEqual(catalog);
	expect(catalog.connectors.map((connector) => connector.slug)).toEqual(CONNECTORS.map((connector) => connector.slug));
	expect(catalog.version).toMatch(/^[0-9a-f]{16}$/);
	for (const connector of CONNECTORS) {
		const entry = catalog.connectors.find((item) => item.slug === connector.slug)!;
		expect(entry.operations.map((op) => op.name)).toEqual(connector.operations.map((op) => op.name));
		if (connector.auth.type !== "oauth2") {
			expect(entry.auth.type).toBe(connector.auth.type);
			continue;
		}
		const auth = connector.auth;
		// The descriptor holds everything a flow needs, the declaration's defaults written out.
		expect(entry.auth).toEqual({
			type: "oauth2",
			client: auth.app,
			authorizeUrl: auth.authorizeUrl,
			tokenUrl: auth.tokenUrl,
			scopes: auth.scopes,
			scopeSeparator: auth.scopeSeparator ?? " ",
			authorizeParams: (auth.authorizeParams ?? []).map(([name, value]) => ({ name, value })),
			loginHint: auth.loginHint ?? false,
			clientAuth: auth.clientAuth ?? "post",
			tokenBody: auth.jsonBody ? "json" : "form",
			pkce: auth.pkce ?? true,
			registrationUrl: auth.registrationUrl ?? null,
		});
	}
	// Todoist registers its own client, and Notion authenticates its token requests with Basic.
	const auth = (slug: string) => catalog.connectors.find((item) => item.slug === slug)!.auth;
	expect(auth("todoist")).toMatchObject({ registrationUrl: expect.stringMatching(/^https:\/\//) });
	expect(auth("notion")).toMatchObject({ clientAuth: "basic" });
});

test("the version names the declarations: the same ones give the same version, any change another", async () => {
	const first = await catalogOf(await Registry.create([mixedConnector(), keyedConnector()]));
	const again = await catalogOf(await Registry.create([mixedConnector(), keyedConnector()]));
	expect(again.version).toBe(first.version);
	const reordered = await catalogOf(await Registry.create([keyedConnector(), mixedConnector()]));
	expect(reordered.version).not.toBe(first.version);
	const renamed = mixedConnector();
	const changed = await catalogOf(await Registry.create([{ ...renamed, name: `${renamed.name} renamed` }, keyedConnector()]));
	expect(changed.version).not.toBe(first.version);
	// The prices have a version of their own: the catalog's stays its connectors'.
	const table = priceTable(null);
	const prices = { version: await pricesVersion(table), table };
	const priced = await catalogOf(await Registry.create([mixedConnector(), keyedConnector()]), prices);
	expect(priced).toEqual({ ...first, prices });
	expect(Catalog.parse(priced)).toEqual(priced);
});

test("each action says whether a grant may ask before it: every write action, never one a read needs", async () => {
	const catalog = await catalogOf(await Registry.create(CONNECTORS));
	const actions = (slug: string) =>
		Object.fromEntries(catalog.connectors.find((entry) => entry.slug === slug)!.actions.map((action) => [action.id, action.askable]));
	expect(actions("gmail")).toEqual({ read: false, send: true, draft: true });
	expect(actions("web")).toEqual({ browse: false });
	for (const entry of catalog.connectors) {
		const connector = CONNECTORS.find((item) => item.slug === entry.slug)!;
		expect(entry.actions.map((action) => action.askable), entry.slug).toEqual(connector.actions.map((action) => askable(connector).has(action.id)));
		expect(entry.actions.find((action) => action.id === "read")?.askable ?? false, entry.slug).toBe(false);
	}
});

test("an operation's terms are what Laravel needs to ask for scopes", async () => {
	const catalog = await catalogOf(await Registry.create([mixedConnector()]));
	const connector = mixedConnector();
	const [entry] = catalog.connectors;
	for (const op of connector.operations) {
		const terms = entry!.operations.find((item) => item.name === op.name)!;
		expect(terms.needs).toEqual(op.needs.map(([kind, action]) => ({ kind, action })));
		expect(terms.consent).toEqual(op.consent ?? null);
		expect(terms.mutates).toBe(op.mutates ?? false);
		expect(terms.offered).toBe(true);
	}
});

test("each connector's tenancy: what a connection policy limits it by", async () => {
	const catalog = await catalogOf(await Registry.create(CONNECTORS));
	const tenancy = Object.fromEntries(catalog.connectors.map((entry) => [entry.slug, entry.tenancy]));
	const account = (label: string) => ({ kind: "account", label });
	const resource = (label: string) => ({ kind: "resource", label });
	expect(tenancy).toEqual({
		confluence: resource("Atlassian site"),
		github: resource("GitHub owner"),
		gmail: account("Google Workspace domain"),
		google_calendar: account("Google Workspace domain"),
		google_drive: account("Google Workspace domain"),
		hubspot: account("HubSpot account"),
		intercom: account("Intercom workspace"),
		jira: resource("Atlassian site"),
		linear: account("Linear workspace"),
		notion: account("Notion workspace"),
		onedrive: account("Microsoft Entra tenant"),
		outlook: account("Microsoft Entra tenant"),
		outlook_calendar: account("Microsoft Entra tenant"),
		sentry: account("Sentry organization"),
		slack: account("Slack workspace"),
		stripe: account("Stripe account"),
		teams: account("Microsoft Entra tenant"),
		todoist: { kind: "unknown", label: null },
		web: resource("domain"),
		xero: resource("Xero organisation"),
	});
});
