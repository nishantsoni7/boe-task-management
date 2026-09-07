/**
 * 20261119000000 — the PI decision, the attached-payment submission rule, PI
 * versions and production alignment, as the DATABASE states them.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * The rules live in SQL and a repository test cannot execute SQL. What it can do
 * — and what every schema suite in this repository does — is read the migration
 * and prove the rules are stated, stated once, and stated in the only form that
 * can be true: server-side recalculation under row locks, permissions asked of
 * the engine and never of a role name, and constraints rather than conventions
 * for "exactly one current PI".
 *
 * The executable half is
 * supabase/tests/order_pi_review_gate_and_versions_assertions.sql, which runs
 * against a real database, plus the assertion block at the foot of the
 * migration itself.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piReviewGateSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const lf = (s: string) => s.replace(/\r\n/g, '\n')
const migration = (file: string) => lf(readFileSync(join(MIGRATIONS, file), 'utf8'))

const FILE = '20261119000000_order_submission_pi_review_gate_versions_and_production.sql'
const sql = migration(FILE)
/** Executable SQL only — a comment explains, it does not run. */
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

/** The body of one function in this migration, from its header to its `$$;`. */
function body(name: string): string {
  const start = sql.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, 'i'))
  assert.ok(start > 0, `public.${name} is not defined in ${FILE}`)
  const end = sql.indexOf('\n$$;', start)
  assert.ok(end > start, `public.${name} has no closing dollar tag`)
  return sql.slice(start, end)
}

const codeOf = (name: string) => body(name).split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

// ── Lineage ───────────────────────────────────────────────────────────────────

describe('lineage', () => {
  // NOT "it is the newest migration": later, unrelated migrations are expected
  // and say nothing about this one. What must hold is the order it applies in.
  //
  // This file was written as 20261113000000 and renumbered on integration:
  // main gave 20261113000000 to the Minop webhook table, 20261114000000 is the
  // Review Workflow body-length change, and 20261118000000 is the Finance
  // verification-context fix. It applies after all three.
  test('it follows the applied ledger, in order', () => {
    const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
    const at = files.indexOf(FILE)
    assert.ok(at > 0, `${FILE} is not in supabase/migrations`)
    assert.deepEqual(files.slice(at - 3, at + 1), [
      '20261113000000_create_minop_webhook_deliveries.sql',
      '20261114000000_review_generation_word_range_and_body_length.sql',
      '20261118000000_restore_finance_payment_verification_context.sql',
      FILE,
    ])
  })

  test('it refuses to apply over a missing dependency', () => {
    for (const dep of ['approve_order_submission(uuid)', 'submit_pi_for_review_internal(uuid, text, text, text, text)',
                       'replace_order_submission_parse(uuid, uuid, jsonb)', 'can_view_order(uuid)',
                       'in_order_amendment()', 'in_test_data_cleanup()']) {
      assert.ok(code.includes(`to_regprocedure('public.${dep}')`), dep)
    }
    assert.ok(code.includes('DEPENDENCY MISSING'))
  })

  test('it is additive: no column, table, function or policy is dropped', () => {
    assert.ok(!/drop\s+column/i.test(code))
    assert.ok(!/drop\s+table/i.test(code))
    assert.ok(!/drop\s+function/i.test(code))
    // The only drops are the constraint re-emit and the idempotent
    // drop-if-exists before each trigger and policy this file itself creates.
    for (const m of code.matchAll(/drop\s+(policy|trigger)\s+if\s+exists\s+"?([a-z_]+)"?/gi)) {
      assert.ok(new RegExp(`create\\s+(constraint\\s+)?${m[1]}\\s+"?${m[2]}"?`, 'i').test(code),
        `${m[2]} is dropped and not recreated`)
    }
  })
})

// ── §1 The PI decision ────────────────────────────────────────────────────────

describe('the PI decision is three columns, guarded like the finance check', () => {
  test('the columns, all or none', () => {
    for (const col of ['pi_approved_by', 'pi_approved_at', 'pi_approved_submission_at']) {
      assert.ok(code.includes(`add column if not exists ${col}`), col)
    }
    assert.ok(code.includes('order_submissions_pi_approval_complete'))
  })

  test('the currency predicate mirrors order_submission_finance_verified', () => {
    const fn = codeOf('order_submission_pi_approved')
    assert.ok(fn.includes('p_pi_approved_submission_at = p_submitted_at'))
    assert.ok(fn.includes('immutable'))
  })

  test('recording is permitted only on a submitted PI, bound to its own submitted_at; leaving review clears it', () => {
    const guard = codeOf('order_submissions_guard_pi_approval')
    assert.ok(guard.includes("if new.status = 'approved' then"), 'approval keeps it')
    assert.ok(guard.includes('new.pi_approved_by            := null'), 'every other move clears it')
    assert.ok(guard.includes("if new.status <> 'submitted' or old.status <> 'submitted' then"))
    assert.ok(guard.includes('new.pi_approved_submission_at is distinct from new.submitted_at'))
    assert.ok(code.includes('create trigger order_submissions_guard_pi_approval'))
    assert.ok(code.includes('revoke execute on function public.order_submissions_guard_pi_approval()\n  from public, anon, authenticated, service_role'))
  })
})

// ── §2/§4 Attached payment and the submission rule ────────────────────────────

describe('the submission rule reads ATTACHED payment, server-side', () => {
  test('attached = verified + unverified, in one function executable by no role', () => {
    const fn = codeOf('order_submission_attached_payment')
    assert.ok(fn.includes('public.order_submission_verified_payment(p_submission_id)'))
    assert.ok(fn.includes('+ public.order_submission_unverified_payment(p_submission_id)'))
    assert.ok(code.includes('revoke execute on function public.order_submission_attached_payment(uuid)\n  from public, anon, authenticated, service_role'))
  })

  test('submit_pi_for_review_internal chooses the route on attached payment, under the same locks', () => {
    const fn = codeOf('submit_pi_for_review_internal')
    assert.ok(fn.includes('v_attached   := v_verified + v_unverified'))
    assert.ok(fn.includes("v_route := case when v_attached >= v_required then 'standard' else 'exception' end"))
    assert.ok(!fn.includes("case when v_verified >= v_required then 'standard'"),
      'the old verified-only rule is gone from the submit door')
    // The locks, in the module's order: payments then allocations, both by id.
    const payments = fn.indexOf('from public.finance_payment_requests f')
    const allocations = fn.indexOf('from public.finance_payment_allocations a\n  where a.order_submission_id = p_submission_id\n  order by a.id\n  for update')
    const route = fn.indexOf('v_route := case')
    assert.ok(payments > 0 && payments < allocations && allocations < route, 'locked before judged')
  })

  test('below 40% attached a reason AND payment terms are mandatory, zero included', () => {
    const fn = codeOf('submit_pi_for_review_internal')
    assert.ok(fn.includes('ORDER_SUBMISSION_EXCEPTION_REASON_REQUIRED'))
    assert.ok(fn.includes('ORDER_SUBMISSION_PAYMENT_TERMS_REQUIRED'))
    assert.ok(fn.includes('ORDER_SUBMISSION_ADVANCE_NOT_OWNER'), 'and only the owner may ask')
  })

  test('the reason is stored on the existing exception columns, not a new field', () => {
    const fn = codeOf('submit_pi_for_review_internal')
    assert.ok(fn.includes('advance_exception_reason = v_reason'))
    assert.ok(fn.includes("advance_exception_status = 'pending'"))
    assert.ok(!code.includes('submission_exception_reason'), 'no duplicate reason column')
  })

  test('the trail carries the attached figures the reviewer will read', () => {
    const fn = codeOf('submit_pi_for_review_internal')
    for (const key of ["'attached_payment',   v_attached", "'unverified_payment', v_unverified", "'attached_percent',   v_attached_percent"]) {
      assert.ok(fn.includes(key), key)
    }
  })

  test('the Order gate is NOT moved: the approval still requires verified payment or an approved exception', () => {
    const fn = codeOf('approve_order_submission')
    assert.ok(fn.includes('if v_verified >= v_required then'))
    assert.ok(fn.includes('elsif v_exception_current then'))
    assert.ok(!fn.includes('v_attached >= v_required'), 'attached payment clears no Order gate')
    assert.ok(fn.includes('ORDER_SUBMISSION_PAYMENT_INSUFFICIENT'))
    assert.ok(fn.includes('ORDER_SUBMISSION_PAYMENT_AWAITING_VERIFICATION'))
  })
})

// ── §5 The summary ────────────────────────────────────────────────────────────

describe('pi_submission_payment_summary reports the new figures and keeps the old ones', () => {
  const fn = codeOf('pi_submission_payment_summary')
  test('every earlier key survives', () => {
    for (const key of ['verified_amount', 'unverified_amount', 'verified_percent', 'needed_for_standard',
                       'required_payment', 'meets_standard', 'approval_position', 'pending_balance',
                       'exception_status', 'exception_reason', 'payment_terms', 'payments']) {
      assert.ok(fn.includes(`'${key}'`), key)
    }
  })
  test('and the new ones are computed in numeric, server-side', () => {
    for (const key of ['attached_amount', 'attached_percent', 'attached_meets_standard',
                       'needed_attached_for_submission', 'submission_position', 'order_gate_cleared',
                       'pi_approved', 'pi_approved_at', 'pi_approved_by', 'pi_approved_by_name']) {
      assert.ok(fn.includes(`'${key}'`), key)
    }
    assert.ok(fn.includes('v_attached := v_verified + v_unverif'))
    assert.ok(fn.includes("when v_attached_meets then 'attached_met'"))
    assert.ok(fn.includes("when v_attached > 0   then 'attached_partial'"))
    assert.ok(fn.includes("else 'no_payment'"))
    assert.ok(fn.includes('trunc(v_attached * 100 / v_total, 2)'), 'truncated, never rounded')
  })
  test('still refuses a caller who cannot open the PI', () => {
    assert.ok(fn.includes('not public.can_view_order_submission(p_submission_id)'))
  })
})

// ── §6 approve_pi_review ──────────────────────────────────────────────────────

describe('approve_pi_review approves the document and creates nothing', () => {
  const fn = codeOf('approve_pi_review')
  test('it asks the engine for orders.approve_order', () => {
    assert.ok(fn.includes("public.actor_has_module_permission('orders', 'approve_order')"))
    assert.ok(!/role\s*=\s*'admin'/.test(fn), 'never a role name')
  })
  test('submitted only, finance check current, no blocking issues, no deletion claim', () => {
    assert.ok(fn.includes("if v_sub.status <> 'submitted' then"))
    assert.ok(fn.includes('order_submission_finance_verified('))
    assert.ok(fn.includes('ORDER_SUBMISSION_BLOCKED'))
    assert.ok(fn.includes('ORDER_SUBMISSION_DELETION_CLAIMED'))
    assert.ok(fn.includes('for update'), 'under a row lock')
  })
  test('it writes the three columns and one event, and nothing else', () => {
    assert.ok(fn.includes('pi_approved_submission_at = v_sub.submitted_at'))
    assert.ok(fn.includes("'pi_approved'"))
    assert.ok(!fn.includes('insert into public.orders'), 'no Order')
    assert.ok(!fn.includes('display_number'), 'no number')
    assert.ok(!fn.includes('finance_payment_allocations'), 'no moved money')
    assert.ok(!fn.includes("status      = 'approved'"), 'the PI stays submitted')
  })
  test('it is idempotent against the same submission', () => {
    assert.ok(fn.includes("'already_approved', true"))
  })
  test('and it is a client-callable door', () => {
    assert.ok(code.includes('grant  execute on function public.approve_pi_review(uuid) to authenticated'))
  })
})

// ── §9 approve_order_submission, re-emitted ───────────────────────────────────

describe('approve_order_submission keeps every rule and adds the PI decision and V1', () => {
  const fn = codeOf('approve_order_submission')
  const previous = lf(readFileSync(join(MIGRATIONS, '20260923000000_order_submission_billing_percentage.sql'), 'utf8'))
    .split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  test('every refusal the deployed body raises is still raised', () => {
    const start = previous.indexOf('create or replace function public.approve_order_submission(')
    const prevBody = previous.slice(start, previous.indexOf('\n$$;', start))
    for (const m of prevBody.matchAll(/'(ORDER_[A-Z_]+):/g)) {
      assert.ok(fn.includes(`'${m[1]}:`), `${m[1]} was dropped from the re-emit`)
    }
  })

  test('the PI decision is stamped after the finance check and before the payment gate', () => {
    const finance = fn.indexOf('ORDER_SUBMISSION_FINANCE_NOT_VERIFIED')
    const stamp = fn.indexOf('pi_approved_submission_at = v_sub.submitted_at')
    const gate = fn.indexOf('v_verified   := public.order_submission_verified_payment')
    assert.ok(finance > 0 && finance < stamp && stamp < gate)
    assert.ok(fn.includes('if not public.order_submission_pi_approved('), 'only when not already current')
  })

  test('the PI-decision event is logged only once the approval context is open, so a refusal writes nothing', () => {
    const context = fn.indexOf("perform set_config('boe.pi_submission_approval_id', p_submission_id::text, true)")
    const event = fn.indexOf("'pi_approved', 'submitted', 'submitted'")
    assert.ok(context > 0 && event > context)
  })

  test('V1 of the PI history is written after the submission is approved, inside the same transaction', () => {
    const approved = fn.indexOf("set status      = 'approved'")
    const v1 = fn.indexOf('insert into public.order_pi_versions')
    const close = fn.indexOf("perform set_config('boe.pi_submission_approval_id', '', true)")
    assert.ok(approved > 0 && approved < v1 && v1 < close)
    assert.ok(fn.slice(v1, v1 + 500).includes("1, 'approved'"))
  })

  test('the Order is born Not Aligned: no alignment column is named in the INSERT', () => {
    const insert = fn.slice(fn.indexOf('insert into public.orders ('), fn.indexOf('returning id, display_number'))
    assert.ok(!insert.includes('production_alignment'))
    assert.ok(fn.includes("'production_alignment',      'not_aligned'"), 'and the Order-side event says so')
  })

  test('the number still comes from the trigger alone', () => {
    assert.ok(!/display_number\s*=/.test(fn))
    assert.ok(fn.includes('returning id, display_number into v_order_id, v_number'))
  })
})

// ── §7 PI versions ────────────────────────────────────────────────────────────

describe('order_pi_versions: one current, one pending, never deleted', () => {
  test('the table, its cascades and its checks', () => {
    assert.ok(code.includes('create table if not exists public.order_pi_versions'))
    assert.ok(code.includes('references public.orders(id) on delete cascade'))
    assert.ok(code.includes('references public.order_submissions(id) on delete cascade'))
    assert.ok(code.includes("check (status in ('pending', 'approved', 'rejected', 'superseded'))"))
    assert.ok(code.includes('order_pi_versions_revision_needs_reason'))
    assert.ok(code.includes('order_pi_versions_decision_complete'))
    assert.ok(code.includes('constraint order_pi_versions_order_version_key unique (order_id, version_number)'))
  })

  test('exactly one current and at most one pending, by PARTIAL UNIQUE INDEX', () => {
    assert.ok(code.includes("on public.order_pi_versions (order_id) where status = 'approved'"))
    assert.ok(code.includes("on public.order_pi_versions (order_id) where status = 'pending'"))
  })

  test('V1 is backfilled for every Order that came from a PI, before the guard exists', () => {
    const backfill = code.indexOf('insert into public.order_pi_versions (')
    const guard = code.indexOf('create trigger order_pi_versions_guard')
    assert.ok(backfill > 0 && backfill < guard)
    assert.ok(code.slice(backfill, backfill + 900).includes("o.id, s.id, 1, 'approved'"))
    assert.ok(code.includes('where not exists (\n  select 1 from public.order_pi_versions v where v.order_id = o.id\n)'), 'idempotent')
  })

  test('the guard: frozen identity, pending→approved|rejected, approved→superseded, delete only in cleanup', () => {
    const guard = codeOf('order_pi_versions_guard')
    assert.ok(guard.includes('if public.in_test_data_cleanup() then'))
    assert.ok(guard.includes('ORDER_PI_VERSION_IMMUTABLE: PI version history cannot be deleted'))
    assert.ok(guard.includes("if old.status = 'pending' and new.status in ('approved', 'rejected') then"))
    assert.ok(guard.includes("if old.status = 'approved' and new.status = 'superseded' then"))
    assert.ok(guard.includes('ORDER_PI_VERSION_TRANSITION_INVALID'))
    assert.ok(guard.includes('new.workbook_path  is distinct from old.workbook_path'), 'the document is frozen')
    assert.ok(guard.includes("new.status = 'approved' and new.version_number = 1\n       and public.in_pi_submission_approval(new.submission_id)"),
      'an approved INSERT is V1 inside the approval, and nothing else')
    assert.ok(code.includes('before insert or update or delete on public.order_pi_versions'))
  })

  test('clients read through the two visibility doors and write nothing', () => {
    assert.ok(code.includes('alter table public.order_pi_versions enable row level security'))
    assert.ok(code.includes('revoke all on table public.order_pi_versions from public, anon, authenticated'))
    assert.ok(code.includes('grant select on table public.order_pi_versions to authenticated'))
    assert.ok(code.includes('public.can_view_order(order_id)\n    or public.can_view_order_submission(submission_id)'))
    assert.ok(code.includes("using (public.module_entry_open('orders'))"))
  })

  test('proposing: owner or admin with orders.create, a reason, a stored xlsx, no open revision, not cancelled', () => {
    const fn = codeOf('propose_order_pi_revision')
    assert.ok(fn.includes("public.actor_has_module_permission('orders', 'create')"))
    assert.ok(fn.includes('ORDER_PI_REVISION_NOT_OWNER'))
    assert.ok(fn.includes('ORDER_PI_REVISION_REASON_REQUIRED'))
    assert.ok(fn.includes('ORDER_PI_REVISION_PENDING'))
    assert.ok(fn.includes('ORDER_PI_REVISION_SAME_FILE'))
    assert.ok(fn.includes('ORDER_PI_REVISION_ORDER_CLOSED'))
    assert.ok(fn.includes("o.metadata ->> 'mimetype'"), 'the file must exist and be a workbook')
    assert.ok(fn.includes("'pending'"))
    assert.ok(fn.includes('select coalesce(max(version_number), 0) + 1'))
    assert.ok(!fn.includes('update public.orders'), 'nothing on the Order moves')
    assert.ok(!fn.includes('update public.order_submissions'), 'nothing on the current PI moves')
    assert.ok(code.includes('grant  execute on function public.propose_order_pi_revision(uuid, text, text, text) to authenticated'))
  })

  test('rejecting: an active admin, a reason, a pending version; the row is kept', () => {
    const fn = codeOf('reject_order_pi_revision')
    assert.ok(fn.includes("coalesce(u.role = 'admin', false)"))
    assert.ok(fn.includes('ORDER_PI_REVISION_DECISION_REASON_REQUIRED'))
    assert.ok(fn.includes('ORDER_PI_REVISION_NOT_PENDING'))
    assert.ok(fn.includes("set status = 'rejected'"))
    assert.ok(!fn.includes('delete from'))
  })

  test('approving: SERVICE ROLE ONLY, one transaction, the deployed parser, the previous version superseded', () => {
    const fn = codeOf('approve_order_pi_revision')
    assert.ok(code.includes('revoke execute on function public.approve_order_pi_revision(uuid, uuid, jsonb)\n  from public, anon, authenticated'))
    assert.ok(code.includes('grant  execute on function public.approve_order_pi_revision(uuid, uuid, jsonb) to service_role'))
    assert.ok(fn.includes('v_result := public.replace_order_submission_parse(v_sub.id, p_actor_id, v_payload)'))
    assert.ok(fn.includes("perform set_config('boe.amendment_context', 'order_amendment', true)"),
      'the Order update inside the parser is a commercial change and is admitted as one')
    assert.ok(fn.includes('ORDER_PI_REVISION_STALE'), 'an older revision cannot replace a newer approved one')
    assert.ok(fn.includes('ORDER_PI_REVISION_FILE_MISMATCH'), 'the parsed file must be the proposed file')
    assert.ok(fn.includes('ORDER_PI_REVISION_NOT_APPLIED'))
    assert.ok(fn.includes("set status = 'superseded'"))
    assert.ok(fn.includes("set status = 'approved'"))
    // Locks in the module's order: the Order, then its PI, then the versions.
    const order = fn.indexOf('from public.orders where id = v_ver.order_id for update')
    const sub = fn.indexOf('from public.order_submissions where id = v_ver.submission_id for update')
    const ver = fn.indexOf('from public.order_pi_versions where id = p_version_id for update')
    assert.ok(order > 0 && order < sub && sub < ver)
  })

  test('the revision upload policy admits the owner or an admin on an APPROVED PI, into original/, and adds no UPDATE or DELETE', () => {
    const fn = codeOf('can_write_order_pi_revision_file')
    assert.ok(fn.includes("s.status = 'approved'"))
    assert.ok(fn.includes('s.order_id is not null'))
    assert.ok(fn.includes("public.resolve_permission(auth.uid(), 'orders', 'create')"))
    assert.ok(code.includes('create policy "order_files_revision_insert" on storage.objects\n  for insert'))
    assert.ok(code.includes("name ~ '^submissions/[0-9a-fA-F-]{36}/original/[^/]+\\.xlsx$'"))
    assert.ok(!/create policy "[a-z_]+" on storage\.objects\s+for (update|delete)/i.test(code))
  })
})

// ── §8 Production alignment ───────────────────────────────────────────────────

describe('production alignment', () => {
  test('the column defaults to not_aligned and admits two values', () => {
    assert.ok(code.includes("add column if not exists production_alignment      text not null default 'not_aligned'"))
    assert.ok(code.includes("check (production_alignment in ('not_aligned', 'aligned'))"))
    assert.ok(code.includes("if exists (select 1 from public.orders where production_alignment <> 'not_aligned')"),
      'and the apply-time assertion proves no existing Order was born aligned')
  })

  test('the columns move only inside set_order_production_alignment, for every caller', () => {
    const guard = codeOf('orders_guard_amendable_columns')
    const alignment = guard.indexOf('in_production_alignment()')
    const amendment = guard.indexOf('if public.in_order_amendment() then')
    assert.ok(alignment > 0 && alignment < amendment, 'checked before the amendment early-return')
    assert.ok(guard.includes('ORDER_PRODUCTION_ALIGNMENT_PATH_REQUIRED'))
    assert.ok(guard.includes('ORDER_AMENDMENT_REQUIRED'), 'and the commercial rule is unchanged')
    assert.ok(code.includes('revoke execute on function public.in_production_alignment() from public, anon, authenticated'))
  })

  test('the RPC asks the engine for orders.align_production, refuses a cancelled Order, and is idempotent', () => {
    const fn = codeOf('set_order_production_alignment')
    assert.ok(fn.includes("public.actor_has_module_permission('orders', 'align_production')"))
    assert.ok(fn.includes('ORDER_PRODUCTION_ALIGNMENT_CLOSED'))
    assert.ok(fn.includes("'unchanged', true"))
    assert.ok(fn.includes("'production_alignment_changed'"))
    assert.ok(fn.includes('for update'))
    assert.ok(!/role\s*=\s*'admin'/.test(fn))
  })

  test('the action is registered in the database and in the registry, and is protected', () => {
    assert.ok(code.includes("values ('align_production', 'Align Production', false)"))
    assert.ok(code.includes("where pm.module_key = 'orders'"))
    const modules = readFileSync('src/lib/permissions/modules.ts', 'utf8')
    assert.ok(modules.includes("{ actionKey: 'align_production', displayName: 'Align Production' }"))
    const levels = readFileSync('src/lib/permissions/levels.ts', 'utf8')
    assert.ok(levels.includes("'align_production',"))
    assert.ok(levels.includes("align_production: 'view'"))
  })
})

// ── §10 History ───────────────────────────────────────────────────────────────

describe('history', () => {
  test('the six new events are declared, and every earlier one survives', () => {
    const start = code.lastIndexOf('add constraint order_submission_activity_action_check')
    const constraint = code.slice(start, code.indexOf(';', start))
    for (const a of ['submission_created', 'approved', 'finance_verified', 'order_number_used',
                     'workbook_replaced_by_admin', 'correction_rejected',
                     'pi_approved', 'payment_verified', 'payment_rejected',
                     'pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected']) {
      assert.ok(constraint.includes(`'${a}'`), a)
    }
  })

  test('the Order side may read the source PI\'s trail', () => {
    assert.ok(code.includes('create policy "order_submission_activity_confirmed_order_select" on public.order_submission_activity\n  for select to authenticated\n  using (public.can_view_order_submission_via_order(submission_id))'))
  })

  test('a Finance decision is echoed at commit, from active allocations, and decides nothing', () => {
    const fn = codeOf('finance_payment_requests_echo_decision')
    assert.ok(fn.includes('public.finance_payment_status_is_verified(new.status)'))
    assert.ok(fn.includes("new.status = 'rejected'"))
    assert.ok(fn.includes("and a.status = 'active'"))
    assert.ok(!fn.includes('update public.finance_payment_requests'), 'echoes; never writes the payment')
    assert.ok(code.includes('create constraint trigger finance_payment_requests_echo_decision\n  after update of status on public.finance_payment_requests\n  deferrable initially deferred'))
  })

  test('the three notification types exist', () => {
    for (const t of ['pi_revision_proposed', 'pi_revision_approved', 'pi_revision_rejected']) {
      assert.ok(code.includes(`alter type notification_type add value if not exists '${t}'`), t)
    }
  })
})

// ── Apply-time assertions ─────────────────────────────────────────────────────

describe('the migration checks itself at apply time', () => {
  test('columns, functions, grants, indexes, the backfill, the seed and the policies', () => {
    for (const check of [
      'the three PI-decision columns are not all present',
      'the four production-alignment columns are not all present',
      'is executable by a client role',
      'is not executable by authenticated',
      'has more than one overload',
      'was not re-emitted with the PI decision and the V1 history row',
      'the submission route is not chosen on attached payment',
      'the two partial unique indexes on order_pi_versions are missing',
      'have no current PI version after the backfill',
      'a client role can write order_pi_versions',
      'orders.align_production is not registered',
      'the Order-side activity policy is missing',
      'the revision upload policy is missing',
    ]) {
      assert.ok(code.includes(check), check)
    }
    assert.ok(code.includes("raise notice '20261119000000 applied"))
  })
})
