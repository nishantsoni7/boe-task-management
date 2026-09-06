/**
 * 20261102000000_boe_credits_review_reward.sql — what the migration SAYS, and
 * what the screen does with its answer.
 *
 * Phase 1B connects the Review Workflow's final verification to a
 * review_reward. This file pins the shape: the reward is posted INSIDE the
 * verify branch of transition_customer_review_test_card(), for the HOLDER,
 * for the ACTIVE SETTING, through the ONE write path, with no backfill and no
 * new grant. The executable proof is supabase/tests/boe_credits_review_reward_
 * assertions.sql; this catches drift a database is not needed to see.
 *
 * Comments are stripped before every assertion, so a claim cannot be satisfied
 * by prose.
 *
 * Run:
 *   npx tsx --test src/lib/boeCredits/reviewReward.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const FILE = '20261102000000_boe_credits_review_reward.sql'
const PREVIOUS = '20261030000000_review_workflow_deletion_and_replacement.sql'
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const strip = (s: string) => s.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

const sql  = read(join(MIGRATIONS, FILE))
const code = strip(sql)

/** The transition function's body in a given file, comments stripped. */
function transitionIn(src: string): string {
  const start = src.indexOf('create or replace function public.transition_customer_review_test_card(')
  assert.ok(start >= 0, 'transition_customer_review_test_card is defined')
  const end = src.indexOf('\n$$;', start)
  assert.ok(end > start)
  return src.slice(start, end + 4)
}

const fn   = transitionIn(code)
const prev = transitionIn(strip(read(join(MIGRATIONS, PREVIOUS))))

// ── 1. The file ─────────────────────────────────────────────────────────────

describe('the file, and where it sits', () => {
  test('it sits directly after the foundation, and only Phase 1C and Phase 1D follow it', () => {
    const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const at = all.indexOf(FILE)
    assert.equal(all[at - 1], '20261101000000_boe_credits_foundation.sql')
    assert.deepEqual(all.slice(at + 1), [
      '20261103000000_boe_credits_attendance_redemption.sql',
      '20261104000000_boe_credits_phase_1d.sql',
      '20261105000000_holiday_half_day.sql',
      // Employee designation level: one nullable, informational column on
      // public.users, granted to authenticated. Reaches nothing here.
      '20261106000000_employee_designation_level.sql',
      // Review types, batch assignment and the project image library. IT DOES
      // REACH THIS WORK, and that is why it is named rather than allowed by a
      // loosened rule: it re-creates transition_customer_review_test_card() a
      // third time so the reward is priced by the review's own review_type, and
      // replaces post_boe_credit_review_reward() with a six-argument form.
      //
      // WHAT THIS FILE ASSERTS IS UNAFFECTED. Every claim below is about what
      // 20261102000000 SAYS — the shape Phase 1B introduced, in the file that
      // introduced it. A later file changing the live definition does not
      // change what this one contains, and the two together are the history.
      // The current shape is asserted in
      // src/lib/customerReviews/reviewTypes.test.ts.
      '20261107000000_review_types_assignment_and_image_groups.sql',
      // Variable batch size. It does NOT reach this work: it touches no reward,
      // no ledger and no transition function, and the price of a review is still
      // read from its review_type. A batch simply holds a different number of
      // them.
      '20261108000000_review_workflow_variable_batch_size.sql',
      // Performance: Personal Performance and Team Performance become separately
      // configurable capabilities. It registers two actions on the existing
      // `performance` permission module and seeds the admin/manager role grants
      // that reproduce today's role checks exactly. It creates no table, alters
      // no table and defines no function, so it reaches nothing asserted here.
      '20261109000000_performance_personal_and_team_capabilities.sql',
      // The forward-only correction to it: Performance management visibility is
      // granted per employee, never inherited from the `manager` role name. It
      // deletes two role_permissions rows and inserts two
      // employee_permission_overrides rows. It creates no table, alters no table
      // and defines no function, so it reaches nothing asserted here.
      '20261110000000_performance_team_visibility_is_granted_not_inherited.sql',
    ])
  })

  test('it touches ONE function and nothing else — no table, no policy, no data', () => {
    assert.equal((code.match(/create or replace function/g) ?? []).length, 1)
    assert.equal(/create table|alter table|create policy|drop policy|create index|create trigger/.test(code), false)
    // The only INSERT in the file is the event row the transition has always
    // written; the ledger is reached through the posting function.
    const inserts = [...code.matchAll(/insert into public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual(inserts, ['customer_review_test_card_events'])
    assert.equal(/insert into public\.boe_credit_transactions/.test(code), false)
    assert.equal(/update public\.boe_credit/.test(code), false)
  })

  test('it is not wrapped in an explicit transaction, like every file before it', () => {
    assert.equal(/^\s*begin;\s*$/m.test(code), false)
    assert.equal(/^\s*commit;\s*$/m.test(code), false)
  })

  test('NO BACKFILL: nothing in the file selects verified reviews to reward, and the post-condition proves zero rows were written', () => {
    assert.equal(/status = 'verified'/.test(code.replace(fn, '')), false, 'no query for already-verified cards outside the function')
    assert.equal(/from public\.customer_review_test_cards[\s\S]{0,200}review_reward/.test(code.replace(fn, '')), false)
    assert.match(code, /transaction_type = 'review_reward'\s*\n\s*and created_at >= transaction_timestamp\(\)/)
    assert.match(code, /it must create none/)
  })
})

// ── 2. The function is the old one, plus the reward ─────────────────────────

describe('the transition is carried forward unchanged, then extended', () => {
  test('the return type is jsonb on the SAME identity signature, dropped first because a return type cannot be altered', () => {
    assert.match(code, /drop function if exists public\.transition_customer_review_test_card\(uuid, text, text\);/)
    assert.match(fn, /p_card_id\s+uuid,\s*\n\s*p_next_status text,\s*\n\s*p_detail\s+text default null\s*\n\)\s*\nreturns jsonb/)
  })

  test('every guard the previous definition had is still there, verbatim', () => {
    for (const needle of [
      "if v_uid is null then",
      "where id = p_card_id for update;",
      "if c.deleted_at is not null then",
      "select 1 from public.users u where u.id = v_uid and u.is_active",
      "v_use    := public.resolve_permission(v_uid, 'customer_review_requests', 'use');",
      "v_verify := public.resolve_permission(v_uid, 'customer_review_requests', 'verify');",
      "v_holder := (c.booked_by = v_uid);",
      "if not (v_use or v_verify) then",
      "when 'submitted' then p_next_status in ('verified', 'booked')",
      "CUSTOMER_REVIEW_TEST_BAD_TRANSITION",
      "if p_next_status in ('verified', 'booked') then",
      "if not v_verify then",
      "if not (v_holder and v_use) then",
      "perform public.assert_customer_review_test_card_submittable(p_card_id);",
      "if p_next_status = 'booked' and v_detail is null then",
      "insert into public.customer_review_test_card_events",
    ]) {
      assert.ok(prev.includes(needle), `the previous definition has: ${needle}`)
      assert.ok(fn.includes(needle), `the new definition kept: ${needle}`)
    }
  })

  test('the lock is still taken BEFORE the status is read, and the UPDATE is byte-identical', () => {
    const lock  = fn.indexOf('for update')
    const guard = fn.indexOf('v_legal := case c.status')
    assert.ok(lock > 0 && lock < guard)
    const update = (s: string) => s.slice(s.indexOf('update public.customer_review_test_cards c2'), s.indexOf('where c2.id = p_card_id;'))
    assert.equal(update(fn), update(prev))
  })

  test('it consults no role — the Review Workflow rule the migration re-asserts on itself', () => {
    assert.equal(/u\.role|users\.role|'admin'/.test(fn), false)
    assert.match(code, /v_src ~ '\(u\\\.role\|users\\\.role\|''admin''\)'/)
  })

  test('grants are restated verbatim: revoke public and anon, grant authenticated — and nothing about the posting function', () => {
    assert.match(code, /revoke execute on function public\.transition_customer_review_test_card\(uuid, text, text\) from public, anon;/)
    assert.match(code, /grant  execute on function public\.transition_customer_review_test_card\(uuid, text, text\) to authenticated;/)
    assert.equal(/grant[^\n]*post_boe_credit_transaction/.test(code), false, 'no grant on the posting function')
    assert.equal(/grant[^\n]*boe_credit_transactions/.test(code), false, 'no grant on the ledger')
  })
})

// ── 3. The reward itself ────────────────────────────────────────────────────

describe('the reward', () => {
  const branch = fn.slice(fn.indexOf("if p_next_status = 'verified' then\n    if c.booked_by is null"), fn.indexOf('select * into c from public.customer_review_test_cards where id = p_card_id;'))

  test('is posted ONLY inside the verified branch, after the UPDATE and the event', () => {
    assert.ok(branch.includes('public.post_boe_credit_transaction('))
    assert.equal((fn.match(/post_boe_credit_transaction\(/g) ?? []).length, 1)
    const post   = fn.indexOf('public.post_boe_credit_transaction(')
    const update = fn.indexOf('update public.customer_review_test_cards c2')
    const event  = fn.indexOf('insert into public.customer_review_test_card_events')
    assert.ok(update < event && event < post)
  })

  test('for the HOLDER — c.booked_by — never the verifier, submitted_by or anybody passed in', () => {
    const call = branch.slice(branch.indexOf('public.post_boe_credit_transaction('), branch.indexOf(');', branch.indexOf('public.post_boe_credit_transaction(')))
    const args = call.slice(call.indexOf('(') + 1).split(',').map(a => a.trim())
    assert.equal(args[0], 'c.booked_by', 'the employee')
    assert.equal(args[1], "'review_reward'", 'the kind')
    assert.equal(args[2], 'v_reward', 'the amount, a variable')
    assert.equal(args[3], "'customer_review'", 'the source type')
    assert.equal(args[4], 'p_card_id', 'the immutable review id')
    assert.equal(args[6], 'v_uid', 'the verifier is the ACTOR, not the recipient')
    assert.equal(/submitted_by|verified_by|uploaded_by/.test(call), false)
    assert.match(branch, /if c\.booked_by is null then/)
  })

  test('for the ACTIVE SETTING — newest boe_credit_settings row — and no literal amount anywhere', () => {
    assert.match(branch, /select s\.review_reward_credits into v_reward\s*\n\s*from public\.boe_credit_settings s\s*\n\s*order by s\.created_at desc\s*\n\s*limit 1;/)
    assert.equal(/\b100\b/.test(fn), false, 'no hard-coded 100 in the function')
    assert.equal(/'review_reward',\s*\d/.test(fn), false)
    assert.match(branch, /if v_reward is null then/)
    assert.match(branch, /BOE_CREDITS_SETTINGS/)
  })

  test('the ledger description names the review, not the employee', () => {
    assert.match(branch, /'Review verified · ' \|\| c\.card_ref/)
    assert.equal(/full_name/.test(branch.slice(0, branch.indexOf('post_boe_credit_transaction'))), false)
  })

  test('the result carries the card and the reward for the screen', () => {
    assert.match(fn, /'card', to_jsonb\(c\)/)
    assert.match(fn, /'transaction_id', v_reward_id/)
    assert.match(fn, /'employee_id',\s+c\.booked_by/)
    assert.match(fn, /'employee_name',\s+v_holder_name/)
    assert.match(fn, /'credits',\s+v_reward/)
    assert.match(fn, /when v_reward_id is null then null/)
  })

  test('every raise the reward adds carries a SQLSTATE', () => {
    for (const block of branch.split('raise exception').slice(1)) {
      assert.match(block.slice(0, 300), /using errcode = '(42501|23514|P0002)'/)
    }
  })
})

// ── 4. The screens ──────────────────────────────────────────────────────────
//
// The verifier's workflow is the one the module had before Phase 1B: a
// successful verification goes straight back to the To verify list. What is
// new is that the list is told, once, what the database awarded.

describe('the screens', () => {
  const clean = (s: string) =>
    strip(s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n'))
  const d = clean(read(join(ROOT, 'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')))
  const l = clean(read(join(ROOT, 'src/app/customer-reviews/TestCardListScreen.tsx')))

  test('the detail screen reads the RPC result and goes back to the To verify list as before, carrying the credits', () => {
    // THE LIST MOVED TO `/customer-reviews/reviews` when the module gained its
    // own workspaces. The root is the verifier's Overview, which reads no query
    // parameters and would have swallowed the reward flag. The guarantee is
    // unchanged: a verification lands on the list that says what was awarded.
    assert.match(d, /const \{ data, error: rpcError \} = await supabase\.rpc\('transition_customer_review_test_card'/)
    assert.match(d, /if \(action\.to === 'verified'\) \{\s*router\.push\(`\/customer-reviews\/reviews\?tab=to_verify\$\{verifiedQuery\(data\)\}`\)\s*return\s*\}/)
    assert.match(d, /export function verifiedQuery\(data: unknown\): string/)
    assert.match(d, /return `&verified=\$\{credits\}`/)
    assert.equal(/setVerifiedReward|VerifiedRewardNote|readVerifiedReward/.test(d), false, 'the screen does not stay behind')
    assert.equal(/₹|formatRupees|formatCredits|credit_value|review_reward_credits/.test(d), false, 'the detail screen formats nothing')
  })

  test('the list says what was awarded, in credits, from the flag alone, and computes no amount of its own', () => {
    assert.match(l, /const verifiedNotice = verifiedNoticeFrom\(searchParams\.get\('verified'\)\)/)
    assert.match(l, /export function verifiedNoticeFrom\(flag: string \| null\): string \| null/)
    assert.match(l, /formatCredits\(credits, \{ signed: true \}\)/)
    assert.match(l, /\{verifiedNotice && \(\s*<p role="status"/)
    assert.equal(/₹|formatRupees|credit_value|review_reward_credits/.test(l), false)
    const helper = l.slice(l.indexOf('export function verifiedNoticeFrom'), l.indexOf('export function TestCardListScreen'))
    assert.equal(/\b100\b/.test(helper), false, 'no hard-coded 100')
  })

  test('still no other caller of the transition, and no new client path to the ledger', () => {
    const src = join(ROOT, 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.test.ts')) {
          const s = strip(read(full))
          if (/rpc\('transition_customer_review_test_card'/.test(s) && !full.endsWith('TestCardDetailScreen.tsx')) offenders.push(full)
          if (/rpc\('post_boe_credit_transaction'/.test(s) && !full.endsWith(join('boeCredits', 'service.ts'))) offenders.push(full)
        }
      }
    }
    walk(src)
    assert.deepEqual(offenders, [])
  })
})
