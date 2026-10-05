import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { ArrowUpIcon, ChevronRightIcon, SquareIcon, WrenchIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import remarkGfm from 'remark-gfm'
import type { ToolCallResult } from '@/components/chat/model'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner, Status, type StatusTone } from '@/components/ui/misc'
import { useDemoVisitor } from '@/lib/demo'
import { cn } from '@/lib/utils'

export function Thread({ empty }: { empty?: ReactNode }) {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 md:px-6">
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 py-8">
          <ThreadPrimitive.Empty>{empty}</ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-background pb-5">
          <Composer />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] border bg-secondary px-3.5 py-2.5 text-sm whitespace-pre-wrap">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  const custom = useAuiState(s => s.message.metadata.custom) as { phase?: string; failure?: boolean }
  const running = useAuiState(s => s.message.status?.type === 'running')
  if (custom.failure) {
    return (
      <MessagePrimitive.Root>
        <ErrorNote><MessagePrimitive.Parts /></ErrorNote>
      </MessagePrimitive.Root>
    )
  }
  return (
    <MessagePrimitive.Root className="space-y-3">
      <MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolCall } }} />
      {running && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {custom.phase ?? 'Thinking'}
        </div>
      )}
    </MessagePrimitive.Root>
  )
}

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      components={{ img: UnloadedImage }}
      className="prose prose-sm prose-minerva max-w-none [overflow-wrap:anywhere]"
    />
  )
}

/** Agent text can carry prompt-injected image URLs; fetching one would send data past the sandbox. */
function UnloadedImage({ src, alt }: ComponentProps<'img'>) {
  const url = typeof src === 'string' ? src : ''
  return (
    <span className="border bg-secondary px-1 font-mono text-xs text-muted-foreground">
      [image not loaded{alt ? `: ${alt}` : ''}{url ? ` (${url})` : ''}]
    </span>
  )
}

/** For tool events recorded before the backend sent a label. */
function describeTool(name: string): string {
  const [alias, ...rest] = name.split('_')
  const provider = alias.replace(/(\d+)$/, ' ($1)')
  const action = rest.join(' ')
  return `${provider.charAt(0).toUpperCase()}${provider.slice(1)}: ${action}`
}

const DECISION_LABEL: Record<ToolCallResult['decision'], string> = {
  allowed: 'Done',
  denied: 'Not allowed',
  error: 'Failed',
}

const DECISION_TONE: Record<ToolCallResult['decision'], StatusTone> = {
  allowed: 'success',
  denied: 'warning',
  error: 'danger',
}

const DECISION_ICON: Record<ToolCallResult['decision'], string> = {
  allowed: 'text-success',
  denied: 'text-warning',
  error: 'text-destructive',
}

/** Tool cards show state in the icon colour and a status word, never a side stripe. */
export const ToolCall: ToolCallMessagePartComponent = ({ toolName, args, result }) => {
  const outcome = result as ToolCallResult | undefined
  const hasArgs = args && Object.keys(args).length > 0
  return (
    <details className="group border bg-card text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <WrenchIcon className={cn('size-3.5', outcome ? DECISION_ICON[outcome.decision] : 'text-info')} />
        <span className="flex-1 truncate font-mono text-[12.5px]">{outcome?.label ?? describeTool(toolName)}</span>
        {outcome
          ? <Status tone={DECISION_TONE[outcome.decision]}>{DECISION_LABEL[outcome.decision]}</Status>
          : <Status tone="info" live>Running</Status>}
      </summary>
      <div className="space-y-2 border-t px-3 py-2 text-xs text-muted-foreground">
        {outcome?.message && <p className="text-foreground">{outcome.message}</p>}
        {hasArgs
          ? <pre className="overflow-x-auto border bg-secondary p-2 font-mono">{JSON.stringify(args, null, 2)}</pre>
          : <p>No arguments.</p>}
      </div>
    </details>
  )
}

function Composer() {
  const visitor = useDemoVisitor()
  return (
    <div className="space-y-1.5">
      <ComposerPrimitive.Root className="flex items-end gap-2 border border-border-strong bg-card p-2 shadow-(--inset-well) focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25">
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          placeholder="Message your agent"
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-faint"
        />
        <AuiIf condition={s => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <Button size="icon-sm" aria-label="Send"><ArrowUpIcon /></Button>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={s => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button size="icon-sm" variant="outline" aria-label="Stop"><SquareIcon className="size-3" /></Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
      </ComposerPrimitive.Root>
      <p className="text-center text-xs text-muted-foreground">
        {visitor ? 'The agent only reaches what the owner allowed under Connections.' : 'Agents only reach what you allow under Connections.'}
      </p>
    </div>
  )
}
