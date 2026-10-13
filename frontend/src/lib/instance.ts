/**
 * The Worker's instance routes (cloudflare/src/accounts/instance-routes.ts): the first-run setup, and what
 * instance admins change. They are not in the generated client's schema, so they are called through the
 * same client and get its CSRF header, its 401 handling and its error shapes.
 * The server is the authority on every one of them; the pages only decide what to show.
 */
import { queryOptions } from '@tanstack/react-query'
import { client } from '@/api/client.gen'

export type SetupStatus = { needed: boolean }
export type InstanceSettings = {
  /** Whether anyone may sign up now. */
  signup_open: boolean
  /** The admins' choice; null follows the server's configuration. */
  signup_open_override: boolean | null
  signup_open_configured: boolean
}
export type InstanceAdmin = { id: string; email: string; name: string }

/** The header that admits the operator's sign-up on a server whose sign-up is closed, until setup is done. */
export const SETUP_KEY_HEADER = 'X-Minerva-Setup-Key'

/** Whether the first-run setup is still open. Public: the sign-up page reads it to offer the setup key. */
export const setupQuery = queryOptions({
  queryKey: ['instance', 'setup'],
  queryFn: async ({ signal }): Promise<SetupStatus> => (await client.get<{ 200: SetupStatus }, unknown, true>({ url: '/api/setup', signal })).data,
  staleTime: 30_000,
})

export const instanceSettingsQuery = queryOptions({
  queryKey: ['instance', 'settings'],
  queryFn: async ({ signal }): Promise<InstanceSettings> =>
    (await client.get<{ 200: InstanceSettings }, unknown, true>({ url: '/api/instance/settings', signal })).data,
})

export const instanceAdminsQuery = queryOptions({
  queryKey: ['instance', 'admins'],
  queryFn: async ({ signal }): Promise<InstanceAdmin[]> =>
    (await client.get<{ 200: InstanceAdmin[] }, unknown, true>({ url: '/api/instance/admins', signal })).data,
})

/** Claims the setup with the operator's key; the signed-in caller becomes the first admin. The key is sent once and kept nowhere. */
export async function claimSetup(key: string): Promise<void> {
  await client.post<{ 204: void }, unknown, true>({
    url: '/api/setup',
    body: { key },
    headers: { 'Content-Type': 'application/json' },
  })
}

/** `null` follows the server's configuration. */
export async function updateSignupOpen(signupOpen: boolean | null): Promise<InstanceSettings> {
  return (
    await client.patch<{ 200: InstanceSettings }, unknown, true>({
      url: '/api/instance/settings',
      body: { signup_open: signupOpen },
      headers: { 'Content-Type': 'application/json' },
    })
  ).data
}

/** Makes the user with this address an admin; answers the admins. */
export async function addAdmin(email: string): Promise<InstanceAdmin[]> {
  return (
    await client.post<{ 200: InstanceAdmin[] }, unknown, true>({
      url: '/api/instance/admins',
      body: { email },
      headers: { 'Content-Type': 'application/json' },
    })
  ).data
}

/** The server refuses to remove the last admin (422). */
export async function removeAdmin(id: string): Promise<void> {
  await client.delete<{ 204: void }, unknown, true>({ url: '/api/instance/admins/{id}', path: { id } })
}
