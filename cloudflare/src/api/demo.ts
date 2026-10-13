// The demo's endpoints, off: the Worker has no demo mode. `GET /api/demo/config` gives the
// off answer the frontend checks on the sign-in pages, and the gate and email endpoints answer 404 after
// the router's CSRF check and their body's validation.

import { z } from "zod";
import { detail, json } from "../http/errors.ts";
import type { App } from "../http/router.ts";
import { readBody } from "./input.ts";

const GateIn = z.object({ token: z.string(), newsletter: z.boolean() });
const EmailIn = z.object({ email: z.string() });

export function demoRoutes(app: App): void {
	app.get("/api/demo/config", () => json(200, { enabled: false, turnstile_site_key: null, providers: [] }));
	app.post("/api/demo/gate", async (c) => {
		await readBody(c.req.raw, GateIn);
		return detail(404, "Not found.");
	});
	app.post("/api/demo/email", async (c) => {
		await readBody(c.req.raw, EmailIn);
		return detail(404, "Not found.");
	});
}
