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
import { CodemodeSandbox, renderDeclarations, type CodemodeJsonSchema, type CodemodeTool } from '@earendil-works/pi-codemode'
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
const TOOL_RESULT_LIMITS = { maxBytes: TOOL_RESULT_BYTES, maxLines: Number.MAX_SAFE_INTEGER }
const SCRIPT_TOOL = 'run_script'
const SCRIPT_TIMEOUT_MS = 120000
const SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024
// The gateway runs at most 4 of a run's calls at once.
const GATEWAY_CALLS_AT_ONCE = 4
// A script can start calls without awaiting them and call in a loop, so the worker bounds what it holds for them.
const SCRIPT_CALLS_OPEN = 100
// Well under the gateway's 512 KiB request body, which also holds the call's envelope.
const SCRIPT_ARGS_BYTES = 256 * 1024
// Calls the worker refuses itself, before the script is stopped.
const SCRIPT_REFUSALS = 100

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
function gatewayTool(client: McpClient, tool: McpTool, spec: RunSpec, gateway: GatewayCalls): ToolRegistration {
  const write = tool.annotations?.readOnlyHint !== true
  return {
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} } as unknown as TSchema,
    executionMode: write ? 'sequential' : 'parallel',
    outputLimits: TOOL_RESULT_LIMITS,
    async execute(args, _api, callContext) {
      const signal = callContext.abortSignal
      // A call still waiting for a slot gives up as soon as the turn is stopped.
      const result = await untilAborted(gateway.send(write, () => client.callTool(tool.name, args as Record<string, unknown>, {
        signal,
        timeoutMs: remainingMs(spec),
      }), () => signal?.throwIfAborted()), signal)
      const content = toLlmContent(result).map(block => (
        block.type === 'text' ? block : { type: 'text' as const, text: `[${block.type} content omitted]` }
      ))
      return { content, isError: result.isError === true }
    },
  }
}

/** Runs tasks one after another, in the order they were queued. */
function serial(): <T>(task: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return task => {
    const next = last.then(task, task)
    last = next.catch(() => {})
    return next
  }
}

/** Settles like `promise`, or rejects as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** `value` as JSON, or undefined when it cannot be written as JSON, for example because it is nested too deeply. */
function toJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Runs at most `size` tasks at once; the rest wait in the order they were queued. */
function limiter(size: number): <T>(task: () => Promise<T>) => Promise<T> {
  let free = size
  const waiting: Array<() => void> = []
  return async task => {
    if (free > 0) free--
    else await new Promise<void>(resolve => waiting.push(resolve))
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else free++
    }
  }
}

type GatewayCalls = ReturnType<typeof gatewayCalls>

/**
 * Sends this turn's tool calls, direct and from scripts. A call waits for one of the gateway's slots and a write also
 * for earlier writes, rather than being refused. A call holds its slot until the gateway answers or the turn runs out
 * of time.
 */
function gatewayCalls() {
  const atOnce = limiter(GATEWAY_CALLS_AT_ONCE)
  const writes = serial()
  let sent = 0
  return {
    /** Calls sent so far. The gateway counts every one. */
    get sent() {
      return sent
    },
    /** `check` runs just before the call is sent and can throw to drop it. */
    send<T>(write: boolean, call: () => Promise<T>, check = () => {}): Promise<T> {
      const start = () => atOnce(() => {
        check()
        sent++
        return call()
      })
      return write ? writes(start) : start()
    },
  }
}

type ScriptCalls = ReturnType<typeof scriptCalls>

/**
 * Admits the tool calls of this turn's scripts. Calls that cannot succeed are refused before they reach the gateway,
 * and a script that keeps making them is stopped.
 */
function scriptCalls(limit: number | undefined, gateway: GatewayCalls) {
  let open = 0
  let refused = 0
  let script: AbortController | undefined
  function refuse(message: string): never {
    if (++refused >= SCRIPT_REFUSALS) {
      // After this call settles, so that it counts as refused rather than cancelled.
      const current = script
      setImmediate(() => current?.abort(new Error('The script kept making tool calls that could not run.')))
    }
    throw new Error(message)
  }
  function checkLimit() {
    // Past the limit the gateway refuses every call; one more reaches it so that it records the refusal.
    if (limit !== undefined && gateway.sent > limit) refuse(`This run has reached its limit of ${limit} tool calls.`)
  }
  return {
    begin(controller: AbortController) {
      script = controller
      refused = 0
    },
    async run<T>(args: unknown, write: boolean, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
      checkLimit()
      if (open >= SCRIPT_CALLS_OPEN) refuse(`At most ${SCRIPT_CALLS_OPEN} tool calls can wait at once. Await some before starting more.`)
      const json = args === undefined ? '' : toJson(args)
      if (json === undefined) refuse('Tool arguments could not be converted to JSON.')
      if (Buffer.byteLength(json) > SCRIPT_ARGS_BYTES) refuse(`Tool arguments are limited to ${SCRIPT_ARGS_BYTES / 1024} KB of JSON.`)
      open++
      // The gateway runs a call to its end even when the script stops waiting for it, so the call keeps its place until then.
      const settled = gateway.send(write, call, () => {
        signal.throwIfAborted()
        checkLimit()
      }).finally(() => { open-- })
      return await untilAborted(settled, signal)
    },
  }
}

/** A gateway tool as scripts call it: it resolves to the tool's result object and rejects with the gateway's message. */
function scriptTool(client: McpClient, tool: McpTool, spec: RunSpec, calls: ScriptCalls): CodemodeTool {
  return {
    name: tool.name,
    inputSchema: tool.inputSchema as CodemodeJsonSchema,
    outputSchema: { type: 'object' },
    async execute(args, { signal }) {
      const result = await calls.run(args, tool.annotations?.readOnlyHint !== true, signal, () => (
        client.callTool(tool.name, (args ?? {}) as Record<string, unknown>, { timeoutMs: remainingMs(spec) })
      ))
      const text = toLlmContent(result).flatMap(block => (block.type === 'text' ? [block.text] : [])).join('\n')
      if (result.isError === true) throw new Error(text || `${tool.name} failed.`)
      return result.structuredContent ?? text
    },
  }
}

/** Runs a model-written script that calls the gateway tools. Each call is still checked and counted by the gateway. */
function scriptRunner(client: McpClient, tools: McpTool[], spec: RunSpec, gateway: GatewayCalls): ToolRegistration {
  const limit = spec.limits.max_tool_calls
  const calls = scriptCalls(limit, gateway)
  const callable = tools.map(tool => scriptTool(client, tool, spec, calls))
  // Values the scripts of this turn keep with store().
  const store: Record<string, unknown> = {}
  const description = [
    'Run JavaScript that calls several tools in one step: to make independent reads at once, chain calls, or filter long results.',
    'The code is the body of an async function in a sandbox, so top-level await and return work. There is no network, file system, timers or modules.',
    'Call tools as `await tools.<name>(args)`. A call resolves to the object the tool returns and rejects with an Error when it fails or is refused.',
    'Await every call, for example with `await Promise.all(...)`: calls still running when the script ends are cancelled. A script that fails or stops does not undo the writes it made.',
    'Only what the script prints with `text(value)` or `console.log()`, and the value it returns, reach you. Tool results the script does not print do not.',
    `Each call is checked like a direct call${limit ? ` and counts toward this turn's limit of ${limit} tool calls` : ''}. Up to ${GATEWAY_CALLS_AT_ONCE} calls run at once, writes run one at a time, and at most ${SCRIPT_CALLS_OPEN} can wait, so start larger batches in parts.`,
    `A script stops after ${SCRIPT_TIMEOUT_MS / 1000} seconds, or sooner when the turn runs out of time. \`store(key, value)\` and \`load(key)\` keep JSON values between scripts in this turn.`,
    '',
    '```ts',
    renderDeclarations({ tools: callable }),
    '```',
  ].join('\n')
  return {
    name: SCRIPT_TOOL,
    description,
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript source.' } },
      required: ['code'],
    } as unknown as TSchema,
    executionMode: 'sequential',
    outputLimits: TOOL_RESULT_LIMITS,
    async execute(args, _api, callContext) {
      const sandbox = new CodemodeSandbox({ tools: callable, memoryLimitBytes: SCRIPT_MEMORY_BYTES })
      const script = new AbortController()
      calls.begin(script)
      try {
        const result = await sandbox.execute(String((args as { code?: unknown }).code ?? ''), {
          signal: callContext.abortSignal ? AbortSignal.any([callContext.abortSignal, script.signal]) : script.signal,
          timeoutMs: Math.min(SCRIPT_TIMEOUT_MS, remainingMs(spec)),
          store,
        })
        // Notes from the worker come first, where cutting a long result cannot drop them.
        const notes: string[] = []
        if (!result.ok) notes.push(clip(`Script failed: ${result.error.stack ?? result.error.message}`))
        const cancelled = result.calls.filter(call => call.status === 'cancelled').length
        if (cancelled) {
          notes.push(`${cancelled} tool call${cancelled === 1 ? '' : 's'} had not finished when the script ended and ${cancelled === 1 ? 'was' : 'were'} cancelled. A cancelled write may still have taken effect.`)
        }
        let value: string | undefined
        if (result.ok) {
          // The store is written as JSON for every later script, so a value that cannot be is not kept.
          if (toJson(result.storeWrites.set) === undefined) {
            notes.push('What the script passed to `store()` was not kept: a value could not be converted to JSON.')
          } else {
            for (const key of result.storeWrites.delete) delete store[key]
            Object.assign(store, result.storeWrites.set)
          }
          if (result.value !== undefined) {
            value = typeof result.value === 'string' ? result.value : toJson(result.value) ?? '[The returned value could not be converted to JSON.]'
          }
        }
        const content = notes.map(text => ({ type: 'text' as const, text }))
        for (const item of result.output) content.push(item.type === 'text' ? item : { type: 'text', text: '[image omitted]' })
        if (value !== undefined) content.push({ type: 'text', text: value })
        if (!content.length) content.push({ type: 'text', text: 'The script printed and returned nothing.' })
        return { content, isError: !result.ok }
      } finally {
        await sandbox.close()
      }
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
  const listed = await client.listTools()
  const gateway = gatewayCalls()
  const tools = listed.map(tool => gatewayTool(client, tool, spec, gateway))
  if (spec.code_mode) tools.push(scriptRunner(client, listed, spec, gateway))

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

  const running = new Map<string, string>()
  events = await watchEvents(harness, root.id, context)
  events.start(async batch => {
    for (const event of batch) {
      if (event.type === 'tool_execution_start') running.set(event.toolCallId, event.toolName)
      else if (event.type === 'tool_execution_end') running.delete(event.toolCallId)
      else if (event.type !== 'turn_start') continue
      const names = [...running.values()]
      sink.phase(names.includes(SCRIPT_TOOL) ? 'Running a script' : names.length ? 'Using tools' : 'Thinking')
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
