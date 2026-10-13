import { expect, test } from 'vitest'
import type { AllowedOut, ConnectionOut } from '@/api/types.gen'
import { setupOf, summarize } from './summary'

const connection = (fields: Partial<ConnectionOut>): ConnectionOut => ({
  id: 'k1',
  label: 'Work',
  provider: 'google-drive',
  provider_name: 'Google Drive',
  auth: 'oauth2',
  status: 'active',
  consent_needed: [],
  allowed: [allowed({})],
  personal: false,
  manage_label: null,
  manage_url: null,
  created_at: '2026-10-13T10:00:00Z',
  ...fields,
})

function allowed(fields: Partial<AllowedOut>): AllowedOut {
  return { action: 'read', action_label: 'Read files', kind: 'folder', kind_label: 'Folder', all: false, count: 1, names: ['My Drive'], ...fields }
}

test('setupOf: a broken connection comes before what the user has left to do', () => {
  expect(setupOf(connection({}))).toEqual({ tone: 'success', label: 'Active', attention: false })
  expect(setupOf(connection({ allowed: [] }))).toMatchObject({ label: 'Not set up', attention: true })
  expect(setupOf(connection({ consent_needed: ['drive'], allowed: [] }))).toMatchObject({ label: 'Needs permission', attention: true })
  expect(setupOf(connection({ status: 'revoked', consent_needed: ['drive'] }))).toMatchObject({ tone: 'danger', label: 'Revoked' })
  expect(setupOf(connection({ status: 'error', allowed: [] }))).toMatchObject({ label: 'Needs reconnecting', attention: true })
})

test('summarize: nothing allowed', () => {
  expect(summarize([])).toBe('Nothing allowed yet, so agents cannot use it.')
})

test('summarize: actions on the same resources share one scope', () => {
  const create = allowed({ action: 'create', action_label: 'Create files' })
  const remove = allowed({ action: 'delete', action_label: 'Delete files' })
  const mail = allowed({ action: 'read_mail', action_label: 'Read mail', kind: 'label', kind_label: 'Label', all: true, names: [] })
  expect(summarize([allowed({}), create, mail])).toBe('Read files and create files in My Drive · Read mail in all labels')
  expect(summarize([allowed({}), create, remove])).toBe('Read files, create files and delete files in My Drive')
})

test('summarize: names beyond those listed are counted, and the account itself has no scope', () => {
  const some = allowed({ names: ['Plans', 'Notes'], count: 5 })
  const account = allowed({ action: 'send', action_label: 'Send mail', kind: 'account', kind_label: 'Account', names: [] })
  expect(summarize([some, account])).toBe('Read files in Plans, Notes and 3 more · Send mail')
})
