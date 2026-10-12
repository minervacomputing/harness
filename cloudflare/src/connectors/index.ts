// The connectors this Worker serves, in one registry per isolate that the Workspace (ConnectionOut, grants,
// run snapshots and their fingerprints) and the Conversation's executor (declarations and calls) share, so
// both read the same contracts. Step 6 adds the 20 connectors to CONNECTORS. A test build (src/faults/)
// and the platform tests add fake connectors through `CONNECTOR_SOURCE` before any object reads it.

import type { Connector } from "../contracts/connectors.ts";
import { Registry } from "../gateway/registry.ts";
import { todoistConnector } from "./todoist/connector.ts";
import { stripeConnector } from "./stripe/connector.ts";
import { confluenceConnector } from "./confluence/connector.ts";
import { jiraConnector } from "./jira/connector.ts";
import { linear } from "./linear/connector.ts";
import { slackConnector } from "./slack/connector.ts";
import { githubConnector } from "./github/connector.ts";
import { notionConnector } from "./notion/connector.ts";
import { hubspotConnector } from "./hubspot/connector.ts";
import { intercom } from "./intercom/connector.ts";
import { xeroConnector } from "./xero/connector.ts";
import { sentryConnector } from "./sentry/connector.ts";
import { googleCalendarConnector } from "./google_calendar/connector.ts";
import { googleDriveConnector } from "./google_drive/connector.ts";
import { gmailConnector } from "./gmail/connector.ts";
import { outlookConnector } from "./outlook/connector.ts";
import { outlookCalendarConnector } from "./outlook_calendar/connector.ts";
import { onedriveConnector } from "./onedrive/connector.ts";
import { teamsConnector } from "./teams/connector.ts";
import { webConnector } from "./web/connector.ts";

export const CONNECTORS: readonly Connector[] = [
	todoistConnector(),
	stripeConnector(),
	jiraConnector(),
	confluenceConnector(),
	linear,
	slackConnector(),
	githubConnector(),
	notionConnector(),
	hubspotConnector(),
	intercom,
	xeroConnector(),
	sentryConnector(),
	googleCalendarConnector(),
	googleDriveConnector(),
	gmailConnector(),
	outlookConnector(),
	outlookCalendarConnector(),
	onedriveConnector(),
	teamsConnector(),
	webConnector(),
];

/** Where the registry's connectors come from; replaced only by a test build and by tests. */
export const CONNECTOR_SOURCE: { connectors: () => readonly Connector[] } = { connectors: () => CONNECTORS };

let built: { source: () => readonly Connector[]; registry: Promise<Registry> } | null = null;

/** Built once per isolate (fingerprints are hashed when it is created), again only if the source changed. */
export function connectorRegistry(): Promise<Registry> {
	const source = CONNECTOR_SOURCE.connectors;
	if (built === null || built.source !== source) built = { source, registry: Registry.create(source()) };
	return built.registry;
}
