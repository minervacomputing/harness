// Cheap scrypt for the accounts the platform tests create: a production hash costs about 90 ms, and some
// files hash hundreds of passwords. Nothing in a deployment sets this (passwords.ts HASHING). A test that
// resets the module registry (`vi.resetModules()`) gets a fresh passwords module with production's
// parameters, and calls this again. Tests of rehashing and of production's parameters restore SCRYPT around
// themselves (accounts-helpers.ts); test/unit/accounts.test.ts checks them in Node.

export async function useCheapHashing(): Promise<void> {
	const { HASHING } = await import("../../src/accounts/passwords.ts");
	HASHING.params = { logN: 10, r: 8, p: 1 };
}
