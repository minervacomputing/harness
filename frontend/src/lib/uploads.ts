import type { AttachmentAdapter, CompleteAttachment, PendingAttachment } from '@assistant-ui/react'
import { useEffect, useMemo } from 'react'
import { csrfToken, ensureCsrf, errorMessage } from '@/lib/http'

export type Uploaded = { id: string; name: string; size: number; media_type: string }

// Uploads one page runs at once. The server takes three per user, and another tab may be uploading too.
const CONCURRENT_UPLOADS = 2

type Entry = { request?: XMLHttpRequest; uploaded?: Uploaded; removed: boolean }

/**
 * Uploads each file as soon as it is added to the composer, reporting progress, so sending only names the uploads.
 * The attachment keeps the id the composer gave it; `uploaded` maps it to the upload the server recorded.
 *
 * The server keeps an upload until a message attaches it or a day passes. `close` deletes those the page leaves
 * unsent, and an attachment removed while its upload is under way deletes the upload once it arrives. The
 * composer does not tell the adapter when an attachment it gave back after a refused send is removed (it counts
 * as sent), so that upload stays until the page closes.
 */
export class UploadAdapter implements AttachmentAdapter {
  accept = '*'
  private entries = new Map<string, Entry>()
  private running = 0
  private waiting: (() => void)[] = []
  private closed = false

  constructor(private workspaceId: string) {}

  uploaded(attachmentId: string): Uploaded | undefined {
    return this.entries.get(attachmentId)?.uploaded
  }

  /** Takes the uploads a message is about to attach, so closing the page does not delete them under it. */
  take(attachmentIds: string[]): Map<string, Entry> {
    const taken = new Map<string, Entry>()
    for (const id of attachmentIds) {
      const entry = this.entries.get(id)
      if (entry) taken.set(id, entry)
      this.entries.delete(id)
    }
    return taken
  }

  /** Gives back uploads a message did not attach: the composer has them again. */
  restore(taken: Map<string, Entry>): void {
    for (const [id, entry] of taken) {
      // The page closed while the message was sent: nothing will send them now.
      if (this.closed) {
        if (entry.uploaded) void this.delete(entry.uploaded)
      } else {
        this.entries.set(id, entry)
      }
    }
  }

  /** Undoes `close`, for a page shown again (and React's development remount). */
  open(): void {
    this.closed = false
  }

  /** Stops uploads under way and deletes the uploads no message attached. */
  close(): void {
    this.closed = true
    for (const id of [...this.entries.keys()]) void this.remove({ id })
  }

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const id = crypto.randomUUID()
    const entry: Entry = { removed: false }
    this.entries.set(id, entry)
    const base = { id, type: 'file', name: file.name, contentType: file.type || undefined, file }
    yield { ...base, status: { type: 'running', reason: 'uploading', progress: 0 } }
    const progress: number[] = []
    let wake = () => {}
    let done = false
    let failure: unknown
    const upload = this.upload(entry, file, fraction => { progress.push(fraction); wake() })
      .then(uploaded => {
        entry.uploaded = uploaded
        // Removed while it uploaded: nothing will send it.
        if (entry.removed) void this.delete(uploaded)
      }, error => { failure = error })
      .finally(() => { done = true; wake() })
    try {
      while (!done) {
        await new Promise<void>(resolve => { wake = resolve })
        const fraction = progress.at(-1)
        if (!done && fraction != null) yield { ...base, status: { type: 'running', reason: 'uploading', progress: fraction } }
      }
      await upload
      if (failure) throw new Error(errorMessage(failure, 'The file could not be uploaded.'))
      yield { ...base, status: { type: 'requires-action', reason: 'composer-send' } }
    } finally {
      // The composer stops reading when the attachment is removed while it uploads.
      if (!entry.uploaded) {
        entry.removed = true
        entry.request?.abort()
      }
    }
  }

  async remove(attachment: { id: string }): Promise<void> {
    const entry = this.entries.get(attachment.id)
    if (!entry) return
    this.entries.delete(attachment.id)
    entry.removed = true
    entry.request?.abort()
    if (entry.uploaded) await this.delete(entry.uploaded)
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    if (!this.uploaded(attachment.id)) throw new Error(`${attachment.name} was not uploaded. Remove it and attach it again.`)
    return { ...attachment, status: { type: 'complete' }, content: [] }
  }

  private async delete(uploaded: Uploaded): Promise<void> {
    // An upload this fails to delete expires within a day.
    await ensureCsrf().then(() => fetch(`/api/workspaces/${this.workspaceId}/uploads/${uploaded.id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'X-CSRFToken': csrfToken() },
      keepalive: true,
    })).catch(() => {})
  }

  private async upload(entry: Entry, file: File, onProgress: (fraction: number) => void): Promise<Uploaded> {
    while (this.running >= CONCURRENT_UPLOADS) await new Promise<void>(resolve => this.waiting.push(resolve))
    this.running++
    try {
      await ensureCsrf()
      if (entry.removed) throw new Error('The upload was cancelled.')
      return await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        entry.request = request
        request.open('POST', `/api/workspaces/${this.workspaceId}/uploads?name=${encodeURIComponent(file.name)}`)
        request.setRequestHeader('X-CSRFToken', csrfToken())
        request.setRequestHeader('Content-Type', 'application/octet-stream')
        request.responseType = 'json'
        request.upload.onprogress = event => { if (event.lengthComputable) onProgress(event.loaded / event.total) }
        request.onload = () => {
          if (request.status === 201) resolve(request.response as Uploaded)
          else reject(request.response ?? { detail: uploadFailure(request.status) })
        }
        request.onerror = () => reject(new TypeError('The upload failed.'))
        request.onabort = () => reject(new Error('The upload was cancelled.'))
        request.send(file)
      })
    } finally {
      entry.request = undefined
      this.running--
      this.waiting.shift()?.()
    }
  }
}

/** The adapter for a page's composer, closed when the page is left, the tab closed or reloaded included. */
export function useUploadAdapter(workspaceId: string): UploadAdapter {
  const adapter = useMemo(() => new UploadAdapter(workspaceId), [workspaceId])
  useEffect(() => {
    adapter.open()
    // A page kept in the back-forward cache may be shown again, chips and all.
    const leave = (event: PageTransitionEvent) => { if (!event.persisted) adapter.close() }
    addEventListener('pagehide', leave)
    return () => {
      removeEventListener('pagehide', leave)
      adapter.close()
    }
  }, [adapter])
  return adapter
}

function uploadFailure(status: number): string {
  if (status === 413) return 'The file is too large.'
  if (status >= 502 && status <= 504) return 'Minerva is briefly unavailable, probably restarting. Try again in a moment.'
  return 'The file could not be uploaded.'
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function downloadUrl(workspaceId: string, conversationId: string, path: string, version?: string | null): string {
  const query = new URLSearchParams({ path })
  if (version) query.set('version', version)
  return `/api/workspaces/${workspaceId}/conversations/${conversationId}/files/download?${query}`
}
