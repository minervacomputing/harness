/**
 * Minerva run worker. Runs one agent turn with pi-durable inside the sandbox.
 *
 * The worker holds a single run token and makes outbound calls to the gateway only:
 * `GET /run` for the turn, `/v1` for model calls, `/mcp` for tools, `POST /events` for progress.
 * It never sees provider keys, connection credentials, or anything outside its own run.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { AssistantMessage, Model, TSchema } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import {
  AssistantEntry, createRegistry, defineExtension, Harness, MemoryStorage, UserEntry, watchEvents,
  type AgentEventStream, type Conversation, type ToolRegistration,
} from '@earendil-works/pi-durable'
import { McpClient, StreamableHttpTransport, toLlmContent, type Tool as McpTool } from '@earendil-works/pi-mcp'
import { authHeader, env, EventSink, fetchRunSpec, gatewayUrl, RunRevoked, type RunSpec } from './gateway.ts'

const PROVIDER = 'minerva'
const CONTEXT_WINDOW = 128000
// The newest earlier messages are replayed until this many characters (about a quarter of the context window).
const HISTORY_BUDGET = 120000
const MESSAGE_LIMIT = 30000
// The gateway sizes tool results and pages long ones, so the harness must not cut them and drop their paging fields.
const TOOL_RESULT_BYTES = 1024 * 1024

const context = BACKGROUND_CONTEXT

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown worker error'
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error.name}: ${error.message}${cause}`.slice(0, 2000)
}

function minervaModel(spec: RunSpec): Model<'openai-responses'> | Model<'openai-completions'> {
  // The relay sets reasoning effort itself, so pi-ai sends no reasoning options and puts instructions in a system message.
  const common = {
    id: spec.model.alias,
    name: spec.model.alias,
    provider: PROVIDER,
    baseUrl: `${gatewayUrl}/v1`,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: CONTEXT_WINDOW,
    maxTokens: spec.model.max_output_tokens,
  }
  if (spec.model.api === 'chat') {
    return {
      ...common,
      api: 'openai-completions',
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsStrictMode: false,
        maxTokensField: 'max_completion_tokens',
        supportsMidConvoSystemMessages: false,
      },
    }
  }
  return {
    ...common,
    api: 'openai-responses',
    compat: {
      supportsStrictMode: false,
      supportsAdditionalTools: false,
      supportsToolSearch: false,
      supportsMidConvoSystemMessages: false,
      supportsLongCacheRetention: false,
    },
  }
}

function remainingMs(spec: RunSpec): number {
  const deadline = Date.parse(spec.limits.deadline)
  return Number.isNaN(deadline) ? 60000 : Math.max(1000, deadline - Date.now())
}

/** A gateway tool. Writes run one at a time: the gateway refuses a second write while one is in progress. */
function gatewayTool(client: McpClient, tool: McpTool, spec: RunSpec): ToolRegistration {
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} } as unknown as TSchema,
    executionMode: tool.annotations?.readOnlyHint === true ? 'parallel' : 'sequential',
    outputLimits: { maxBytes: TOOL_RESULT_BYTES, maxLines: Number.MAX_SAFE_INTEGER },
    async execute(args, _api, callContext) {
      const result = await client.callTool(tool.name, args as Record<string, unknown>, {
        signal: callContext.abortSignal,
        timeoutMs: remainingMs(spec),
      })
      const content = toLlmContent(result).map(block => (
        block.type === 'text' ? block : { type: 'text' as const, text: `[${block.type} content omitted]` }
      ))
      return { content, isError: result.isError === true }
    },
  }
}

function clip(text: string): string {
  if (text.length <= MESSAGE_LIMIT) return text
  return `${text.slice(0, MESSAGE_LIMIT)}\n\n[The rest of this message was left out.]`
}

/** The newest earlier messages that fit the budget, oldest first. */
function recentHistory(spec: RunSpec): RunSpec['history'] {
  const kept: RunSpec['history'] = []
  let used = 0
  for (const message of [...spec.history].reverse()) {
    const content = clip(message.content)
    if (used + content.length > HISTORY_BUDGET) break
    used += content.length
    kept.unshift({ role: message.role, content })
  }
  return kept
}

function earlierAnswer(spec: RunSpec, text: string, timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: spec.model.api === 'chat' ? 'openai-completions' : 'openai-responses',
    provider: PROVIDER,
    model: spec.model.alias,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp,
  }
}

function answerText(message: unknown): string {
  if (typeof message !== 'object' || message === null || (message as { role?: unknown }).role !== 'assistant') return ''
  return (message as AssistantMessage).content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()
}

let mcp: McpClient | null = null
let harness: Harness | null = null
let root: Conversation | null = null
let events: AgentEventStream | null = null
let closing = false

async function close(): Promise<void> {
  await events?.stop().catch(() => {})
  await root?.abort(context).catch(() => {})
  await harness?.close(context).catch(() => {})
  await mcp?.close().catch(() => {})
}

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true
    // A tool call that ignores cancellation must not keep the process alive.
    await Promise.race([close(), new Promise(resolve => setTimeout(resolve, 5000))])
  }
  process.exit(code)
}

process.on('SIGTERM', () => { void shutdown(143) })
process.on('SIGINT', () => { void shutdown(130) })

const sink = new EventSink(() => { void shutdown(0) })

try {
  const spec = await fetchRunSpec()
  sink.phase('Starting the agent')

  const models = createModels()
  models.setProvider(createProvider({
    id: PROVIDER,
    baseUrl: `${gatewayUrl}/v1`,
    auth: { apiKey: { name: 'Minerva run token', resolve: async () => ({ auth: { apiKey: env.RUN_TOKEN } }) } },
    models: [minervaModel(spec)],
    api: spec.model.api === 'chat' ? openAICompletionsApi() : openAIResponsesApi(),
  }))

  mcp = new McpClient({ name: 'minerva-worker', version: '1', requestTimeoutMs: remainingMs(spec) })
  await mcp.connect(new StreamableHttpTransport({
    url: `${gatewayUrl}/mcp`,
    headers: { Authorization: authHeader },
    openGetStream: false,
  }))
  const client = mcp
  const tools = (await client.listTools()).map(tool => gatewayTool(client, tool, spec))

  const registry = createRegistry()
  registry.install(defineExtension({ name: 'minerva', tools }))

  harness = await Harness.open(new MemoryStorage(), {
    models,
    registry,
    settings: {
      // The relay's refusal at the model-call limit is final, so a failed model call ends the turn.
      retry: { enabled: false },
      // The relay streams every model call into the chat, so a summary must not run beside the answer.
      // Compaction still runs when the context is nearly full.
      compaction: { backgroundTokens: 0 },
    },
    onReport: error => { process.stderr.write(`${describeError(error)}\n`) },
  }, context)

  const history = recentHistory(spec)
  root = await harness.root(context, {
    agent: { model: { provider: PROVIDER, modelId: spec.model.alias }, instructions: spec.instructions || null },
    async init(tx, conversationId) {
      const timestamp = Date.now()
      for (const message of history) {
        if (message.role === 'user') {
          await tx.appendEntry(UserEntry, conversationId, { model: [{ role: 'user', content: message.content, timestamp }] })
        } else {
          await tx.appendEntry(AssistantEntry, conversationId, { model: [earlierAnswer(spec, message.content, timestamp)] })
        }
      }
    },
  })

  const running = new Set<string>()
  events = await watchEvents(harness, root.id, context)
  events.start(async batch => {
    for (const event of batch) {
      if (event.type === 'tool_execution_start') running.add(event.toolCallId)
      else if (event.type === 'tool_execution_end') running.delete(event.toolCallId)
      else if (event.type !== 'turn_start') continue
      sink.phase(running.size ? 'Using tools' : 'Thinking')
    }
  })

  sink.phase('Thinking')
  const submission = await root.submit({ type: 'input', content: spec.prompt }, context)
  const settled = await submission.wait(context)
  if (settled.status === 'unanswered') {
    const detail = typeof settled.detail === 'string' ? `: ${settled.detail}` : ''
    throw new Error(`The model turn ended without an answer (${settled.reason}${detail}).`)
  }
  const answerId = settled.answer
  const answer = answerId && await root.commit(tx => tx.entry(AssistantEntry, answerId), context)
  const response = answer ? answerText(answer.model?.[0]) : ''
  if (!response) throw new Error('The model turn ended without a response.')
  await sink.completed(response)
  await shutdown(0)
} catch (error) {
  if (error instanceof RunRevoked || sink.revoked) await shutdown(0)
  // Logged for operators through the sandbox logs; the gateway shows users a generic message.
  process.stderr.write(`${describeError(error)}\n`)
  await sink.failed(describeError(error)).catch(() => {})
  await shutdown(1)
}
