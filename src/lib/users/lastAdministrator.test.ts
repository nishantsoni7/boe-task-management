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
  lastAdministratorBlock,
  otherUsableAdministratorCount,
  targetCarriesAdministratorAuthority,
  type AdministratorAction,
  type AdministratorRow,
} from './lastAdministrator'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

// ── A fake `users` table that answers the guard's one query ─────────────────
//
// The guard asks exactly one thing of the database: how many OTHER rows are
// role='admin', is_active=true and not deleted. This mirrors that filter chain
// rather than a generic query engine, so a change to the filter shows up as a
// failing test instead of being silently mimicked.

type Row = { id: string; role: string; is_active: boolean; is_deleted: boolean | null }

function fakeClient(rows: Row[], opts: { failCount?: boolean } = {}): SupabaseClient {
  const builder = {
    _role: '' as string,
    _active: undefined as boolean | undefined,
    _notDeleted: false,
    _exclude: '' as string,
    select() { return this },
    eq(column: string, value: unknown) {
      if (column === 'role') this._role = value as string
      if (column === 'is_active') this._active = value as boolean
      return this
    },
    or() { this._notDeleted = true; return this },
    neq(_column: string, value: unknown) { this._exclude = value as string; return this },
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
  }
  return { from: () => ({ ...builder }) } as unknown as SupabaseClient
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

  for (const action of ACTIONS) {
    test(`${action}: REFUSED when they are the only usable administrator`, async () => {
      const target: AdministratorRow = action === 'permanently_delete'
        ? { role: 'admin', is_active: false, is_deleted: true }
        : { role: 'admin', is_active: action === 'delete' ? false : true, is_deleted: false }
      const rows = action === 'permanently_delete' ? [deletedAdmin(LAST)] : [activeAdmin(LAST)]

      const blocked = await lastAdministratorBlock(fakeClient(rows), target, LAST, action)
      assert.ok(blocked, `${action} must be refused`)
      assert.match(blocked!, /last administrator account/)
    })

    test(`${action}: ALLOWED when a second valid administrator remains`, async () => {
      const target: AdministratorRow = action === 'permanently_delete'
        ? { role: 'admin', is_active: false, is_deleted: true }
        : { role: 'admin', is_active: action === 'delete' ? false : true, is_deleted: false }
      const rows = [
        action === 'permanently_delete' ? deletedAdmin(LAST) : activeAdmin(LAST),
        activeAdmin('second-admin'),
      ]

      assert.equal(await lastAdministratorBlock(fakeClient(rows), target, LAST, action), null)
    })

    test(`${action}: an ordinary employee is never blocked, even with no admins at all`, async () => {
      assert.equal(await lastAdministratorBlock(fakeClient([]), member('m'), 'm', action), null)
    })
  }

  test('a DEACTIVATED second administrator is not a replacement', async () => {
    // The strict reading, and the direction that fails safe: BOE must be left
    // with somebody who can actually work, not somebody who would first have to
    // be reactivated by an administrator who no longer exists.
    const rows = [activeAdmin('last-admin'), inactiveAdmin('benched')]
    const target: AdministratorRow = { role: 'admin', is_active: true, is_deleted: false }
    const blocked = await lastAdministratorBlock(fakeClient(rows), target, 'last-admin', 'deactivate')
    assert.ok(blocked)
    assert.match(blocked!, /reactivate/)
  })

  test('a SOFT-DELETED second administrator is not a replacement either', async () => {
    const rows = [activeAdmin('last-admin'), deletedAdmin('gone')]
    const target: AdministratorRow = { role: 'admin', is_active: true, is_deleted: false }
    assert.ok(await lastAdministratorBlock(fakeClient(rows), target, 'last-admin', 'demote'))
  })
})

// ── 4. THE CHAIN that the demotion-only guard left open ─────────────────────

describe('the deactivate → soft-delete lockout chain', () => {
  test('step one is refused: the final administrator cannot be deactivated', async () => {
    const rows = [activeAdmin('solo')]
    const blocked = await lastAdministratorBlock(
      fakeClient(rows), { role: 'admin', is_active: true, is_deleted: false }, 'solo', 'deactivate',
    )
    assert.ok(blocked, 'deactivating the last administrator must be refused')
  })

  test('and step two is refused independently, for a row that is already inactive', async () => {
    // Belt and braces: even if an inactive administrator exists from before the
    // guard, or from a direct database edit, soft-deleting them is refused
    // while nobody else can administer.
    const rows = [inactiveAdmin('solo')]
    const blocked = await lastAdministratorBlock(
      fakeClient(rows), { role: 'admin', is_active: false, is_deleted: false }, 'solo', 'delete',
    )
    assert.ok(blocked, 'soft-deleting the last administrator must be refused even when inactive')
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
    test(`${path} calls the shared guard with '${action}'`, () => {
      const src = read(path)
      assert.ok(src.includes("from '@/lib/users/lastAdministrator'"), 'imports the shared rule')
      assert.ok(src.includes(`'${action}')`), `passes the ${action} action`)
      assert.ok(src.includes('if (blocked) return NextResponse.json({ error: blocked }, { status: 400 })'),
        'returns the block as a 400 rather than continuing')
    })

    test(`${path} selects the columns the rule reads`, () => {
      // A guard handed a row without `role` would silently never fire.
      const src = read(path)
      assert.ok(/select\('(id, )?role, is_active, is_deleted'\)/.test(src),
        'the target read must include role, is_active and is_deleted')
    })
  }

  test('no route re-implements the count inline', () => {
    // The original defect was a bespoke count in one route. One rule, one file.
    for (const [path] of ROUTES) {
      const src = read(path)
      assert.equal(src.includes(".eq('role', 'admin')"), false, `${path} must not count admins itself`)
    }
  })

  test('the guard runs BEFORE the row is changed', () => {
    for (const [path] of ROUTES) {
      const src = read(path)
      const guardAt = src.indexOf('lastAdministratorBlock(')
      const writeAt = Math.min(
        ...['\n    .update(', '\n    .delete(', 'auth.admin.deleteUser']
          .map(marker => { const i = src.indexOf(marker); return i === -1 ? Number.MAX_SAFE_INTEGER : i }),
      )
      assert.ok(guardAt > -1 && guardAt < writeAt, `${path}: the guard must precede the write`)
    }
  })
})
