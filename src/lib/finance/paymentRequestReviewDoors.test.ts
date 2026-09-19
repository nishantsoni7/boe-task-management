/**
 * THE FINANCE REVIEW MODAL DECIDES THROUGH SERVER-GATED DOORS (20261220000000).
 *
 * The Payment Requests review modal on /finance sent Needs Clarification and
 * Reject as a direct UPDATE of finance_payment_requests. Production refuses
 * every direct client write to that table: the reset write guard
 * (20261010000000) runs as the caller and calls in_test_data_cleanup() and
 * open_order_finance_reset_scope(), which authenticated may not execute. So both
 * actions failed with "permission denied for function in_test_data_cleanup".
 *
 * The fix routes Reject through reject_finance_payment_request (20261211000000)
 * and Needs Clarification through a new twin, request_finance_payment_clarification,
 * and leaves the guard — and every client table privilege — exactly as it was.
 *
 * These tests pin the shape. The behaviour is EXECUTED on a disposable database
 * by supabase/tests/run_payment_request_review_suite.sh, which reproduces the
 * defect first.
 *
 * Run:
 *   npx tsx --test src/lib/finance/paymentRequestReviewDoors.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const FILE = '20261220000000_finance_payment_request_clarification_door.sql'
const read = (...p: string[]) => readFileSync(join(...p), 'utf8').replace(/\r\n/g, '\n')
const sql = read('supabase', 'migrations', FILE)
const code = sql.replace(/--[^\n]*/g, '')

const page = read('src', 'app', 'finance', 'page.tsx')
const modal = (() => {
  const from = page.indexOf('function AdminReviewModal(')
  const to   = page.indexOf('// ── Delete confirm modal (admin only)')
  assert.ok(from > -1 && to > from, 'the review modal could not be located')
  return page.slice(from, to)
})()
const modalCode = modal.split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

describe('20261220000000 — one new door, nothing widened', () => {
  test('forward-only, unique version, after 20261218000000', () => {
    const files = readdirSync(join('supabase', 'migrations')).filter(f => /^\d{14}_/.test(f)).sort()
    const i = files.indexOf(FILE)
    assert.ok(i > 0)
    assert.equal(files.filter(f => f.startsWith(FILE.slice(0, 14))).length, 1)
    assert.ok(files[i - 1] >= '20261218000000', `${files[i - 1]} sorts immediately before it`)
  })

  test('it creates exactly one function and touches no table, policy or trigger', () => {
    const fns = [...code.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map(m => m[1])
    assert.deepEqual(fns, ['request_finance_payment_clarification'])
    assert.ok(!/\b(create|alter|drop)\s+(table|policy|trigger|index|view)\b/i.test(code))
    assert.ok(!/\bdrop\s+function\b/i.test(code))
  })

  test('its only grants are EXECUTE on the new function — authenticated yes, anon and public no', () => {
    const grants = [...code.matchAll(/\b(grant|revoke)\b[^;]*;/gi)].map(m => m[0].replace(/\s+/g, ' '))
    assert.deepEqual(grants, [
      'revoke execute on function public.request_finance_payment_clarification(uuid, text) from public, anon;',
      'grant execute on function public.request_finance_payment_clarification(uuid, text) to authenticated;',
    ])
  })

  test('the reset guard is not made SECURITY DEFINER and its helpers are not granted', () => {
    assert.ok(!/order_finance_reset_write_guard/.test(code.replace(/pg_get_functiondef[^;]*;/g, '')),
      'the guard is not re-emitted or altered')
    assert.ok(!/in_test_data_cleanup|open_order_finance_reset_scope/.test(code))
  })

  test('SECURITY DEFINER with a fixed search_path', () => {
    assert.ok(/returns jsonb\s+language plpgsql\s+security definer\s+set search_path = public, pg_temp\s+as \$\$/.test(code))
  })

  test('the same authority as the rejection door, and nothing wider', () => {
    const body = code.slice(code.indexOf('create or replace function'), code.indexOf('comment on function'))
    assert.ok(body.includes("v_actor uuid := auth.uid();"))
    assert.ok(body.includes("public.actor_has_module_permission('finance', 'approve')"))
    for (const wider of ["'view_all'", "'manage'", "'allocate'", "'create'"]) {
      assert.ok(!body.includes(wider), `must not accept ${wider}`)
    }
    assert.ok(body.includes('PAYMENT_SELF_DECISION_FORBIDDEN'))
    assert.ok(body.includes("u.role = 'admin'"), 'admins keep the override, as with rejection')
    assert.ok(body.includes('PAYMENT_CLARIFICATION_NOTE_REQUIRED'))
    assert.ok(body.includes("nullif(btrim(coalesce(p_note, '')), '')"))
    assert.ok(/where id = p_request_id\s+for update;/.test(body), 'the row is locked')
    assert.ok(body.includes("v_req.status <> 'pending_approval'"), 'pending only')
    assert.ok(/set status\s+= 'needs_clarification',\s+admin_note = v_note,/.test(body),
      'status and note land in one statement')
  })

  test('its own apply-time assertions exist', () => {
    for (const needle of ['DEPENDENCY MISSING: 20261211000000',
      'ASSERTION FAILED: request_finance_payment_clarification is not SECURITY DEFINER',
      'ASSERTION FAILED: request_finance_payment_clarification has no fixed search_path',
      'ASSERTION FAILED: clarification is not gated on finance.approve',
      'ASSERTION FAILED: anon can call the clarification RPC']) {
      assert.ok(sql.includes(needle), needle)
    }
  })
})

describe('the review modal writes nothing directly', () => {
  test('no table access at all — the approval, clarification and rejection RPCs only', () => {
    assert.equal((modalCode.match(/\.from\(/g) ?? []).length, 0)
    for (const write of ['.update(', '.insert(', '.upsert(', '.delete(']) {
      assert.ok(!modalCode.includes(write), `the modal must not call ${write}`)
    }
    const rpcs = [...modalCode.matchAll(/\.rpc\('([^']+)'/g)].map(m => m[1]).sort()
    assert.deepEqual(rpcs, [
      'approve_finance_payment_request',
      'reject_finance_payment_request',
      'request_finance_payment_clarification',
    ])
  })

  test('each RPC gets the argument names its SQL signature declares', () => {
    assert.ok(/rpc\('request_finance_payment_clarification', \{\s+p_request_id: r\.id,\s+p_note:\s+adminNote\.trim\(\),\s+\}\)/.test(modalCode))
    assert.ok(/rpc\('reject_finance_payment_request', \{\s+p_request_id: r\.id,\s+p_reason:\s+adminNote\.trim\(\),\s+\}\)/.test(modalCode))
    assert.ok(/request_finance_payment_clarification\(\s+p_request_id uuid,\s+p_note\s+text\s+\)/.test(code))
    const reject = read('supabase', 'migrations', '20261211000000_finance_payment_decisions_belong_to_verifiers.sql')
    assert.ok(/reject_finance_payment_request\(\s+p_request_id uuid,\s+p_reason\s+text\s+\)/.test(reject))
  })

  test('the right RPC for the right decision, and the same notifications', () => {
    assert.ok(/action === 'needs_clarification'\s+\? await supabase\.rpc\('request_finance_payment_clarification'/.test(modalCode))
    assert.ok(modalCode.includes("event: action === 'needs_clarification' ? 'finance_clarification' : 'finance_rejected',"))
    assert.ok(modalCode.includes("const noteRequired = action === 'needs_clarification' || action === 'reject'"))
  })

  test('a refusal is shown as a sentence, never a raw database message for a known refusal', () => {
    assert.ok(modalCode.includes('setError(reviewDecisionErrorMessage(rpcError))'))
    const helper = page.slice(page.indexOf('function reviewDecisionErrorMessage('), page.indexOf('// ── Approval lock'))
    for (const marker of ['PAYMENT_SELF_DECISION_FORBIDDEN', 'PAYMENT_CLARIFICATION_NOTE_REQUIRED',
      'PAYMENT_REJECTION_REASON_REQUIRED', 'Only a pending payment request', 'ORDER_FINANCE_RESET_IN_PROGRESS', "'42501'"]) {
      assert.ok(helper.includes(marker), `${marker} is not mapped`)
    }
  })
})

describe('an executable suite proves it on a disposable database', () => {
  const runner = read('supabase', 'tests', 'run_payment_request_review_suite.sh')
  const before = read('supabase', 'tests', 'payment_request_review_before.sql')
  const after  = read('supabase', 'tests', 'payment_request_review_assertions.sql')
  const shape  = read('supabase', 'tests', '_payment_request_review_extra_schema.sql')

  test('it never talks to a linked project and applies the REAL guard and 20261211000000', () => {
    assert.ok(runner.includes('never talks to a linked project'))
    assert.ok(runner.includes('20261010000000_order_submission_and_finance_test_data_reset.sql'))
    assert.ok(runner.includes('20261211000000_finance_payment_decisions_belong_to_verifiers.sql'))
    assert.ok(runner.includes(FILE))
  })

  test('it mirrors production\'s function privileges before reproducing', () => {
    assert.ok(shape.includes('revoke execute on function public.in_test_data_cleanup() from public, anon, authenticated;'))
    assert.ok(shape.includes('revoke execute on function public.open_order_finance_reset_scope() from public, anon, authenticated;'))
  })

  test('the defect reproduces first, then every assertion passes, then the race', () => {
    assert.ok(before.includes("'42501 permission denied for function in_test_data_cleanup%'"))
    assert.ok(runner.includes('expected 6 REPRODUCED lines'))
    assert.ok(runner.includes('expected 14 PASS lines'))
    assert.equal((after.match(/raise notice 'PASS: /g) ?? []).length, 14)
    assert.ok(runner.includes('Only a pending payment request can be rejected (PR-0006 is needs_clarification)'))
  })

  test('the "not widened" check runs in its own transaction, first', () => {
    const first = after.indexOf('begin;')
    const check = after.indexOf("'42501 permission denied for function in_test_data_cleanup%'")
    const rpc   = after.indexOf('select public.request_finance_payment_clarification(')
    assert.ok(first > -1 && first < check && check < after.indexOf('rollback;') && after.indexOf('rollback;') < rpc)
  })
})
