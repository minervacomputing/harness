// Every connector this Worker serves, in the order the connectors page lists them. Their modules (operations,
// zod schemas, clients) are loaded only when the registry is first needed (index.ts), not at the Worker's
// startup (cloudflare/README.md, Startup): import this module dynamically, never from code the Worker's entry
// imports statically.

import type { Connector } from "../gateway/connector.ts";
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

// In the order the connectors page lists them.
export const CONNECTORS: readonly Connector[] = [
	todoistConnector(),
	googleCalendarConnector(),
	googleDriveConnector(),
	githubConnector(),
	notionConnector(),
	linear,
	slackConnector(),
	outlookConnector(),
	outlookCalendarConnector(),
	onedriveConnector(),
	teamsConnector(),
	gmailConnector(),
	stripeConnector(),
	hubspotConnector(),
	jiraConnector(),
	confluenceConnector(),
	intercom,
	xeroConnector(),
	sentryConnector(),
	webConnector(),
];
