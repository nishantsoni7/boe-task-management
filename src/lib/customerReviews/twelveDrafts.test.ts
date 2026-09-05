/**
 * TWELVE DRAFTS A BATCH, proved at every place the number is written down.
 *
 * The number lives in four places that have to agree, and this file is what
 * makes disagreement a failing test rather than a batch the database refuses
 * after the model call has been paid for:
 *
 *   1. DRAFTS_PER_BATCH, which the prompt, the validator and the UI read;
 *   2. the CHECK on customer_review_draft_batches.card_count;
 *   3. the count guard inside create_customer_review_draft_batch();
 *   4. the upper bound inside approve_customer_review_drafts(), because a
 *      batch you can generate but not approve is worse than one you cannot
 *      generate.
 *
 * AND ONE THING THE NUMBER MUST NOT DO: invalidate the eight-draft batches
 * already in the database. The constraints are added NOT VALID for exactly that
 * reason, and the assertion below is the only thing standing between that
 * decision and somebody "tidying" it into a plain CHECK that would fail on
 * every historical row.
 *
 * NO PROVIDER IS CALLED. The generation test drives runGeneration() with a
 * counted fake, the same harness generationRun.test.ts uses. There is no
 * network in this file and no ANTHROPIC_API_KEY is read.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/twelveDrafts.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DRAFTS_PER_BATCH,
  buildSystemPrompt,
  buildUserPrompt,
  validateDrafts,
} from './draftGeneration'
import { runGeneration, type ClaimOutcome, type RunDeps } from './generationRun'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261031000000_review_workflow_twelve_drafts_editing_and_images.sql'

/** SQL with the comments stripped, so a claim cannot be satisfied by prose. */
const executable = (source: string) =>
  source
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--'))
    .join('\n')

const SQL = executable(read(MIGRATION))

const KEY = '11111111-2222-4333-8444-555555555555'

/** A batch the validator accepts, so the negative cases mean something. */
const goodDrafts = (n = DRAFTS_PER_BATCH) =>
  Array.from({ length: n }, (_, i) => ({
    title: `Draft number ${i + 1}`,
    body: `We ordered seating for a small dining room and the fit was right first time. Draft ${i + 1} exists to be long enough to pass the minimum length check comfortably.`,
    category: 'restaurant_test',
  }))

// ══ 1. THE CONSTANT ═════════════════════════════════════════════════════════

describe('twelve, and everything that reads the number', () => {
  test('the constant is twelve', () => {
    assert.equal(DRAFTS_PER_BATCH, 12)
  })

  test('the prompt asks the model for exactly twelve', () => {
    const prompt = buildUserPrompt('Cafe seating, plain and specific.')
    assert.ok(prompt.includes('Draft exactly 12 reviews'))
    assert.ok(prompt.includes('a JSON array of 12 objects'))

    // THE BATCH SIZE IS STILL TWELVE AND ONLY TWELVE. This used to be "the word
    // eight appears nowhere", which was the right assertion while eight was the
    // COUNT it had been mistaken for. Review types then made 8 a legitimate
    // number in this prompt — eight of the twelve are posted as text — so the
    // assertion is narrowed to what it was always defending: that no sentence
    // asks the model for eight REVIEWS.
    assert.equal(/\b(8|eight)\s+reviews?\b/i.test(prompt), false, 'the prompt still asks for eight reviews')
    assert.equal(/exactly\s+(8|eight)\b/i.test(prompt), false, 'the prompt still says exactly eight')
    assert.equal(/array of (8|eight)\b/i.test(prompt), false, 'the prompt still asks for an array of eight')
  })

  test('…and the composition it describes is not a count the model controls', () => {
    // The prompt TELLS the model what the last four drafts are for, because a
    // draft written to sit beside photographs reads better beside them. It does
    // not ask the model to label anything: there is no `type` field in the
    // schema the system turn defines, and assignReviewTypes() stamps eight text
    // and four image on whatever comes back — see reviewTypes.test.ts.
    const prompt = buildUserPrompt('Cafe seating, plain and specific.')
    assert.ok(prompt.includes('posted as text alone'))
    assert.ok(prompt.includes('alongside photographs of a single completed project'))
    assert.equal(/"type"/.test(buildSystemPrompt()), false,
      'the model is asked to label a review type')
  })

  test('the system turn does not name a count at all', () => {
    // It says "The user message says how many", which is what lets the SAME
    // system prompt serve a generation of twelve and a revision of three.
    const system = buildSystemPrompt()
    assert.ok(system.includes('The user message says how many'))
    assert.equal(/\b12\b|\btwelve\b/i.test(system), false)
  })

  test('the UI reads the constant rather than a literal', () => {
    // Every user-facing count in the generate flow interpolates
    // DRAFTS_PER_BATCH, so "Generate 12 drafts" is a consequence of the
    // constant rather than a second place to change.
    const panel = read('src/components/customerReviews/GenerateDrafts.tsx')
    assert.ok(panel.includes('Generate {DRAFTS_PER_BATCH} drafts'))
    assert.ok(panel.includes('Generate ${DRAFTS_PER_BATCH} review drafts'))
    assert.ok(panel.includes('Yes, create ${DRAFTS_PER_BATCH} drafts'))
    assert.ok(panel.includes('This creates exactly {DRAFTS_PER_BATCH} drafts'))
    // No hard-coded count anywhere in the panel's executable lines.
    const code = panel.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/>\s*Generate 8\b|>\s*Generate 12\b/.test(code), false)
  })

  test('the batch toolbar counts what is actually pending, not the batch size', () => {
    // "Approve all N" has to say how many are STILL pending, because approving
    // four of twelve leaves eight — a label reading "Approve all 12" after that
    // would name a set that no longer exists.
    const pending = read('src/components/customerReviews/PendingBatches.tsx')
    assert.ok(pending.includes('Approve all {pendingCount}'))
    assert.ok(pending.includes('Select all {pendingCount} in this batch'))
    assert.equal(/Approve all 8\b|Approve all 12\b/.test(pending), false)
  })
})

// ══ 2. VALIDATION ═══════════════════════════════════════════════════════════

describe('exactly twelve, or nothing', () => {
  test('twelve good drafts validate', () => {
    const result = validateDrafts(goodDrafts())
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.drafts.length, 12)
  })

  test('eleven and thirteen are both refused — and so is the retired eight', () => {
    for (const n of [0, 1, 8, 11, 13, 20]) {
      const result = validateDrafts(goodDrafts(n))
      assert.equal(result.ok, false, `${n} drafts were accepted`)
    }
  })

  test('the refusal names both numbers, so the log says what went wrong', () => {
    const result = validateDrafts(goodDrafts(11))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('11'))
      assert.ok(result.error.includes('12'))
    }
  })

  test('a revision still validates any size between one and twelve', () => {
    // validateDrafts takes `expected` as a parameter precisely so a revision of
    // the three drafts still pending in a batch is held to the same rules.
    for (const n of [1, 3, 12]) {
      const result = validateDrafts(goodDrafts(n), n)
      assert.equal(result.ok, true, `${n} drafts were refused for a revision`)
    }
  })
})

// ══ 3. ONE BATCH OF TWELVE, THROUGH THE ORCHESTRATOR ════════════════════════

describe('a generation writes ONE batch of exactly twelve', () => {
  /**
   * The claim table and the provider, both faked, both counted.
   *
   * THE PROVIDER RETURNS TWELVE and the insert receives twelve. Those are two
   * different assertions: the first is that the model was asked for the right
   * number, the second is that everything the orchestrator hands to SQL came
   * from the reply it validated.
   */
  function harness(reply: () => Promise<string>) {
    const claims = new Map<string, { state: 'running' | 'completed'; batchId: string | null; count: number | null }>()
    const providerCalls: string[] = []
    const inserted: { drafts: unknown[]; batchId: string }[] = []

    const deps: RunDeps = {
      claim: async (key) => {
        await Promise.resolve()
        const existing = claims.get(key)
        if (!existing) {
          claims.set(key, { state: 'running', batchId: null, count: null })
          return { outcome: 'claimed', attempts: 1 } satisfies ClaimOutcome
        }
        if (existing.state === 'completed') {
          return { outcome: 'completed', batchId: existing.batchId as string, resultCount: existing.count }
        }
        return { outcome: 'in_progress', attempts: 1 }
      },
      finish: async (key, state, batchId, count) => {
        await Promise.resolve()
        const row = claims.get(key)
        if (!row) return
        if (state === 'failed') { claims.delete(key); return }
        row.state = 'completed'; row.batchId = batchId; row.count = count
      },
      provider: async (prompt) => { providerCalls.push(prompt.user); return reply() },
      log: () => {},
    }

    const input = {
      requestKey: KEY,
      guidance: 'Cafe seating, plain and specific.',
      model: 'claude-opus-5',
      buildSystem: buildSystemPrompt,
      buildUser: buildUserPrompt,
      maxTokens: 6000,
      insertBatch: async (drafts: unknown[]) => {
        inserted.push({ drafts, batchId: 'batch-1' })
        return { ok: true as const, batchId: 'batch-1' }
      },
    }

    return { deps, input, providerCalls, inserted, claims }
  }

  test('twelve drafts are stored as ONE batch, in one insert', async () => {
    const h = harness(async () => JSON.stringify(goodDrafts(12)))
    const result = await runGeneration(h.deps, h.input)

    assert.equal(result.kind, 'completed')
    if (result.kind === 'completed') {
      assert.equal(result.created, 12)
      assert.equal(result.repeated, false)
      assert.equal(result.batchId, 'batch-1')
    }

    // ONE insert, carrying twelve. Two inserts would be two batches, which is
    // the thing "stored as one batch" rules out.
    assert.equal(h.inserted.length, 1, 'the drafts were written in more than one insert')
    assert.equal(h.inserted[0].drafts.length, 12)

    // And the model was asked once, for twelve.
    assert.equal(h.providerCalls.length, 1)
    assert.ok(h.providerCalls[0].includes('Draft exactly 12 reviews'))
  })

  test('the claim is completed with twelve, so a repeat returns the same batch', async () => {
    const h = harness(async () => JSON.stringify(goodDrafts(12)))
    await runGeneration(h.deps, h.input)

    const repeat = await runGeneration(h.deps, h.input)
    assert.equal(repeat.kind, 'completed')
    if (repeat.kind === 'completed') {
      assert.equal(repeat.repeated, true)
      assert.equal(repeat.created, 12)
      assert.equal(repeat.batchId, 'batch-1')
    }
    // STILL ONE CALL. The repeat consulted the claim and never reached the
    // provider, which is the money property this count protects.
    assert.equal(h.providerCalls.length, 1)
  })

  test('a reply of eleven writes NOTHING and releases the key', async () => {
    const h = harness(async () => JSON.stringify(goodDrafts(11)))
    const result = await runGeneration(h.deps, h.input)

    assert.notEqual(result.kind, 'completed')
    // No half-batch. The whole point of validating before inserting.
    assert.equal(h.inserted.length, 0)
    // The key is released, so an honest retry is not told "already in progress".
    assert.equal(h.claims.has(KEY), false)
  })

  test('a reply of thirteen is refused too — extra is not a bonus', async () => {
    const h = harness(async () => JSON.stringify(goodDrafts(13)))
    const result = await runGeneration(h.deps, h.input)
    assert.notEqual(result.kind, 'completed')
    assert.equal(h.inserted.length, 0)
  })
})

// ══ 4. THE DATABASE SAYS TWELVE TOO ═════════════════════════════════════════

describe('the migration pins the same number', () => {
  test('card_count and expected_count both say twelve', () => {
    assert.ok(SQL.includes('check (card_count = 12)'))
    assert.ok(SQL.includes('check (expected_count = 12 and card_count = expected_count)'))
  })

  test('AND BOTH ARE NOT VALID, so existing eight-draft batches survive', () => {
    // THE ASSERTION THIS FILE MOST NEEDS. A plain CHECK is validated against
    // every existing row when it is added: every batch generated before this
    // change holds eight, so the plain form would either fail to apply or
    // condemn real history. NOT VALID enforces the rule on new writes and asks
    // nothing of the rows already there.
    //
    // Anybody "tidying" the NOT VALID away breaks this test, which is the
    // entire reason it is written as a source assertion rather than a comment.
    assert.ok(SQL.includes('check (card_count = 12) not valid'))
    assert.ok(SQL.includes('check (expected_count = 12 and card_count = expected_count) not valid'))
  })

  test('the generator refuses anything but twelve', () => {
    const start = SQL.indexOf('create or replace function public.create_customer_review_draft_batch(')
    assert.ok(start >= 0, 'the generator is not redefined')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(fn.includes('if v_n <> 12 then'))
    assert.ok(fn.includes('expected exactly 12'))
    assert.ok(fn.includes('values (p_actor_id, p_guidance, p_model, 12, 12, p_request_key)'))
    // The status the drafts land in is unchanged, and it is the safety property
    // the whole workflow rests on.
    assert.ok(fn.includes("'pending_approval')"))
    assert.equal(/\b8\b/.test(fn), false, 'an eight survives in the generator')
  })

  test('approval accepts a full batch of twelve', () => {
    // A batch you can generate but not approve would be worse than one you
    // cannot generate: the drafts would exist, be visible to a verifier, and
    // refuse to be released.
    const start = SQL.indexOf('create or replace function public.approve_customer_review_drafts(')
    assert.ok(start >= 0, 'approval is not redefined')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(fn.includes('if v_asked > 12 then'))
    assert.ok(fn.includes('A batch holds twelve reviews'))
    // The permission check is still there, unchanged, and still resolved.
    assert.ok(fn.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
  })

  test('the revision and claim bounds were widened, not left at eight', () => {
    assert.ok(SQL.includes('check (revised_count between 1 and 12)'))
    assert.ok(SQL.includes('check (result_count is null or result_count between 1 and 12)'))
  })

  test('and no eight is left anywhere in the twelve section', () => {
    // A crude sweep, and it earns its place: the numbers in this migration are
    // all counts, so a stray 8 is a stray count.
    const twelveSection = SQL.slice(0, SQL.indexOf('2. EDITING A DRAFT') >= 0
      ? SQL.indexOf('2. EDITING A DRAFT')
      : SQL.length)
    assert.equal(/\b8\b/.test(twelveSection), false, 'an eight survives in the twelve section')
  })
})

// ══ 5. WHAT THE COUNT CHANGE MUST NOT BREAK ═════════════════════════════════

describe('raising the count did not weaken anything else', () => {
  test('the token budget grew with the batch', () => {
    // TWELVE BODIES AT 900 CHARACTERS DO NOT FIT IN 4000 TOKENS with the
    // titles and the JSON scaffolding, and a reply cut off mid-array is invalid
    // JSON — refused whole, after the call has been paid for. The budget is
    // sized per draft, so it had to move when the count did.
    const route = read('src/app/api/customer-reviews/generate/route.ts')
    assert.ok(route.includes('const MAX_TOKENS = 6000'))
  })

  test('the missing-key guard is untouched, and still creates nothing', () => {
    const route = read('src/app/api/customer-reviews/generate/route.ts')
    const code = route.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.ok(code.includes('const apiKey = process.env.ANTHROPIC_API_KEY'))
    assert.ok(code.includes('if (!apiKey) return fail(503, MESSAGES.not_configured)'))
    // BEFORE THE CLAIM, which is what makes a misconfigured deployment refuse
    // having claimed nothing and written nothing.
    assert.ok(code.indexOf('process.env.ANTHROPIC_API_KEY') < code.indexOf('await runGeneration('))
  })

  test('the route still holds the credential, and the browser still cannot', () => {
    const panel = read('src/components/customerReviews/GenerateDrafts.tsx')
    const code = panel.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/ANTHROPIC|api[_-]?key|anthropic\.com/i.test(code), false)
  })
})
