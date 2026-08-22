/**
 * WHAT AN AMENDMENT MAY NEVER TOUCH.
 *
 * Every editor added on this branch is a SECURITY DEFINER function, so it runs
 * as the table owner and RLS does not stand between it and any row. The only
 * thing keeping an amendment away from an Order number, a PI linkage or a
 * payment allocation is the text of the function itself.
 *
 * So the text is what this file reads. One rule, applied to every editor at
 * once, so a section added later is covered the moment it is written rather
 * than when somebody remembers to extend a test.
 *
 * Run:
 *   npx tsx --test src/lib/orders/amendmentContinuity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'supabase/migrations')

/** Every editing/amendment function this branch installs. */
const EDITORS = [
  { fn: 'set_order_submission_billing_percentage', file: '20260927000000_order_submission_admin_amendment.sql' },
  { fn: 'update_order_submission_client_details',  file: '20260928000000_order_submission_client_details_edit.sql' },
  { fn: 'update_order_submission_schedule_terms',  file: '20260929000000_order_submission_schedule_terms_edit.sql' },
  { fn: 'request_order_submission_correction',     file: '20260930000000_order_submission_correction_requests.sql' },
  { fn: 'resolve_order_submission_correction',     file: '20260930000000_order_submission_correction_requests.sql' },
]

function bodyOf(file: string, fn: string): string {
  const text = readFileSync(join(DIR, file), 'utf8')
  const code = text.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
  const at = code.indexOf(`function public.${fn}`)
  assert.ok(at > 0, `${fn} not found in ${file}`)
  const rest = code.slice(at)
  return rest.slice(0, rest.indexOf('$$;') + 3)
}

/** The statements one function issues against a given table. */
function statementsAgainst(body: string, table: string): string[] {
  const out: string[] = []
  for (const verb of ['update', 'delete from', 'insert into']) {
    const re = new RegExp(`${verb}\\s+${table.replace('.', '\\.')}\\b`, 'gi')
    for (const m of body.matchAll(re)) {
      const end = body.indexOf(';', m.index!)
      out.push(body.slice(m.index!, end === -1 ? body.length : end))
    }
  }
  return out
}

/**
 * The SET list of an UPDATE — what it ASSIGNS, not what it selects by.
 *
 * `update public.orders ... where id = v_sub.order_id` names `id`, and a scan
 * of the whole statement reads that WHERE clause as an assignment. Every
 * amendment identifies its Order by id; none of them assigns one, and only the
 * second is a problem.
 */
function assignmentsOf(stmt: string): string {
  const setAt = stmt.search(/\bset\b/i)
  if (setAt === -1) return stmt
  const whereAt = stmt.search(/\bwhere\b/i)
  return whereAt > setAt ? stmt.slice(setAt, whereAt) : stmt.slice(setAt)
}

// ══ 1. The Order's identity ══════════════════════════════════════════════════

describe('no editor may touch the Order\'s identity', () => {
  /**
   * Columns whose change would break the Order's continuity with everything
   * attached to it. An amendment corrects DATA; it never re-identifies the
   * record the data belongs to.
   */
  const FORBIDDEN_ORDER_COLUMNS = [
    'id',
    'display_number',              // the confirmed Order number — permanent
    'source_order_submission_id',  // the PI linkage — immutable once set
    'source_order_request_id',
    'source_request_number',
    'status',
    'created_by',
    'requested_by',
    'created_at',
    'is_test_data',
    'total_value',
    'total_product_value',
  ]

  for (const { fn, file } of EDITORS) {
    test(`${fn} writes none of them`, () => {
      const body = bodyOf(file, fn)
      for (const stmt of statementsAgainst(body, 'public.orders')) {
        const sets = assignmentsOf(stmt)
        for (const col of FORBIDDEN_ORDER_COLUMNS) {
          assert.ok(!new RegExp(`\\b${col}\\s*=`).test(sets),
            `${fn} assigns orders.${col}:\n${sets.trim().slice(0, 160)}`)
        }
      }
    })
  }

  test('the list is not empty, so these tests are not vacuous', () => {
    assert.ok(FORBIDDEN_ORDER_COLUMNS.length > 8)
    assert.ok(EDITORS.length >= 5)
  })
})

// ══ 2. Money that already moved ══════════════════════════════════════════════

describe('no editor may touch a payment or an allocation', () => {
  const MONEY_TABLES = [
    'public.finance_payment_allocations',
    'public.finance_payment_requests',
  ]

  for (const { fn, file } of EDITORS) {
    test(`${fn} does not write to either ledger table`, () => {
      const body = bodyOf(file, fn)
      for (const table of MONEY_TABLES) {
        assert.deepEqual(statementsAgainst(body, table), [],
          `${fn} writes ${table}`)
      }
    })
  }

  for (const { fn, file } of EDITORS) {
    test(`${fn} does not even name an allocation identifier`, () => {
      // Reading one would be the first step to changing one, and no editor has
      // any business doing either.
      const body = bodyOf(file, fn)
      for (const token of ['allocation_id', 'allocated_amount', 'payment_id']) {
        assert.ok(!body.includes(token), `${fn} names ${token}`)
      }
    })
  }
})

// ══ 3. The document register ═════════════════════════════════════════════════

describe('no editor may reach into the document register directly', () => {
  for (const { fn, file } of EDITORS) {
    test(`${fn} changes documents only through supersede_order_documents`, () => {
      const body = bodyOf(file, fn)
      const direct = statementsAgainst(body, 'public.order_document_versions')
      assert.deepEqual(direct, [],
        `${fn} writes the register directly; supersession is the only door`)
    })
  }

  test('and that door never deletes or rewrites a generated file', () => {
    const body = bodyOf('20260927000000_order_submission_admin_amendment.sql',
                        'supersede_order_documents')
    assert.ok(!/delete\s+from/i.test(body))
    assert.ok(!body.includes('excel_path ='))
    assert.ok(!body.includes('pdf_path ='))
    assert.ok(!body.includes("status = 'failed'"))
    // A ready version stays ready and stays downloadable; only its CURRENCY
    // changes. That is what keeps history accessible.
    assert.match(body, /set superseded_at\s+= now\(\)/)
  })

  test('and a claim token is never named by an editor', () => {
    for (const { fn, file } of EDITORS) {
      assert.ok(!bodyOf(file, fn).includes('claim_token'), `${fn} names claim_token`)
    }
  })
})

// ══ 4. Authority and audit, held to one shape ════════════════════════════════

describe('every editor keeps the same shape', () => {
  const WRITERS = EDITORS.filter(e => e.fn.startsWith('update_') || e.fn.startsWith('set_'))

  for (const { fn, file } of WRITERS) {
    test(`${fn} locks the row before judging anything`, () => {
      const body = bodyOf(file, fn)
      const lock = body.indexOf('for update')
      const auth = body.indexOf('can_admin_edit_order_submission')
      assert.ok(lock > 0, `${fn} takes no row lock`)
      assert.ok(lock < auth, `${fn} judges authority before locking`)
    })

    test(`${fn} accepts either authority and refuses when neither holds`, () => {
      const body = bodyOf(file, fn)
      assert.match(body, /v_is_admin or v_is_owner/)
      assert.match(body, /NOT_EDITABLE/)
    })

    test(`${fn} requires a reason for an admin edit after submission`, () => {
      assert.match(bodyOf(file, fn), /REASON_REQUIRED/)
    })

    test(`${fn} writes its activity in the SAME transaction as the change`, () => {
      // No queue, no trigger that could be disabled, no second call that could
      // fail on its own and leave a change unexplained.
      const body = bodyOf(file, fn)
      assert.match(body, /log_order_submission_activity/)
      assert.ok(!/\bcommit\b|autonomous/i.test(body))
    })
  }

  for (const { fn, file } of WRITERS.filter(e => e.fn.startsWith('update_'))) {
    test(`${fn} uses the row_version counter, never a timestamp`, () => {
      const body = bodyOf(file, fn)
      assert.match(body, /row_version is distinct from p_expected_version/)
      assert.ok(!/updated_at is distinct from p_expected/.test(body),
        'a timestamp is not a version: now() is transaction-scoped')
    })
  }
})

// ══ 5. Every editor is SECURITY DEFINER with a fixed search path ═════════════

describe('the privilege shape', () => {
  for (const { fn, file } of EDITORS) {
    test(`${fn} is DEFINER with a fixed search_path, revoked from public and anon`, () => {
      const body = bodyOf(file, fn)
      assert.match(body, /security definer/)
      assert.match(body, /set search_path = public, pg_temp/)
      const text = readFileSync(join(DIR, file), 'utf8')
      assert.ok(new RegExp(`revoke all\\s+on function public\\.${fn}\\(`).test(text)
             || new RegExp(`revoke execute on function public\\.${fn}\\(`).test(text),
        `${fn} is not revoked from public/anon`)
    })
  }
})
