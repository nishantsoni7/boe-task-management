/**
 * A BATCH IS SIX TO TWENTY REVIEWS, proved at every place the range is written
 * down — and proved not to have broken the workflow the number runs through.
 *
 * This file replaces twelveDrafts.test.ts, which pinned the single fixed size
 * that came before. The range now lives in four places that have to agree, and
 * this is what makes disagreement a failing test rather than a batch the
 * database refuses after the model call has been paid for:
 *
 *   1. MIN_BATCH_SIZE / MAX_BATCH_SIZE, which the form, the validator and the
 *      route all read;
 *   2. the CHECK on customer_review_draft_batches.card_count;
 *   3. the size guard inside create_customer_review_draft_batch();
 *   4. the upper bound inside approve_customer_review_drafts(), because a batch
 *      you can generate but not approve is worse than one you cannot generate.
 *
 * AND TWO THINGS THE RANGE MUST NOT DO.
 *
 * It must not invalidate the batches already in the database — 20, 8 and 12 are
 * all inside it, and the constraints are added NOT VALID anyway, for the reason
 * the historical section below still asserts.
 *
 * And it must not leave a fixed twelve anywhere downstream. Approval, "approve
 * all", assignment and revision are each checked here for the assumption.
 *
 * NO PROVIDER IS CALLED. The generation tests drive runGeneration() with a
 * counted fake, the same harness generationRun.test.ts uses. There is no
 * network in this file and no ANTHROPIC_API_KEY is read.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/batchSize.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  buildUserPrompt,
  maxTokensFor,
  validateDrafts,
} from './draftGeneration'
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_GENERATION_SETTINGS,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  validateGenerationSettings,
  type GenerationSettings,
} from './generationSettings'
import { imageReviewsFor, textReviewsFor } from './reviewTypes'
import { runGeneration, type ClaimOutcome, type RunDeps } from './generationRun'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const HISTORIC = 'supabase/migrations/20261031000000_review_workflow_twelve_drafts_editing_and_images.sql'
const MIGRATION = 'supabase/migrations/20261108000000_review_workflow_variable_batch_size.sql'

/** SQL with the comments stripped, so a claim cannot be satisfied by prose. */
const executable = (source: string) =>
  source
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--'))
    .join('\n')

const HISTORIC_SQL = executable(read(HISTORIC))
const SQL = executable(read(MIGRATION))

const KEY = '11111111-2222-4333-8444-555555555555'

/** A batch the validator accepts, so the negative cases mean something. */
const goodDrafts = (n = DEFAULT_BATCH_SIZE) =>
  Array.from({ length: n }, (_, i) => ({
    title: `Draft number ${i + 1}`,
    body: `We ordered seating for a small dining room and the fit was right first time. Draft ${i + 1} exists to be long enough to pass the minimum length check comfortably.`,
    category: 'restaurant_test',
  }))

const settingsFor = (batchSize: number): GenerationSettings => {
  const checked = validateGenerationSettings({ ...DEFAULT_GENERATION_SETTINGS, batchSize })
  assert.equal(checked.ok, true, checked.ok ? '' : checked.error)
  if (!checked.ok) throw new Error('unreachable')
  return checked.settings
}

// ══ 1. THE RANGE ════════════════════════════════════════════════════════════

describe('six to twenty, and everything that reads the range', () => {
  test('the constants are six and twenty, and the default is twelve', () => {
    assert.equal(MIN_BATCH_SIZE, 6)
    assert.equal(MAX_BATCH_SIZE, 20)
    assert.equal(DEFAULT_BATCH_SIZE, 12)
  })

  test('the prompt asks the model for exactly the number requested', () => {
    for (const n of [6, 12, 17, 20]) {
      const prompt = buildUserPrompt('Cafe seating, plain and specific.', settingsFor(n))
      assert.ok(prompt.includes(`Draft exactly ${n} reviews`), `${n} is not asked for`)
      assert.ok(prompt.includes(`a JSON array of ${n} objects`), `${n} is not the array length`)
    }
  })

  test('the prompt describes the composition that batch size implies', () => {
    for (const n of [6, 12, 20]) {
      const prompt = buildUserPrompt('Cafe seating.', settingsFor(n))
      assert.ok(prompt.includes(`The first ${textReviewsFor(n)} will be posted as text alone`))
      assert.ok(prompt.includes(`the last ${imageReviewsFor(n)} will be posted alongside photographs`))
    }
  })

  test('…and the composition is still not a count the model controls', () => {
    // The prompt TELLS the model what the last few drafts are for, because a
    // draft written to sit beside photographs reads better beside them. It does
    // not ask the model to label anything: there is no `type` field in the
    // schema the system turn defines, and assignReviewTypes() stamps the
    // composition on whatever comes back — see reviewTypes.test.ts.
    assert.equal(/"type"/.test(buildSystemPrompt()), false,
      'the model is asked to label a review type')
  })

  test('the system turn still does not name a count at all', () => {
    // It says "The user message says how many", which is what lets the SAME
    // system prompt serve a generation of twenty and a revision of three.
    const system = buildSystemPrompt()
    assert.ok(system.includes('The user message says how many'))
    assert.equal(/\b12\b|\btwelve\b/i.test(system), false)
  })

  test('THE REPLY BUDGET GROWS WITH THE BATCH', () => {
    // Twelve bodies at 900 characters do not fit in 4000 tokens with the titles
    // and the JSON scaffolding, and a reply cut off mid-array is invalid JSON —
    // refused whole, after the call has been paid for. A fixed budget would
    // have made that the ordinary outcome at twenty rather than a rare one.
    assert.equal(maxTokensFor(12), 6000, 'twelve no longer gets what it got')
    assert.ok(maxTokensFor(20) > maxTokensFor(12))
    assert.ok(maxTokensFor(6) >= 4000, 'a small batch has no headroom for scaffolding')
    for (let n = MIN_BATCH_SIZE; n <= MAX_BATCH_SIZE; n++) {
      assert.ok(maxTokensFor(n) >= n * 400, `${n} is under-budgeted`)
    }
  })

  test('the UI reads the chosen size rather than a literal', () => {
    // Every user-facing count in the generate flow interpolates the size the
    // administrator picked, so "12 drafts" is a consequence of the form rather
    // than a second place to change.
    const panel = read('src/components/customerReviews/GenerateDrafts.tsx')
    assert.ok(panel.includes('`Generate ${size} review drafts`'))
    assert.ok(panel.includes('`Yes, create ${size} drafts`'))
    assert.ok(panel.includes('This creates exactly {size} drafts'))
    assert.ok(panel.includes('Drafting {size} reviews'))
    // No hard-coded count anywhere in the panel's executable lines.
    const code = panel.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/>\s*Generate 8\b|>\s*Generate 12\b|create 12 drafts/.test(code), false)
  })

  test('the batch toolbar counts what is actually pending, not the batch size', () => {
    // "Approve all N" has to say how many are STILL pending, because approving
    // four of twelve leaves eight — a label reading "Approve all 12" after that
    // would name a set that no longer exists.
    const pending = read('src/components/customerReviews/PendingBatches.tsx')
    assert.ok(pending.includes('Approve all {pendingCount}'))
    assert.ok(pending.includes('Select all {pendingCount} in this batch'))
    assert.equal(/Approve all 8\b|Approve all 12\b|Approve all 20\b/.test(pending), false)
  })

  test('THE ASSIGNMENT SCREEN READS THE BATCH, NOT A CONSTANT', () => {
    // A batch of seventeen must read "17 of 17 ready" and "Assign all 17".
    const assign = read('src/components/customerReviews/AssignBatch.tsx')
    assert.ok(assign.includes('{row.eligible} of {row.size} ready'))
    assert.ok(assign.includes('Assign all {size}'))
    assert.ok(assign.includes('imageReviewsFor(size)'))
    assert.equal(/REVIEWS_PER_BATCH/.test(assign), false,
      'the assignment screen still reads a fixed batch constant')
    // And it reads the size from the batch row rather than counting live cards,
    // which would call a batch with three deleted reviews assignable.
    assert.ok(assign.includes("select('id, card_count, intended_for')"))
  })

  test('the overview counts a ready batch against its own size', () => {
    const overview = read('src/app/customer-reviews/OverviewScreen.tsx')
    assert.ok(overview.includes("select('id, card_count')"))
    assert.ok(overview.includes('v.eligible === sizeOf.get(id)'))
    assert.equal(/REVIEWS_PER_BATCH/.test(overview), false)
  })
})

// ══ 2. VALIDATION ═══════════════════════════════════════════════════════════

describe('exactly what was asked for, or nothing', () => {
  test('a full batch validates at every legal size', () => {
    for (let n = MIN_BATCH_SIZE; n <= MAX_BATCH_SIZE; n++) {
      const result = validateDrafts(goodDrafts(n), n)
      assert.equal(result.ok, true, `${n} good drafts were refused`)
      if (result.ok) assert.equal(result.drafts.length, n)
    }
  })

  test('ONE SHORT AND ONE OVER ARE BOTH REFUSED, at every legal size', () => {
    for (let n = MIN_BATCH_SIZE; n <= MAX_BATCH_SIZE; n++) {
      assert.equal(validateDrafts(goodDrafts(n - 1), n).ok, false, `${n - 1} passed as ${n}`)
      assert.equal(validateDrafts(goodDrafts(n + 1), n).ok, false, `${n + 1} passed as ${n}`)
    }
  })

  test('the refusal names both numbers, so the log says what went wrong', () => {
    const result = validateDrafts(goodDrafts(19), 20)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.ok(result.error.includes('19'))
      assert.ok(result.error.includes('20'))
    }
  })

  test('a revision still validates any size from one to a whole batch', () => {
    // validateDrafts takes `expected` as a parameter precisely so a revision of
    // the three drafts still pending in a batch is held to the same rules.
    for (const n of [1, 3, 12, 20]) {
      assert.equal(validateDrafts(goodDrafts(n), n).ok, true, `${n} drafts were refused for a revision`)
    }
  })
})

// ══ 3. THE REQUESTED COUNT REACHES THE GENERATION LAYER ═════════════════════

describe('a generation writes ONE batch of exactly the size requested', () => {
  /**
   * The claim table and the provider, both faked, both counted.
   *
   * THE PROVIDER IS ASKED FOR N and the insert receives N. Those are two
   * different assertions: the first is that the model was asked for the right
   * number, the second is that everything the orchestrator hands to SQL came
   * from the reply it validated.
   */
  function harness(reply: () => Promise<string>, batchSize = DEFAULT_BATCH_SIZE) {
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
      settings: settingsFor(batchSize),
      model: 'claude-opus-5',
      buildSystem: buildSystemPrompt,
      buildUser: buildUserPrompt,
      maxTokens: maxTokensFor(batchSize),
      insertBatch: async (drafts: unknown[]) => {
        inserted.push({ drafts, batchId: 'batch-1' })
        return { ok: true as const, batchId: 'batch-1' }
      },
    }

    return { deps, input, providerCalls, inserted, claims }
  }

  test('SIX, TWELVE, SEVENTEEN AND TWENTY each produce exactly that many', async () => {
    for (const n of [6, 12, 17, 20]) {
      const h = harness(async () => JSON.stringify(goodDrafts(n)), n)
      const result = await runGeneration(h.deps, h.input)

      assert.equal(result.kind, 'completed', `a batch of ${n} did not complete`)
      if (result.kind === 'completed') {
        assert.equal(result.created, n, `a batch of ${n} reported ${result.created}`)
        assert.equal(result.repeated, false)
      }

      // ONE insert, carrying n. Two inserts would be two batches.
      assert.equal(h.inserted.length, 1, `a batch of ${n} was written in more than one insert`)
      assert.equal(h.inserted[0].drafts.length, n)

      // And the model was asked once, for n.
      assert.equal(h.providerCalls.length, 1)
      assert.ok(h.providerCalls[0].includes(`Draft exactly ${n} reviews`))
    }
  })

  test('a reply of the wrong length writes NOTHING and releases the key', async () => {
    for (const [asked, returned] of [[20, 19], [6, 7], [12, 11]] as const) {
      const h = harness(async () => JSON.stringify(goodDrafts(returned)), asked)
      const result = await runGeneration(h.deps, h.input)

      assert.notEqual(result.kind, 'completed', `${returned} passed as ${asked}`)
      // No half-batch. The whole point of validating before inserting.
      assert.equal(h.inserted.length, 0)
      // The key is released, so an honest retry is not told "already in progress".
      assert.equal(h.claims.has(KEY), false)
    }
  })

  test('the claim is completed with the requested count, so a repeat matches', async () => {
    const h = harness(async () => JSON.stringify(goodDrafts(17)), 17)
    await runGeneration(h.deps, h.input)

    const repeat = await runGeneration(h.deps, h.input)
    assert.equal(repeat.kind, 'completed')
    if (repeat.kind === 'completed') {
      assert.equal(repeat.repeated, true)
      assert.equal(repeat.created, 17)
      assert.equal(repeat.batchId, 'batch-1')
    }
    // STILL ONE CALL. The repeat consulted the claim and never reached the
    // provider, which is the money property this count protects.
    assert.equal(h.providerCalls.length, 1)
  })

  test('the orchestrator validates against the request, never a constant', () => {
    const run = read('src/lib/customerReviews/generationRun.ts')
    assert.ok(run.includes('validateDrafts(text, input.settings.batchSize)'))
    assert.ok(run.includes('user: input.buildUser(input.guidance, input.settings),'))
    assert.equal(/DRAFTS_PER_BATCH/.test(run), false,
      'the orchestrator still reads a fixed batch constant')
  })
})

// ══ 4. THE ROUTE VALIDATES THE SIZE BEFORE IT SPENDS ANYTHING ═══════════════

describe('the server decides the size, and the browser only suggests one', () => {
  const route = read('src/app/api/customer-reviews/generate/route.ts')
  const code = route.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')

  test('the settings are validated in the route, not trusted from the body', () => {
    assert.ok(code.includes('validateGenerationSettings(body?.settings)'))
    assert.ok(code.includes('if (!checkedSettings.ok) return fail(400, checkedSettings.error)'))
  })

  test('…BEFORE the claim is taken and before the provider is called', () => {
    // A request that is going to be refused must not hold a claim for five
    // minutes or spend a credential proving it.
    assert.ok(code.indexOf('validateGenerationSettings') < code.indexOf('await runGeneration('))
  })

  test('the requested size is sent to SQL separately from what came back', () => {
    // p_card_count is what was ASKED FOR; the drafts array is what ARRIVED. The
    // function compares them, so a reply that slipped past validation with the
    // wrong length still cannot define the batch.
    assert.ok(code.includes('p_card_count:  settings.batchSize'))
  })

  test('the permission is still resolved, and no role is read', () => {
    assert.ok(code.includes("p_action_key: 'verify'"))
    assert.ok(code.includes("if (allowed !== true) return fail(403, MESSAGES.forbidden)"))
    assert.equal(/\.select\('role'\)|profile\.role/.test(code), false,
      'the route reads a role')
  })

  test('the missing-key guard is untouched, and still creates nothing', () => {
    assert.ok(code.includes('const apiKey = process.env.ANTHROPIC_API_KEY'))
    assert.ok(code.includes('if (!apiKey) return fail(503, MESSAGES.not_configured)'))
    // BEFORE THE CLAIM, which is what makes a misconfigured deployment refuse
    // having claimed nothing and written nothing.
    assert.ok(code.indexOf('process.env.ANTHROPIC_API_KEY') < code.indexOf('await runGeneration('))
  })

  test('the route still holds the credential, and the browser still cannot', () => {
    const panel = read('src/components/customerReviews/GenerateDrafts.tsx')
    const panelCode = panel.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/ANTHROPIC|api[_-]?key|anthropic\.com/i.test(panelCode), false)
  })

  test('THE CANDIDATE IS CHECKED AGAINST THE REAL EMPLOYEE SOURCE, before the claim', () => {
    // A UUID THAT PARSES IS NOT AN EMPLOYEE. validateGenerationSettings() only
    // proves the shape of the string; this proves the person exists, is active
    // and resolves `use` — through the same verify-gated function the
    // assignment step picks from, so there is no second employee directory.
    assert.ok(code.includes("await caller\n      .rpc('customer_review_assignable_employees')"))
    assert.ok(code.includes('return fail(400, MESSAGES.bad_candidate)'))

    // ON THE CALLER'S CLIENT, NOT THE SERVICE ROLE — which is what makes it
    // answer "may THIS actor select THAT candidate" rather than merely "does
    // the row exist".
    assert.equal(
      code.includes("admin.client.rpc('customer_review_assignable_employees')"), false,
      'the candidate check bypasses the caller\u2019s own permission',
    )

    // BEFORE THE CLAIM AND BEFORE THE PROVIDER. The database checks the same
    // thing again, but only at insert time — after the call has been paid for.
    assert.ok(code.indexOf('customer_review_assignable_employees')
      < code.indexOf('await runGeneration('))
  })

  test('THE INTENDED CANDIDATE IS NOT AN ASSIGNMENT', () => {
    // The one thing that could quietly widen visibility here. The batch stores
    // who it was meant for; nothing writes customer_review_test_cards.assigned_to
    // except assign_customer_review_batch(), and no policy reads the batch.
    assert.ok(code.includes('p_intended_for: settings.intendedFor'))
    assert.equal(/assigned_to/.test(code), false,
      'the generate route writes an assignment')
    assert.equal(/assigned_to/.test(SQL.slice(
      SQL.indexOf('create or replace function public.create_customer_review_draft_batch'),
      SQL.indexOf('\n$$;', SQL.indexOf('create or replace function public.create_customer_review_draft_batch')),
    )), false, 'the generator function writes an assignment')
  })
})

// ══ 5. THE DATABASE SAYS SIX TO TWENTY TOO ══════════════════════════════════

describe('the migration pins the same range', () => {
  test('card_count and expected_count are both bounded, not fixed', () => {
    assert.ok(SQL.includes('check (card_count between 6 and 20)'))
    assert.ok(SQL.includes('check (expected_count between 6 and 20 and card_count = expected_count)'))
  })

  test('AND BOTH ARE NOT VALID, so existing batches are never re-judged', () => {
    // Every batch in the database holds 20, 8 or 12 and all three are inside
    // the new range, so a plain CHECK would in fact pass today. It is still
    // added NOT VALID: a batch row is a RECORD of what a model produced, and
    // validating a record against a rule invented afterwards is the wrong shape
    // of statement whatever the answer comes out as.
    assert.ok(SQL.includes('check (card_count between 6 and 20) not valid'))
    assert.ok(SQL.includes('check (expected_count between 6 and 20 and card_count = expected_count) not valid'))
  })

  test('the generator takes the size and refuses anything outside the range', () => {
    const start = SQL.indexOf('create or replace function public.create_customer_review_draft_batch(')
    assert.ok(start >= 0, 'the generator is not redefined')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(fn.includes('p_card_count    integer'))
    assert.ok(fn.includes('if p_card_count is null or p_card_count < 6 or p_card_count > 20 then'))
    // What was asked for is compared with what arrived, rather than inferred.
    assert.ok(fn.includes('if v_n <> p_card_count then'))
    assert.ok(fn.includes('values (p_actor_id, p_guidance, p_model, p_card_count, p_card_count, p_request_key,'))
    // The status the drafts land in is unchanged, and it is the safety property
    // the whole workflow rests on.
    assert.ok(fn.includes("'pending_approval', v_type)"))
    // And the permission is still resolved from the actor, with no role branch.
    assert.ok(fn.includes("public.resolve_permission(p_actor_id, 'customer_review_requests', 'verify')"))
  })

  test('THE COMPOSITION IS DERIVED IN SQL WITH THE SAME ARITHMETIC AS THE ROUTE', () => {
    // round(n / 3) in both languages. No batch size between six and twenty
    // divides by three to a halfway value, so there is no tie for Postgres and
    // JavaScript to break in opposite directions.
    const start = SQL.indexOf('create or replace function public.create_customer_review_draft_batch(')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(fn.includes('v_want_img := round(p_card_count::numeric / 3)'))
    assert.ok(fn.includes('v_want_txt := p_card_count - v_want_img'))
    assert.ok(fn.includes('if v_text_n <> v_want_txt or v_image_n <> v_want_img then'))

    // The two implementations agree at every legal size.
    for (let n = MIN_BATCH_SIZE; n <= MAX_BATCH_SIZE; n++) {
      assert.equal(imageReviewsFor(n), Math.round(n / 3), `${n} disagrees`)
      assert.equal(textReviewsFor(n), n - Math.round(n / 3))
      // No halfway value, so no rounding-mode disagreement is possible.
      assert.notEqual((n / 3) % 1, 0.5, `${n} is a rounding tie`)
    }
  })

  test('THE OLD FIVE-ARGUMENT GENERATOR IS KEPT, so applying this cannot break the live bundle', () => {
    // THE DEPLOYMENT WINDOW. A migration is applied before the bundle that
    // needs it is live. In between, the CURRENTLY DEPLOYED route is still
    // calling the five-argument form — dropping it makes every generation in
    // that window fail with PGRST202, and rolling the application back would
    // not fix it because the function would be gone.
    assert.equal(
      SQL.includes('drop function if exists public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid);'),
      false,
      'the migration drops the signature the deployed bundle still calls',
    )

    // The wrapper exists, with exactly the old parameter list.
    const start = SQL.indexOf('create or replace function public.create_customer_review_draft_batch(\n  p_guidance    text,')
    assert.ok(start >= 0, 'the compatibility wrapper is missing')
    const wrapper = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(wrapper.includes('p_request_key uuid\n)'))

    // IT DELEGATES RATHER THAN REIMPLEMENTING. Every rule — the size range, the
    // composition, the permission check, the telephone check, idempotence —
    // has one home, and the wrapper passes the twelve its callers always meant.
    assert.ok(wrapper.includes('select public.create_customer_review_draft_batch('))
    assert.ok(wrapper.includes('p_guidance, p_model, p_drafts, p_actor_id, p_request_key, 12, null::jsonb, null::uuid'))
    assert.equal(/insert into/i.test(wrapper), false, 'the wrapper writes rows of its own')
  })

  test('AND THE TWO SIGNATURES CANNOT BOTH MATCH ONE CALL', () => {
    // This is the condition PGRST203 reports, and the reason the eight-argument
    // form carries NO defaults: a default on p_settings or p_intended_for would
    // let a five-name request satisfy both functions.
    const start = SQL.indexOf('create or replace function public.create_customer_review_draft_batch(\n  p_guidance      text,')
    assert.ok(start >= 0, 'the eight-argument form is missing')
    const wide = SQL.slice(start, SQL.indexOf('\n$$;', start))
    const signature = wide.slice(0, wide.indexOf(')'))
    assert.equal(/default/i.test(signature), false,
      'the eight-argument form has a default, which makes a five-argument call ambiguous')
    assert.ok(signature.includes('p_card_count    integer'))
    assert.ok(signature.includes('p_settings      jsonb'))
    assert.ok(signature.includes('p_intended_for  uuid'))
  })

  test('the wrapper is granted the same way and to nobody more', () => {
    assert.ok(SQL.includes('revoke execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)\n  from public, anon, authenticated;'))
    assert.ok(SQL.includes('grant  execute on function public.create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)\n  to service_role;'))
  })

  test('…and it is marked for removal rather than left to look permanent', () => {
    assert.ok(SQL.includes('DEPRECATED COMPATIBILITY WRAPPER'))
    assert.ok(SQL.includes('drop it once the new bundle is live everywhere'))
  })

  test('approval accepts a full batch of twenty', () => {
    const start = SQL.indexOf('create or replace function public.approve_customer_review_drafts(')
    assert.ok(start >= 0, 'approval is not redefined')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.ok(fn.includes('if v_asked > 20 then'))
    assert.ok(fn.includes('A batch holds at most twenty reviews'))
    assert.equal(/v_asked > 12|v_asked > 8/.test(fn), false, 'an old bound survives')
    // The permission check is still there, unchanged, and still resolved.
    assert.ok(fn.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
  })

  test('ASSIGNMENT COMPARES AGAINST THE BATCH, not against twelve', () => {
    const start = SQL.indexOf('create or replace function public.assign_customer_review_batch(')
    assert.ok(start >= 0, 'assignment is not redefined')
    const fn = SQL.slice(start, SQL.indexOf('\n$$;', start))
    assert.equal(/v_n <> 12/.test(fn), false, 'the fixed twelve survives in assignment')
    assert.ok(fn.includes('select card_count into v_expected'))
    assert.ok(fn.includes('if v_n <> v_expected then'))
    // A batch row that cannot be read is an error rather than a fallback, so a
    // missing batch never becomes silently assignable.
    assert.ok(fn.includes('if v_expected is null then'))
    // Still assigned whole, still rechecked after the lock.
    assert.ok(fn.includes("and (status <> 'available' or assigned_to is not null)"))
    assert.ok(fn.includes("public.resolve_permission(p_employee_id, 'customer_review_requests', 'use')"))
  })

  test('the revision and claim bounds were widened, not left at twelve', () => {
    assert.ok(SQL.includes('check (revised_count between 1 and 20)'))
    assert.ok(SQL.includes('check (result_count is null or result_count between 1 and 20)'))
  })

  test('the new columns are nullable and additive', () => {
    assert.ok(SQL.includes('add column if not exists generation_settings jsonb'))
    assert.ok(SQL.includes('add column if not exists intended_for uuid references public.users(id)'))
    // No NOT NULL and no default, so every historical batch reads back as it is.
    assert.equal(/generation_settings jsonb\s+not null/i.test(SQL), false)
    assert.equal(/intended_for uuid[^;]*not null/i.test(SQL), false)
  })

  test('NO POLICY IS TOUCHED, so nothing about visibility moved', () => {
    // The single most important negative claim in this file. A batch changing
    // size must not change who can see a review.
    assert.equal(/create policy|drop policy|alter policy/i.test(SQL), false,
      'the migration touches a row-level security policy')
    assert.equal(/grant .* to authenticated/i.test(
      SQL.replace(/grant\s+execute[\s\S]*?to authenticated;/gi, ''),
    ), false, 'the migration grants a new table privilege to the browser role')
  })
})

// ══ 6. THE HISTORICAL FILE STILL SAYS WHAT IT SAID ══════════════════════════

describe('the twelve-draft era is still recorded accurately', () => {
  test('20261031000000 still pins twelve, NOT VALID, exactly as it did', () => {
    // A migration is history. This assertion exists because the tempting
    // "tidy-up" when a range replaces a constant is to go back and edit the
    // file that introduced the constant — which would falsify the record of
    // what the database did between then and now.
    assert.ok(HISTORIC_SQL.includes('check (card_count = 12) not valid'))
    assert.ok(HISTORIC_SQL.includes('check (expected_count = 12 and card_count = expected_count) not valid'))
    assert.ok(HISTORIC_SQL.includes('if v_n <> 12 then'))
  })

  test('and the eight-draft batches it protected are still legal today', () => {
    // Eight is inside six-to-twenty, so the batches that NOT VALID was invented
    // to protect satisfy the new constraint outright.
    assert.ok(8 >= MIN_BATCH_SIZE && 8 <= MAX_BATCH_SIZE)
    // As are the twenty-draft batches from the era before that.
    assert.ok(20 >= MIN_BATCH_SIZE && 20 <= MAX_BATCH_SIZE)
  })
})
