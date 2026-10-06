/**
 * A worker that dies mid-turn is replaced by one that loads the turn's saved state from the journal and finishes it,
 * set up as the worker sets up pi-durable. The dead worker's journal access is revoked, as the gateway revokes it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText,
  type AssistantMessageEvent, type AssistantMessageEventStream, type FauxProviderHandle, type FauxResponseStep,
  type Message, type Provider, type TSchema,
} from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  AssistantEntry, createRegistry, defineExtension, Harness,
  type Conversation, type SettledSubmissionRecord, type ToolExecutionApi, type ToolRegistration,
} from '@earendil-works/pi-durable'
import { loadStore, saveStore, STORE_BYTES } from '../src/script-store.ts'
import { GatewayStorage } from '../src/storage.ts'
import { AttemptJournal, FakeJournal } from './journal.ts'

const context = BACKGROUND_CONTEXT
const NEVER_MS = 2_000_000_000
const PARAMETERS = { type: 'object', properties: {} } as unknown as TSchema

interface Worker {
  harness: Harness
  root: Conversation
  attempt: AttemptJournal
  settled: Promise<SettledSubmissionRecord>
}

interface Spec {
  provider?: Provider
  model?: string
  instructions?: string | null
}

/** Starts a worker on the run's journal and submits the turn, as `main.ts` does. */
async function start(journal: FakeJournal, faux: FauxProviderHandle, tools: ToolRegistration[], spec: Spec = {}): Promise<Worker> {
  const attempt = new AttemptJournal(journal)
  const storage = await GatewayStorage.load(attempt, () => {})
  const models = createModels()
  models.setProvider(spec.provider ?? faux.provider)
  const registry = createRegistry()
  registry.install(defineExtension({ name: 'test', tools }))
  const harness = await Harness.open(storage, {
    models,
    registry,
    settings: { retry: { enabled: false }, progress: { partialIntervalMs: NEVER_MS, outputIntervalMs: NEVER_MS } },
    onReport: () => {},
  }, context)
  const agent = { model: { provider: 'faux', modelId: spec.model ?? faux.models[0].id }, instructions: spec.instructions ?? null }
  const root = await harness.root(context, { agent })
  if (storage.loaded) await root.configure({ ...agent, thinkingLevel: null, extensions: null, tools: null, cwd: null }, context)
  const submission = await root.submit({ type: 'input', content: 'Do it', requestId: 'run:1' }, context)
  const settled = submission.wait(context)
  settled.catch(() => {})
  return { harness, root, attempt, settled }
}

/** The worker dies: a later attempt took over its run, so nothing it does is saved any more. */
async function kill(worker: Worker): Promise<void> {
  worker.attempt.revoked = true
  await worker.harness.close(context).catch(() => {})
}

async function answer(worker: Worker): Promise<string> {
  const settled = await worker.settled
  assert.equal(settled.status, 'done')
  const entry = settled.answer && await worker.root.commit(tx => tx.entry(AssistantEntry, settled.answer!), context)
  const message = entry ? entry.model?.[0] : undefined
  assert.ok(message && message.role === 'assistant')
  return message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
}

/** Answers with `text`, keeping the messages the model was sent. */
function reply(text: string, sent: Message[][]): FauxResponseStep {
  return transcript => {
    sent.push(structuredClone(transcript.messages))
    return fauxAssistantMessage(text)
  }
}

function callTool(name: string): FauxResponseStep {
  return fauxAssistantMessage(fauxToolCall(name, {}, { id: `call-${name}` }), { stopReason: 'toolUse' })
}

/** A tool that waits, the first time it is called, until its worker dies. */
function tool(
  name: string, replay: 'safe' | 'unsafe', started: () => void,
  run: (api: ToolExecutionApi, callContext: Context) => Promise<string> = async () => `${name} result`,
): ToolRegistration & { calls: number } {
  const registration = {
    calls: 0,
    name,
    description: name,
    parameters: PARAMETERS,
    replay,
    async execute(_args: unknown, api: ToolExecutionApi, callContext: Context) {
      registration.calls++
      if (registration.calls === 1) {
        started()
        const signal = callContext.abortSignal
        await new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      return { content: [{ type: 'text' as const, text: await run(api, callContext) }] }
    },
  }
  return registration as unknown as ToolRegistration & { calls: number }
}

/** A tool that runs at once. */
function quick(name: string, run: (api: ToolExecutionApi, callContext: Context) => Promise<string>): ToolRegistration {
  return {
    name,
    description: name,
    parameters: PARAMETERS,
    replay: 'unsafe',
    async execute(_args: unknown, api: ToolExecutionApi, callContext: Context) {
      return { content: [{ type: 'text' as const, text: await run(api, callContext) }] }
    },
  } as unknown as ToolRegistration
}

/** `provider`, telling `onEvent` about each event of the answers it streams. */
function observed(provider: Provider, onEvent: (event: AssistantMessageEvent) => void): Provider {
  const watch = (stream: AssistantMessageEventStream): AssistantMessageEventStream => {
    const push = stream.push.bind(stream)
    stream.push = event => {
      onEvent(event)
      push(event)
    }
    return stream
  }
  return new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key)
      if ((key !== 'stream' && key !== 'streamSimple') || typeof value !== 'function') return value
      return (...args: unknown[]) => watch(value.apply(target, args) as AssistantMessageEventStream)
    },
  })
}

function waiting(): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function users(messages: Message[]): number {
  return messages.filter(message => message.role === 'user').length
}

test('a read the dead worker was running runs again', async () => {
  const journal = new FakeJournal()
  const faux = fauxProvider()
  const sent: Message[][] = []
  faux.setResponses([callTool('lookup'), reply('Found it.', sent)])
  const called = waiting()
  const lookup = tool('lookup', 'safe', called.resolve)

  const first = await start(journal, faux, [lookup])
  await called.promise
  await kill(first)

  const second = await start(journal, faux, [lookup])
  assert.equal(await answer(second), 'Found it.')
  await second.harness.close(context)
  assert.equal(lookup.calls, 2)
  const [messages] = sent
  assert.equal(users(messages), 1)
  const result = messages.find(message => message.role === 'toolResult')
  assert.deepEqual(result?.content, [{ type: 'text', text: 'lookup result' }])
  assert.equal(result?.isError, false)
})

test('a write the dead worker was running is not run again, and the model is told it may have happened', async () => {
  const journal = new FakeJournal()
  const faux = fauxProvider()
  const sent: Message[][] = []
  faux.setResponses([callTool('create'), reply('It may have been created.', sent)])
  const called = waiting()
  const create = tool('create', 'unsafe', called.resolve)

  const first = await start(journal, faux, [create])
  await called.promise
  await kill(first)

  const second = await start(journal, faux, [create])
  assert.equal(await answer(second), 'It may have been created.')
  await second.harness.close(context)
  assert.equal(create.calls, 1)
  const [messages] = sent
  assert.equal(users(messages), 1)
  const result = messages.find(message => message.role === 'toolResult')
  assert.equal(result?.isError, true)
  assert.match(JSON.stringify(result?.content), /Tool create was interrupted and may have partially run/)
})

test('an answer the dead worker was streaming is not saved, and the model is asked again', async () => {
  const journal = new FakeJournal()
  // About 6 seconds to stream the first answer.
  const faux = fauxProvider({ tokensPerSecond: 20 })
  const sent: Message[][] = []
  const streamed: string[] = []
  const streaming = waiting()
  const provider = observed(faux.provider, event => {
    if (event.type !== 'text_delta') return
    streamed.push(event.delta)
    if (streamed.join('').length >= 'Lost'.length) streaming.resolve()
  })
  faux.setResponses([fauxAssistantMessage('Lost answer. '.repeat(40)), reply('Hello.', sent)])

  const first = await start(journal, faux, [], { provider })
  await streaming.promise
  await kill(first)
  assert.ok(streamed.join('').length < 'Lost answer. '.repeat(40).length)
  assert.doesNotMatch(Buffer.concat(journal.commits).toString(), /Lost/)

  const second = await start(journal, faux, [])
  assert.equal(await answer(second), 'Hello.')
  await second.harness.close(context)
  assert.equal(faux.state.callCount, 2)
  const [messages] = sent
  assert.deepEqual(messages.map(message => message.role), ['user'])
})

test('an answer the dead worker had finished is kept, and the model is not asked again', async () => {
  const journal = new FakeJournal()
  const faux = fauxProvider()
  faux.setResponses([fauxAssistantMessage('Done before it died.')])

  const first = await start(journal, faux, [])
  await first.settled
  await kill(first)

  const second = await start(journal, faux, [])
  assert.equal(await answer(second), 'Done before it died.')
  await second.harness.close(context)
  assert.equal(faux.state.callCount, 1)
})

test("what a turn's scripts stored is there for the scripts of the worker that resumes it", async () => {
  const journal = new FakeJournal()
  const faux = fauxProvider()
  const sent: Message[][] = []
  faux.setResponses([callTool('keep'), callTool('drop'), callTool('look'), reply('Done.', sent)])
  const notes: (string | undefined)[] = []
  const keep = quick('keep', async (api, callContext) => {
    notes.push(await saveStore(api, { set: { kept: 1, gone: 2 }, delete: [] }, callContext))
    return 'kept'
  })
  const drop = quick('drop', async (api, callContext) => {
    notes.push(await saveStore(api, { set: {}, delete: ['gone'] }, callContext))
    const big = { big: 'x'.repeat(STORE_BYTES) }
    notes.push(await saveStore(api, { set: big, delete: [] }, callContext))
    return 'dropped'
  })
  const looked = waiting()
  const look = tool('look', 'safe', looked.resolve, async (api, callContext) => JSON.stringify(await loadStore(api, callContext)))

  const first = await start(journal, faux, [keep, drop, look])
  await looked.promise
  await kill(first)

  const second = await start(journal, faux, [keep, drop, look])
  assert.equal(await answer(second), 'Done.')
  await second.harness.close(context)
  assert.equal(look.calls, 2)
  assert.equal(notes.length, 3)
  assert.deepEqual(notes.slice(0, 2), [undefined, undefined])
  assert.match(notes[2]!, /not kept: the stored values would take more than 1 MiB/)
  const [messages] = sent
  const results = messages.filter(message => message.role === 'toolResult')
  assert.deepEqual(results.map(message => message.content), [
    [{ type: 'text', text: 'kept' }],
    [{ type: 'text', text: 'dropped' }],
    [{ type: 'text', text: '{"kept":1}' }],
  ])
})

/** Resumes a turn whose worker died in a read, with `saved` as the dead worker's agent and `spec` as the new one's. */
async function resumeWith(saved: Spec, spec: Spec): Promise<{ model: string, instructions: string[] }> {
  const journal = new FakeJournal()
  const faux = fauxProvider({ models: [{ id: 'saved' }, { id: 'spec' }] })
  const asked: { model: string, instructions: string[] }[] = []
  faux.setResponses([callTool('lookup'), (transcript, _options, _state, model) => {
    const instructions = transcript.messages.flatMap(message => (message.role === 'system' ? [getSystemMessageText(message)] : []))
    asked.push({ model: model.id, instructions })
    return fauxAssistantMessage('Found it.')
  }])
  const called = waiting()
  const lookup = tool('lookup', 'safe', called.resolve)

  const first = await start(journal, faux, [lookup], saved)
  await called.promise
  await kill(first)

  const second = await start(journal, faux, [lookup], spec)
  assert.equal(await answer(second), 'Found it.')
  await second.harness.close(context)
  assert.equal(asked.length, 1)
  return asked[0]
}

test('a worker that resumes the turn sets up the agent from its spec, not from the saved state', async () => {
  // What the dead worker saved is untrusted: it could have changed its own agent. Its instructions stay in the
  // saved transcript, which it could have written anyway, and the spec's follow them.
  const asked = await resumeWith({ model: 'saved', instructions: 'Saved instructions.' }, { model: 'spec', instructions: 'Spec instructions.' })
  assert.equal(asked.model, 'spec')
  assert.match(asked.instructions.at(-1) ?? '', /Spec instructions\./)
})

test('a worker that resumes the turn with the same spec does not repeat its instructions', async () => {
  const spec = { model: 'spec', instructions: 'Spec instructions.' }
  const asked = await resumeWith(spec, spec)
  assert.equal(asked.model, 'spec')
  assert.equal(asked.instructions.join('\n').match(/Spec instructions\./g)?.length, 1)
})
