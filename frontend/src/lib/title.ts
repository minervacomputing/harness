import { useEffect } from 'react'

/** Names the browser tab after the page, for example "Agents · Minerva". */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Minerva` : 'Minerva'
    // A conversation's title should not stay in the tab after leaving it, for example on the sign-in page.
    return () => { document.title = 'Minerva' }
  }, [title])
}
