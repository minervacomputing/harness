// What one browser request to Better Auth's routes has learned so far, for the policy (policy.ts) whose
// hooks run inside it: Better Auth calls our password hash and database hooks without saying which
// request they serve, so handleAuth (auth.ts) runs each request in a scope of its own. Code outside such
// a request (seed, our routes reading the session) has no scope, and the policy treats it as our own.

import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "./rate-limits.ts";

/** The session a request carries, as Better Auth read it, with the credential stamp it was made with. */
export interface Holder {
	sessionId: string;
	userId: string;
	email: string;
	stamp: string;
}

export interface AuthScope {
	/** Set by the policy's before hook on the routes that act for a signed-in user. */
	holder: Holder | null;
	/** The password hash this request verified (a sign-in), after any rehash. */
	verifiedHash?: string;
	/** The password hash this request wrote (a password change or reset). */
	writtenHash?: string;
	/** The address a first factor was given: the session is stamped with it, not with whatever is stored. */
	claimedEmail?: string;
	/** A first factor that succeeded: the stamp its session, or its two-factor challenge, gets. */
	signIn?: { userId: string; stamp: string };
	/** The two-factor challenge this request answers: its user and the stamp kept with it. */
	challenge?: { userId: string; stamp: string; identifier: string };
	/** A TOTP code this request claimed the time step of (totp.ts); a session from verify-totp needs it. */
	totpClaimed?: boolean;
	/** A sign-up the policy admitted (sign-up open, or the setup key before setup): only it creates a user. */
	signupAdmitted?: boolean;
	/** A password sign-in counted against the address's failed logins, taken back unless it failed. */
	loginUsage?: Usage;
}

const storage = new AsyncLocalStorage<AuthScope>();

export function runInScope<T>(scope: AuthScope, fn: () => Promise<T>): Promise<T> {
	return storage.run(scope, fn);
}

export function currentScope(): AuthScope | undefined {
	return storage.getStore();
}
