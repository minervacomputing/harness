// Facts: what the engine tells Laravel about its runs, written to its outbox with the execution facts they describe and
// delivered in order per conversation (product-and-engine.md, Decisions 7). Deltas and phases are not facts: the browser
// streams them from the engine.

import { z } from 'zod'
import type { Attachment, FolderChanges, FolderWarnings, LocalToolEventData } from '../shapes.ts'
import { Id, Seq, Time } from './common.ts'

/** A file a message attached, as added to the folder. */
export const AttachedFile = z.object({ path: z.string(), size: z.int().min(0), mediaType: z.string() })

const Changed = z.object({ path: z.string(), size: z.int().min(0) })

/** What a turn changed in the folder: the first 100 of each kind, and how many there were. */
export const FolderChangesSchema = z.object({
  added: z.array(Changed),
  modified: z.array(Changed),
  deleted: z.array(Changed),
  counts: z.object({
    added: z.int().min(0),
    modified: z.int().min(0),
    deleted: z.int().min(0),
    dirsAdded: z.int().min(0),
    dirsDeleted: z.int().min(0),
  }),
  dirsAdded: z.array(z.string()),
  dirsDeleted: z.array(z.string()),
})

/** What a turn left out of the folder, the first few and how many. */
export const FolderWarningsSchema = z.object({
  items: z.array(z.object({ path: z.string(), reason: z.string() })),
  total: z.int().min(0),
})

/** A tool call's arguments are cut to this many characters. */
export const MAX_ARGUMENTS = 2000

/** A connector tool call that finished, as the page shows it: never a provider's result. */
const ToolCall = z.object({
  /** The tool name cut to 64 characters, `todoist2_list_tasks`. */
  tool: z.string(),
  /** `Todoist (2): List tasks`. */
  label: z.string(),
  /**
   * The arguments' JSON, cut to its first 2000 characters when longer. A string, not an object, so that it reaches Laravel
   * exactly as written: no key is lost to a parser (`__proto__`), and an empty object stays one in PHP.
   */
  arguments: z.string().max(MAX_ARGUMENTS),
  /** Whether `arguments` was cut. */
  truncated: z.boolean(),
})

const ToolCallData = z.discriminatedUnion('decision', [
  ToolCall.extend({
    decision: z.literal('allowed'),
    title: z.string(),
    count: z.int().min(0).nullable(),
    /** For a write: 32 hex, a keyed hash of (run, write key). */
    write: z.string().optional(),
    /** The same write asked for again, answered from the run's record. */
    repeat: z.literal(true).optional(),
  }),
  ToolCall.extend({ decision: z.enum(['denied', 'error']), code: z.string(), message: z.string() }),
])

/** A read, write, edit or bash call in the folder that finished. */
const LocalToolData = z.object({ tool: z.enum(['read', 'write', 'edit', 'bash']), summary: z.string(), ok: z.boolean(), excerpt: z.string() })

const fact = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ seq: Seq, run: Id, at: Time, type: z.literal(type), data })

/** The schemas mirror the engine's shapes (shapes.ts); the compiler checks they agree. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
true satisfies Same<z.infer<typeof AttachedFile>, Attachment>
true satisfies Same<z.infer<typeof FolderChangesSchema>, FolderChanges>
true satisfies Same<z.infer<typeof FolderWarningsSchema>, FolderWarnings>
true satisfies Same<z.infer<typeof LocalToolData>, LocalToolEventData>

export const Fact = z.discriminatedUnion('type', [
  /** The run started an attempt, or is running it. */
  fact('run.status', z.object({ status: z.enum(['provisioning', 'running']), attempt: z.int().min(1) })),
  fact('run.tool_call', ToolCallData),
  fact('run.local_tool', LocalToolData),
  /** A write's settlement, also one that settles after the run was cancelled, for the audit log. */
  fact(
    'run.write',
    z.object({
      write: z.string(),
      tool: z.string(),
      connection: Id,
      outcome: z.enum(['done', 'failed', 'uncertain']),
      afterCancel: z.boolean(),
    }),
  ),
  /** One model call's usage. */
  fact(
    'run.usage',
    z.object({
      /** 8 lowercase hex, as the call's deltas name it. */
      call: z.string(),
      model: z.string(),
      inputTokens: z.int().min(0),
      outputTokens: z.int().min(0),
      cachedTokens: z.int().min(0),
      reasoningTokens: z.int().min(0),
    }),
  ),
  /** The only terminal fact: Laravel marks a run finished from it alone, so a next start sees the whole turn. */
  fact(
    'run.finished',
    z.object({
      status: z.enum(['completed', 'failed', 'cancelled', 'timed_out']),
      /** Why it ended, for users; empty when it did not fail. */
      error: z.string(),
      /** The final answer; null when the run wrote none. */
      message: z.object({ id: Id, content: z.string() }).nullable(),
      /** The folder it started from and left, and what changed; null when the run had no folder. */
      folder: z
        .object({
          base: Id.nullable(),
          result: Id.nullable(),
          changes: FolderChangesSchema.nullable(),
          warnings: FolderWarningsSchema.nullable(),
        })
        .nullable(),
    }),
  ),
])
export type Fact = z.infer<typeof Fact>

/** At most this many facts go in one delivery or one page of a replay. */
export const MAX_FACTS = 500

/** A conversation's facts in `seq` order: a delivery's body, and a replay's page. */
export const FactBatch = z.object({ conversation: Id, facts: z.array(Fact).min(1).max(MAX_FACTS) })
