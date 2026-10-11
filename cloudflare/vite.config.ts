import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The Worker's static assets are the frontend's production build plus public/_headers, which
// `pnpm assets` copies into .assets/. The plugin serves them and, with no index.html at the root,
// builds no client of its own.
export default defineConfig({
	publicDir: ".assets",
	plugins: [cloudflare()],
});
