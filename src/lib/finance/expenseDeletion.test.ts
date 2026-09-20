/**
 * SAFE DELETION — the rules, and the migration that enforces them.
 *
 * Two halves, deliberately in one file so they cannot disagree:
 *
 *   1. The pure rules the screens use — who may delete, what the typed word is,
 *      what the write contains, what a deleted expense is excluded from.
 *   2. Source assertions over 20261222000000, because the database is what
 *      actually decides and a browser rule that the database does not share is
 *      decoration.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expenseTotal, type ExpenseRow } from './expenses'
import {
  EXPENSE_DELETE_CONFIRMATION,
  EXPENSE_DELETE_EXPLANATION,
  EXPENSE_DELETE_PROMPT,
  EXPENSE_DELETE_RETENTION_NOTE,
  expenseDeleteConfirmationMatches,
  expenseDeleteConfirmationProblem,
  expenseSoftDeletePayload,
  isExpenseDeleted,
  liveExpenses,
  mayDeleteExpense,
  mayEditExpense,
} from './expenseDeletion'

/** A migration, with its line endings normalized — see expenseDrafts.test.ts. */
const readSql = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = readSql('supabase/migrations/20261222000000_expense_lifecycle.sql')
const PHASE_ONE = readSql('supabase/migrations/20261220000000_finance_expenses.sql')

const ROW: ExpenseRow = {
  id: 'exp-1', expense_date: '2026-09-18', amount: '850.50', payment_mode: 'upi',
  paid_to: 'Sharma Ji', category_id: 'cat-1', remark: 'welding machine',
  created_by: 'author', created_at: '2026-09-18T10:00:00Z',
  updated_at: '2026-09-18T10:00:00Z', updated_by: null,
  deleted_at: null, deleted_by: null,
}
const DEAD: ExpenseRow = { ...ROW, deleted_at: '2026-09-19T08:00:00Z', deleted_by: 'author' }

// ── The tombstone ────────────────────────────────────────────────────────────

describe('a deleted expense is tombstoned, never destroyed', () => {
  test('the two columns are what "deleted" means', () => {
    assert.equal(isExpenseDeleted(ROW), false)
    assert.equal(isExpenseDeleted(DEAD), true)
    assert.equal(isExpenseDeleted(null), false)
  })

  test('EVERY ORIGINAL FACT SURVIVES — that is the entire point of the row', () => {
    for (const key of [
      'expense_date', 'amount', 'payment_mode', 'paid_to',
      'category_id', 'remark', 'created_by', 'created_at',
    ] as const) {
      assert.deepEqual(DEAD[key], ROW[key], `${key} must not be cleared by a deletion`)
    }
  })

  test('the write sets the tombstone and NOTHING ELSE', () => {
    const payload = expenseSoftDeletePayload('me')
    assert.deepEqual(Object.keys(payload).sort(), ['deleted_by', 'updated_by'])
    assert.equal(payload.deleted_by, 'me')
    // The correction policies' WITH CHECK requires updated_by to be the caller
    // on every UPDATE, and deleting is a kind of writing.
    assert.equal(payload.updated_by, 'me')
    // deleted_at is deliberately ABSENT: the database stamps it from the server
    // clock, so a phone's clock can never backdate a removal.
    assert.equal('deleted_at' in payload, false)
    assert.equal('amount' in payload, false)
  })
})

// ── Exclusion ────────────────────────────────────────────────────────────────

describe('a deleted expense is excluded from everything a person sees', () => {
  test('from the list', () => {
    assert.deepEqual(liveExpenses([ROW, DEAD]).map(r => r.id), ['exp-1'])
    assert.deepEqual(liveExpenses([DEAD]), [])
  })

  test('AND FROM THE TOTAL, computed rather than asserted', () => {
    assert.equal(expenseTotal([ROW, ROW]), '1701.00')
    assert.equal(expenseTotal([ROW, { ...DEAD, amount: '1000000' }]), '850.50',
      'a million rupees of deleted expense contributes nothing')
    assert.equal(expenseTotal([DEAD]), '0')
  })

  test('a row with no tombstone field at all is live', () => {
    // Several callers pass a bare { amount }. They are live expenses.
    assert.equal(expenseTotal([{ amount: '100' }, { amount: '5' }]), '105')
  })
})

// ── Who may delete ───────────────────────────────────────────────────────────

describe('only somebody allowed to manage the expense may delete it', () => {
  const author = { userId: 'author', canManageFinance: false }
  const stranger = { userId: 'someone-else', canManageFinance: false }
  const manager = { userId: 'someone-else', canManageFinance: true }
  const anonymous = { userId: null, canManageFinance: false }

  test('its author may', () => {
    assert.equal(mayDeleteExpense(ROW, author), true)
  })

  test('a holder of the protected finance.manage may', () => {
    assert.equal(mayDeleteExpense(ROW, manager), true)
  })

  test('SOMEBODY ELSE MAY NOT — no new action key, no widening', () => {
    assert.equal(mayDeleteExpense(ROW, stranger), false)
    assert.equal(mayDeleteExpense(ROW, anonymous), false)
  })

  test('IT IS EXACTLY THE SET WHO MAY ALREADY CORRECT IT', () => {
    // Removing a financial fact and rewriting one are the same authority. If
    // these two ever diverge, somebody who may silently change an amount to ₹1
    // may not withdraw it, which is absurd.
    for (const actor of [author, stranger, manager, anonymous]) {
      assert.equal(mayDeleteExpense(ROW, actor), mayEditExpense(ROW, actor))
    }
  })
})

describe('A DELETED EXPENSE IS NOT EDITABLE, BY ANYBODY', () => {
  test('not by its author, not by a manager', () => {
    assert.equal(mayEditExpense(DEAD, { userId: 'author', canManageFinance: false }), false)
    assert.equal(mayEditExpense(DEAD, { userId: 'x', canManageFinance: true }), false)
  })

  test('and it cannot be deleted a second time', () => {
    assert.equal(mayDeleteExpense(DEAD, { userId: 'author', canManageFinance: true }), false)
  })
})

// ── The typed confirmation ───────────────────────────────────────────────────

describe('the typed DELETE confirmation', () => {
  test('the word is DELETE, in capitals', () => {
    assert.equal(EXPENSE_DELETE_CONFIRMATION, 'DELETE')
    assert.equal(EXPENSE_DELETE_PROMPT, 'Type DELETE to confirm')
  })

  test('it matches only the exact word', () => {
    assert.equal(expenseDeleteConfirmationMatches('DELETE'), true)
    assert.equal(expenseDeleteConfirmationMatches('  DELETE  '), true,
      'a trailing space from a phone keyboard is not a different answer')
  })

  test('CASE IS NOT FORGIVEN — that is the half-attention this gate catches', () => {
    assert.equal(expenseDeleteConfirmationMatches('delete'), false)
    assert.equal(expenseDeleteConfirmationMatches('Delete'), false)
  })

  test('and neither is anything else', () => {
    assert.equal(expenseDeleteConfirmationMatches(''), false)
    assert.equal(expenseDeleteConfirmationMatches('DELETE IT'), false)
    assert.equal(expenseDeleteConfirmationMatches('DEL'), false)
    assert.equal(expenseDeleteConfirmationMatches(null), false)
    assert.equal(expenseDeleteConfirmationMatches(undefined), false)
    assert.equal(expenseDeleteConfirmationMatches(42), false)
  })

  test('AN EMPTY BOX IS NOT A MISTAKE — nothing is said until something is typed', () => {
    assert.equal(expenseDeleteConfirmationProblem(''), null)
    assert.equal(expenseDeleteConfirmationProblem('   '), null)
    assert.equal(expenseDeleteConfirmationProblem('DELETE'), null)
    assert.equal(expenseDeleteConfirmationProblem('delete'), 'Type DELETE exactly, in capitals.')
  })
})

describe('what the dialog promises', () => {
  test('it says the expense stops counting', () => {
    assert.ok(EXPENSE_DELETE_EXPLANATION.includes('removed from the normal expense records'))
    assert.ok(/totals/.test(EXPENSE_DELETE_EXPLANATION))
  })

  test('IT NEVER CLAIMS THE ROW IS DESTROYED, because it is not', () => {
    assert.equal(/permanent|forever|cannot be recovered/i.test(EXPENSE_DELETE_EXPLANATION), false)
    assert.ok(EXPENSE_DELETE_RETENTION_NOTE.includes('kept in the database'))
    assert.ok(/your name and the time/.test(EXPENSE_DELETE_RETENTION_NOTE))
  })

  test('and it does not say "soft delete", which means nothing to a reader', () => {
    assert.equal(/soft.?delet|tombstone/i.test(
      EXPENSE_DELETE_EXPLANATION + EXPENSE_DELETE_RETENTION_NOTE), false)
  })
})

// ── The database ─────────────────────────────────────────────────────────────

describe('THE MIGRATION IS WHAT ACTUALLY DECIDES', () => {
  test('the tombstone columns are added, nullable, and paired', () => {
    assert.ok(MIGRATION.includes('add column if not exists deleted_at timestamptz'))
    assert.ok(MIGRATION.includes('add column if not exists deleted_by uuid references public.users(id)'))
    assert.ok(MIGRATION.includes('(deleted_at is null) = (deleted_by is null)'),
      'an expense cannot vanish with nobody accountable, nor name a deleter while still counting')
  })

  test('NO DELETE POLICY IS ADDED — in this migration or in Phase 1', () => {
    for (const [name, sql] of [['phase 2', MIGRATION], ['phase 1', PHASE_ONE]] as const) {
      assert.equal(/create policy[\s\S]{0,200}?for delete/i.test(sql), false,
        `${name} must not create a DELETE policy`)
    }
  })

  test('and the DELETE privilege is revoked from every client role', () => {
    assert.ok(MIGRATION.includes('revoke delete on public.expenses from anon, authenticated'))
    assert.ok(MIGRATION.includes('revoke delete on public.expense_drafts from anon, authenticated'))
    assert.ok(MIGRATION.includes('revoke delete on public.expense_categories from anon, authenticated'))
    // service_role keeps it: a future supervised recovery must not have to
    // re-grant privileges in a hurry.
    assert.equal(/revoke delete[^\n]*service_role/.test(MIGRATION), false)
  })

  test('NO NEW UPDATE POLICY — deletion travels on the two Phase 1 policies', () => {
    // The authority to delete IS the authority to correct. Expressed by using
    // the same two policies rather than by adding two more that would have to
    // be kept in step forever, and asserted inside the migration itself.
    assert.ok(MIGRATION.includes("and cmd = 'UPDATE' and permissive = 'PERMISSIVE'"))
    assert.ok(MIGRATION.includes('expected exactly the 2 Phase 1 UPDATE policies on expenses'))
    assert.equal(/create policy expenses_[a-z_]*update/.test(MIGRATION), false,
      'phase 2 creates no UPDATE policy on public.expenses')
  })

  test('a tombstoned row is frozen for EVERY caller, the service role included', () => {
    assert.ok(MIGRATION.includes('create or replace function public.expenses_guard_removal()'))
    assert.ok(MIGRATION.includes('This expense has been deleted and can no longer be changed'))
    // A trigger binds the service role; RLS does not.
    assert.ok(MIGRATION.includes('before update on public.expenses\n  for each row execute function public.expenses_guard_removal()')
      || MIGRATION.includes('execute function public.expenses_guard_removal()'))
  })

  test('UN-DELETING IS NOT AN UPDATE — recovery is a later, supervised act', () => {
    // Rule 1 of the guard fires on ANY update to a row whose deleted_at is set,
    // which includes one that would clear it.
    assert.ok(/if old\.deleted_at is not null then[\s\S]{0,200}raise exception/.test(MIGRATION))
  })

  test('a removal names its author and takes the SERVER clock', () => {
    assert.ok(MIGRATION.includes('A deleted expense must name the person who deleted it'))
    assert.ok(MIGRATION.includes('new.deleted_at := now()'))
  })

  test('deleted_by IS THE SIGNAL AND deleted_at IS THE CONSEQUENCE', () => {
    // The browser sets ONE column, and the database decides the moment. An
    // earlier version required both and the database suite caught it at once:
    // the client set deleted_by alone — correctly, it has no business inventing
    // the moment — and the trigger refused the write. A rule that demands a
    // value it then overwrites is a trap for whoever writes the next caller.
    assert.deepEqual(Object.keys(expenseSoftDeletePayload('me')).sort(),
      ['deleted_by', 'updated_by'])
    assert.ok(MIGRATION.includes('if new.deleted_by is not null then'),
      'the trigger branches on deleted_by, not on deleted_at')
    assert.ok(MIGRATION.includes('deleted_by IS THE SIGNAL, AND deleted_at IS THE CONSEQUENCE'),
      'and says so where the next reader will look')
  })

  test('an expense cannot be edited and deleted in one step', () => {
    assert.ok(MIGRATION.includes('An expense cannot be edited and deleted in the same step'))
    for (const column of ['expense_date', 'amount', 'payment_mode', 'paid_to', 'category_id', 'remark']) {
      assert.ok(MIGRATION.includes(`new.${column} is distinct from old.${column}`),
        `${column} must be frozen on the way out`)
    }
  })

  test('THE MIGRATION ITSELF ASSERTS IT DELETED NOTHING', () => {
    assert.ok(MIGRATION.includes('this migration must delete nothing'))
    assert.ok(MIGRATION.includes('are not live after this migration'))
  })

  test('it touches no other business table', () => {
    // Compared against the SQL WITH ITS COMMENTS STRIPPED, so the header's
    // explanation of what this does not touch cannot be mistaken for a
    // statement that touches it.
    const sql = MIGRATION
      .split('\n').filter(line => !/^\s*--/.test(line)).join('\n')

    for (const table of [
      'finance_payment_requests', 'finance_payment_allocations',
      'payment_proof_attachments', 'order_submissions', 'orders',
    ]) {
      assert.equal(new RegExp(`\\b${table}\\b`).test(sql), false,
        `${table} must not be named in any statement`)
    }
    // ALTER TABLE reaches exactly two tables: public.expenses, to add the
    // tombstone, and public.expense_drafts, which this migration creates.
    const alters = [...sql.matchAll(/alter table (public\.\w+)\s*([\s\S]*?);/g)]
    for (const [, table, body] of alters) {
      assert.ok(['public.expenses', 'public.expense_drafts'].includes(table),
        `${table} must not be altered`)
      if (table !== 'public.expenses') continue
      assert.ok(/add column if not exists|add constraint|validate constraint/.test(body),
        'the only thing done to public.expenses is adding the tombstone and its CHECK')
    }
    assert.equal(/\bdrop table\b|\btruncate\b/i.test(sql), false)
    assert.equal(/\bdelete from\b/i.test(sql), false)
    assert.equal(/\bupdate public\.(expenses|expense_categories)\b/i.test(sql), false,
      'no DML against an existing table outside the finalize door')
    // public.users is REFERENCED by two foreign keys and never written.
    assert.equal(/\b(insert into|update)\s+public\.users\b/i.test(sql), false)
  })
})
