/** The signed-in user's password and two-factor settings. Each takes the password again, as the server requires. */
import { AuthError, client, withAuthErrors } from '@/lib/auth-client'

export const account = {
  changePassword: withAuthErrors(async ({ current, next }: { current: string; next: string }) => {
    await client.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
  }),

  twoFactorEnabled: withAuthErrors(async () => (await client.getSession({ query: { disableCookieCache: true } }))?.user.twoFactorEnabled === true),

  /** Starts two-factor setup. It is on only after `confirmTwoFactor` accepts a code from the app. */
  startTwoFactor: withAuthErrors(async (password: string) => {
    const started = await client.twoFactor.enable({ password, method: 'totp' })
    if (started.method !== 'totp') throw new AuthError('The server did not start an authenticator app setup.')
    return { uri: started.totpURI, secret: new URL(started.totpURI).searchParams.get('secret') ?? '', recoveryCodes: started.backupCodes }
  }),

  confirmTwoFactor: withAuthErrors(async (code: string) => {
    await client.twoFactor.verifyTotp({ code: code.replaceAll(/\s+/g, '') })
  }),

  disableTwoFactor: withAuthErrors(async (password: string) => {
    await client.twoFactor.disable({ password })
  }),

  /** Replaces the recovery codes; the server keeps no way to show the old ones again. */
  newRecoveryCodes: withAuthErrors(async (password: string) => (await client.twoFactor.generateBackupCodes({ password })).backupCodes),
}
