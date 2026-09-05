/**
 * The last-administrator invariant, on all four paths that can violate it.
 *
 * The rule under test:
 *
 *   AN OPERATION MAY NOT LEAVE THE ORGANISATION WITHOUT AT LEAST ONE
 *   ADMINISTRATOR WHO IS ACTIVE AND NOT DELETED.
 *
 * Two halves. The first exercises the decision function against a fake Supabase
 * client, so every combination is cheap and no database is involved. The second
 * is a repository check that all four routes actually call it — a correct rule
 * that one route forgets to ask is the defect this file exists because of.
 *
 * THE DEFECT THIS WAS WRITTEN FOR. The first version of the guard covered role
 * demotion only. /api/toggle-active would happily deactivate the final
 * administrator, and /api/delete-user then accepted them BECAUSE they were
 * inactive — a complete lockout in two clicks, past a guard that looked like
 * protection.
 *
 * Run:
 *   npx tsx --test src/lib/users/lastAdministrator.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  checkLastAdministrator,
  otherUsableAdministratorCount,
  targetCarriesAdministratorAuthority,
  type AdministratorAction,
} from './lastAdministrator'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// ── A fake `users` table answering the guard's TWO queries ──────────────────
//
// The guard now owns both: reading the target row (`.single()`), and counting
// the other administrators who are active and not deleted (a head count). The
// fake mirrors those filter chains rather than being a general query engine, so
// changing a filter shows up as a failing test instead of being mimicked.
//
// `failTarget` and `failCount` inject the failures that matter: a target read
// that errors is the fail-open condition this file's second half exists for.

type Row = { id: string; role: string; is_active: boolean; is_deleted: boolean | null }

type FakeOpts = {
  failCount?: boolean
  /** 'read' = a transient failure; 'missing' = PGRST116, no such member. */
  failTarget?: 'read' | 'missing'
}

function fakeClient(rows: Row[], opts: FakeOpts = {}): SupabaseClient {
  const makeBuilder = () => ({
    _role: '' as string,
    _active: undefined as boolean | undefined,
    _notDeleted: false,
    _exclude: '' as string,
    _id: '' as string,
    _head: false,
    select(_cols?: string, options?: { head?: boolean }) {
      this._head = options?.head === true
      return this
    },
    eq(column: string, value: unknown) {
      if (column === 'role') this._role = value as string
      if (column === 'is_active') this._active = value as boolean
      if (column === 'id') this._id = value as string
      return this
    },
    or() { this._notDeleted = true; return this },
    neq(_column: string, value: unknown) { this._exclude = value as string; return this },

    // The target read.
    single() {
      if (opts.failTarget === 'read') {
        return Promise.resolve({ data: null, error: { code: '08006', message: 'connection lost' } })
      }
      if (opts.failTarget === 'missing') {
        return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
      }
      const row = rows.find(r => r.id === this._id) ?? null
      return Promise.resolve(
        row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      )
    },

    // The head count.
    then(resolve: (r: { count: number | null; error: { message: string } | null }) => void) {
      if (opts.failCount) return resolve({ count: null, error: { message: 'connection lost' } })
      const count = rows.filter(r =>
        r.id !== this._exclude &&
        r.role === this._role &&
        (this._active === undefined || r.is_active === this._active) &&
        (!this._notDeleted || r.is_deleted !== true),
      ).length
      return resolve({ count, error: null })
    },
  })
  return { from: () => makeBuilder() } as unknown as SupabaseClient
}

const ACTIONS: AdministratorAction[] = ['demote', 'deactivate', 'delete', 'permanently_delete']

const activeAdmin   = (id: string): Row => ({ id, role: 'admin',  is_active: true,  is_deleted: false })
const inactiveAdmin = (id: string): Row => ({ id, role: 'admin',  is_active: false, is_deleted: false })
const deletedAdmin  = (id: string): Row => ({ id, role: 'admin',  is_active: false, is_deleted: true })
const member        = (id: string): Row => ({ id, role: 'member', is_active: true,  is_deleted: false })

// ── 1. The counting rule ────────────────────────────────────────────────────

describe('who counts as a remaining administrator', () => {
  test('only administrators who are active and not deleted', async () => {
    const rows = [
      activeAdmin('keeper'), inactiveAdmin('benched'), deletedAdmin('gone'),
      member('ordinary'), { id: 'mgr', role: 'manager', is_active: true, is_deleted: false },
    ]
    assert.equal(await otherUsableAdministratorCount(fakeClient(rows), 'nobody'), 1)
  })

  test('the target is never counted as their own replacement', async () => {
    const rows = [activeAdmin('only')]
    assert.equal(await otherUsableAdministratorCount(fakeClient(rows), 'only'), 0)
  })

  test('a NULL is_deleted means not deleted', async () => {
    const rows = [{ id: 'legacy', role: 'admin', is_active: true, is_deleted: null }]
    assert.equal(await otherUsableAdministratorCount(fakeClient(rows), 'someone-else'), 1)
  })

  test('IT FAILS CLOSED: a count that errors throws rather than reporting zero or plenty', async () => {
    // Supabase rejects with a plain PostgrestError object, not an Error, so the
    // assertion inspects the thrown value rather than matching a message.
    await assert.rejects(
      () => otherUsableAdministratorCount(fakeClient([activeAdmin('a')], { failCount: true }), 'x'),
      (thrown: unknown) => (thrown as { message?: string })?.message === 'connection lost',
    )
    // The point of failing closed: the route never reaches its write, so an
    // unanswerable question can never be read as "somebody else is left".
  })
})

// ── 2. Which targets the invariant applies to ───────────────────────────────

describe('which targets carry administrator authority', () => {
  test('an ordinary employee never does, on any path', () => {
    for (const action of ACTIONS) {
      assert.equal(targetCarriesAdministratorAuthority(member('m'), action), false, action)
    }
  })

  test('a live administrator does, on every path', () => {
    for (const action of ACTIONS) {
      assert.equal(targetCarriesAdministratorAuthority(activeAdmin('a'), action), true, action)
      assert.equal(targetCarriesAdministratorAuthority(inactiveAdmin('a'), action), true, action)
    }
  })

  test('a SOFT-DELETED administrator counts only for permanent deletion', () => {
    // The row is already out of the directory, so demote/deactivate/delete have
    // nothing left to take. Permanent deletion does: the account is still
    // restorable, and this is the step that ends that. Testing is_deleted on
    // that path would have made the guard unreachable — every target reaching
    // /api/permanently-delete-user is soft-deleted by definition.
    assert.equal(targetCarriesAdministratorAuthority(deletedAdmin('d'), 'permanently_delete'), true)
    for (const action of ['demote', 'deactivate', 'delete'] as AdministratorAction[]) {
      assert.equal(targetCarriesAdministratorAuthority(deletedAdmin('d'), action), false, action)
    }
  })

  test('a missing row carries nothing', () => {
    for (const action of ACTIONS) {
      assert.equal(targetCarriesAdministratorAuthority(null, action), false, action)
      assert.equal(targetCarriesAdministratorAuthority(undefined, action), false, action)
    }
  })
})

// ── 3. THE FOUR PATHS ───────────────────────────────────────────────────────

describe('the last administrator is protected on all four paths', () => {
  const LAST = 'last-admin'

  /** The target row as each path would actually find it. */
  const targetRow = (action: AdministratorAction): Row =>
    action === 'permanently_delete' ? deletedAdmin(LAST)
      : action === 'delete'         ? inactiveAdmin(LAST)
      :                               activeAdmin(LAST)

  for (const action of ACTIONS) {
    test(`${action}: REFUSED when they are the only usable administrator`, async () => {
      const check = await checkLastAdministrator(fakeClient([targetRow(action)]), LAST, action)
      assert.equal(check.ok, false, `${action} must be refused`)
      assert.equal(check.ok === false && check.status, 400)
      assert.match(check.ok === false ? check.error : '', /last administrator account/)
    })

    test(`${action}: ALLOWED when a second valid administrator remains`, async () => {
      const rows = [targetRow(action), activeAdmin('second-admin')]
      assert.deepEqual(await checkLastAdministrator(fakeClient(rows), LAST, action), { ok: true })
    })

    test(`${action}: an ordinary employee is never blocked, even with no admins at all`, async () => {
      assert.deepEqual(await checkLastAdministrator(fakeClient([member('m')]), 'm', action), { ok: true })
    })
  }

  test('a DEACTIVATED second administrator is not a replacement', async () => {
    // The strict reading, and the direction that fails safe: BOE must be left
    // with somebody who can actually work, not somebody who would first have to
    // be reactivated by an administrator who no longer exists.
    const rows = [activeAdmin('last-admin'), inactiveAdmin('benched')]
    const check = await checkLastAdministrator(fakeClient(rows), 'last-admin', 'deactivate')
    assert.equal(check.ok, false)
    assert.match(check.ok === false ? check.error : '', /reactivate/)
  })

  test('a SOFT-DELETED second administrator is not a replacement either', async () => {
    const rows = [activeAdmin('last-admin'), deletedAdmin('gone')]
    const check = await checkLastAdministrator(fakeClient(rows), 'last-admin', 'demote')
    assert.equal(check.ok, false)
  })
})

// ── 4. THE CHAIN that the demotion-only guard left open ─────────────────────

describe('the deactivate → soft-delete lockout chain', () => {
  test('step one is refused: the final administrator cannot be deactivated', async () => {
    const check = await checkLastAdministrator(fakeClient([activeAdmin('solo')]), 'solo', 'deactivate')
    assert.equal(check.ok, false, 'deactivating the last administrator must be refused')
  })

  test('and step two is refused independently, for a row that is already inactive', async () => {
    // Belt and braces: even if an inactive administrator exists from before the
    // guard, or from a direct database edit, soft-deleting them is refused
    // while nobody else can administer.
    const check = await checkLastAdministrator(fakeClient([inactiveAdmin('solo')]), 'solo', 'delete')
    assert.equal(check.ok, false, 'soft-deleting the last administrator must be refused even when inactive')
  })
})

// ── 4b. THE FAIL-OPEN CONDITION ─────────────────────────────────────────────
//
// Review of the previous head found it: two routes read the target and threw
// the query's error away. A failed read produced `null`, `null` was
// indistinguishable from "not an administrator", and the write went ahead —
// fail-open in the one guard that must fail closed.
//
// The read now lives inside the rule, so there is no error for a route to
// discard. These tests pin that: an unreadable target, and an unreadable count,
// must both stop the request.

describe('a check that cannot be completed never says "go ahead"', () => {
  for (const action of ACTIONS) {
    test(`${action}: an unreadable TARGET stops the request with a 500`, async () => {
      // The exact regression: previously this produced `null` and waved the
      // write through. The rows say the target IS the last administrator, so a
      // fail-open would be catastrophic here.
      const check = await checkLastAdministrator(
        fakeClient([activeAdmin('solo')], { failTarget: 'read' }), 'solo', action,
      )
      assert.equal(check.ok, false, 'an unreadable target must not be treated as "not an admin"')
      assert.equal(check.ok === false && check.status, 500)
      assert.match(check.ok === false ? check.error : '', /nothing was changed/)
    })

    test(`${action}: an unreadable COUNT stops the request with a 500`, async () => {
      const check = await checkLastAdministrator(
        fakeClient([activeAdmin('solo')], { failCount: true }), 'solo', action,
      )
      assert.equal(check.ok, false)
      assert.equal(check.ok === false && check.status, 500)
    })
  }

  test('a genuinely missing member is a 404, not a 500 — the two are told apart', async () => {
    const check = await checkLastAdministrator(
      fakeClient([], { failTarget: 'missing' }), 'ghost', 'demote',
    )
    assert.equal(check.ok, false)
    assert.equal(check.ok === false && check.status, 404)
    assert.equal(check.ok === false && check.error, 'Member not found')
  })

  test('a missing row found by an ordinary lookup is also a 404', async () => {
    const check = await checkLastAdministrator(fakeClient([activeAdmin('someone')]), 'ghost', 'delete')
    assert.equal(check.ok, false)
    assert.equal(check.ok === false && check.status, 404)
  })
})

// ── 5. Every route actually asks ────────────────────────────────────────────

describe('all four routes enforce it', () => {
  const ROUTES: [string, AdministratorAction][] = [
    ['src/app/api/update-member/route.ts',            'demote'],
    ['src/app/api/toggle-active/route.ts',            'deactivate'],
    ['src/app/api/delete-user/route.ts',              'delete'],
    ['src/app/api/permanently-delete-user/route.ts',  'permanently_delete'],
  ]

  for (const [path, action] of ROUTES) {
    test(`${path} calls the shared rule with '${action}' and obeys its answer`, () => {
      const src = read(path)
      assert.ok(src.includes("from '@/lib/users/lastAdministrator'"), 'imports the shared rule')
      assert.ok(src.includes(`checkLastAdministrator(`), 'uses the one entry point')
      assert.ok(src.includes(`'${action}')`), `passes the ${action} action`)
      // The status comes from the rule, so a 404, a 500 and a 400 each reach
      // the administrator as themselves rather than being flattened.
      assert.ok(
        src.includes('if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status })'),
        'stops the request on any not-ok answer, with the rule’s own status',
      )
    })

    test(`${path} CANNOT reach a write past a failed target lookup`, () => {
      // THE REGRESSION THIS FILE EXISTS FOR. Two routes used to read the target
      // themselves and discard the query error; a failed read then looked like
      // "not an administrator". A route may no longer read the target FOR the
      // guard at all — the rule does it — so there is no error left to drop.
      const src = read(path)
      const guardAt = src.indexOf('checkLastAdministrator(')
      assert.ok(guardAt > -1, 'the rule is called')

      // Any target read the route still does for its OWN reasons must check its
      // error. delete-user and permanently-delete-user legitimately read the
      // row to enforce is_active/is_deleted; both already guard `targetError`.
      if (/const \{ data: target/.test(src)) {
        assert.ok(
          /error: targetError \}/.test(src) && /if \(targetError \|\| !target\)/.test(src),
          `${path}: a target read must capture and check its error`,
        )
      }

      // And nothing may silently drop an error from a target read.
      assert.equal(
        /const \{ data: target \} = await/.test(src), false,
        `${path}: a target read that ignores its error is the fail-open defect`,
      )
    })
  }

  test('no route re-implements the count or the target read inline', () => {
    // The original defect was a bespoke count in one route; the second was a
    // bespoke target read in two. One rule, one file, one read.
    for (const [path] of ROUTES) {
      const src = read(path)
      assert.equal(src.includes(".eq('role', 'admin')"), false, `${path} must not count admins itself`)
      assert.equal(src.includes('targetCarriesAdministratorAuthority'), false,
        `${path} must not re-decide who carries authority`)
    }
  })

  test('the rule runs BEFORE the row is changed', () => {
    for (const [path] of ROUTES) {
      const src = read(path)
      const guardAt = src.indexOf('checkLastAdministrator(')
      const writeAt = Math.min(
        ...['\n    .update(', '\n    .delete(', 'auth.admin.deleteUser']
          .map(marker => { const i = src.indexOf(marker); return i === -1 ? Number.MAX_SAFE_INTEGER : i }),
      )
      assert.ok(guardAt > -1 && guardAt < writeAt, `${path}: the rule must precede the write`)
    }
  })
})
