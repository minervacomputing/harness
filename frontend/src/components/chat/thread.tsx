import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAuiState,
} from '@assistant-ui/react'
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import { ArrowUpIcon, BrainIcon, ChevronRightIcon, SquareIcon, WrenchIcon } from 'lucide-react'
import { type ComponentProps, type ReactNode, useId, useState } from 'react'
import remarkGfm from 'remark-gfm'
import { NARRATION, type ToolCallResult } from '@/components/chat/model'
import { Button } from '@/components/ui/button'
import { ErrorNote, Spinner, Status, type StatusTone } from '@/components/ui/misc'
import { useDemoVisitor } from '@/lib/demo'
import { cn } from '@/lib/utils'

export function Thread({ empty }: { empty?: ReactNode }) {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col">
      {/* The scrollbar's space is kept, so the centred column does not shift when the thread starts to scroll
          (opening a tall tool card, with scrollbars that take space). */}
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col overflow-y-auto px-4 [scrollbar-gutter:stable] md:px-6">
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

type GroupBy = ComponentProps<typeof MessagePrimitive.GroupedParts>['groupBy']

const WORK = ['group-work'] as const

/**
 * The agent's work (reasoning, tool calls and what it wrote between them) folds into one row per stretch. A call our
 * policies refused stays a card of its own, between the stretches; so does the answer.
 */
const groupWork: GroupBy = part => {
  if (part.type === 'reasoning') return WORK
  if (part.type === 'tool-call') return (part.result as ToolCallResult | undefined)?.decision === 'denied' ? null : WORK
  if (part.type === 'text' && part.parentId === NARRATION) return WORK
  return null
}

function AssistantMessage() {
  const custom = useAuiState(s => s.message.metadata.custom) as { phase?: string; failure?: string }
  return (
    <MessagePrimitive.Root className="space-y-3">
      <MessagePrimitive.GroupedParts groupBy={groupWork} indicator={custom.failure ? 'never' : 'always'}>
        {({ part, children }) => {
          switch (part.type) {
            case 'group-work':
              return <Work indices={part.indices}>{children}</Work>
            case 'text':
              return <MarkdownText />
            case 'reasoning':
              return <MarkdownText quiet />
            case 'tool-call':
              return <ToolCall {...part} />
            case 'indicator':
              return (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  {custom.phase ?? 'Thinking'}
                </div>
              )
            default:
              return null
          }
        }}
      </MessagePrimitive.GroupedParts>
      {custom.failure && <ErrorNote>{custom.failure}</ErrorNote>}
    </MessagePrimitive.Root>
  )
}

/**
 * A stretch of work, summarised from its parts. Open while the agent is still in it, unless the user closed it: until
 * something other than text follows it, since text only joins the stretch once a later tool call has finished.
 */
function Work({ indices, children }: { indices: readonly number[]; children: ReactNode }) {
  const parts = useAuiState(s => s.message.parts)
  const live = useAuiState(s => s.message.status?.type === 'running' && s.message.parts.slice((indices.at(-1) ?? 0) + 1).every(part => part.type === 'text'))
  const [chosen, setChosen] = useState<boolean | null>(null)
  const items = indices.map(i => parts[i])
  const tools = items.flatMap(part => (part?.type === 'tool-call' ? [part.result as ToolCallResult | undefined] : []))
  // A lone tool call needs no summary.
  if (items.length === 1 && tools.length === 1) return children
  const apps = [...new Set(items.flatMap(part => (part?.type === 'tool-call' ? [appOf(part.toolName, part.result as ToolCallResult | undefined)] : [])))]
  return (
    <WorkGroup
      tools={tools.length}
      failed={tools.filter(tool => tool?.decision === 'error').length}
      apps={apps}
      live={live}
      open={chosen ?? live}
      onOpenChange={setChosen}
    >
      {children}
    </WorkGroup>
  )
}

function appOf(toolName: string, result: ToolCallResult | undefined): string {
  const label = result?.label ?? describeTool(toolName)
  return label.split(':')[0]
}

/** A disclosure, not `<details>`: the tool cards inside use the `group-open` variant for their own chevrons. */
export function WorkGroup({ tools, failed, apps, live, open, onOpenChange, children }: {
  tools: number
  failed: number
  apps: string[]
  live?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const id = useId()
  const title = tools > 0 ? `Used ${tools} ${tools === 1 ? 'tool' : 'tools'}` : live ? 'Thinking' : 'Thought'
  const Icon = tools > 0 ? WrenchIcon : BrainIcon
  return (
    <div className="border bg-card text-sm">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/25"
      >
        <ChevronRightIcon className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0">{title}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground">{apps.join(', ')}</span>
        {failed > 0 && <Status tone="danger">{failed} failed</Status>}
      </button>
      {open && <div id={id} className="space-y-2 border-t p-2">{children}</div>}
    </div>
  )
}

function MarkdownText({ quiet }: { quiet?: boolean }) {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      components={{ img: UnloadedImage }}
      className={cn('prose prose-sm prose-minerva max-w-none [overflow-wrap:anywhere]', quiet && 'prose-quiet')}
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
