import { expect, test } from 'vitest'
import type { ConnectorAction } from '@minerva/contract'
import { toggle } from './access'

// read <- create <- delete, and read <- share.
const actions: ConnectorAction[] = [
  { id: 'read', label: 'Read', requires: null },
  { id: 'create', label: 'Create', requires: 'read' },
  { id: 'delete', label: 'Delete', requires: 'create' },
  { id: 'share', label: 'Share', requires: 'read' },
]
const sorted = (set: Set<string>) => [...set].toSorted()

test('checking an action checks everything it requires, however far', () => {
  expect(sorted(toggle(actions, new Set(), 'delete', true))).toEqual(['create', 'delete', 'read'])
  expect(sorted(toggle(actions, new Set(['share']), 'create', true))).toEqual(['create', 'read', 'share'])
})

test('unchecking an action clears what depends on it, and nothing it depends on', () => {
  const all = new Set(['read', 'create', 'delete', 'share'])
  expect(sorted(toggle(actions, all, 'create', false))).toEqual(['read', 'share'])
  expect(sorted(toggle(actions, all, 'read', false))).toEqual([])
})

test('the current set is left as it was', () => {
  const current = new Set(['read'])
  toggle(actions, current, 'delete', true)
  toggle(actions, current, 'read', false)
  expect(sorted(current)).toEqual(['read'])
})
