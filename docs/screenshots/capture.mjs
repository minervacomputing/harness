// Captures the README screenshots from the demo account (make seed-demo) into docs/images.
// Needs make dev running, Google Chrome installed, and ImageMagick (magick) to resize them.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pw from 'playwright-core'

const BASE = process.env.MINERVA_URL || 'http://localhost:5173'
const IMAGES = new URL('../images/', import.meta.url).pathname
const raw = mkdtempSync(join(tmpdir(), 'minerva-screenshots-'))

const browser = await pw.chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
})
const page = await context.newPage()

await page.goto(`${BASE}/login`)
await page.waitForLoadState('networkidle')
await page.getByLabel(/email/i).fill('demo@example.com')
await page.getByLabel(/password/i).fill('password')
await page.getByRole('button', { name: /sign in|log in|continue/i }).first().click()
await page.waitForURL(/\/w\//)
const workspace = page.url().match(/\/w\/([^/]+)/)[1]
const conversations = await page.evaluate(
  async (ws) => (await fetch(`/api/workspaces/${ws}/conversations`)).json(),
  workspace,
)

async function capture(name, path, expandDenied) {
  await page.goto(`${BASE}/w/${workspace}${path}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(600)
  if (expandDenied) await page.getByText('Not allowed').first().click()
  await page.waitForTimeout(400)
  await page.mouse.move(0, 0)
  const file = join(raw, `${name}.png`)
  await page.screenshot({ path: file })
  execFileSync('magick', [
    file, '-resize', '2000x', '-strip', '-colors', '256',
    '-define', 'png:compression-level=9', join(IMAGES, `${name}.png`),
  ])
  console.log(`wrote docs/images/${name}.png`)
}

const chat = (prefix) => `/chat/${conversations.find((c) => c.title.startsWith(prefix)).id}`
await capture('chat', chat('Jana from'), true)
await capture('injection', chat('Go through'), true)
await capture('connections', '/connections', false)
await browser.close()
