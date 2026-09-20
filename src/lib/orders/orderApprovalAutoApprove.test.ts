/**
 * 20261224000000 — auto-approval on self-submit, as the DATABASE states it.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The migration re-emits submit_pi_for_review_internal in full in order to add
 * one block to it. Re-emitting a 380-line function is how a business rule gets
 * silently reverted, so the first suite below re-extracts the applied copy from
 * 20261119000000, applies the three documented edits, and asserts the result is
 * the new copy CHARACTER FOR CHARACTER. Anything else that moved — a lost
 * validation, a changed threshold, a dropped lock — fails here and says where.
 *
 * The remaining suites state the rules of the added block itself, and the rules
 * it must NOT have reached: the Order gate, the advance-exception decision, and
 * the preview/import path.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderApprovalAutoApprove.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase/migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const APPLIED = '20261119000000_order_submission_pi_review_gate_versions_and_production.sql'
const FILE = '20261224000000_order_submission_approval_permanent_grant_and_auto_approval.sql'

const applied = migration(APPLIED)
const sql = migration(FILE)
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** One function, from its header to its closing dollar tag. */
function fnText(source: string, name: string, file: string): string {
  const start = source.indexOf(`create or replace function public.${name}(`)
  assert.ok(start >= 0, `public.${name} is not defined in ${file}`)
  const end = source.indexOf('\n$$;', start)
  assert.ok(end > start, `public.${name} has no closing dollar tag in ${file}`)
  return source.slice(start, end + '\n$$;'.length)
}

const previous = fnText(applied, 'submit_pi_for_review_internal', APPLIED)
const current = fnText(sql, 'submit_pi_for_review_internal', FILE)
const currentCode = current.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// ── 1. The re-emission changed only what it said it changed ─────────────────

describe('the re-emitted submit door differs only in the three documented places', () => {
  /**
   * The three added spans, located in the NEW copy rather than described by
   * hand — a literal typed here could drift from the file and would then prove
   * nothing. Removing all three must leave the applied copy exactly.
   */
  function addedSpans(): string[] {
    const locals = current.slice(
      current.indexOf('  -- ── Added by 20261224000000'),
      current.indexOf('\nbegin\n') + 1)

    const blockStart = current.indexOf('  -- ══ AUTO-APPROVAL')
    const block = current.slice(blockStart, current.indexOf('  return jsonb_build_object(', blockStart))

    const keysStart = current.indexOf("'exception_requested', v_requested")
      + "'exception_requested', v_requested".length
    const keys = current.slice(keysStart, current.indexOf('\n  );\nend;', keysStart))

    for (const [name, span] of [['locals', locals], ['block', block], ['keys', keys]] as const) {
      assert.ok(span.length > 0, `the ${name} span was not found in the new copy`)
    }
    return [locals, block, keys]
  }

  test('removing the three documented additions leaves the applied copy exactly', () => {
    let stripped = current
    for (const span of addedSpans()) {
      assert.ok(stripped.includes(span))
      stripped = stripped.replace(span, '')
    }
    assert.equal(stripped, previous,
      'the re-emitted function differs from the applied one somewhere other than the three documented additions')
  })

  test('the three additions are additions — nothing was removed to make room', () => {
    const [locals, block, keys] = addedSpans()
    assert.equal(current.length, previous.length + locals.length + block.length + keys.length)
  })

  test('nothing the applied copy refused is missing from this one', () => {
    for (const refusal of [
      'ORDER_SUBMISSION_BLOCKED',
      'ORDER_SUBMISSION_INCOMPLETE',
      'ORDER_SUBMISSION_BAD_WORKBOOK_PATH',
      'ORDER_SUBMISSION_WORKBOOK_NOT_STORED',
      'ORDER_SUBMISSION_WORKBOOK_NOT_XLSX',
      'ORDER_SUBMISSION_BAD_IMAGE_PATH',
      'ORDER_SUBMISSION_IMAGE_NOT_STORED',
      'ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED',
      'ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED',
      'ORDER_SUBMISSION_ADVANCE_NOT_OWNER',
      'ORDER_SUBMISSION_NOTE_TOO_LONG',
      'ORDER_SUBMISSION_TERMS_TOO_LONG',
      'ORDER_SUBMISSION_ADVANCE_TOTAL_MISSING',
    ]) {
      assert.ok(current.includes(refusal), `${refusal} was lost in the re-emission`)
      assert.equal(
        [...current.matchAll(new RegExp(refusal, 'g'))].length,
        [...previous.matchAll(new RegExp(refusal, 'g'))].length,
        `${refusal} appears a different number of times`)
    }
  })

  test('submitting still requires orders.create, and that check is unchanged', () => {
    assert.ok(currentCode.includes("if not public.actor_has_module_permission('orders', 'create') then"))
    assert.ok(currentCode.includes('You do not have permission to submit an order submission'))
  })

  test('the public door is not re-emitted, so there is one implementation', () => {
    assert.ok(!code.includes('create or replace function public.submit_pi_for_review('),
      'the door is one line over the internal and must stay that way')
    // approve_pi_review IS re-emitted, by §4, for its authorization line and
    // nothing else — orderApprovalAuthority.test.ts is what proves that.
  })
})

// ── 2. What the added block does ────────────────────────────────────────────

describe('auto-approval', () => {
  const block = current.slice(current.indexOf('  -- ══ AUTO-APPROVAL'))

  test('the permission is resolved by the engine at the moment of the call', () => {
    // THE PERMISSION-ONLY DOOR, the same one the reviewer's Approve button
    // goes through (§4). Not actor_has_module_permission: its admin branch
    // would auto-approve every administrator's own uploads and no withdrawal
    // in the Control Centre could stop it.
    assert.ok(block.includes('public.actor_can_approve_order()'))
    assert.ok(!block.includes('actor_has_module_permission'),
      'the admin-branching helper must not decide auto-approval')
    // Not a role name, not a stored column, not anything the caller sent.
    assert.ok(!/role\s*=\s*'admin'/.test(block), 'a role name is not the permission')
    assert.ok(!/actor_can_approve_order\([^)]/.test(block),
      'the authority takes no argument, so nothing the caller sent can reach it')
    // p_submission_id is the only parameter the block may name, and only ever
    // as the row it acts on.
    const params = [...block.matchAll(/\bp_[a-z_]+/g)].map(m => m[0])
    assert.deepEqual([...new Set(params)], ['p_submission_id'])
  })

  test('the approver is the authenticated actor and nobody else', () => {
    assert.ok(block.includes('pi_approved_by            = v_actor'))
    // v_actor is assert_order_submission_actor(), resolved at the top of the
    // function from auth.uid() — the same value the 'submitted' event carries.
    assert.ok(current.includes('v_actor      uuid := public.assert_order_submission_actor();'))
  })

  test('it runs LAST, after every validation and after the submitted event', () => {
    const blocked = current.indexOf('ORDER_SUBMISSION_BLOCKED')
    const images = current.indexOf('ORDER_SUBMISSION_IMAGE_NOT_STORED')
    const submittedEvent = current.indexOf("'submitted', v_sub.status, 'submitted', v_note")
    const auto = current.indexOf('  -- ══ AUTO-APPROVAL')

    assert.ok(blocked > 0 && blocked < auto, 'blocking issues are judged first')
    assert.ok(images > 0 && images < auto, 'the images are judged first')
    assert.ok(submittedEvent > 0 && submittedEvent < auto, 'the upload is recorded first')
  })

  test('the decision is bound to the submission it was made against', () => {
    // Read back, never assumed: submitted_at is written by the status
    // transition trigger and cannot be supplied by a caller.
    assert.ok(block.includes('select submitted_at into v_submitted_at'))
    assert.ok(block.includes('pi_approved_submission_at = v_submitted_at'))
    assert.ok(!block.includes('pi_approved_submission_at = now()'),
      'a clock reading is not the submission it belongs to')
  })

  test('the stamp is its own statement, because a status move clears it', () => {
    // order_submissions_guard_pi_approval nulls the three columns on any update
    // that moves status, so folding this into the writes above would discard it.
    const writes = current.lastIndexOf("set status = 'submitted'")
    const stamp = current.indexOf('update public.order_submissions\n       set pi_approved_by')
    assert.ok(writes > 0 && stamp > writes, 'the stamp must follow the status write')

    const guard = applied.slice(applied.indexOf('create or replace function public.order_submissions_guard_pi_approval'))
    assert.ok(guard.includes('new.pi_approved_by            := null;'),
      'this test exists because the guard clears the columns on a status move')
  })

  test('both halves of the history are written: who uploaded, and who approved', () => {
    assert.ok(block.includes("'pi_approved', 'submitted', 'submitted'"),
      'the approval is its own event, on the existing closed vocabulary')
    assert.ok(block.includes("'auto_approved',          true"),
      'a reader can tell an automatic decision from a deliberate one')
    assert.ok(block.includes("'submitted_by',           v_actor"))
    // 'pi_approved' is already in the closed action set, so no new event type
    // had to be minted for this.
    assert.ok(applied.includes("    'pi_approved',\n"),
      "'pi_approved' is the applied vocabulary, not a new value")
    assert.ok(!/order_submission_activity_action_check/.test(code),
      'the closed set of events is not extended by this migration')
  })

  test('the result says what happened, additively', () => {
    assert.ok(currentCode.includes("'pi_auto_approved',    v_auto_approved"))
    assert.ok(currentCode.includes("'exception_requested', v_requested"),
      'every key the applied version returned is still returned')
  })
})

// ── 3. What auto-approval deliberately does NOT reach ───────────────────────

describe('the gates auto-approval does not open', () => {
  test('no Order is created, no order number is taken, no status becomes approved', () => {
    const block = current.slice(current.indexOf('  -- ══ AUTO-APPROVAL'))
    assert.ok(!/insert\s+into\s+public\.orders/i.test(block))
    assert.ok(!/reserve_order_number|allocate_confirmed_order_number|display_number/i.test(block))
    assert.ok(!/status\s*=\s*'approved'/.test(block))
    assert.ok(!/order_id\s*=/.test(block))
  })

  test('the advance exception is still somebody else s decision', () => {
    const block = current.slice(current.indexOf('  -- ══ AUTO-APPROVAL'))
    assert.ok(!/advance_exception_status\s*=/.test(block),
      'approving your own PI is not approving your own commercial terms')
    assert.ok(!code.includes('approve_advance_exception'),
      'this migration does not touch the separately-assignable exception authority')
  })

  test('the Order gate keeps every condition it had', () => {
    // The conversion IS re-emitted, by §4, for its authorization line. Every
    // gate it carried must still be in the copy this file ships — asserted
    // against the new text, not merely against the old file.
    const conversion = fnText(sql, 'approve_order_submission', FILE)
    for (const rule of [
      'ORDER_SUBMISSION_FINANCE_NOT_VERIFIED',
      'ORDER_SUBMISSION_NOT_UNDER_REVIEW',
      'ORDER_SUBMISSION_DELETION_CLAIMED',
      'ORDER_CONFIRMATION_SALESPERSON_REQUIRED',
      'ORDER_CONFIRMATION_CONFIRM_DATE_REQUIRED',
      'ORDER_CONFIRMATION_DUE_DATE_REQUIRED',
      'ORDER_CONFIRMATION_LEAD_SOURCE_REQUIRED',
      'ORDER_CONFIRMATION_LEAD_SOURCE_INVALID',
    ]) {
      assert.ok(conversion.includes(rule), `${rule} still gates the Confirmed Order`)
    }
    // Auto-approval reaches none of it: the stamp is in the submit door, and
    // the conversion is a separate, later, explicitly-pressed decision.
    assert.ok(!conversion.includes('auto_approved'))
    // And the migration says so itself, at apply time.
    assert.ok(sql.includes('ORDER GATE: approve_order_submission no longer requires a current finance verification'))
  })

  test('nothing is auto-approved while a PI is merely selected and previewed', () => {
    // The import/preview route creates a draft and never submits, so the door
    // auto-approval lives behind is out of its reach. Asserted against the
    // route itself rather than trusted.
    const importRoute = lf(readFileSync(
      join(ROOT, 'src/app/api/orders/import/process-draft/route.ts'), 'utf8'))
    for (const door of [
      'submit_pi_for_review',
      'approve_pi_review',
      'approve_order_submission',
      'pi_approved',
    ]) {
      assert.ok(!importRoute.includes(door),
        `the preview route must not reach ${door}`)
    }
  })

  test('a normal employee s PI is untouched by any of this', () => {
    const block = current.slice(current.indexOf('  -- ══ AUTO-APPROVAL'))
    // One conditional, and everything the block does is inside it. Without the
    // permission the function ends exactly where it used to: status 'submitted',
    // no PI decision, awaiting review.
    assert.equal([...block.matchAll(/^  if /gm)].length, 1)
    assert.ok(block.includes('if v_can_approve then'))
    assert.ok(current.includes('v_auto_approved boolean := false;'))
  })
})
