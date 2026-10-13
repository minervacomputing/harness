import { expect, test } from 'vitest'
import type { Allowed, Connection } from '@minerva/contract'
import { setupOf, summarize } from './summary'

const connection = (fields: Partial<Connection>): Connection => ({
  id: 'k1',
  label: 'Work',
  provider: 'google-drive',
  providerName: 'Google Drive',
  auth: 'oauth2',
  status: 'active',
  consentNeeded: [],
  allowed: [allowed({})],
  personal: false,
  manageLabel: null,
  manageUrl: null,
  createdAt: '2026-10-13T10:00:00Z',
  ...fields,
})

function allowed(fields: Partial<Allowed>): Allowed {
  return { action: 'read', actionLabel: 'Read files', kind: 'folder', kindLabel: 'Folder', all: false, count: 1, names: ['My Drive'], ...fields }
}

test('setupOf: a broken connection comes before what the user has left to do', () => {
  expect(setupOf(connection({}))).toEqual({ tone: 'success', label: 'Active', attention: false })
  expect(setupOf(connection({ allowed: [] }))).toMatchObject({ label: 'Not set up', attention: true })
  expect(setupOf(connection({ consentNeeded: ['drive'], allowed: [] }))).toMatchObject({ label: 'Needs permission', attention: true })
  expect(setupOf(connection({ status: 'revoked', consentNeeded: ['drive'] }))).toMatchObject({ tone: 'danger', label: 'Revoked' })
  expect(setupOf(connection({ status: 'error', allowed: [] }))).toMatchObject({ label: 'Needs reconnecting', attention: true })
})

test('summarize: nothing allowed', () => {
  expect(summarize([])).toBe('Nothing allowed yet, so agents cannot use it.')
})

test('summarize: actions on the same resources share one scope', () => {
  const create = allowed({ action: 'create', actionLabel: 'Create files' })
  const remove = allowed({ action: 'delete', actionLabel: 'Delete files' })
  const mail = allowed({ action: 'read_mail', actionLabel: 'Read mail', kind: 'label', kindLabel: 'Label', all: true, names: [] })
  expect(summarize([allowed({}), create, mail])).toBe('Read files and create files in My Drive · Read mail in all labels')
  expect(summarize([allowed({}), create, remove])).toBe('Read files, create files and delete files in My Drive')
})

test('summarize: names beyond those listed are counted, and the account itself has no scope', () => {
  const some = allowed({ names: ['Plans', 'Notes'], count: 5 })
  const account = allowed({ action: 'send', actionLabel: 'Send mail', kind: 'account', kindLabel: 'Account', names: [] })
  expect(summarize([some, account])).toBe('Read files in Plans, Notes and 3 more · Send mail')
})
