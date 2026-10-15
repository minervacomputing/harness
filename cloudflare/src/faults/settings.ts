// The settings a deployed test build (mode `faults`) has unless its vars file sets them (cloudflare.config.ts): the internal
// API on, behind an Access issuer it never asks (index.ts refuses every assertion), and Laravel at the fake the
// FaultProvider hosts (laravel.ts). No imports, so the build's config and the account tests' driver can read it in Node.

export const FAULTS_SETTINGS = {
	MINERVA_ENVIRONMENT: "faults",
	MINERVA_ACCESS_ISSUER: "https://faults.cloudflareaccess.example",
	MINERVA_ACCESS_AUDIENCE: "faults",
	MINERVA_ACCESS_CLIENTS: "faults",
	MINERVA_LARAVEL_URL: "https://laravel.fake.invalid",
} as const;

/** The host of the fake Laravel: requests to it go to the FaultProvider of the workspace they name. */
export const LARAVEL_HOST = new URL(FAULTS_SETTINGS.MINERVA_LARAVEL_URL).hostname;
