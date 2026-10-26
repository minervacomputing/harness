// Facts: what the engine tells Laravel about its runs, written to its outbox with the execution facts they describe and
// delivered in order per conversation. Deltas and phases are not facts: the browser
// streams them from the engine.

import { z } from 'zod'
import type { Attachment, FolderChanges, FolderWarnings, LocalToolEventData } from '../shapes.ts'
import { PricesVersion } from './catalog.ts'
import { Id, Provider, Seq, Time } from './common.ts'

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

/** A run holds at most this many calls for approval. */
export const MAX_HOLDS = 10

/** A held call's arguments are at most 1.5 MiB of UTF-8, the engine's measure, and so at most this many characters. */
export const MAX_HELD_ARGUMENTS = 1_572_864

/** 32 lowercase hex, a keyed hash of (run, write key): the same for a write and its repeat, different across runs. */
const Write = z.string()

/** A held call's place in its run, from 1. */
const HeldPosition = z.int().min(1).max(MAX_HOLDS)

/** The held call a continuation carried out or refused. */
const Approved = z.object({ run: Id, position: HeldPosition })

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
  approved: Approved.optional(),
})

const ToolCallData = z.discriminatedUnion('decision', [
  ToolCall.extend({
    decision: z.literal('allowed'),
    title: z.string(),
    count: z.int().min(0).nullable(),
    /** For a write. */
    write: Write.optional(),
    /** The same write asked for again, answered from the run's record. */
    repeat: z.literal(true).optional(),
  }),
  ToolCall.extend({
    decision: z.enum(['denied', 'error']),
    code: z.string(),
    message: z.string(),
    /** For a call held for approval (`APPROVAL_REQUIRED`): its `run.held_call`'s. */
    write: Write.optional(),
  }),
])

/** One resource and action a held call needs, named as a grant names them, and what the layers make of it. */
const HeldRequirement = z.object({
  kind: z.string().min(1).max(64),
  kindLabel: z.string(),
  resource: z.string().min(1).max(200),
  /** The provider's name for the resource; absent when it could not be read or left it out. */
  name: z.string().max(300).optional(),
  action: z.string().min(1).max(64),
  actionLabel: z.string(),
  effect: z.enum(['ask', 'allow']),
  /** The layers that asked; empty on an allow. */
  asked: z.array(z.enum(['ceiling', 'agent', 'user'])),
})

/** A read, write, edit or bash call in the folder that finished. */
const LocalToolData = z.object({ tool: z.enum(['read', 'write', 'edit', 'bash']), summary: z.string(), ok: z.boolean(), excerpt: z.string() })

const Count = z.int().min(0)

/** 8 lowercase hex, as the call's deltas name it; unique within its run. */
const Call = z.string()

/** The UTF-8 length of the request's JSON as sent; absent when the call built no request. */
const RequestBytes = Count.optional()

/** A call's charge in µ$, at the rates of the price table `prices` names; both absent when the engine priced nothing. */
const Charge = { costMicros: Count.optional(), prices: PricesVersion.optional() }
const together = (keys: string[]) => (data: Record<string, unknown>) => new Set(keys.map((key) => data[key] === undefined)).size === 1
const priced = [together(['costMicros', 'prices']), { message: 'costMicros and prices come together.' }] as const

/**
 * A counted model call that reported no usage. One the provider refused (a 4xx) cost nothing; every other is counted at its
 * reservation, estimated.
 */
const UnmeteredData = z.discriminatedUnion('cause', [
  z.object({
    call: Call,
    provider: z.string(),
    model: z.string(),
    cause: z.literal('refused'),
    inputTokens: z.literal(0),
    outputTokens: z.literal(0),
    estimated: z.literal(false),
    requestBytes: RequestBytes,
    ...Charge,
    costMicros: z.literal(0).optional(),
  }).refine(...priced),
  z.object({
    call: Call,
    provider: z.string(),
    model: z.string(),
    /**
     * An answer with no usage report, a call stopped with no answer, one that failed with no answer, or one left open by an
     * object instance that is gone.
     */
    cause: z.enum(['no_usage', 'stopped', 'failed', 'lost']),
    inputTokens: Count,
    outputTokens: Count,
    estimated: z.literal(true),
    requestBytes: RequestBytes,
    ...Charge,
  }).refine(...priced),
])

const fact = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ seq: Seq, run: Id, at: Time, type: z.literal(type), data })

/** The schemas mirror the engine's shapes (shapes.ts); the compiler checks they agree. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
true satisfies Same<z.infer<typeof AttachedFile>, Attachment>
true satisfies Same<z.infer<typeof FolderChangesSchema>, FolderChanges>
true satisfies Same<z.infer<typeof FolderWarningsSchema>, FolderWarnings>
true satisfies Same<z.infer<typeof LocalToolData>, LocalToolEventData>

export const Fact = z.discriminatedUnion('type', [
  /** The run started an attempt, or is running it. A run's first `running` comes only after its attachments are copied. */
  fact('run.status', z.object({ status: z.enum(['provisioning', 'running']), attempt: z.int().min(1) })),
  fact('run.tool_call', ToolCallData),
  /** A write held for the user's approval, written with its hold, before the call's refused `run.tool_call`. */
  fact(
    'run.held_call',
    z.object({
      position: HeldPosition,
      /** As `run.tool_call` names it. */
      tool: z.string(),
      /** `Gmail: Send mail`. */
      label: z.string(),
      connection: Id,
      provider: Provider,
      operation: z.string().min(1).max(64),
      requirements: z.array(HeldRequirement).min(1),
      /** The validated fields' canonical JSON as a string, as on `run.tool_call`, but never cut. */
      arguments: z.string().max(MAX_HELD_ARGUMENTS),
      write: Write,
    }),
  ),
  fact('run.local_tool', LocalToolData),
  /** A write's settlement, also one that settles after the run was cancelled, for the audit log. */
  fact(
    'run.write',
    z.object({
      write: Write,
      tool: z.string(),
      connection: Id,
      outcome: z.enum(['done', 'failed', 'uncertain']),
      afterCancel: z.boolean(),
      approved: Approved.optional(),
    }),
  ),
  /** One model call's usage, as the provider reported it. */
  fact(
    'run.usage',
    z.object({
      call: Call,
      /** The route's provider; with `model`, what prices the call. */
      provider: z.string().optional(),
      model: z.string(),
      /** Every input token, cache reads and writes included. */
      inputTokens: Count,
      outputTokens: Count,
      /** Input tokens read from the provider's cache. */
      cachedTokens: Count,
      /** Input tokens written to the provider's cache. */
      cacheWriteTokens: Count.optional(),
      reasoningTokens: Count,
      requestBytes: RequestBytes,
      ...Charge,
    }).refine(...priced),
  ),
  fact('run.unmetered', UnmeteredData),
  /**
   * A run's totals, written once after it finished and every one of its calls and scripts settled, so its sequence is above
   * every `run.usage` and `run.unmetered` of its run. Reported tokens and estimates are kept apart.
   */
  fact(
    'run.settled',
    z.object({
      /** Every counted call: the run's `run.usage` and `run.unmetered` facts number exactly this. */
      modelCalls: Count,
      refusedCalls: Count,
      unmeteredCalls: Count,
      inputTokens: Count,
      outputTokens: Count,
      cachedTokens: Count,
      cacheWriteTokens: Count,
      reasoningTokens: Count,
      estimatedInputTokens: Count,
      estimatedOutputTokens: Count,
      containers: Count,
      containerMs: Count,
      /** A container's span was still open, was found stopped, or ran past its lease's cutoff. */
      containerEstimated: z.boolean(),
      scripts: Count,
      scriptMs: Count,
      /** A script was ended at its clock's bound because the object instance running it was gone. */
      scriptEstimated: z.boolean(),
      /**
       * What the run is charged, in µ$, all present or all absent: its calls' `costMicros`, its container time priced by the
       * table `prices` names, its scripts' charges, and their sum.
       */
      prices: PricesVersion.optional(),
      modelMicros: Count.optional(),
      containerMicros: Count.optional(),
      scriptMicros: Count.optional(),
      chargedMicros: Count.optional(),
    }).refine(together(['prices', 'modelMicros', 'containerMicros', 'scriptMicros', 'chargedMicros']), { message: "A run's charge has every field or none." }),
  ),
  /** The only terminal fact: Laravel marks a run finished from it alone, so a next start sees the whole turn. */
  fact(
    'run.finished',
    z.object({
      status: z.enum(['completed', 'failed', 'cancelled', 'timed_out']),
      /** Why it ended, for users; empty when it did not fail. */
      error: z.string(),
      /**
       * Why it ended, for code (`budget_reached`, `folder_limit`; `attachment_unavailable` and `workspace_full` for a run whose
       * copy of its attachments failed); empty when it completed.
       */
      code: z.string().optional(),
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
      /**
       * The bytes the conversation's folder keeps once the run has ended: each distinct contents of every version it keeps,
       * counted once and rounded up to whole 4 KiB pages (an empty file counts 0), what a failed clean-up left included and
       * copies the engine is still deleting left out. It holds until the conversation's next run starts; absent when it could not be read.
       */
      storedBytes: Count.optional(),
    }),
  ),
])
export type Fact = z.infer<typeof Fact>

/** At most this many facts go in one delivery or one page of a replay. */
export const MAX_FACTS = 500

/** A conversation's facts in `seq` order: a delivery's body, and a replay's page. */
export const FactBatch = z.object({ conversation: Id, facts: z.array(Fact).min(1).max(MAX_FACTS) })
