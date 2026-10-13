/** The name of the browser tab for a page, for example "Agents · Minerva". */
export const documentTitle = (page: string) => `${page} · Minerva`

/** A route's `head` that names the browser tab after the page. */
export const pageHead = (page: string) => () => ({ meta: [{ title: documentTitle(page) }] })
