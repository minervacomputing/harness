/** The rules of the grant editor that need no React: which kind is the connection itself, and how actions depend on each other. */
import type { ActionOut } from '@/api/types.gen'

// Kinds other than the connection itself are what users pick resources of.
export const ACCOUNT = 'account'

/** Checking an action also checks what it requires; unchecking an action clears what depends on it. */
export function toggle(actions: ActionOut[], current: Set<string>, id: string, on: boolean): Set<string> {
  const next = new Set(current)
  if (on) {
    let action: ActionOut | undefined = actions.find(a => a.id === id)
    while (action) {
      next.add(action.id)
      action = action.requires ? actions.find(a => a.id === action!.requires) : undefined
    }
  } else {
    const drop = (target: string) => {
      next.delete(target)
      for (const dependent of actions.filter(a => a.requires === target)) drop(dependent.id)
    }
    drop(id)
  }
  return next
}
