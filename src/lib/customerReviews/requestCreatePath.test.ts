/**
 * THE CREATE PATH, and the one policy that has to be right for it to work.
 *
 * These two facts only make sense together, which is why they are asserted in
 * one file rather than in the component's tests and the migration's separately:
 *
 *   1. RequestForm creates a request the ordinary way — `.insert(...).select('id')`,
 *      letting the database name the row.
 *   2. customer_review_requests_select decides on the candidate row instead of
 *      looking the request up again.
 *
 * Break (2) and (1) stops working, everywhere, for everybody. PostgREST turns
 * `.select()` into `INSERT ... RETURNING`; Postgres applies the SELECT policy to
 * the row it is about to return; and a STABLE helper that resolves the request
 * by reading public.customer_review_requests cannot see a row the current
 * statement is still inserting. The policy evaluates false and the insert is
 * refused 42501 "new row violates row-level security policy" — with nothing
 * wrong with the payload, and no hint that the problem is the read side.
 *
 * That is exactly what shipped, and no unit test caught it: this module has 364
 * of them and they all mock Supabase, so none of them ever met a policy. It was
 * found by running the module against a real database.
 *
 * WHAT THIS FILE CANNOT DO. It reads text. The decisive proof is
 * supabase/tests/customer_review_request_visibility_assertions.sql, which
 * performs a real INSERT ... RETURNING as a real authorized user against a real
 * database and fails against the old policy. This file is the cheap guard that
 * runs on every commit; that one is the guard that actually knows.
 *
 * WHY NOT JUST GENERATE THE ID IN THE BROWSER. It was tried, as a stopgap, and
 * it works — but it treats a broken read policy as a fact of life and leaves the
 * next `.select()` anybody writes against this table to fail the same way. The
 * policy was the defect, so the policy was fixed.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/requestCreatePath.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

const form = readFileSync(
  join(ROOT, 'src/components/customerReviews/RequestForm.tsx'), 'utf8',
).replace(/\r\n/g, '\n')

const sql = readFileSync(
  join(ROOT, 'supabase/migrations/20261017000000_customer_review_outreach.sql'), 'utf8',
).replace(/\r\n/g, '\n')
/** Executable SQL only — comments explain, they do not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** The `else` arm of RequestForm's save(): the branch that creates. */
function createBranch(): string {
  const start = form.indexOf(".from('customer_review_requests')", form.indexOf('let requestId'))
  assert.notEqual(start, -1, 'the create branch is missing')
  // Far enough to cover the whole chained call and the error handling under it.
  return form.slice(start, start + 700)
}

describe('the form creates a request the ordinary way', () => {
  test('it inserts and asks for the id back', () => {
    const branch = createBranch()
    assert.ok(/\.insert\(/.test(branch), 'the create branch does not insert')
    assert.ok(/\.select\('id'\)/.test(branch), 'the create branch does not ask for the id back')
    assert.ok(/\.single\(\)/.test(branch), 'the create branch does not read a single row')
  })

  test('the row is named by the database, not by the browser', () => {
    // A client-generated id is a legitimate technique, and here it would be a
    // workaround for a policy defect rather than a decision — so it is pinned
    // out. If a future change genuinely wants one, this test should be deleted
    // deliberately and with a reason, not quietly satisfied.
    const branch = createBranch()
    assert.equal(/crypto\.randomUUID\(\)/.test(branch), false,
      'the create branch generates its own id — is it working around the SELECT policy?')
    assert.equal(/\bid:\s/.test(branch), false,
      'the insert payload names an id; the database assigns it')
  })

  test('created_by is still sent explicitly, because the INSERT policy compares it', () => {
    assert.ok(/created_by: userId/.test(createBranch()))
  })

  test('and the request is still born a draft', () => {
    assert.ok(/status: 'draft'/.test(createBranch()))
  })
})

describe('the policy that lets it work', () => {
  const policy = (() => {
    const start = code.indexOf('create policy "customer_review_requests_select"')
    assert.notEqual(start, -1, 'the request SELECT policy is missing')
    return code.slice(start, code.indexOf(';', start))
  })()

  /** The definer predicate the policy delegates to. */
  const rowPredicate = () => {
    const start = code.indexOf('create or replace function public.can_view_customer_review_request_row')
    assert.notEqual(start, -1, 'the row predicate is missing')
    return code.slice(start, code.indexOf('$$;', start))
  }

  test('the predicate has definer rights and a pinned search_path', () => {
    // Without both, delegating solves nothing: definer rights are the point,
    // and an unpinned search_path would let a caller resolve `users` to a
    // table of their own while running as the owner.
    const fn = rowPredicate()
    assert.ok(fn.includes('security definer'))
    assert.ok(fn.includes('set search_path = public, pg_temp'))
    // It decides from its arguments; it never reads the guarded table.
    assert.equal(
      /(from|join)\s+(public\.)?customer_review_requests\b/i.test(fn), false,
      'the predicate must not query customer_review_requests',
    )
  })

  test('the request SELECT policy does not re-query the table it guards', () => {
    // The whole reason `.select('id')` above can work.
    assert.equal(/can_view_customer_review_request\(/.test(policy), false)
    assert.equal(/from\s+public\.customer_review_requests/.test(policy), false,
      'the policy selects from the table it guards')
  })

  test('it reads created_by off the candidate row', () => {
    // Passed as an argument, with the table named, so no column added to
    // anything else in scope can rebind it.
    assert.ok(policy.includes('customer_review_requests.created_by'))
    assert.ok(policy.includes('can_view_customer_review_request_row('))
    // And the policy must not reach into users itself: that would run as the
    // caller and tie this module's visibility to that table's grants.
    assert.equal(/\bfrom\s+(public\.)?users\b/i.test(policy), false)
  })

  test('it still admits exactly the same three people', () => {
    const fn = rowPredicate()
    assert.ok(fn.includes("u.role = 'admin'"), 'admin')
    assert.ok(
      fn.includes("resolve_permission(p_user_id, 'customer_review_requests', 'verify')"),
      'verifier',
    )
    assert.ok(fn.includes('p_created_by = p_user_id'), 'owner')
    // `use` opens the module; it does not disclose a colleague's customer.
    assert.equal(fn.includes("'customer_review_requests', 'use'"), false)
  })

  test('it still requires an active employee, on every branch including the owner’s', () => {
    // The join is what carries this, and it sits OUTSIDE the three-way or —
    // which is the difference between "a deactivated employee keeps their own
    // rows" and "a deactivated employee keeps nothing".
    const fn = rowPredicate()
    assert.ok(fn.includes('u.is_active'))
    assert.ok(fn.indexOf('u.is_active') < fn.indexOf('and ('),
      'is_active must gate all three branches, not sit inside one of them')
  })

  test('nothing about it is unconditional', () => {
    assert.equal(/\btrue\b/.test(policy), false)
    assert.equal(/\btrue\b/.test(rowPredicate()), false)
  })
})

describe('the child tables were left alone', () => {
  test('photos and events still resolve through the shared helper', () => {
    // They ask about ANOTHER table's row, where the lookup is correct and where
    // there is no INSERT ... RETURNING to break: neither table has a client
    // INSERT policy at all.
    for (const name of ['customer_review_photos_select', 'customer_review_events_select']) {
      const start = code.indexOf(`create policy "${name}"`)
      assert.notEqual(start, -1, name)
      assert.ok(
        code.slice(start, code.indexOf(';', start)).includes('can_view_customer_review_request'),
        `${name} no longer uses the shared predicate`,
      )
    }
  })

  test('the helper itself is unchanged and still requires an active user', () => {
    const start = code.indexOf('create or replace function public.can_view_customer_review_request')
    assert.notEqual(start, -1)
    const body = code.slice(start, code.indexOf('$$;', start))
    assert.ok(body.includes('join public.users u on u.id = p_user_id and u.is_active'))
    assert.ok(body.includes('r.created_by = p_user_id'))
    assert.ok(body.includes("u.role = 'admin'"))
    assert.ok(body.includes("resolve_permission(p_user_id, 'customer_review_requests', 'verify')"))
  })
})
