/**
 * THE REST OF THE WORKFLOW, AT EVERY BATCH SIZE.
 *
 * batchSize.test.ts proves that a generation of six, twelve, seventeen or
 * twenty produces that many drafts. This file is about everything that happens
 * to them AFTERWARDS: the counts a screen shows, approving one, approving all,
 * assigning the batch, who can see it, the progress line, editing a draft and
 * revising the set. Each of those had a fixed twelve in it somewhere, or could
 * have acquired one.
 *
 * ── TWO KINDS OF TEST, AND THE DIFFERENCE DECIDES WHAT A FAILURE MEANS ─────
 *
 *   EXECUTABLE   the counting and the visibility rule are functions of rows, so
 *                they are tested by calling them at each size. A failure is a
 *                real defect somebody would see.
 *   SOURCE PINS  what only the database can do — a row lock, a policy — is
 *                asserted against the migration's executable SQL.
 *
 * ── WHAT THE VISIBILITY SECTION IS, EXACTLY ────────────────────────────────
 *
 * IT IS POLICY-LOGIC REGRESSION COVERAGE. IT IS NOT AN AUTHENTICATED
 * AUTHORIZATION TEST, and the difference is worth stating plainly because it
 * decides what a green run here entitles anybody to believe.
 *
 * "The migration contains no CREATE POLICY" proves only that this change did
 * not touch the rule; it proves nothing about what the rule DOES, and it would
 * pass just as happily if the rule were wrong. So the policy is MODELLED here
 * as a function and exercised — assigned candidate, other candidate, verifier —
 * and the model is then pinned against the SQL clause by clause, so it cannot
 * quietly stop describing the policy it stands for.
 *
 * WHAT THAT STILL DOES NOT DO is run a query as a signed-in user and let
 * Postgres decide. No row is read here and no session exists. A model can agree
 * with the SQL it was written from and both can be wrong about what the
 * database actually does.
 *
 * THE TEST THAT CLOSES THAT GAP IS
 * src/lib/security/customerReviewBatchIsolation.test.ts, which assigns a
 * seventeen-review batch and reads it back as three real signed-in actors. It
 * SKIPS until 20261108000000 is applied, so until then authenticated RLS
 * execution for this feature remains a pre-deployment verification item — see
 * that file's header.
 *
 * There is no database and no network in this file.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/variableBatchWorkflow.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
} from './generationSettings'
import {
  assignReviewTypes,
  countReviews,
  countReviewsByType,
  imageReviewsFor,
  progressLine,
  textReviewsFor,
} from './reviewTypes'
import type { TestCardStatus } from './types'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** SQL with the comments stripped, so a claim cannot be satisfied by prose. */
const executable = (source: string) =>
  source.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const CURRENT = executable(read('supabase/migrations/20261108000000_review_workflow_variable_batch_size.sql'))
const TYPES = executable(read('supabase/migrations/20261107000000_review_types_assignment_and_image_groups.sql'))
const BASE = executable(read('supabase/migrations/20261017000000_customer_review_outreach.sql'))
const DELETION = executable(read('supabase/migrations/20261030000000_review_workflow_deletion_and_replacement.sql'))
const EDITING = executable(read('supabase/migrations/20261031000000_review_workflow_twelve_drafts_editing_and_images.sql'))

/** The sizes this file cares about. 17 and 20 are the ones nothing was built for. */
const SIZES = [MIN_BATCH_SIZE, 12, 17, MAX_BATCH_SIZE] as const

// ── A batch, as rows ─────────────────────────────────────────────────────────

type Row = {
  id: string
  status: TestCardStatus
  review_type: 'text' | 'image'
  assigned_to: string | null
  booked_by: string | null
  deleted_at: string | null
}

/** One approved batch of `size` reviews, assigned whole to `owner`. */
function batchOf(size: number, owner: string | null = null): Row[] {
  const drafts = Array.from({ length: size }, (_, i) => ({ id: `c${i}` }))
  return assignReviewTypes(drafts).map(d => ({
    id: d.id,
    status: (owner ? 'available' : 'pending_approval') as TestCardStatus,
    review_type: d.type,
    assigned_to: owner,
    booked_by: null,
    deleted_at: null,
  }))
}

// ══ 1. GENERATION COUNT AND COMPOSITION, DOWNSTREAM ═════════════════════════

describe('a batch of any size is a whole batch everywhere it is counted', () => {
  test('the rows a generation produces are exactly the size asked for', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, 'emp-1')
      assert.equal(rows.length, size)
      assert.equal(rows.filter(r => r.review_type === 'text').length, textReviewsFor(size))
      assert.equal(rows.filter(r => r.review_type === 'image').length, imageReviewsFor(size))
    }
  })

  test('every size in the range keeps both review types populated', () => {
    // A batch with no image review would pay nobody the image rate; one with no
    // text review is not a batch this workflow describes.
    for (let size = MIN_BATCH_SIZE; size <= MAX_BATCH_SIZE; size++) {
      assert.ok(textReviewsFor(size) >= 1, `${size} has no text review`)
      assert.ok(imageReviewsFor(size) >= 1, `${size} has no image review`)
    }
  })
})

// ══ 2. COUNTERS AND PROGRESS ════════════════════════════════════════════════

describe('the counters count the batch, not twelve', () => {
  test('a freshly assigned batch is entirely available and entirely remaining', () => {
    for (const size of SIZES) {
      const counts = countReviews(batchOf(size, 'emp-1'))
      assert.equal(counts.assigned, size)
      assert.equal(counts.available, size)
      assert.equal(counts.remaining, size)
      assert.equal(counts.posted, 0)
      assert.equal(counts.in_progress, 0)
    }
  })

  test('progress moves through the whole batch, whatever its size', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, 'emp-1')
      // Half of them submitted, one booked, the rest available.
      const posted = Math.floor(size / 2)
      for (let i = 0; i < posted; i++) rows[i].status = 'submitted'
      rows[posted].status = 'booked'
      rows[posted].booked_by = 'emp-1'

      const counts = countReviews(rows)
      assert.equal(counts.assigned, size)
      assert.equal(counts.posted, posted)
      assert.equal(counts.in_progress, 1)
      assert.equal(counts.available, size - posted - 1)
      assert.equal(counts.remaining, size - posted)
      assert.equal(progressLine(counts), `${posted} of ${size} posted`)
    }
  })

  test('the per-type split adds up to the batch at every size', () => {
    for (const size of SIZES) {
      const split = countReviewsByType(batchOf(size, 'emp-1'))
      assert.equal(split.text.assigned, textReviewsFor(size))
      assert.equal(split.image.assigned, imageReviewsFor(size))
      assert.equal(split.all.assigned, size)
      assert.equal(split.text.assigned + split.image.assigned, split.all.assigned)
    }
  })

  test('A DELETED REVIEW SHRINKS THE DENOMINATOR, so nobody is told they owe work that is gone', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, 'emp-1')
      rows[0].deleted_at = '2026-09-06T00:00:00Z'
      const counts = countReviews(rows)
      assert.equal(counts.assigned, size - 1)
      assert.equal(progressLine(counts), `0 of ${size - 1} posted`)
    }
  })

  test('the batch header reads the batch row rather than a constant', () => {
    const pending = read('src/components/customerReviews/PendingBatches.tsx')
    assert.ok(pending.includes('${pendingCount} of ${batch.card_count} awaiting approval'))
    assert.equal(/of 12 awaiting|of 8 awaiting/.test(pending), false)
  })
})

// ══ 3. APPROVAL — ONE, SOME, AND ALL ════════════════════════════════════════

describe('approval works for a batch of any size', () => {
  test('the multi-select bound admits a whole batch of the largest size', () => {
    const start = CURRENT.indexOf('create or replace function public.approve_customer_review_drafts(')
    assert.ok(start >= 0)
    const fn = CURRENT.slice(start, CURRENT.indexOf('\n$$;', start))
    assert.ok(fn.includes(`if v_asked > ${MAX_BATCH_SIZE} then`))
    // A batch you can generate but not approve would be worse than one you
    // cannot generate: the drafts would exist and refuse to be released.
    assert.equal(/v_asked > 12|v_asked > 8/.test(fn), false, 'an old bound survives')
  })

  test('approving ONE is unaffected by the batch size', () => {
    // The bound is an upper limit on a selection, not a required count; a
    // single id has always been legal and still is.
    const start = CURRENT.indexOf('create or replace function public.approve_customer_review_drafts(')
    const fn = CURRENT.slice(start, CURRENT.indexOf('\n$$;', start))
    assert.ok(fn.includes('if v_asked = 0 then'))
    assert.equal(/v_asked < |v_asked <> /.test(fn), false,
      'approval requires a particular number of reviews')
  })

  test('APPROVE ALL NAMES NO COUNT AT ALL, which is why it needed no change', () => {
    // It selects every still-pending draft in the batch under a row lock and
    // approves what it found, so six and twenty are the same code path. The
    // assertion is against the file that defines it, unchanged by this work.
    const start = DELETION.indexOf('create or replace function public.approve_customer_review_draft_batch(')
    assert.ok(start >= 0)
    const fn = DELETION.slice(start, DELETION.indexOf('\n$$;', start))
    assert.ok(fn.includes("and status = 'pending_approval'"))
    assert.ok(fn.includes('for update'))
    assert.equal(/\b12\b|\b8\b/.test(fn), false, 'approve-all names a batch size')
  })

  test('and the toolbar label counts what is pending rather than the batch', () => {
    const pending = read('src/components/customerReviews/PendingBatches.tsx')
    assert.ok(pending.includes('Approve all {pendingCount}'))
    assert.ok(pending.includes('Select all {pendingCount} in this batch'))
  })
})

// ══ 4. ASSIGNMENT ═══════════════════════════════════════════════════════════

describe('assignment insists on the batch, not on twelve', () => {
  const start = CURRENT.indexOf('create or replace function public.assign_customer_review_batch(')
  const fn = CURRENT.slice(start, CURRENT.indexOf('\n$$;', start))

  test('the size it requires is read from the batch row, inside the transaction', () => {
    assert.ok(start >= 0, 'assignment is not redefined')
    assert.ok(fn.includes('select card_count into v_expected'))
    assert.ok(fn.includes('if v_n <> v_expected then'))
    assert.equal(/v_n <> 12/.test(fn), false, 'the fixed twelve survives')
  })

  test('a batch row that cannot be read is refused rather than assumed', () => {
    // Falling back to \"however many rows there are\" would make a batch with
    // three deleted reviews silently assignable under a name promising all of
    // them.
    assert.ok(fn.includes('if v_expected is null then'))
    assert.ok(fn.includes('CUSTOMER_REVIEW_TEST_NOT_FOUND'))
  })

  test('it still assigns whole, and still rechecks after the lock', () => {
    assert.ok(fn.includes('for update'))
    assert.ok(fn.includes("and (status <> 'available' or assigned_to is not null)"))
  })

  test('the image reviews ask for as many projects as the batch actually has', () => {
    // pick_customer_review_image_groups() already takes a count, so a batch of
    // twenty asking for seven behaves as twelve asking for four did: any it
    // cannot fill stay `awaiting_images`, and the caller is told how many.
    assert.ok(fn.includes('public.pick_customer_review_image_groups(array_length(v_image_ids, 1))'))
    assert.ok(fn.includes("'awaiting_images'"))
    assert.equal(/pick_customer_review_image_groups\(4\)/.test(fn), false)
  })

  test('the employee must still resolve `use`, and the actor must resolve `verify`', () => {
    assert.ok(fn.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
    assert.ok(fn.includes("public.resolve_permission(p_employee_id, 'customer_review_requests', 'use')"))
  })

  test('the screen offers the batch by its own size', () => {
    const assign = read('src/components/customerReviews/AssignBatch.tsx')
    assert.ok(assign.includes('{row.eligible} of {row.size} ready'))
    assert.ok(assign.includes('Assign all {size}'))
    assert.ok(assign.includes('imageReviewsFor(size)'))
  })
})

// ══ 5. CANDIDATE VISIBILITY — POLICY LOGIC, MODELLED AND EXERCISED ══════════
//
// Not an authenticated authorization test. See the header, and
// src/lib/security/customerReviewBatchIsolation.test.ts for the one that is.

/**
 * The SELECT policy on customer_review_test_cards, as a function.
 *
 * This is a MODEL of the SQL, written so the rule can be exercised rather than
 * only quoted. The test below it pins every clause against the migration, so a
 * model that stopped describing the policy would fail rather than pass quietly.
 */
type Viewer = { id: string | null; active: boolean; canVerify: boolean }

/** public.can_view_customer_review_test_card_row(holder) — 20261017000000. */
function rowVisible(holder: string | null, viewer: Viewer): boolean {
  if (viewer.id === null || !viewer.active) return false
  return holder === viewer.id || viewer.canVerify
}

/** The three-clause policy from 20261107000000. */
function canSelect(card: Row, viewer: Viewer): boolean {
  if (
    card.status === 'available'
    && card.deleted_at === null
    && card.assigned_to !== null
    && rowVisible(card.assigned_to, viewer)
  ) return true
  if (card.deleted_at === null && rowVisible(card.booked_by, viewer)) return true
  if (card.deleted_at !== null && viewer.canVerify) return true
  return false
}

const OWNER: Viewer = { id: 'emp-1', active: true, canVerify: false }
const OTHER: Viewer = { id: 'emp-2', active: true, canVerify: false }
const VERIFIER: Viewer = { id: 'admin-1', active: true, canVerify: true }
const SUSPENDED: Viewer = { id: 'emp-1', active: false, canVerify: false }

describe('the visibility RULE, modelled: a candidate’s own batch and nobody else’s', () => {
  test('THE ASSIGNED CANDIDATE SEES EVERY REVIEW IN THEIR BATCH', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, OWNER.id)
      assert.equal(rows.filter(r => canSelect(r, OWNER)).length, size, `size ${size}`)
    }
  })

  test('ANOTHER CANDIDATE SEES NONE OF IT', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, OWNER.id)
      assert.equal(rows.filter(r => canSelect(r, OTHER)).length, 0, `size ${size}`)
    }
  })

  test('…including once the owner has booked and submitted some of them', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, OWNER.id)
      rows[0].status = 'booked'; rows[0].booked_by = OWNER.id
      rows[1].status = 'submitted'; rows[1].booked_by = OWNER.id
      rows[2].status = 'verified'; rows[2].booked_by = OWNER.id
      assert.equal(rows.filter(r => canSelect(r, OTHER)).length, 0, `size ${size}`)
      assert.equal(rows.filter(r => canSelect(r, OWNER)).length, size, `size ${size}`)
    }
  })

  test('A VERIFIER SEES THE WHOLE BATCH, and that is unchanged', () => {
    for (const size of SIZES) {
      const rows = batchOf(size, OWNER.id)
      assert.equal(rows.filter(r => canSelect(r, VERIFIER)).length, size, `size ${size}`)
    }
  })

  test('NOBODY BUT A VERIFIER SEES A PENDING DRAFT — the safety property of the module', () => {
    for (const size of SIZES) {
      const pending = batchOf(size)          // unassigned, pending_approval
      assert.equal(pending.filter(r => canSelect(r, OWNER)).length, 0, `size ${size}`)
      assert.equal(pending.filter(r => canSelect(r, OTHER)).length, 0, `size ${size}`)
      assert.equal(pending.filter(r => canSelect(r, VERIFIER)).length, size, `size ${size}`)
    }
  })

  test('a deactivated account sees nothing, even its own former work', () => {
    const rows = batchOf(12, OWNER.id)
    rows[0].status = 'booked'; rows[0].booked_by = OWNER.id
    assert.equal(rows.filter(r => canSelect(r, SUSPENDED)).length, 0)
  })

  test('a deleted review is visible only to a verifier', () => {
    const rows = batchOf(12, OWNER.id)
    rows[0].deleted_at = '2026-09-06T00:00:00Z'
    assert.equal(canSelect(rows[0], OWNER), false)
    assert.equal(canSelect(rows[0], OTHER), false)
    assert.equal(canSelect(rows[0], VERIFIER), true)
  })

  test('AND THE MODEL ABOVE IS THE POLICY THAT IS ACTUALLY DEPLOYED', () => {
    // Without this, the model is just a function agreeing with itself.
    const at = TYPES.indexOf('create policy "customer_review_test_cards_select"')
    assert.ok(at >= 0, 'the SELECT policy is not defined where expected')
    const policy = TYPES.slice(at, TYPES.indexOf(';', at))

    // Clause 1 — an available review, assigned, seen through its assignee.
    assert.ok(policy.includes("customer_review_test_cards.status = 'available'"))
    assert.ok(policy.includes('customer_review_test_cards.assigned_to is not null'))
    assert.ok(policy.includes('public.can_view_customer_review_test_card_row(customer_review_test_cards.assigned_to)'))
    // Clause 2 — anything live, seen through its holder.
    assert.ok(policy.includes('public.can_view_customer_review_test_card_row(customer_review_test_cards.booked_by)'))
    // Clause 3 — a deleted review, verifiers only.
    assert.ok(policy.includes('customer_review_test_cards.deleted_at is not null'))
    assert.ok(policy.includes('public.can_verify_customer_review_test_cards()'))

    // And the helper the model mirrors: the holder, or somebody with `verify`.
    const helperAt = BASE.indexOf('create or replace function public.can_view_customer_review_test_card_row(')
    const helper = BASE.slice(helperAt, BASE.indexOf('$$;', helperAt))
    assert.ok(helper.includes('p_booked_by = auth.uid()'))
    assert.ok(helper.includes("public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
    assert.ok(helper.includes('u.is_active'))
    // NO ROLE BRANCH. An administrator whose `verify` was revoked must lose the
    // module with it.
    assert.equal(/u\.role\s*=/.test(helper), false, 'the visibility helper reads a role')
  })

  test('THIS CHANGE TOUCHED NO POLICY — the negative claim, kept as a second check', () => {
    // Weaker than the tests above and deliberately kept beside them: it says
    // the rule did not move, while they say what the rule does.
    assert.equal(/create policy|drop policy|alter policy/i.test(CURRENT), false)
    assert.equal(/can_view_customer_review_test_card/.test(CURRENT), false,
      'the migration redefines a visibility helper')
  })

  test('and intended_for is read by nothing that decides visibility', () => {
    // The new column names who a batch was generated FOR. If any predicate ever
    // reads it, a batch would become visible before it was assigned.
    assert.equal(/intended_for/.test(TYPES), false)
    const policyUse = CURRENT.split('\n').filter(l => l.includes('intended_for'))
    for (const line of policyUse) {
      assert.equal(/policy|using|auth\.uid\(\)/.test(line), false,
        `intended_for reaches an authorization decision: ${line.trim()}`)
    }
  })
})

// ══ 6. EDITING AND REVISION ═════════════════════════════════════════════════

describe('editing and revising do not assume a batch size', () => {
  test('editing one draft names no count', () => {
    const start = EDITING.indexOf('create or replace function public.edit_customer_review_draft(')
    assert.ok(start >= 0, 'the editor is not defined where expected')
    const fn = EDITING.slice(start, EDITING.indexOf('\n$$;', start))
    // It refuses anything that is not still a pending draft, and says nothing
    // about how many drafts the batch holds.
    assert.ok(fn.includes("if c.status <> 'pending_approval' then"))
    assert.equal(/\b12\b|\b8\b/.test(fn), false, 'the draft editor names a batch size')
  })

  test('REVISION REWRITES WHAT IS PENDING, whatever that number is', () => {
    // It compares the replacements it was given against the pending rows it
    // locked, so one, seventeen and twenty are the same path.
    const run = read('src/lib/customerReviews/generationRun.ts')
    assert.ok(run.includes('validateDrafts(text, batch.pending.length)'))
    assert.equal(/DRAFTS_PER_BATCH/.test(run), false)
  })

  test('and the revise route bounds the prompt by the largest batch, not by twelve', () => {
    const route = read('src/app/api/customer-reviews/revise/route.ts')
    assert.ok(route.includes('if (rows.length > MAX_BATCH_SIZE) {'))
    assert.ok(route.includes('const MAX_TOKENS = maxTokensFor(MAX_BATCH_SIZE)'))
  })

  test('the revision and claim bounds admit a whole batch of the largest size', () => {
    assert.ok(CURRENT.includes(`check (revised_count between 1 and ${MAX_BATCH_SIZE})`))
    assert.ok(CURRENT.includes(`check (result_count is null or result_count between 1 and ${MAX_BATCH_SIZE})`))
  })
})

// ══ 7. HISTORICAL BATCHES ═══════════════════════════════════════════════════

describe('the batches already in the database still work', () => {
  test('every size this module has ever used is inside the new range', () => {
    for (const historical of [8, 12, 20]) {
      assert.ok(
        historical >= MIN_BATCH_SIZE && historical <= MAX_BATCH_SIZE,
        `a historical batch of ${historical} is now illegal`,
      )
    }
  })

  test('an eight-draft batch counts, renders and assigns like any other', () => {
    // Eight predates both the twelve era and this one. Nothing about reading it
    // back depends on the size it was generated with.
    const rows = batchOf(8, OWNER.id)
    assert.equal(countReviews(rows).assigned, 8)
    assert.equal(progressLine(countReviews(rows)), '0 of 8 posted')
    assert.equal(rows.filter(r => canSelect(r, OWNER)).length, 8)
    assert.equal(rows.filter(r => canSelect(r, OTHER)).length, 0)
  })

  test('and the constraints that admit them were added NOT VALID', () => {
    assert.ok(CURRENT.includes(`check (card_count between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}) not valid`))
  })
})
