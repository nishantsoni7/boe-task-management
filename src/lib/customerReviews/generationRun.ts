// THE ORDER A PROVIDER-BACKED REQUEST HAPPENS IN, AND NOTHING ELSE.
//
// SERVER ONLY. It reads no credential and builds no client: every effect is a
// function handed in, which is the whole point of the file. The routes wire the
// real ones; the tests wire a counting stub and can therefore prove the one
// property that matters and that a database test cannot reach — THAT THE MODEL
// IS CALLED EXACTLY ONCE PER REQUEST KEY, even when two requests arrive at the
// same instant on two server instances.
//
// ── WHY THIS IS NOT IN THE ROUTES ──────────────────────────────────────────
//
// It was. The routes read the key, saw nothing, and called the provider — which
// is correct for a repeat that arrives a second later and useless for one that
// arrives in the same millisecond:
//
//     A reads the key → nothing        B reads the key → nothing
//     A calls Anthropic                B calls Anthropic
//     A inserts a batch                B is refused by the unique index
//
// One batch, two invoices. The window is the network call, so the fix has to be
// a durable claim taken BEFORE it — see
// supabase/migrations/20261027000000_review_workflow_generation_claims.sql.
// Keeping the sequence in a route made it untestable without a live Next
// server, a live Postgres and a live provider, so it moved here.
//
// ── THE SEQUENCE ───────────────────────────────────────────────────────────
//
//   1. CLAIM the request key. One upsert, committed immediately.
//        claimed      → continue; nobody else may call the provider for this key
//        in_progress  → stop, 409. Its twin is mid-flight.
//        completed    → stop, 200 with the result the first run produced.
//   2. Everything the model needs, read now that we hold the claim.
//   3. CALL THE PROVIDER. Nothing is held: no transaction, no lock, no row.
//   4. VALIDATE. A batch that fails validation writes nothing.
//   5. WRITE, atomically, through the definer function.
//   6. FINISH — 'completed' keeps the claim as the answer to a repeat;
//      'failed' DELETES it so a legitimate retry is a fresh attempt.
//
// Step 6 runs on EVERY exit after step 1. That is the property that keeps a
// crash from being the only way a claim leaks, and it is why every failure path
// below goes through `fail()` rather than returning directly.

import {
  validateDrafts,
  type GeneratedDraft,
} from './draftGeneration'
import type { GenerationSettings } from './generationSettings'

/** What the claim function answered. Mirrors its `outcome` column exactly. */
export type ClaimOutcome =
  | { outcome: 'claimed'; attempts: number }
  | { outcome: 'in_progress'; attempts: number | null }
  | { outcome: 'completed'; batchId: string; resultCount: number | null }

/**
 * Everything that touches the outside world, so a test can hand over stubs.
 *
 * `provider` returns the model's raw text. It is deliberately the ONLY thing
 * here that costs money, so a test counting its invocations is measuring the
 * exact quantity this file exists to bound.
 */
export type RunDeps = {
  claim: (key: string) => Promise<ClaimOutcome>
  finish: (key: string, state: 'completed' | 'failed', batchId: string | null, count: number | null) => Promise<void>
  provider: (prompt: { system: string; user: string; maxTokens: number }) => Promise<string>
  /** Server-side only; never reaches a caller. */
  log: (...parts: unknown[]) => void
}

export type RunFailure = {
  kind: 'failed'
  status: number
  /** A prewritten sentence. Never a provider's words and never a credential. */
  message: string
}

export type GenerationSuccess = {
  kind: 'completed'
  batchId: string
  created: number
  /** True when the answer came from a claim somebody else's run completed. */
  repeated: boolean
}

export type InProgress = {
  kind: 'in_progress'
  status: 409
  message: string
}

export type GenerationResult = GenerationSuccess | InProgress | RunFailure

// Prewritten, every one. A provider's error text can quote the request, so it
// goes to the server log and a sentence from here goes to the browser.
export const RUN_MESSAGES = {
  in_progress_generate:
    'That batch is already being generated. Wait a moment and reload — it will appear under Pending approval.',
  in_progress_revise:
    'That revision is already running. Wait a moment and reload the batch.',
  unavailable: 'The generator is unavailable right now. Please try again in a moment.',
  model_failed:
    'The generator did not return a usable batch. Nothing was created. Please try again.',
  revision_failed:
    'The generator did not return a usable set. Nothing was changed. Please try again.',
  insert_failed: 'That batch could not be saved. Nothing was created.',
  write_failed: 'That revision could not be saved. Nothing was changed.',
  nothing_pending:
    'Every review in that batch has already been approved, so there is nothing to revise.',
  changed:
    'The reviews awaiting approval in that batch changed while this was being prepared. Nothing was rewritten — open the batch again and try once more.',
  not_found: 'That batch no longer exists.',
} as const

// ─── Generation ───────────────────────────────────────────────────────────────

export type GenerationInput = {
  requestKey: string
  guidance: string
  /**
   * HOW MANY, AND WHAT KIND.
   *
   * The batch size lives here rather than in a module constant, so this
   * orchestrator ASKS FOR, VALIDATES AGAINST and REPORTS the same number — the
   * one the caller requested — instead of three separate references to a global
   * that used to happen to agree because there was only ever one value.
   */
  settings: GenerationSettings
  model: string
  buildSystem: () => string
  buildUser: (guidance: string, settings: GenerationSettings) => string
  maxTokens: number
  /** Writes the batch atomically. Returns the new batch id. */
  insertBatch: (drafts: GeneratedDraft[]) => Promise<{ ok: true; batchId: string } | { ok: false; code: string; message: string }>
}

export async function runGeneration(
  deps: RunDeps,
  input: GenerationInput,
): Promise<GenerationResult> {
  // ── 1. Claim ──────────────────────────────────────────────────────────────
  //
  // Before anything that costs money, and outside every later try/catch: if the
  // claim itself throws there is nothing to release, and calling finish() for a
  // claim we do not hold would delete somebody else's.
  const claimed = await deps.claim(input.requestKey)

  if (claimed.outcome === 'completed') {
    return {
      kind: 'completed',
      batchId: claimed.batchId,
      created: claimed.resultCount ?? input.settings.batchSize,
      repeated: true,
    }
  }
  if (claimed.outcome === 'in_progress') {
    // NOT AN ERROR THE CALLER SHOULD RETRY IMMEDIATELY, and not a success
    // either. Its twin is mid-flight and will write the batch; saying so is the
    // honest answer and it never starts a second provider call.
    return { kind: 'in_progress', status: 409, message: RUN_MESSAGES.in_progress_generate }
  }

  // From here the claim is HELD and every exit must release or complete it.
  const fail = async (status: number, message: string): Promise<RunFailure> => {
    await deps.finish(input.requestKey, 'failed', null, null).catch(err => {
      // A claim that could not be released expires on its own; losing the
      // release is not worth losing the caller's answer over.
      deps.log('[customer-reviews:generate] claim release failed:', (err as Error)?.name)
    })
    return { kind: 'failed', status, message }
  }

  // ── 2 + 3. The model ──────────────────────────────────────────────────────
  let text: string
  try {
    text = await deps.provider({
      system: input.buildSystem(),
      user: input.buildUser(input.guidance, input.settings),
      maxTokens: input.maxTokens,
    })
  } catch (err) {
    const name = (err as Error)?.name ?? 'error'
    deps.log('[customer-reviews:generate] provider call failed:', name)
    return fail(
      name === 'ProviderRefusedError' ? 422 : 502,
      name === 'ProviderRefusedError' ? RUN_MESSAGES.model_failed : RUN_MESSAGES.unavailable,
    )
  }

  // ── 4. Validate before anything is written ────────────────────────────────
  // AGAINST WHAT WAS ASKED FOR, never against a constant. A provider that
  // returned nineteen drafts for a batch of twenty is refused here, before
  // anything is written — the same rule at every size.
  const checked = validateDrafts(text, input.settings.batchSize)
  if (!checked.ok) {
    deps.log('[customer-reviews:generate] rejected batch:', checked.error)
    return fail(422, `${RUN_MESSAGES.model_failed} (${checked.error})`)
  }

  // ── 5. Write, atomically ──────────────────────────────────────────────────
  const written = await input.insertBatch(checked.drafts)
  if (!written.ok) {
    deps.log('[customer-reviews:generate] batch insert failed:', written.code)
    return fail(
      written.message.includes('UNAUTHORIZED') ? 403 : 500,
      written.message.includes('UNAUTHORIZED')
        ? 'You do not have permission to generate reviews.'
        : RUN_MESSAGES.insert_failed,
    )
  }

  // ── 6. Finish ─────────────────────────────────────────────────────────────
  await deps.finish(input.requestKey, 'completed', written.batchId, input.settings.batchSize)
    .catch(err => {
      // The batch EXISTS; a lost completion only means a repeat of this key
      // would be answered by the batch table's own unique index instead of by
      // the claim. Reporting failure here would be a lie about what happened.
      deps.log('[customer-reviews:generate] claim completion failed:', (err as Error)?.name)
    })

  return { kind: 'completed', batchId: written.batchId, created: input.settings.batchSize, repeated: false }
}

// ─── Revision ─────────────────────────────────────────────────────────────────

export type RevisionSuccess = {
  kind: 'completed'
  batchId: string
  revised: number
  repeated: boolean
}

export type RevisionResult = RevisionSuccess | InProgress | RunFailure

export type RevisionInput = {
  requestKey: string
  batchId: string
  feedback: string
  model: string
  buildSystem: () => string
  buildRevision: (args: {
    originalGuidance: string
    feedback: string
    current: readonly { title: string; body: string }[]
  }) => string
  maxTokens: number
  /** The batch's own guidance, and the drafts still pending, in card_ref order. */
  readBatch: () => Promise<
    | { ok: true; guidance: string; pending: { title: string; body: string }[] }
    | { ok: false; reason: 'not_found' | 'nothing_pending' | 'unavailable' }
  >
  applyRevision: (drafts: GeneratedDraft[]) => Promise<{ ok: true; revised: number } | { ok: false; code: string; message: string }>
}

export async function runRevision(
  deps: RunDeps,
  input: RevisionInput,
): Promise<RevisionResult> {
  const claimed = await deps.claim(input.requestKey)

  if (claimed.outcome === 'completed') {
    return {
      kind: 'completed',
      batchId: input.batchId,
      revised: claimed.resultCount ?? 0,
      repeated: true,
    }
  }
  if (claimed.outcome === 'in_progress') {
    return { kind: 'in_progress', status: 409, message: RUN_MESSAGES.in_progress_revise }
  }

  const fail = async (status: number, message: string): Promise<RunFailure> => {
    await deps.finish(input.requestKey, 'failed', null, null).catch(err => {
      deps.log('[customer-reviews:revise] claim release failed:', (err as Error)?.name)
    })
    return { kind: 'failed', status, message }
  }

  // ── What there is to revise ───────────────────────────────────────────────
  //
  // READ AFTER THE CLAIM, not before. Reading first would put a database round
  // trip inside the window two simultaneous requests race through, and the
  // count it produced could be stale by the time the claim was taken anyway.
  const batch = await input.readBatch()
  if (!batch.ok) {
    if (batch.reason === 'not_found')       return fail(404, RUN_MESSAGES.not_found)
    if (batch.reason === 'nothing_pending') return fail(409, RUN_MESSAGES.nothing_pending)
    return fail(503, RUN_MESSAGES.unavailable)
  }

  let text: string
  try {
    text = await deps.provider({
      system: input.buildSystem(),
      // ALL THREE INPUTS, EACH FENCED SEPARATELY: the batch's original guidance
      // (what it was for), the drafts as they stand (what "these" refers to),
      // and the new feedback (what to change). "Make these shorter" is only
      // answerable with all three, and all three are untrusted context rather
      // than instructions — see buildRevisionPrompt.
      user: input.buildRevision({
        originalGuidance: batch.guidance,
        feedback: input.feedback,
        current: batch.pending,
      }),
      maxTokens: input.maxTokens,
    })
  } catch (err) {
    const name = (err as Error)?.name ?? 'error'
    deps.log('[customer-reviews:revise] provider call failed:', name)
    return fail(
      name === 'ProviderRefusedError' ? 422 : 502,
      name === 'ProviderRefusedError' ? RUN_MESSAGES.revision_failed : RUN_MESSAGES.unavailable,
    )
  }

  // EXACTLY AS MANY AS WERE PENDING, held to the same rules as a fresh draft.
  const checked = validateDrafts(text, batch.pending.length)
  if (!checked.ok) {
    deps.log('[customer-reviews:revise] rejected revision:', checked.error)
    return fail(422, `${RUN_MESSAGES.revision_failed} (${checked.error})`)
  }

  const written = await input.applyRevision(checked.drafts)
  if (!written.ok) {
    deps.log('[customer-reviews:revise] revision failed:', written.code)
    const m = written.message
    if (m.includes('REVISION_CHANGED'))  return fail(409, RUN_MESSAGES.changed)
    if (m.includes('NOTHING_PENDING'))   return fail(409, RUN_MESSAGES.nothing_pending)
    if (m.includes('UNAUTHORIZED'))      return fail(403, 'You do not have permission to revise reviews.')
    if (m.includes('NOT_FOUND'))         return fail(404, RUN_MESSAGES.not_found)
    return fail(500, RUN_MESSAGES.write_failed)
  }

  await deps.finish(input.requestKey, 'completed', input.batchId, written.revised)
    .catch(err => {
      deps.log('[customer-reviews:revise] claim completion failed:', (err as Error)?.name)
    })

  return { kind: 'completed', batchId: input.batchId, revised: written.revised, repeated: false }
}

/**
 * A provider that answered, but declined.
 *
 * A safety decline arrives as an ordinary 200 with no usable content, so it is
 * not an HTTP failure and must not be reported as one — the caller should be
 * told their guidance was refused, not that the service is down.
 */
export class ProviderRefusedError extends Error {
  constructor() {
    super('the provider declined the request')
    this.name = 'ProviderRefusedError'
  }
}
