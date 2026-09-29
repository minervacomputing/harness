/**
 * Minerva run worker. Runs one agent turn with DeepSeek Harness inside the sandbox.
 *
 * The worker holds a single run token and makes outbound calls to the gateway only:
 * `GET /run` for the turn, `/v1` for model calls, `/mcp` for tools, `POST /events` for progress.
 * It never sees provider keys, connection credentials, or anything outside its own run.
 */
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { authHeader, EventSink, fetchRunSpec, gatewayUrl, RunRevoked, type RunSpec } from './gateway.ts'

const PROFILE = 'sdk-minimal'
const DISABLED_PLUGINS = [
  'persistent-bash', 'persistent-pwsh', 'pty', 'terminal-bash', 'terminal-pwsh',
  'llm-deepseek', 'subprocess', 'sandbox', 'mcp-resources',
]

function composePrompt(spec: RunSpec): string {
  if (!spec.history.length) return spec.prompt
  const earlier = spec.history
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
    .join('\n\n')
  return `Earlier in this conversation:\n\n${earlier}\n\nCurrent message from the user:\n\n${spec.prompt}`
}

function profilePatch(spec: RunSpec): unknown[] {
  const rows: unknown[] = DISABLED_PLUGINS.map(id => ({ id, disabled: true }))
  rows.push({
    id: 'system-prompt',
    config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: spec.instructions },
  })
  rows.push({
    insert: [
      {
        id: 'minerva-model',
        name: '@deepseek-ai/dsh-llm-pi-ai',
        config: {
          providers: {
            minerva: {
              api: 'openai-completions',
              baseURL: `${gatewayUrl}/v1`,
              apiKeyEnv: 'MINERVA_RUN_TOKEN',
              models: [{
                id: spec.model.alias, contextWindow: 128000,
                maxTokens: spec.model.max_output_tokens, input: ['text'],
              }],
            },
          },
        },
      },
      {
        id: 'minerva-tools',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'minerva',
          transport: 'streamable-http',
          url: `${gatewayUrl}/mcp`,
          headers: { Authorization: authHeader },
          failOnStartupError: true,
        },
      },
    ],
  })
  return rows
}

/** The published profile resolves bare plugin names next to itself; point it at the installed bundle. */
async function prepareHome(home: string): Promise<void> {
  const require = createRequire(import.meta.url)
  const sdkRequire = createRequire(require.resolve('@deepseek-ai/dsh-sdk-client'))
  const cliRequire = createRequire(sdkRequire.resolve('@deepseek-ai/dsh/package.json'))
  const bundleRoot = dirname(dirname(cliRequire.resolve('@deepseek-ai/dsh-sdk-minimal')))
  const profileDirectory = join(home, 'profiles', PROFILE)
  await mkdir(profileDirectory, { recursive: true })
  await symlink(resolve(bundleRoot, '../..'), join(profileDirectory, 'node_modules'))
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown worker error'
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error.name}: ${error.message}${cause}`.slice(0, 2000)
}

let harness: DeepSeekHarness | null = null
let closing = false

async function shutdown(code: number): Promise<never> {
  if (!closing) {
    closing = true
    await harness?.close().catch(() => {})
  }
  process.exit(code)
}

process.on('SIGTERM', () => { void shutdown(143) })
process.on('SIGINT', () => { void shutdown(130) })

const sink = new EventSink(() => { void shutdown(0) })

try {
  const spec = await fetchRunSpec()
  const root = process.env.MINERVA_WORKDIR || await mkdtemp(join(tmpdir(), 'minerva-run-'))
  const workspace = join(root, 'workspace')
  const home = join(root, 'dsh-home')
  const patch = join(root, 'profile.patch.json')
  await mkdir(workspace, { recursive: true })
  await prepareHome(home)
  await writeFile(patch, JSON.stringify(profilePatch(spec)), { mode: 0o600 })

  sink.phase('Starting the agent')
  harness = new DeepSeekHarness({
    profile: PROFILE,
    patches: [patch],
    dshHome: home,
    cwd: workspace,
    processCwd: workspace,
    provider: 'minerva',
    model: spec.model.alias,
    maxTokens: spec.model.max_output_tokens,
    env: {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: root,
      TMPDIR: tmpdir(),
      LANG: 'C.UTF-8',
      NODE_ENV: 'production',
      ...(process.env.NARB_DISABLE_NATIVE_CACHE && { NARB_DISABLE_NATIVE_CACHE: process.env.NARB_DISABLE_NATIVE_CACHE }),
      MINERVA_RUN_TOKEN: process.env.RUN_TOKEN ?? '',
    },
    initializeTimeoutMs: 45000,
  })
  sink.phase('Thinking')
  const result = await harness.run(composePrompt(spec), {
    onNotification(notification) {
      if (notification.method !== 'session.event') return
      const params = notification.params as Record<string, unknown>
      const event = (typeof params.event === 'object' && params.event !== null ? params.event : params) as { type?: string }
      if (event.type === 'tool/call') sink.phase('Using tools')
      if (event.type === 'tool/result') sink.phase('Thinking')
    },
  })
  const response = result.finalResponse.trim()
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
