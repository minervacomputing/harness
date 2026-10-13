/**
 * After a deploy, a page opened before it can ask for a chunk of the build it came from that no longer
 * exists. Vite reports that as `vite:preloadError`; loading the page again fetches the new build.
 * The reload happens once: if the page fails again within a minute, the error is left to show,
 * so a chunk that really is missing cannot send the page into a loop.
 */

const KEY = 'minerva-preload-reload-at'

/** Reloads once when a lazily loaded chunk is gone. The error is not cancelled, so a second failure still shows. */
export function installPreloadErrorReload(): void {
  window.addEventListener('vite:preloadError', () => {
    const now = Date.now()
    try {
      // Without usable storage there is nothing to remember the reload by, so the page does not reload.
      const last = Number(window.sessionStorage.getItem(KEY))
      // A malformed time, or one in the future, does not count.
      if (last > 0 && last <= now && now - last < 60_000) return
      window.sessionStorage.setItem(KEY, String(now))
    } catch {
      return
    }
    window.location.reload()
  })
}
