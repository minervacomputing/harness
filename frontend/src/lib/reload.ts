/**
 * After a deploy, a page opened before it can ask for a chunk of the build it came from that no longer
 * exists. Vite reports that as `vite:preloadError`; loading the page again fetches the new build.
 * The reload happens once: if the page fails again within the window, the error is left to show,
 * so a chunk that really is missing cannot send the page into a loop.
 */

const KEY = 'minerva-preload-reload-at'

/** How soon after one reload another is refused. */
export const RELOAD_WINDOW_MS = 60_000

export interface ReloadDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
  now?: () => number
  reload?: () => void
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Reloads the page unless it was reloaded for this reason less than a minute ago. Answers whether it reloaded.
 * Without usable storage there is nothing to remember the reload by, so it does not reload.
 */
export function reloadOnce(deps: ReloadDeps = {}): boolean {
  const storage = deps.storage === undefined ? sessionStorageOrNull() : deps.storage
  const now = (deps.now ?? Date.now)()
  try {
    if (!storage) return false
    const last = Number(storage.getItem(KEY))
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS && now >= last) return false
    storage.setItem(KEY, String(now))
  } catch {
    return false
  }
  ;(deps.reload ?? (() => window.location.reload()))()
  return true
}

/** Reloads once when a lazily loaded chunk is gone. The error is not cancelled, so a second failure still shows. */
export function installPreloadErrorReload(): void {
  window.addEventListener('vite:preloadError', () => {
    reloadOnce()
  })
}
