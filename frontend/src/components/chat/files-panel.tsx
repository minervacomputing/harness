import { useQuery } from '@tanstack/react-query'
import { FileIcon, FolderIcon, XIcon } from 'lucide-react'
import { listFilesOptions } from '@/api/@tanstack/react-query.gen'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner } from '@/components/ui/misc'
import { errorMessage } from '@/lib/http'
import { downloadUrl, formatSize } from '@/lib/uploads'

/** The conversation's folder as the last run left it: what was attached and what the agent wrote. */
export function FilesPanel({ id, workspaceId, conversationId, onClose }: {
  id: string
  workspaceId: string
  conversationId: string
  onClose: () => void
}) {
  const folder = useQuery(listFilesOptions({ path: { workspace_id: workspaceId, conversation_id: conversationId } }))
  const files = folder.data?.files ?? []
  // Folders that hold no file would not show otherwise.
  const empty = (folder.data?.dirs ?? []).filter(dir => !files.some(file => file.path.startsWith(`${dir}/`)))
  return (
    <aside
      id={id}
      className="flex h-full w-full flex-col bg-background md:w-80 md:border-l"
      aria-label="Files"
      onKeyDown={event => { if (event.key === 'Escape') onClose() }}
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2">
        <h2 className="flex-1 text-sm font-medium">Files</h2>
        <Button size="icon-sm" variant="ghost" aria-label="Close files" onClick={onClose}><XIcon /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {folder.isPending && <div className="p-2"><Spinner /></div>}
        {folder.error && <ErrorNote>{errorMessage(folder.error)}</ErrorNote>}
        {folder.data && files.length === 0 && empty.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">No files yet. Attach files to a message, or ask the agent to write some.</p>
        )}
        <ul className="text-sm">
          {files.map(file => (
            <li key={file.path}>
              <a
                href={downloadUrl(workspaceId, conversationId, file.path, folder.data?.version_id)}
                download
                className="flex items-center gap-2 px-2 py-1.5 hover:bg-secondary"
                title={file.path}
              >
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{file.path}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatSize(file.size)}</span>
              </a>
            </li>
          ))}
          {empty.map(dir => (
            <li key={dir} className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground" title={dir}>
              <FolderIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{dir}/</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  )
}
