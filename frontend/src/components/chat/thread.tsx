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
import type { ReactNode } from 'react'
import remarkGfm from 'remark-gfm'
import type { ToolCallResult } from '@/components/chat/model'
import { Button } from '@/components/ui/button'
import { Badge, ErrorNote, Spinner } from '@/components/ui/misc'

export function Thread({ empty, disabledReason }: { empty?: ReactNode; disabledReason?: string }) {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-6">
        <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 py-8">
          <ThreadPrimitive.Empty>{empty}</ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-3xl bg-background pb-5">
          <Composer disabledReason={disabledReason} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-2.5 text-sm">
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
      className="prose prose-sm prose-neutral max-w-none prose-pre:bg-muted prose-pre:text-foreground"
    />
  )
}

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

const ToolCall: ToolCallMessagePartComponent = ({ toolName, args, result }) => {
  const outcome = result as ToolCallResult | undefined
  const hasArgs = args && Object.keys(args).length > 0
  return (
    <details className="group rounded-md border text-sm">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <WrenchIcon className="size-3.5 text-muted-foreground" />
        <span className="flex-1 truncate">{describeTool(toolName)}</span>
        {outcome && (
          <Badge variant={outcome.decision === 'allowed' ? 'secondary' : 'destructive'}>{DECISION_LABEL[outcome.decision]}</Badge>
        )}
      </summary>
      <div className="space-y-2 border-t px-3 py-2 text-xs text-muted-foreground">
        {outcome?.message && <p>{outcome.message}</p>}
        {hasArgs
          ? <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">{JSON.stringify(args, null, 2)}</pre>
          : <p>No arguments.</p>}
      </div>
    </details>
  )
}

function Composer({ disabledReason }: { disabledReason?: string }) {
  return (
    <div className="space-y-1.5">
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-lg border bg-background p-2 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          placeholder={disabledReason ?? 'Message your agent'}
          className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
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
        Agents only reach what you allow under Connections.
      </p>
    </div>
  )
}
