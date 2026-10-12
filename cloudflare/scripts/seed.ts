// `make seed` for the local Worker (web-api spec 6.4): creates or resets ada@example.com and
// grace@example.com with the password `password`, verified, without two-factor, and signs out their
// sessions. It asks the running Worker (`POST /api/dev/seed`), which refuses unless MINERVA_DEBUG is on.
//
//   pnpm run seed [url]    # default http://localhost:5173, the frontend's dev server in front of the Worker

const base = new URL(process.argv[2] ?? "http://localhost:5173");

const csrf = await fetch(new URL("/api/csrf", base));
const cookie = csrf.headers.getSetCookie().find((value) => value.startsWith("csrftoken="));
const token = cookie?.slice("csrftoken=".length).split(";")[0];
if (!csrf.ok || !token) {
	console.error(`No CSRF cookie from ${base.origin}/api/csrf (${csrf.status}). Is the Worker running?`);
	process.exit(1);
}

const response = await fetch(new URL("/api/dev/seed", base), {
	method: "POST",
	headers: { Cookie: `csrftoken=${token}`, "X-CSRFToken": token, Origin: base.origin },
});
if (response.status === 404) {
	console.error("Seed accounts have a known password; this only runs with MINERVA_DEBUG=true.");
	process.exit(1);
}
if (!response.ok) {
	console.error(`Seeding failed: ${response.status} ${await response.text()}`);
	process.exit(1);
}
const { lines } = (await response.json()) as { lines: string[] };
for (const line of lines) console.log(line);
