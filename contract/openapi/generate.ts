// Writes the internal API's OpenAPI documents from the contract (src/internal/), or with `--check` fails when the committed
// ones differ, so every change to the interface shows in review. Laravel keeps copies of both and validates against them.

import { readFile, writeFile } from 'node:fs/promises'
import { OpenAPIGenerator } from '@orpc/openapi'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import { Catalog, Fact, GrantInput, Id, LayerInput, Scope, engine, laravel } from '../src/internal/index.ts'

const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] })

/** Named once under `components`, referred to everywhere else. */
const COMMON = {
  Id: { schema: Id },
  Scope: { schema: Scope },
  GrantInput: { schema: GrantInput },
  LayerInput: { schema: LayerInput },
  Catalog: { schema: Catalog },
  Fact: { schema: Fact },
}

const DOCUMENTS = [
  { file: 'engine-v1.json', router: engine, title: "Minerva's engine: the commands Laravel sends" },
  { file: 'laravel-v1.json', router: laravel, title: "Minerva's Laravel: the engine's requests and facts" },
]

let stale = false
for (const { file, router, title } of DOCUMENTS) {
  const document = await generator.generate(router, { info: { title, version: 'v1' }, commonSchemas: COMMON })
  const text = `${JSON.stringify(document, null, 2)}\n`
  const url = new URL(file, import.meta.url)
  if (!process.argv.includes('--check')) {
    await writeFile(url, text)
    continue
  }
  const committed = await readFile(url, 'utf8').catch(() => null)
  if (committed !== text) {
    console.error(`contract/openapi/${file} is not what the contract generates: run \`pnpm --dir contract openapi\` and commit it.`)
    stale = true
  }
}
if (stale) process.exitCode = 1
