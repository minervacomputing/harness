import { oc, type } from '@orpc/contract'
import { z } from 'zod'
import { ERRORS } from './errors.ts'
import { uuid } from './ids.ts'

/** A workspace the user belongs to, with their role in it. */
export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['personal', 'team']),
  role: z.enum(['owner', 'admin', 'member']),
})
export type Workspace = z.infer<typeof Workspace>

/** The signed-in user and their workspaces, personal first. `role` is `admin` for an instance admin, which grants no workspace. */
export const Me = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string(), role: z.enum(['admin', 'user']) }),
  workspaces: z.array(Workspace),
})
export type Me = z.infer<typeof Me>

/** Whether anyone may sign up now: the admins' choice (`signupOpenOverride`, null to follow the server's configuration), else the configuration. */
export const InstanceSettings = z.object({ signupOpen: z.boolean(), signupOpenOverride: z.boolean().nullable(), signupOpenConfigured: z.boolean() })
export type InstanceSettings = z.infer<typeof InstanceSettings>

export const InstanceAdmin = z.object({ id: z.string(), email: z.string(), name: z.string() })
export type InstanceAdmin = z.infer<typeof InstanceAdmin>

/**
 * The header that carries the operator's setup key: to claim the setup, and on Better Auth's sign-up, where it admits the operator's
 * account on a server whose sign-up is closed until setup is done. A header, so the key is never in a body, a URL or a stored step.
 */
export const SETUP_KEY_HEADER = 'X-Minerva-Setup-Key'

const api = oc.errors(ERRORS)

/** Who is signed in; `UNAUTHORIZED` for a visitor. */
export const me = api.route({ method: 'GET', path: '/me' }).output(Me)

export const setup = {
  /** Whether the first-run setup is still open. The one route a visitor may call; it says nothing else about the server. */
  status: api.route({ method: 'GET', path: '/setup' }).output(z.object({ needed: z.boolean() })),
  /**
   * Makes the signed-in caller the first instance admin, once: `INVALID_SETUP_KEY` for another key, `ALREADY_SET_UP` once anyone has
   * claimed it (also when that admin is gone).
   */
  claim: api
    .route({ method: 'POST', path: '/setup', successStatus: 204, inputStructure: 'detailed' })
    .input(z.object({ headers: z.object({ 'x-minerva-setup-key': z.string().min(1).max(500) }) }))
    .output(type<void>()),
}

// Every route under /instance is for instance admins (`INSTANCE_ADMINS_ONLY`), whose role is read from the database on every request.
export const instance = {
  settings: {
    get: api.route({ method: 'GET', path: '/instance/settings' }).output(InstanceSettings),
    /** `signupOpen: null` follows the server's configuration again. */
    update: api
      .route({ method: 'PATCH', path: '/instance/settings' })
      .input(z.object({ signupOpen: z.boolean().nullable() }))
      .output(type<InstanceSettings>()),
  },
  admins: {
    list: api.route({ method: 'GET', path: '/instance/admins' }).output(z.array(InstanceAdmin)),
    /** Makes the account with this address an admin (`NO_SUCH_USER` if none has it); answers the admins. */
    add: api
      .route({ method: 'POST', path: '/instance/admins' })
      .input(z.object({ email: z.string().min(1).max(254) }))
      .output(type<InstanceAdmin[]>()),
    /** `NOT_FOUND` for a user who is not an admin, `KEEP_ONE_ADMIN` for the last one. The account stays. */
    remove: api
      .route({ method: 'DELETE', path: '/instance/admins/{userId}', successStatus: 204 })
      .input(z.object({ userId: uuid() }))
      .output(type<void>()),
  },
}
