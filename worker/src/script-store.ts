/**
 * Values the scripts of a turn keep with `store()` and read with `load()`. They are saved with the turn, so the scripts
 * of a worker that resumes it load what earlier scripts stored.
 */
import type { Context, JsonValue } from '@earendil-works/chord'
import type { CodemodeStoreWrites } from '@earendil-works/pi-codemode'
import { defineDoc, type ToolExecutionApi } from '@earendil-works/pi-durable'

type Values = { [key: string]: JsonValue }

const STORE = defineDoc<{ values: Values }>({
  kind: 'minerva.script-store',
  version: 1,
  scope: 'session',
  initial: () => ({ values: {} }),
})
// The store is saved with the turn, whose saved state the gateway limits.
export const STORE_BYTES = 1024 * 1024

/** The values earlier scripts of this turn stored. */
export async function loadStore(api: Pick<ToolExecutionApi, 'snapshot'>, context: Context): Promise<Readonly<Values>> {
  return (await api.snapshot(STORE, context))?.values ?? {}
}

/** Saves what a script stored. Returns why it was not kept, if it was not. */
export async function saveStore(
  api: Pick<ToolExecutionApi, 'commit'>, writes: CodemodeStoreWrites, context: Context,
): Promise<string | undefined> {
  if (!writes.delete.length && !Object.keys(writes.set).length) return undefined
  let set: Values
  try {
    set = JSON.parse(JSON.stringify(writes.set)) as Values
  } catch {
    return 'What the script passed to `store()` was not kept: a value could not be converted to JSON.'
  }
  try {
    await api.commit(async tx => {
      const doc = await tx.doc(STORE)
      for (const key of writes.delete) delete doc.values[key]
      Object.assign(doc.values, set)
      if (new TextEncoder().encode(JSON.stringify(doc.values)).length > STORE_BYTES) throw new TooLarge()
    }, context)
  } catch (error) {
    if (!(error instanceof TooLarge)) throw error
    return `What the script passed to \`store()\` was not kept: the stored values would take more than ${STORE_BYTES / 1024 / 1024} MiB.`
  }
  return undefined
}

class TooLarge extends Error {}
