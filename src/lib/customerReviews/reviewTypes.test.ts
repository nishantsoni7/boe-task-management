/**
 * REVIEW TYPES, ASSIGNMENT AND PROJECT IMAGE GROUPS — the whole of
 * 20261107000000, asserted claim by claim.
 *
 * Two kinds of test, and the difference is worth stating because it decides
 * what a failure here means:
 *
 *   PURE LOGIC   composition, readiness and counts are functions of rows, so
 *                they are tested by calling them. A failure is a real defect in
 *                behaviour a person will see.
 *   SOURCE PINS  everything that only the database can enforce — the SELECT
 *                policy, the conditional UPDATE that books a review, the price
 *                the reward is read from — is asserted against the migration's
 *                EXECUTABLE SQL, with comments stripped so a claim cannot be
 *                satisfied by prose. A failure is drift between what the
 *                repository says and what the database would do.
 *
 * There is no database and no network in this file.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/reviewTypes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IMAGE_REVIEWS_PER_BATCH,
  REVIEWS_PER_BATCH,
  TEXT_REVIEWS_PER_BATCH,
  assignReviewTypes,
  countByType,
  countReviews,
  countReviewsByType,
  imageReadiness,
  progressLine,
  reviewTypeSequence,
} from './reviewTypes'
import { canBookCard } from './status'
import { isShareableReview } from './sharing'
import { nextStepFor } from './nextStep'
import { DRAFTS_PER_BATCH } from './draftGeneration'
import { REVIEW_TYPES, type ReviewType, type TestCardStatus } from './types'
import {
  DEFAULT_BOE_CREDIT_SETTINGS,
  parseBoeCreditSettings,
  rewardForReviewType,
  sameBoeCreditSettings,
} from '@/lib/boeCredits/settings'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261107000000_review_types_assignment_and_image_groups.sql'

/**
 * Executable lines only, so a claim cannot be satisfied by prose — and, just as
 * important, so a comment SAYING a column is not read cannot fail a test that
 * checks the column is not read.
 *
 * Handles both syntaxes because this file reads SQL and TypeScript: `--` for
 * one, `//` and block comments for the other.
 */
const executable = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter(line => {
      const t = line.trimStart()
      return !t.startsWith('--') && !t.startsWith('//') && !t.startsWith('*')
    })
    .join('\n')

const SQL = executable(read(MIGRATION))

/** The body of one plpgsql function, so a claim about it cannot match elsewhere. */
function fn(name: string): string {
  const at = SQL.indexOf(`create or replace function public.${name}(`)
  assert.ok(at >= 0, `${name} is not defined in the migration`)
  const end = SQL.indexOf('\n$$;', at)
  assert.ok(end > at, `${name} has no terminator`)
  return SQL.slice(at, end)
}

const ME = 'user-me'
const OTHER = 'user-other'

/** A card shaped for canBookCard / imageReadiness. */
const card = (over: Partial<{
  status: TestCardStatus
  deleted_at: string | null
  review_type: ReviewType
  assigned_to: string | null
  image_group_id: string | null
}> = {}) => ({
  status: 'available' as TestCardStatus,
  deleted_at: null as string | null,
  review_type: 'text' as ReviewType,
  assigned_to: ME as string | null,
  image_group_id: null as string | null,
  ...over,
})

// ══ 1. THE GENERATOR PRODUCES EXACTLY 8 TEXT AND 4 IMAGE ════════════════════

describe('a batch is eight text and four image, and the model does not decide it', () => {
  test('the constants add up to the batch size the rest of the module already uses', () => {
    assert.equal(TEXT_REVIEWS_PER_BATCH, 8)
    assert.equal(IMAGE_REVIEWS_PER_BATCH, 4)
    assert.equal(REVIEWS_PER_BATCH, 12)
    // The split cannot drift from the count. DRAFTS_PER_BATCH is what the
    // prompt, the validator and the batch CHECK are all written against.
    assert.equal(REVIEWS_PER_BATCH, DRAFTS_PER_BATCH)
  })

  test('the sequence is eight text then four image', () => {
    const seq = reviewTypeSequence()
    assert.equal(seq.length, REVIEWS_PER_BATCH)
    assert.equal(seq.filter(t => t === 'text').length, TEXT_REVIEWS_PER_BATCH)
    assert.equal(seq.filter(t => t === 'image').length, IMAGE_REVIEWS_PER_BATCH)
  })

  test('assignReviewTypes stamps that composition on twelve drafts', () => {
    const drafts = Array.from({ length: REVIEWS_PER_BATCH }, (_, i) => ({ title: `t${i}`, body: `b${i}` }))
    const typed = assignReviewTypes(drafts)
    assert.deepEqual(countByType(typed.map(d => ({ review_type: d.type }))), { text: 8, image: 4 })
    // The drafts themselves are untouched apart from the added field.
    assert.equal(typed[0].title, 't0')
  })

  test('A TYPE THE MODEL SUPPLIED IS IGNORED, whatever it says', () => {
    // The failure this guards against is a model that has been talked into
    // returning `"type": "image"` on all twelve — which would be twelve image
    // rewards for a batch that is meant to be eight text ones.
    const hostile = Array.from({ length: REVIEWS_PER_BATCH }, (_, i) => ({
      title: `t${i}`, body: `b${i}`, type: 'image' as const,
    }))
    const typed = assignReviewTypes(hostile)
    assert.deepEqual(countByType(typed.map(d => ({ review_type: d.type }))), { text: 8, image: 4 })
  })

  test('a list that is not exactly twelve is refused rather than typed', () => {
    assert.throws(() => assignReviewTypes([{ title: 'a', body: 'b' }]), /12 reviews/)
    assert.throws(
      () => assignReviewTypes(Array.from({ length: 13 }, () => ({ title: 'a', body: 'b' }))),
      /13 were supplied/,
    )
  })

  test('THE DATABASE COUNTS AGAIN, so a bug in the route cannot write a wrong batch', () => {
    const body = fn('create_customer_review_draft_batch')
    assert.ok(body.includes("count(*) filter (where coalesce(d->>'type', 'text') = 'text')"))
    assert.ok(body.includes('v_text_n <> 8 or v_image_n <> 4'),
      'the generator does not enforce eight text and four image')
    // ...and the composition is checked BEFORE any row is inserted, so a bad
    // batch writes nothing rather than eleven rows and a failure.
    assert.ok(
      body.indexOf('v_text_n <> 8 or v_image_n <> 4')
        < body.indexOf('insert into public.customer_review_draft_batches'),
      'the composition is counted after the batch row is written',
    )
  })

  test('the route stamps the types and does not forward the model’s', () => {
    const route = executable(read('src/app/api/customer-reviews/generate/route.ts'))
    assert.ok(route.includes('const typed = assignReviewTypes(drafts)'))
    assert.ok(route.includes('p_drafts:      typed,'),
      'the route still sends the untyped drafts')
  })
})

// ══ 2. ASSIGNMENT: ONE BATCH, ONE EMPLOYEE, ALL TWELVE ══════════════════════

describe('a batch is assigned whole, to one employee', () => {
  const body = fn('assign_customer_review_batch')

  test('it refuses a batch that is not twelve live reviews', () => {
    assert.ok(body.includes('if v_n <> 12 then'))
    assert.ok(body.includes('A batch is assigned whole'))
  })

  test('every one of them must be approved AND unassigned, rechecked under the lock', () => {
    // The set is locked first...
    assert.ok(/for update/.test(body))
    // ...and only then is its state read, which is the only place the check
    // means anything.
    const lockAt = body.indexOf('for update')
    const checkAt = body.indexOf("status <> 'available' or assigned_to is not null")
    assert.ok(checkAt > lockAt, 'the state is checked before the rows are locked')
    assert.ok(body.includes('nothing was assigned'))
  })

  test('all twelve are written in ONE update, so a partial assignment is not expressible', () => {
    assert.ok(body.includes('set assigned_to = p_employee_id'))
    assert.ok(body.includes('where id = any(v_ids)'))
    assert.equal((body.match(/set assigned_to = p_employee_id/g) ?? []).length, 1)
  })

  test('THE EMPLOYEE MUST BE ABLE TO USE THE MODULE, resolved from the engine', () => {
    assert.ok(body.includes("public.resolve_permission(p_employee_id, 'customer_review_requests', 'use')"))
    // ...and no role is read anywhere in the function.
    assert.equal(/u\.role|'admin'/.test(body), false, 'the assignment consults a role')
  })

  test('the ACTOR is auth.uid() and holds verify; the employee is only a target', () => {
    assert.ok(body.includes('v_uid       uuid := auth.uid()'))
    assert.ok(body.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
    // The one place a user id is a parameter, and it is the person the work is
    // FOR rather than the person doing it.
    assert.ok(body.includes('p_employee_id uuid'))
    assert.equal(body.includes('p_actor_id'), false, 'the assignment takes an actor from its caller')
  })
})

// ══ 3. EMPLOYEE A CANNOT SEE EMPLOYEE B'S BATCH ═════════════════════════════

describe('the common pool is gone, and the policy is what removed it', () => {
  test('the available branch of the cards policy asks about the ASSIGNEE', () => {
    const at = SQL.indexOf('create policy "customer_review_test_cards_select"')
    assert.ok(at >= 0, 'the cards policy is not re-created')
    const policy = SQL.slice(at, SQL.indexOf(';', at))

    assert.ok(policy.includes('customer_review_test_cards.assigned_to is not null'))
    assert.ok(policy.includes(
      'public.can_view_customer_review_test_card_row(customer_review_test_cards.assigned_to)',
    ))
    // THE OLD BRANCH IS GONE. can_use_customer_review_test_cards() answered
    // "may this person use the module", which is what made every approved
    // review readable by everybody who could.
    assert.equal(policy.includes('can_use_customer_review_test_cards'), false,
      'the policy still offers a company-wide pool')
  })

  test('the card-id predicate says the same thing for the child tables and the bucket', () => {
    const body = fn('can_view_customer_review_test_card')
    assert.ok(body.includes('c.assigned_to = auth.uid()'))
    // A `use` holder no longer sees an available card merely for holding `use`.
    assert.equal(
      /c\.status = 'available'\s*\n\s*and public\.resolve_permission/.test(body), false,
      'the card predicate still admits any use holder to an available review',
    )
  })

  test('…AND IT IS A ONE-CLAUSE CHANGE, with the tombstone branch untouched', () => {
    // THE REGRESSION THIS PINS, because it was made once and was invisible.
    //
    // The verify branch sits OUTSIDE the `deleted_at is null` guard on purpose:
    // 20261030000000 says so in as many words, and it is what keeps a DELETED
    // review's screenshots and activity trail readable to the people the audit
    // record exists for. Three policies resolve a card by id and defer to this
    // function, so hoisting `deleted_at is null` to the top of the WHERE —
    // which reads tidier — silently revokes all three at once while leaving the
    // card row itself readable through the policy's own verify-only branch.
    //
    // Asserted STRUCTURALLY rather than by a diff, so it holds however the file
    // is later reformatted: the verify disjunct must appear BEFORE the deleted
    // guard, and the guard must not be a top-level conjunct of the WHERE.
    const body = fn('can_view_customer_review_test_card')
    const verifyAt = body.indexOf("resolve_permission(auth.uid(), 'customer_review_requests', 'verify')")
    const guardAt = body.indexOf('c.deleted_at is null')
    assert.ok(verifyAt >= 0 && guardAt > verifyAt,
      'the deleted-row guard now precedes the verify branch, so a verifier has lost the tombstone')
    assert.equal(/where c\.id = p_card_id\s*\n\s*and c\.deleted_at is null/.test(body), false,
      'the deleted-row guard is a top-level conjunct, which revokes a verifier’s audit access')

    // And the whole predicate really is one clause away from its predecessor.
    const previous = executable(
      read('supabase/migrations/20261030000000_review_workflow_deletion_and_replacement.sql'),
    )
    const at = previous.indexOf('create or replace function public.can_view_customer_review_test_card(')
    const prior = previous.slice(at, previous.indexOf('\n$$;', at))
    const normalise = (s: string) =>
      s.split('\n').map(l => l.trim()).filter(l => l !== '' && l !== 'and c.assigned_to = auth.uid()').join('\n')
    assert.equal(normalise(body), normalise(prior),
      'the predicate differs from 20261030000000 by more than the assignment clause')
  })

  test('THE SCREEN DOES NOT DO THIS WORK — there is no browser-side owner filter', () => {
    // The requirement is explicit that authorization must not be weakened into
    // a frontend filter. The Available tab issues the same query it always did;
    // what changed is the policy underneath it.
    const list = executable(read('src/app/customer-reviews/TestCardListScreen.tsx'))
    const table = list.slice(list.indexOf('const TAB_STATUSES'), list.indexOf('export function verifiedNoticeFrom'))
    assert.ok(/available: \['available'\]/.test(table))
    // `mine` is still scoped by booked_by, which is a possessive heading rather
    // than a security boundary — and it was there before this change.
    assert.equal(list.includes(".eq('assigned_to', profile.id)"), false,
      'the list screen filters by assignee, which would make RLS the second line rather than the first')
  })

  test('APPROVING WITH REPLACE DOES NOT DESTROY SOMEBODY ELSE’S ASSIGNED WORK', () => {
    // Replace clears the reviews that belong to nobody. Before assignment
    // existed that was every available review and it was harmless; now an
    // available review is work one employee has been given and has not picked
    // up yet, and a verifier approving a new batch must not silently discard it.
    const body = fn('customer_review_replace_available')
    assert.ok(body.includes('and assigned_to is null'),
      'a replacement still displaces assigned reviews')
    // ...and the number the confirmation shows matches what would happen.
    const list = executable(read('src/app/customer-reviews/TestCardListScreen.tsx'))
    assert.ok(list.includes(".is('assigned_to', null)"),
      'the Replace count includes reviews a replacement would not touch')
  })

  test('a candidate cannot book somebody else’s review, or an unassigned one', () => {
    const viewer = { userId: ME, canUse: true }
    assert.equal(canBookCard(card(), viewer), true)
    assert.equal(canBookCard(card({ assigned_to: OTHER }), viewer), false)
    assert.equal(canBookCard(card({ assigned_to: null }), viewer), false)
  })

  test('and the DATABASE refuses it inside the conditional UPDATE, not before it', () => {
    const body = fn('book_customer_review_test_card')
    // A read-then-write would let two requests both decide a review was
    // bookable. The clause is a condition on the UPDATE itself.
    const updateAt = body.indexOf('update public.customer_review_test_cards c2')
    const clauseAt = body.indexOf('and c2.assigned_to = v_uid')
    const returningAt = body.indexOf('returning * into c')
    assert.ok(updateAt >= 0 && clauseAt > updateAt && clauseAt < returningAt,
      'the assignment check is not a condition on the claiming UPDATE')
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_NOT_YOURS'))
  })
})

// ══ 4. THE REWARD IS PRICED BY THE REVIEW'S OWN TYPE ════════════════════════

describe('two rewards, chosen by the database from the review’s own row', () => {
  test('the settings carry both, and the text reward keeps its original field', () => {
    // THE MIGRATION SHAPE THAT MATTERS: review_reward_credits is not renamed,
    // so every append-only history row still means what it meant.
    assert.ok(SQL.includes('add column if not exists image_review_reward_credits integer not null default 1'))
    assert.equal(/rename column .*review_reward_credits/.test(SQL), false,
      'the migration renames the existing reward column')
    assert.equal(/update public\.boe_credit_settings/.test(SQL), false,
      'the migration rewrites settings history instead of appending a row')
  })

  test('the parser and the equality check both know six numbers', () => {
    const parsed = parseBoeCreditSettings({ ...DEFAULT_BOE_CREDIT_SETTINGS, image_review_reward_credits: 3 })
    assert.ok(parsed.ok)
    if (parsed.ok) assert.equal(parsed.settings.image_review_reward_credits, 3)

    const a = { ...DEFAULT_BOE_CREDIT_SETTINGS }
    const b = { ...DEFAULT_BOE_CREDIT_SETTINGS, image_review_reward_credits: 9 }
    assert.equal(sameBoeCreditSettings(a, a), true)
    assert.equal(sameBoeCreditSettings(a, b), false,
      'a change to the image reward would be treated as no change at all')
  })

  test('a missing or invalid image reward is refused, not defaulted', () => {
    const noField = parseBoeCreditSettings({
      review_reward_credits: 1, credit_value: 100,
      half_day_redemption_credits: 8, full_day_redemption_credits: 15, minimum_monthly_reviews: 3,
    })
    assert.equal(noField.ok, false)
    const zero = parseBoeCreditSettings({ ...DEFAULT_BOE_CREDIT_SETTINGS, image_review_reward_credits: 0 })
    assert.equal(zero.ok, false)
  })

  test('TEXT USES THE TEXT SETTING AND IMAGE USES THE IMAGE SETTING', () => {
    const s = { ...DEFAULT_BOE_CREDIT_SETTINGS, review_reward_credits: 2, image_review_reward_credits: 7 }
    assert.equal(rewardForReviewType(s, 'text'), 2)
    assert.equal(rewardForReviewType(s, 'image'), 7)
    // An unknown type reads as text, which is what every review was before
    // types existed and what the column default says.
    assert.equal(rewardForReviewType(s, null), 2)
  })

  test('CHANGING THE SETTINGS CHANGES FUTURE AWARDS, and only future ones', () => {
    // The amount is read at verification time from the newest settings row.
    // Nothing snapshots it onto the review, so a new settings row is the whole
    // of "the next award is different".
    const before = { ...DEFAULT_BOE_CREDIT_SETTINGS, image_review_reward_credits: 5 }
    const after = { ...DEFAULT_BOE_CREDIT_SETTINGS, image_review_reward_credits: 11 }
    assert.equal(rewardForReviewType(before, 'image'), 5)
    assert.equal(rewardForReviewType(after, 'image'), 11)

    const poster = fn('post_boe_credit_review_reward')
    assert.ok(poster.includes('order by created_at desc'),
      'the reward is not read from the newest settings row')
    assert.ok(poster.includes('when \'image\' then v_settings.image_review_reward_credits'))
    assert.ok(poster.includes('else v_settings.review_reward_credits'))
    // ...and nothing in the migration writes a literal credit amount into a
    // reward.
    assert.equal(/'review_reward',\s*\d+/.test(poster), false,
      'a literal credit amount is posted as a review reward')
  })

  test('AN UNKNOWN TYPE IS REFUSED BY THE POSTER, never defaulted', () => {
    const poster = fn('post_boe_credit_review_reward')
    assert.ok(poster.includes("p_review_type not in ('text', 'image')"))
    assert.ok(poster.includes('BOE_CREDITS_REVIEW_TYPE'))
  })

  test('THE TYPE COMES OFF THE LOCKED ROW, so a browser cannot supply one', () => {
    const transition = fn('transition_customer_review_test_card')
    // The row is locked at the top...
    const lockAt = transition.indexOf('where id = p_card_id for update')
    const useAt = transition.indexOf('c.review_type,')
    assert.ok(lockAt >= 0 && useAt > lockAt, 'the type is read before the row is locked')

    // ...and the browser-facing signature takes three arguments and no field
    // map, so there is nothing a request could put a type in.
    const signature = SQL.slice(
      SQL.indexOf('create or replace function public.transition_customer_review_test_card('),
      SQL.indexOf('returns jsonb', SQL.indexOf('create or replace function public.transition_customer_review_test_card(')),
    )
    assert.ok(signature.includes('p_card_id     uuid'))
    assert.ok(signature.includes('p_next_status text'))
    assert.ok(signature.includes('p_detail      text default null'))
    assert.equal(/p_review_type|jsonb/.test(signature), false,
      'the browser-callable transition accepts a review type')
  })

  test('THE REWARD GOES TO THE HOLDER, and the verifier is only the actor', () => {
    const transition = fn('transition_customer_review_test_card')
    assert.ok(transition.includes('public.post_boe_credit_review_reward(\n      c.booked_by,'))
    // v_uid — the verifier — is passed LAST, as the actor, and is not the
    // recipient.
    assert.ok(/c\.booked_by,[\s\S]{0,200}v_uid\s*\n\s*\);/.test(transition))
  })

  test('the poster is reachable by the service role alone', () => {
    assert.ok(SQL.includes(
      'revoke execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)\n  from public, anon, authenticated;',
    ))
    assert.ok(SQL.includes(
      'grant  execute on function public.post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)\n  to service_role;',
    ))
    // The old five-argument signature is DROPPED rather than left beside it,
    // so there is no second, unpriced way to post a review reward.
    assert.ok(SQL.includes('drop function if exists public.post_boe_credit_review_reward(uuid, uuid, text, timestamptz, uuid);'))
  })

  test('VERIFYING TWICE CANNOT AWARD TWICE, and the reason is unchanged', () => {
    const transition = fn('transition_customer_review_test_card')
    // 1. `verified` is terminal, and the row is locked before its status is read.
    assert.ok(transition.includes("when 'submitted' then p_next_status in ('verified', 'booked')"))
    assert.equal(/when 'verified' then/.test(transition), false,
      'a verified review has a legal move out of it')
    // 2. The reward is posted through the one write path, never inserted directly.
    assert.equal(/insert into public\.boe_credit_transactions/.test(transition), false)
    // 3. And the ledger's own one-row-per-source rule is what refuses a
    //    duplicate whatever path reached it — asserted where it lives.
    const foundation = read('supabase/migrations/20261101000000_boe_credits_foundation.sql')
    assert.ok(foundation.includes('boe_credit_transactions_one_per_source_idx'))
  })

  test('the verify panel names the reward but sends nothing to the RPC', () => {
    const panel = executable(read('src/components/customerReviews/VerifyPanel.tsx'))
    assert.ok(panel.includes('rewardForReviewType('))
    // NOTHING FROM THE PANEL REACHES A WRITE. It performs no rpc call at all.
    assert.equal(/\.rpc\(/.test(panel), false, 'the verify panel calls an RPC')
    const detail = executable(read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx'))
    const call = detail.slice(detail.indexOf("supabase.rpc('transition_customer_review_test_card'"))
    const args = call.slice(0, call.indexOf('})'))
    assert.equal(/review_type|reward|credits|employee/.test(args), false,
      'the transition call carries a type, a reward or a recipient')
  })
})

// ══ 5. PROJECT IMAGE GROUPS ════════════════════════════════════════════════

describe('a project image group is one project, and a review points at the group', () => {
  test('a group owns its images; nothing attaches an image to a review', () => {
    assert.ok(SQL.includes('create table if not exists public.customer_review_image_groups'))
    assert.ok(SQL.includes('create table if not exists public.customer_review_group_images'))
    // The link from a review is to the GROUP. There is no card_id on a group
    // image and no group_id on a review image — which is what makes "images
    // from two projects in one post" unexpressible rather than merely avoided.
    const imageTable = SQL.slice(
      SQL.indexOf('create table if not exists public.customer_review_group_images'),
      SQL.indexOf('create unique index if not exists customer_review_group_image_unique_live_content'),
    )
    assert.equal(/card_id/.test(imageTable), false,
      'a project image can be attached to a single review')
    assert.ok(SQL.includes('add column if not exists image_group_id uuid references public.customer_review_image_groups(id)'))
  })

  test('A TEXT REVIEW CANNOT HOLD A GROUP — a CHECK, not a convention', () => {
    assert.ok(SQL.includes("check (image_group_id is null or review_type = 'image')"))
  })

  test('the images live in their own PRIVATE bucket, with no client write policy', () => {
    assert.ok(/insert into storage\.buckets[\s\S]{0,400}'customer-review-project-images'[\s\S]{0,200}false/.test(SQL),
      'the project image bucket is missing or is public')
    // A SELECT policy, and no INSERT or DELETE policy on storage.objects for it.
    assert.ok(SQL.includes('create policy "customer_review_project_images_storage_select"'))
    const storagePolicies = SQL.match(/create policy "[^"]+"\s*\n\s*on storage\.objects\s*\n\s*for (\w+)/g) ?? []
    for (const p of storagePolicies) {
      if (p.includes('customer_review_project_images')) assert.ok(p.includes('for select'), p)
    }
  })

  test('no client role may write the two tables, by privilege as well as by policy', () => {
    for (const table of ['customer_review_image_groups', 'customer_review_group_images']) {
      assert.ok(SQL.includes(
        `revoke insert, update, delete, truncate, references, trigger\n  on public.${table} from authenticated, anon;`,
      ), table)
    }
  })

  test('WHO MAY SEE A PROJECT IMAGE: a verifier, or the assignee of a review using it', () => {
    const body = fn('can_view_customer_review_image_group')
    assert.ok(body.includes("public.resolve_permission(auth.uid(), 'customer_review_requests', 'verify')"))
    assert.ok(body.includes('c.assigned_to = auth.uid()'))
    assert.ok(body.includes('c.image_group_id = p_group_id'))
    // ...and nobody else. There is no branch that admits a `use` holder who was
    // not assigned a review pointing at this group.
    assert.equal(/u\.role|'admin'/.test(body), false, 'the predicate consults a role')
  })

  test('an image can be removed only where production safety permits', () => {
    const body = fn('begin_customer_review_group_image_removal')
    assert.ok(body.includes('c.booked_by is not null'))
    assert.ok(body.includes('CUSTOMER_REVIEW_GROUP_IN_USE'))
    // The two halves are service-role only, so no client can perform half of a
    // removal that spans the bucket and the table.
    assert.ok(SQL.includes('revoke execute on function public.begin_customer_review_group_image_removal(uuid, uuid)\n  from public, anon, authenticated;'))
    assert.ok(SQL.includes('revoke execute on function public.finish_customer_review_group_image_removal(uuid)\n  from public, anon, authenticated;'))
  })

  test('a group is ARCHIVED, never deleted, so a review’s record survives', () => {
    assert.ok(SQL.includes('references public.customer_review_image_groups(id) on delete restrict'))
    assert.ok(SQL.includes('create or replace function public.archive_customer_review_image_group('))
    assert.equal(/delete from public\.customer_review_image_groups/.test(SQL), false,
      'a project group can be deleted out from under a review that names it')
  })
})

// ══ 6. RANDOM GROUP ASSIGNMENT ═════════════════════════════════════════════

describe('four image reviews get four different projects', () => {
  const picker = SQL.slice(
    SQL.indexOf('create or replace function public.pick_customer_review_image_groups('),
    SQL.indexOf('revoke execute on function public.pick_customer_review_image_groups(integer)'),
  )

  test('the selection is at GROUP level, and distinct by construction', () => {
    // One row per GROUP, numbered, and the first N taken. There is no way for
    // one group to appear twice in the result, so "four different projects" is
    // a property of the query rather than something the caller must check.
    assert.ok(picker.includes('from public.customer_review_image_groups gr'))
    assert.ok(picker.includes('row_number() over ('))
    assert.ok(picker.includes('where g.rn <= greatest(coalesce(p_wanted, 0), 0)'))
    assert.equal(/customer_review_group_images i[\s\S]{0,120}order by/.test(picker), false,
      'the selection orders individual images rather than groups')
  })

  test('LEAST RECENTLY USED FIRST, ties random — and no recommendation engine', () => {
    assert.ok(picker.includes('max(c.assigned_at)'))
    assert.ok(picker.includes('asc nulls first'))
    assert.ok(picker.includes('random()'))
    // Deliberately absent: any notion of scoring, weighting or matching.
    assert.equal(/score|weight|similarity|embedding/i.test(picker), false)
  })

  test('only READY groups are offered — not archived, and holding an image', () => {
    assert.ok(picker.includes('gr.archived_at is null'))
    assert.ok(picker.includes('i.removal_started_at is null'))
  })

  test('the four image reviews of a batch are paired with the picked groups, one each', () => {
    const body = fn('assign_customer_review_batch')
    assert.ok(body.includes("where c.id = any(v_ids) and c.review_type = 'image'"))
    assert.ok(body.includes('v_groups := public.pick_customer_review_image_groups(array_length(v_image_ids, 1))'))
    assert.ok(body.includes('set image_group_id = v_groups[v_i]'))
    // FEWER GROUPS THAN REVIEWS IS HANDLED BY STOPPING, not by reusing one.
    assert.ok(body.includes('exit when v_i > coalesce(array_length(v_groups, 1), 0)'))
    assert.ok(body.includes("'awaiting_images'"))
  })

  test('THE CHOICE IS PERSISTED, so it does not re-randomise on every load', () => {
    // The group is written onto the review, and the only other writer is the
    // verifier's explicit set_customer_review_image_group().
    const writers = (SQL.match(/set image_group_id = /g) ?? []).length
    assert.equal(writers, 2, 'there is a third writer of image_group_id')
    assert.ok(fn('set_customer_review_image_group').includes('set image_group_id = p_group_id'))
    // Nothing on the read path picks a group: the screens select the column.
    const control = executable(read('src/components/customerReviews/ProjectGroupControl.tsx'))
    assert.equal(/random|Math\.random/i.test(control), false,
      'the browser chooses a project group')
  })
})

// ══ 7. MISSING IMAGES ══════════════════════════════════════════════════════

describe('an image review with no project waits, and cannot be used', () => {
  test('readiness is derived, and is NOT a status', () => {
    assert.equal(imageReadiness({ review_type: 'text', image_group_id: null }), 'not_applicable')
    assert.equal(imageReadiness({ review_type: 'image', image_group_id: null }), 'awaiting_images')
    assert.equal(imageReadiness({ review_type: 'image', image_group_id: 'g1' }), 'ready')
    // A group that exists but holds nothing is not ready either.
    assert.equal(imageReadiness({ review_type: 'image', image_group_id: 'g1' }, false), 'awaiting_images')

    // NO SIXTH STATUS WAS ADDED. The status CHECK is untouched by this
    // migration, and the type list is what it was.
    assert.equal(/add constraint customer_review_test_cards_status_check/.test(SQL), false,
      'the migration changed the status list')
  })

  test('a waiting image review cannot be BOOKED', () => {
    const viewer = { userId: ME, canUse: true }
    const waiting = card({ review_type: 'image', image_group_id: null })
    assert.equal(canBookCard(waiting, viewer), false)
    const ready = card({ review_type: 'image', image_group_id: 'g1' })
    assert.equal(canBookCard(ready, viewer), true)
    assert.equal(canBookCard(ready, viewer, false), false)
  })

  test('and the database refuses it inside the same conditional UPDATE', () => {
    const body = fn('book_customer_review_test_card')
    assert.ok(body.includes("c2.review_type <> 'image'"))
    assert.ok(body.includes('c2.image_group_id is not null'))
    assert.ok(body.includes('from public.customer_review_group_images i'))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_AWAITING_IMAGES'))
  })

  test('a waiting image review cannot be SHARED either', () => {
    const approved = { status: 'available' as TestCardStatus, approved_at: 't', deleted_at: null }
    assert.equal(isShareableReview(approved), true)
    assert.equal(isShareableReview({ ...approved, review_type: 'image', image_group_id: null }), false)
    assert.equal(isShareableReview({ ...approved, review_type: 'image', image_group_id: 'g1' }), true)
    assert.equal(isShareableReview({ ...approved, review_type: 'image', image_group_id: 'g1' }, false), false)
  })

  test('the candidate is told what is happening, and the verifier what to do', () => {
    const waiting = {
      status: 'available' as TestCardStatus, booked_by: null,
      whatsapp_opened_at: null, sent_confirmed_at: null, returned_at: null,
      return_reason: null, deleted_at: null,
      review_type: 'image' as ReviewType, image_group_id: null,
    }
    const candidate = nextStepFor(waiting, { userId: ME, canUse: true, canVerify: false })
    assert.equal(candidate.tone, 'wait')
    assert.match(candidate.headline, /Waiting for admin images/)

    const verifier = nextStepFor(waiting, { userId: OTHER, canUse: false, canVerify: true })
    assert.equal(verifier.tone, 'attention')
    assert.match(verifier.headline, /Attach the project images/)
  })

  test('ADDING A GROUP MAKES IT READY, with nothing else to remember', () => {
    const before = card({ review_type: 'image', image_group_id: null })
    assert.equal(imageReadiness(before), 'awaiting_images')
    const after = { ...before, image_group_id: 'g1' }
    assert.equal(imageReadiness(after), 'ready')
    assert.equal(canBookCard(after, { userId: ME, canUse: true }), true)
    // The status did not move, and nothing else was set.
    assert.equal(after.status, before.status)

    // The setter refuses a group with no live images, so attaching one cannot
    // leave a review that has a project and is still not ready.
    const setter = fn('set_customer_review_image_group')
    assert.ok(setter.includes('CUSTOMER_REVIEW_GROUP_NOT_READY'))
    assert.ok(setter.includes('i.removal_started_at is null'))
  })

  test('a group cannot be moved under a candidate who is already holding the review', () => {
    const setter = fn('set_customer_review_image_group')
    assert.ok(setter.includes("c.status not in ('pending_approval', 'available')"))
    assert.ok(setter.includes('CUSTOMER_REVIEW_TEST_LOCKED'))
  })
})

// ══ 7A. THE PROJECT GROUP IS THE IMAGE REVIEW'S IMAGE SOURCE ═══════════════
//
// The decision this section pins: for review_type = 'image', the project image
// group is authoritative and the old per-card `review_image` attachment plays
// no part — not in readiness, not in booking, and above all not in what the
// share sheet carries.

describe('an image review shares its PROJECT GROUP’s images, never per-card ones', () => {
  const DETAIL = executable(read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx'))
  const SHARE = executable(read('src/components/customerReviews/ShareReview.tsx'))
  const PENDING = executable(read('src/components/customerReviews/PendingBatches.tsx'))
  const PROJECT = executable(read('src/components/customerReviews/ProjectImages.tsx'))

  test('THE SHARE CONTROL IS HANDED THE GROUP’S IMAGES AND THE GROUP’S BUCKET', () => {
    // The defect this replaces: ShareReviewButton was handed `reviewImages` —
    // the per-card rows — so an image review could be Ready, be paid the image
    // reward, and share nothing but text.
    assert.ok(DETAIL.includes('images={isImageReview ? projectImages.images : reviewImages}'),
      'the share control is not given the project group’s images')
    assert.ok(DETAIL.includes('bucket={isImageReview ? GROUP_IMAGE_BUCKET : REVIEW_IMAGE_BUCKET}'),
      'the share control is not told which bucket to sign')
    assert.ok(DETAIL.includes('groupUsable={isImageReview ? projectImages.usable : undefined}'),
      'the share control is not told whether the group is usable')
  })

  test('…and a TEXT review still shares its per-card images, unchanged', () => {
    // The other half of the same ternary. Nothing about the text path moved.
    assert.ok(DETAIL.includes('? projectImages.images : reviewImages'))
    assert.ok(DETAIL.includes('? GROUP_IMAGE_BUCKET : REVIEW_IMAGE_BUCKET'))
    // A text review passes no group usability, so isShareableReview() judges it
    // exactly as it did before review types existed.
    assert.ok(DETAIL.includes(': undefined}'))
  })

  test('AN IMAGE REVIEW NEVER DEGRADES TO A TEXT-ONLY SHARE', () => {
    // shareCapability() answers `text` for an empty file list, which is right
    // for a text review and catastrophic here: the share sheet reports nothing
    // back, so a candidate would post a review about how something LOOKS with
    // nothing to look at and never know.
    assert.ok(SHARE.includes("if (card.review_type === 'image' && files.length === 0)"),
      'an image review with no loaded files can still reach shareCapability')
    // And the refusal happens BEFORE the capability is asked.
    const guardAt = SHARE.indexOf("card.review_type === 'image' && files.length === 0")
    const capabilityAt = SHARE.indexOf('const capability = shareCapability(')
    assert.ok(guardAt >= 0 && capabilityAt > guardAt,
      'the empty-file guard runs after the share capability is chosen')
  })

  test('the share path is the EXISTING one — no second sharing system', () => {
    // One navigator.share call, one manual fallback, one file loader. The fix
    // made the loader bucket-agnostic; it did not add a parallel path.
    assert.equal((SHARE.match(/navigator\.share\(/g) ?? []).length, 1)
    assert.equal((SHARE.match(/async function loadImageFiles\(/g) ?? []).length, 1)
    assert.ok(SHARE.includes('.from(bucket)'), 'the loader still hard-codes one bucket')
  })

  test('MISSING, EMPTY AND ARCHIVED GROUPS ALL BLOCK SHARE', () => {
    const approved = { status: 'available' as TestCardStatus, approved_at: 't', deleted_at: null }
    const image = { ...approved, review_type: 'image' as ReviewType }

    // missing
    assert.equal(isShareableReview({ ...image, image_group_id: null }), false)
    // empty or archived — both arrive as `usable: false` from useProjectImages,
    // which is the single fact that answers both questions.
    assert.equal(isShareableReview({ ...image, image_group_id: 'g1' }, false), false)
    // ready
    assert.equal(isShareableReview({ ...image, image_group_id: 'g1' }, true), true)
  })

  test('A TEXT REVIEW NEEDS NO PROJECT GROUP to be shared', () => {
    const text = {
      status: 'available' as TestCardStatus, approved_at: 't', deleted_at: null,
      review_type: 'text' as ReviewType, image_group_id: null,
    }
    assert.equal(isShareableReview(text), true)
    // ...and passing a false group usability does not affect it either, because
    // the clause is scoped to image reviews.
    assert.equal(isShareableReview(text, false), true)
  })

  test('THE GROUP IS READ THROUGH THE CALLER’S OWN CLIENT, never a service role', () => {
    // The security requirement: no privileged path is exposed to the browser.
    // Both reads are plain `supabase.from(...)` on the signed-in user's client,
    // so customer_review_group_images_select and its group twin decide — and
    // both defer to can_view_customer_review_image_group().
    assert.ok(PROJECT.includes("supabase\n          .from('customer_review_image_groups')")
      || PROJECT.includes(".from('customer_review_image_groups')"))
    assert.ok(PROJECT.includes(".from('customer_review_group_images')"))
    for (const forbidden of ['adminClient', 'service_role', 'SERVICE_ROLE', '/api/']) {
      assert.equal(PROJECT.includes(forbidden), false,
        `the project image reader reaches for ${forbidden}`)
    }
    // The thumbnails are signed in the browser under the bucket's own policy.
    assert.ok(PROJECT.includes('createSignedUrls'))
  })

  test('a read that FAILED is “unknown”, not “unusable”', () => {
    // Reporting false on a network blip would grey out Book and hide Share on a
    // review that is perfectly fine. Unknown leaves the controls as the row
    // alone implies, and the database refuses anything that should not happen.
    assert.ok(PROJECT.includes('if (groupError || imageError) return { images: [], usable: undefined, loading: false }'))
  })

  test('EMPTY, ARCHIVED AND INVISIBLE ALL COLLAPSE TO usable: false', () => {
    assert.ok(PROJECT.includes('usable: group !== null && group.archived_at === null && images.length > 0'),
      'the usability rule is not the three facts it claims to be')
  })

  test('THE OLD PER-CARD MANAGER IS NOT DRAWN FOR AN IMAGE REVIEW', () => {
    // Two render sites, and both are now scoped to a text review.
    assert.ok(PENDING.includes("{current.review_type !== 'image' && ("),
      'the verifier’s pending sheet still shows the per-card manager for an image review')
    assert.ok(DETAIL.includes('{isImageReview ? (') && DETAIL.includes('<ReviewImageManager'),
      'the detail screen no longer chooses between the two image sources')
    // ...and the project images are what an image review shows instead.
    assert.ok(DETAIL.includes('<ProjectImages supabase={supabase} set={projectImages} label={groupLabel} />'))
  })

  test('nothing underneath the old system was deleted — this is a UI decision', () => {
    // The requirement is explicit that this is not a cleanup migration.
    assert.ok(read('src/app/api/customer-reviews/images/route.ts').length > 0,
      'the per-card image route was removed')
    assert.ok(read('src/lib/customerReviews/reviewImages.ts').includes('REVIEW_IMAGE_BUCKET'))
    assert.equal(/drop table[\s\S]*customer_review_test_card_screenshots/i.test(SQL), false,
      'the migration drops the per-card screenshot table')
    assert.equal(/delete from storage\.buckets/i.test(SQL), false,
      'the migration removes a storage bucket')
  })

  test('AN ARCHIVED GROUP CANNOT BE BOOKED EITHER, and the database says so', () => {
    const body = fn('book_customer_review_test_card')
    assert.ok(body.includes('join public.customer_review_image_groups g on g.id = i.group_id'))
    assert.ok(body.includes('g.archived_at is null'))
    // Both the claiming UPDATE and the refusal branch ask the same three
    // questions, so the sentence a candidate reads matches the reason.
    assert.equal((body.match(/g\.archived_at is null/g) ?? []).length, 2,
      'the archived check is missing from either the UPDATE or the explanation')
  })

  test('the persisted group survives a reload — nothing re-reads or re-picks it', () => {
    // The hook keys on the card's OWN stored image_group_id and does no
    // selection of its own; picking happens once, in SQL, at assignment.
    assert.ok(DETAIL.includes('useProjectImages(supabase, isImageReview ? card?.image_group_id : null)'))
    assert.equal(/random|Math\.random|pick_customer_review_image_groups/i.test(PROJECT), false,
      'the browser picks a project group')
  })
})

// ══ 8. COUNTS ══════════════════════════════════════════════════════════════

describe('the operational counts, for a candidate and for management', () => {
  const rows = (statuses: TestCardStatus[], type: ReviewType = 'text') =>
    statuses.map(status => ({ status, deleted_at: null as string | null, review_type: type }))

  test('POSTED IS SUBMITTED-OR-VERIFIED, never merely booked', () => {
    const counts = countReviews(rows(['available', 'booked', 'submitted', 'verified']))
    assert.equal(counts.assigned, 4)
    assert.equal(counts.posted, 2, 'a booked review counted as posted')
    assert.equal(counts.verified, 1)
    assert.equal(counts.in_progress, 1)
    assert.equal(counts.available, 1)
    assert.equal(counts.remaining, 2)
  })

  test('VERIFIED IS COUNTED SEPARATELY as well as inside posted', () => {
    const counts = countReviews(rows(['verified', 'verified', 'submitted']))
    assert.equal(counts.posted, 3)
    assert.equal(counts.verified, 2)
  })

  test('a deleted review counts for nothing at all', () => {
    const counts = countReviews([
      { status: 'available', deleted_at: null },
      { status: 'submitted', deleted_at: 'gone' },
    ])
    assert.equal(counts.assigned, 1)
    assert.equal(counts.posted, 0)
  })

  test('the candidate’s per-type breakdown is the same function, twice', () => {
    const byType = countReviewsByType([
      ...rows(['submitted', 'submitted', 'submitted', 'available', 'available', 'available', 'available', 'available'], 'text'),
      ...rows(['submitted', 'submitted', 'available', 'available'], 'image'),
    ])
    assert.equal(byType.text.assigned, 8)
    assert.equal(byType.text.posted, 3)
    assert.equal(byType.image.assigned, 4)
    assert.equal(byType.image.posted, 2)
    assert.equal(byType.all.assigned, 12)
    assert.equal(progressLine(byType.text), '3 of 8 posted')
    assert.equal(progressLine(byType.image), '2 of 4 posted')
  })

  test('a full untouched batch reads as twelve assigned and nothing posted', () => {
    const byType = countReviewsByType([
      ...rows(Array<TestCardStatus>(8).fill('available'), 'text'),
      ...rows(Array<TestCardStatus>(4).fill('available'), 'image'),
    ])
    assert.equal(byType.all.assigned, 12)
    assert.equal(byType.all.posted, 0)
    assert.equal(byType.all.remaining, 12)
    assert.equal(byType.all.available, 12)
  })

  test('THE ADMIN SUMMARY USES THE SAME FUNCTIONS, and lists nothing', () => {
    const summary = executable(read('src/components/customerReviews/EmployeeProgress.tsx'))
    assert.ok(summary.includes('countReviewsByType('))
    // A COUNT SOURCE, NOT A LIST: no review text is selected, so there is
    // nothing in the query that could be rendered as a review.
    assert.ok(summary.includes("select('assigned_to, status, review_type, deleted_at')"))
    for (const column of ['card_ref', 'test_title', 'test_body']) {
      assert.equal(summary.includes(column), false, `the summary reads ${column}`)
    }
    // ...and the list screen still asks no tab for a verified row.
    const list = executable(read('src/app/customer-reviews/TestCardListScreen.tsx'))
    const table = list.slice(list.indexOf('const TAB_STATUSES'), list.indexOf('export function verifiedNoticeFrom'))
    assert.equal(table.includes("'verified'"), false,
      'some tab still asks the database for verified cards')
  })
})

// ══ 9. THE MIGRATION IS ADDITIVE, AND LEGACY ROWS ARE TEXT ═════════════════

describe('the migration touches no history', () => {
  test('every existing review becomes a TEXT review, by column default', () => {
    assert.ok(SQL.includes("add column if not exists review_type text not null default 'text'"))

    // AND THE FILE RE-TYPES NOTHING. There is no UPDATE of review_type in it at
    // all, which is the property "additive" actually means here: legacy rows
    // are typed by the DEFAULT, not by a statement that rewrote them.
    assert.equal(/set\s+review_type\s*=/.test(SQL.replace(fn('set_customer_review_draft_type'), '')), false,
      'something outside the verifier’s correction writes review_type')

    // The migration's own post-condition asserts the DEFAULT rather than
    // counting rows, so it stays true on a re-run — by then the generator has
    // legitimately made image reviews, and a row count would fail on work the
    // file did not do.
    assert.ok(SQL.includes('review_type does not default to text'))
    assert.equal(/where review_type <> 'text'/.test(SQL), false,
      'the post-condition counts rows and would fail on any re-run')
  })

  test('IT AWARDS NOTHING, and says so at apply time', () => {
    assert.equal(/insert into public\.boe_credit_transactions/.test(SQL), false)
    assert.ok(SQL.includes("where transaction_type = 'review_reward'\n     and created_at >= transaction_timestamp()"))
    assert.ok(SQL.includes('it must create none'))
  })

  test('a constraint that could refuse an existing row is added NOT VALID', () => {
    // The holder-is-assignee rule is the only one that could fail on a row
    // written before assignment existed.
    assert.ok(SQL.includes('check (booked_by is null or assigned_to is null or booked_by = assigned_to)\n      not valid'))
  })

  test('and no review type but the two exists', () => {
    assert.deepEqual([...REVIEW_TYPES], ['text', 'image'])
    assert.ok(SQL.includes("check (review_type in ('text', 'image'))"))
  })
})

// ══ 9A. MONTHLY QUALIFICATION IS UNTOUCHED ═════════════════════════════════

describe('the existing monthly credit qualification still works exactly as it did', () => {
  const poster = fn('post_boe_credit_review_reward')

  test('the month is still the Asia/Kolkata month of the SUBMISSION', () => {
    assert.ok(poster.includes("date_trunc('month', (p_submitted_at at time zone 'Asia/Kolkata')::date)::date"))
    // ...and the transition still passes the submission it is verifying.
    assert.ok(fn('transition_customer_review_test_card').includes('c.submitted_at,'))
  })

  test('the month row, the reward record and the refresh all still happen, in order', () => {
    const monthAt   = poster.indexOf('insert into public.boe_credit_review_months')
    const rewardAt  = poster.indexOf('insert into public.boe_credit_review_rewards')
    const refreshAt = poster.indexOf('public.refresh_boe_credit_review_month(')
    assert.ok(monthAt >= 0 && rewardAt > monthAt && refreshAt > rewardAt,
      'the month is created, recorded and refreshed in a different order')
    // The minimum is still SNAPSHOTTED on first use of a month, so a settings
    // change mid-month does not move the target of a month already open.
    assert.ok(poster.includes('minimum_reviews_snapshot)'))
    assert.ok(poster.includes('v_settings.minimum_monthly_reviews'))
  })

  test('QUALIFICATION COUNTS REVIEWS, NOT CREDITS, so two rewards do not change the target', () => {
    // The one thing that could have gone wrong here: if a month qualified on
    // CREDITS rather than on a count of reviews, giving image reviews a larger
    // reward would have quietly lowered the number of reviews needed. It counts
    // reviews — the refresh function and the month row are untouched by this
    // migration, and this file adds nothing that reads earned credits to decide
    // qualification.
    assert.equal(/qualifying_review_count\s*=/.test(SQL), false,
      'this migration writes the qualifying review count itself')
    assert.equal(SQL.includes('refresh_boe_credit_review_month'), true)
    assert.equal(/create or replace function public\.refresh_boe_credit_review_month/.test(SQL), false,
      'this migration re-creates the qualification refresh')
    assert.equal(/create or replace function public\.finalize_boe_credit_review_month/.test(SQL), false,
      'this migration re-creates the month finalization')
  })

  test('the whole per-employee lock is still taken before anything is posted', () => {
    const lockAt = poster.indexOf("pg_advisory_xact_lock(hashtext('boe_credits')")
    const postAt = poster.indexOf('public.post_boe_credit_transaction(')
    assert.ok(lockAt >= 0 && postAt > lockAt, 'the reward is posted before the per-employee lock')
  })

  test('the lapse kind, the review-month tables and the balance view are all left alone', () => {
    for (const untouched of [
      'boe_credit_transactions_transaction_type_check',
      'create table if not exists public.boe_credit_review_months',
      'create table if not exists public.boe_credit_review_rewards',
      'create or replace view public.boe_credit_balances',
      'boe_credit_payroll_applications',
    ]) {
      assert.equal(SQL.includes(untouched), false, `the migration touches ${untouched}`)
    }
  })
})

// ══ 10. THE SECURITY POSTURE IS UNCHANGED ══════════════════════════════════

describe('nothing here weakened the module’s existing guarantees', () => {
  test('STILL NO WRITE POLICY OF ANY KIND on the cards table', () => {
    const policies = SQL.match(/create policy "[^"]+"\s*\n?\s*on public\.customer_review_test_cards\s*\n?\s*for (\w+)/g) ?? []
    assert.ok(policies.length > 0, 'the cards policy is not re-created')
    for (const p of policies) assert.ok(p.includes('for select'), p)
  })

  test('every new browser-callable function is revoked from public and anon first', () => {
    const clientCallable = [
      'can_view_customer_review_image_group(uuid)',
      'create_customer_review_image_group(text)',
      'rename_customer_review_image_group(uuid, text)',
      'archive_customer_review_image_group(uuid, boolean)',
      'set_customer_review_draft_type(uuid, text)',
      'assign_customer_review_batch(uuid, uuid)',
      'set_customer_review_image_group(uuid, uuid)',
      'customer_review_assignable_employees()',
    ]
    for (const signature of clientCallable) {
      const revoke = new RegExp(`revoke execute on function public\\.${signature.replace(/[()]/g, m => `\\${m}`)} from public, anon`)
      const grant = new RegExp(`grant  execute on function public\\.${signature.replace(/[()]/g, m => `\\${m}`)} to authenticated`)
      assert.ok(revoke.test(SQL), `${signature} is not revoked from public, anon`)
      assert.ok(grant.test(SQL), `${signature} is not granted to authenticated`)
    }
  })

  test('every internal function is unreachable from a browser', () => {
    for (const signature of [
      'pick_customer_review_image_groups(integer)',
      'create_customer_review_draft_batch(text, text, jsonb, uuid, uuid)',
      'begin_customer_review_group_image_removal(uuid, uuid)',
      'finish_customer_review_group_image_removal(uuid)',
      'post_boe_credit_review_reward(uuid, uuid, text, text, timestamptz, uuid)',
    ]) {
      const escaped = signature.replace(/[()]/g, m => `\\${m}`)
      assert.ok(
        new RegExp(`revoke execute on function public\\.${escaped}\\s*\\n?\\s*from public, anon, authenticated`).test(SQL)
        || new RegExp(`revoke execute on function public\\.${escaped}\\s*\\n?\\s*from public, anon, authenticated;`).test(SQL),
        `${signature} is not revoked from authenticated`,
      )
    }
  })

  test('search_path is pinned on every function this file defines', () => {
    const definitions = SQL.match(/create or replace function public\.\w+\([\s\S]*?\$\$/g) ?? []
    assert.ok(definitions.length >= 10, 'the function scan found nothing')
    for (const def of definitions) {
      assert.ok(/set search_path = public, pg_temp/.test(def), def.slice(0, 90))
    }
  })

  test('no browser-callable writer takes an actor id', () => {
    // The one exception is deliberate and is a TARGET rather than an actor:
    // assign_customer_review_batch names the employee the work is for.
    for (const name of [
      'create_customer_review_image_group',
      'rename_customer_review_image_group',
      'archive_customer_review_image_group',
      'set_customer_review_draft_type',
      'set_customer_review_image_group',
    ]) {
      const body = fn(name)
      assert.equal(/p_actor_id|p_user_id/.test(body), false, `${name} accepts an actor`)
      assert.ok(body.includes('auth.uid()'), `${name} does not derive its own actor`)
    }
  })

  test('A CANDIDATE CANNOT CHANGE A REVIEW TYPE AFTER RELEASE', () => {
    const body = fn('set_customer_review_draft_type')
    assert.ok(body.includes("c.status <> 'pending_approval'"))
    assert.ok(body.includes('CUSTOMER_REVIEW_TEST_LOCKED'))
    assert.ok(body.includes("public.resolve_permission(v_uid, 'customer_review_requests', 'verify')"))
    // ...and the row is locked before its status is read.
    assert.ok(body.indexOf('for update') < body.indexOf("c.status <> 'pending_approval'"))
  })

  test('every lifecycle writer this file re-creates still locks the row first', () => {
    for (const name of [
      'transition_customer_review_test_card',
      'set_customer_review_draft_type',
      'set_customer_review_image_group',
    ]) {
      assert.ok(fn(name).includes('for update'), `${name} does not lock the row`)
    }
  })

  test('no role is consulted anywhere in the file', () => {
    assert.equal(/\bu\.role\b|users\.role|= 'admin'/.test(SQL), false,
      'the migration consults a role somewhere')
  })
})
