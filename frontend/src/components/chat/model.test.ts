import { describe, expect, test } from 'vitest'
import type { Conversation, Run, RunEvent, RunStatus, ToolCallAllowed } from '@minerva/contract'
import { buildMessages, NARRATION } from './model'

let seq = 0
const text = (value: string, call = 'c1'): RunEvent => ({ seq: ++seq, type: 'text_delta', data: { text: value, call } })
const reasoning = (value: string, call = 'c1'): RunEvent => ({ seq: ++seq, type: 'reasoning_delta', data: { text: value, call } })
const tool = (name: string, data: Partial<ToolCallAllowed> = {}): RunEvent => ({
  seq: ++seq,
  type: 'tool_call',
  data: { tool: name, label: name, arguments: {}, decision: 'allowed', title: name, count: null, ...data },
})
const refused = (name: string): RunEvent => ({
  seq: ++seq,
  type: 'tool_call',
  data: { tool: name, label: name, arguments: {}, decision: 'denied', code: 'denied', message: 'Not allowed.' },
})
const restart = (): RunEvent => ({ seq: ++seq, type: 'status', data: { status: 'provisioning', attempt: 2 } })

function run(status: RunStatus, events: RunEvent[], errorMessage = ''): Run {
  return {
    id: 'r1',
    status,
    events,
    errorMessage,
    baseVersionId: null,
    createdAt: '2026-10-13T10:00:00Z',
    finishedAt: null,
    folderChanges: null,
    folderWarnings: null,
    resultVersionId: null,
  }
}

/** The message that follows the user's, for a conversation with one run and, if given, its saved answer. */
function reply(r: Run, answer?: string) {
  const message = { attachments: [], createdAt: '2026-10-13T10:00:00Z', runId: r.id }
  const conversation: Conversation = {
    agentId: 'a1',
    id: 'c1',
    title: '',
    updatedAt: '',
    runs: [r],
    messages: [
      { ...message, id: 'm1', role: 'user', content: 'Question' },
      ...(answer === undefined ? [] : [{ ...message, id: 'm2', role: 'assistant' as const, content: answer }]),
    ],
  }
  const messages = buildMessages(conversation, undefined, [])
  expect(messages).toHaveLength(2)
  return messages[1]
}

const shape = (m: ReturnType<typeof reply>) =>
  'parts' in m
    ? m.parts.map(p =>
        p.type === 'tool-call' ? `tool:${p.toolName}` : `${p.type}${'parentId' in p && p.parentId === NARRATION ? '(narration)' : ''}:${p.text}`,
      )
    : []

describe('restarts', () => {
  test('drop text and reasoning streamed before them and keep tool calls', () => {
    const m = reply(run('running', [reasoning('Hmm'), text('Half an'), tool('search'), restart(), text('Again')]))
    expect(shape(m)).toEqual(['tool:search', 'text:Again'])
  })

  test('show as restarting while the new worker starts, and forget the earlier phase', () => {
    const phase: RunEvent = { seq: ++seq, type: 'phase', data: { text: 'Reading files' } }
    expect(reply(run('provisioning', [restart()]))).toMatchObject({ kind: 'progress', phase: 'Restarting the agent' })
    expect(reply(run('running', [phase, restart()]))).toMatchObject({ kind: 'progress', phase: 'Thinking' })
  })
})

describe('repeated writes', () => {
  test('a write repeated after a restart shows once', () => {
    const m = reply(run('running', [tool('create', { write: 'w1' }), restart(), tool('create', { write: 'w1', repeat: true })]))
    expect(shape(m)).toEqual(['tool:create'])
  })

  test('a repeat shows when the original is missing or was not carried out', () => {
    const missing = reply(run('running', [tool('create', { write: 'w1', repeat: true })]))
    expect(shape(missing)).toEqual(['tool:create'])
    const denied = reply(run('running', [refused('create'), tool('create', { write: 'w2', repeat: true })]))
    expect(shape(denied)).toEqual(['tool:create', 'tool:create'])
  })
})

describe('narration', () => {
  test('text before the last tool call is narration, text after it is not', () => {
    const m = reply(run('running', [text('Let me look.'), tool('search'), text('Found', 'c2'), text(' it.', 'c2')]))
    expect(shape(m)).toEqual(['text(narration):Let me look.', 'tool:search', 'text:Found it.'])
  })

  test('text from two model calls does not run together', () => {
    const m = reply(run('running', [text('One', 'c1'), text('Two', 'c2')]))
    expect(shape(m)).toEqual(['text:One', 'text:Two'])
  })
})

describe('the answer', () => {
  const answered = (content: string, call: string): RunEvent => ({ seq: ++seq, type: 'message', data: { id: 'm2', content, call } })

  test('replaces what its model call streamed, including before a tool call finished', () => {
    const events = [text('Checking.'), tool('search'), text('The answer', 'c2'), tool('lookup'), text('\n\nis  42.', 'c2')]
    const m = reply(run('completed', [...events, answered('The answer is 42.', 'c2')]), 'The answer is 42.')
    expect(m).toMatchObject({ kind: 'assistant', id: 'run-r1' })
    expect(shape(m)).toEqual(['text(narration):Checking.', 'tool:search', 'tool:lookup', 'text:The answer is 42.'])
  })

  test('from a call that streamed nothing leaves the streamed text as narration', () => {
    const m = reply(run('completed', [text('Looking it up.'), tool('search'), answered('I cannot share that.', 'c9')]), 'I cannot share that.')
    expect(shape(m)).toEqual(['text(narration):Looking it up.', 'tool:search', 'text:I cannot share that.'])
  })

  test('that names no call replaces the text after the last tool call and keeps the text before it as narration', () => {
    const unnamed: RunEvent = { seq: ++seq, type: 'message', data: { id: 'm2', content: 'It is 42.' } }
    const m = reply(run('completed', [text('Checking.'), tool('search'), text('It is', 'c2'), unnamed]), 'It is 42.')
    expect(shape(m)).toEqual(['text(narration):Checking.', 'tool:search', 'text:It is 42.'])
  })

  test('comes from the message event until the conversation refreshes, under the same id', () => {
    const events = [text('Hi'), answered('Hi there', 'c1')]
    const streamed = reply(run('running', events))
    expect(streamed).toMatchObject({ kind: 'assistant', id: 'run-r1' })
    expect(shape(streamed)).toEqual(['text:Hi there'])
    expect(reply(run('completed', events), 'Hi there')).toMatchObject({ kind: 'assistant', id: streamed.id })
  })

  test('a failed or stopped run is a failure', () => {
    expect(reply(run('failed', [], 'The model is unavailable.'))).toMatchObject({ kind: 'failure', text: 'The model is unavailable.' })
    expect(reply(run('cancelled', []))).toMatchObject({ kind: 'failure', text: 'Stopped.' })
  })
})
