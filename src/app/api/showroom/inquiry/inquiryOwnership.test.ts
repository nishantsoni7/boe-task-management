/**
 * Repository check: one inquiry has one owner, and every surface shows that one.
 *
 * Why a source check
 * ------------------
 * The three surfaces are a route, a route and a client page; exercising them
 * needs a live Supabase, a real bearer token and a rendered session. The
 * invariant is about which identity is ALLOWED to reach the display — the kind
 * of thing that stays green in every other test while quietly showing the wrong
 * person's name.
 *
 * What went wrong, which is why this exists
 * -----------------------------------------
 * The inquiry detail page resolved the salesperson name itself, and for a
 * NON-ADMIN caller it short-cut to `session.user.id` — the viewer — on the
 * reasoning that a non-admin can only ever open their own inquiry. That is true
 * of today's guard and of nothing else: the day a team lead, a manager role or
 * a shared-queue permission can open a colleague's inquiry, every such screen
 * silently relabels that colleague's customer as the viewer's own. The name is
 * now resolved server-side from `salesperson_id` on all three surfaces, and no
 * client code looks it up at all.
 *
 * Run:
 *   npx tsx --test src/app/api/showroom/inquiry/inquiryOwnership.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const DETAIL_ROUTE = read('src/app/api/showroom/inquiry/[id]/route.ts')
const LIST_ROUTE   = read('src/app/api/showroom/inquiry/route.ts')
const PDF_ROUTE    = read('src/app/api/showroom/quotation/[id]/route.ts')
const DETAIL_PAGE  = read('src/app/showroom-admin/inquiry/[inquiryId]/page.tsx')
const LIST_PAGE    = read('src/app/showroom-admin/page.tsx')

describe('the detail route resolves the owner', () => {
  test('looks the name up by the inquiry’s salesperson_id', () => {
    assert.match(
      DETAIL_ROUTE,
      /\.from\('users'\)[\s\S]{0,80}\.select\('full_name'\)[\s\S]{0,80}\.eq\('id', inquiry\.salesperson_id\)/,
    )
  })

  test('returns it as salesperson_name, null when unresolved', () => {
    assert.match(DETAIL_ROUTE, /salesperson_name:/)
    assert.match(DETAIL_ROUTE, /\?\?\s*null/)
  })

  test('never resolves the owner from the caller', () => {
    assert.equal(/\.eq\('id', caller\.id\)/.test(DETAIL_ROUTE), false)
  })

  test('still refuses a non-admin who does not own the inquiry', () => {
    // Adding a name must not have loosened the guard that made it safe.
    assert.match(DETAIL_ROUTE, /inquiry\.salesperson_id !== caller\.id/)
    assert.match(DETAIL_ROUTE, /status: 403/)
  })
})

describe('all three surfaces agree on who owns an inquiry', () => {
  test('every surface resolves the name from salesperson_id', () => {
    for (const [name, src] of [
      ['detail route', DETAIL_ROUTE],
      ['list route',   LIST_ROUTE],
      ['quotation PDF', PDF_ROUTE],
    ] as const) {
      assert.match(src, /salesperson_id/, `${name} must key on salesperson_id`)
      assert.match(src, /full_name/,      `${name} must resolve a full_name`)
    }
  })

  test('no surface ever substitutes the caller’s own name', () => {
    for (const [name, src] of [
      ['detail route',  DETAIL_ROUTE],
      ['list route',    LIST_ROUTE],
      ['quotation PDF', PDF_ROUTE],
    ] as const) {
      assert.equal(src.includes('caller.full_name'), false, `${name} must not use caller.full_name`)
    }
  })
})

describe('the inquiry detail page', () => {
  test('shows a Sales Candidate row fed by the inquiry’s own owner', () => {
    assert.match(DETAIL_PAGE, /label=\{SALES_CANDIDATE_LABEL\}/)
    assert.match(DETAIL_PAGE, /value=\{salesCandidateLabel\(inquiry\.salesperson_name\)\}/)
  })

  test('does not look the salesperson up on the client at all', () => {
    // The whole class of bug lived in a client-side name lookup, so the page is
    // asserted to have none rather than to have a correct one.
    //
    // `.select('full_name')` on its own is the salesperson-resolution shape —
    // both removed lookups had exactly it. The page's remaining `users` query
    // is the CALLER'S OWN PROFILE, which selects nine columns and feeds
    // resolveModuleAccess; that one is legitimate and must survive, so the
    // assertion targets the narrow select rather than the table.
    assert.equal(
      DETAIL_PAGE.includes(".select('full_name')"),
      false,
      'page must not resolve any name from the client',
    )
    assert.equal(
      (DETAIL_PAGE.match(/\.from\('users'\)/g) ?? []).length,
      1,
      'exactly one users query should remain: the caller’s own profile',
    )
    assert.equal(DETAIL_PAGE.includes('setSalespersonName'), false)
  })

  test('the WhatsApp message is signed by the owner, not the sender', () => {
    assert.match(DETAIL_PAGE, /inquiry\.salesperson_name \|\| 'Your Salesperson'/)
  })

  test('the viewer’s own profile is still used only for access control', () => {
    // `session.user.id` remains legitimate for loading the caller's profile and
    // deciding module access — it just must never name the salesperson.
    assert.match(DETAIL_PAGE, /resolveModuleAccess\('showroom_qr'/)
  })
})

describe('the admin inquiry list', () => {
  test('renders the owner it was given rather than the signed-in user', () => {
    assert.match(LIST_PAGE, /inquiry\.salesperson_name \?\? 'Unassigned'/)
    assert.equal(LIST_PAGE.includes('profile.full_name'), false)
  })
})
