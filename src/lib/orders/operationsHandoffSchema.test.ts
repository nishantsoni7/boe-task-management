/**
 * THE PI-TO-OPERATIONS HANDOFF MIGRATION (20261229000000), read as text.
 *
 * Executing it is done by supabase/tests/run_order_operations_handoff_local.sh
 * against a disposable stack. This file holds the migration and the code that
 * reads it to their promises without a database:
 *
 *   * it is forward-only and additive: it alters no existing table, hooks
 *     the one write both approval paths already make (a version becoming
 *     approved), and re-emits one approval door — approve_order_pi_revision,
 *     word for word from 20261124000000 but for the reviewer-row lock it now
 *     takes before the Order (a deadlock fix, proved by the race runner);
 *   * lock order: the reviewer row → orders → PI rows → handoffs, in every
 *     door that holds an Order and can then wait on either;
 *   * ONE operations decision: accepting aligns, flagging or withdrawing
 *     un-aligns, a later version resets, and set_order_production_alignment()
 *     is re-emitted to be the same door on a handoff Order — so no older
 *     alignment can make a newer, unaccepted version look ready;
 *   * authority is at the database: clients read only, anon executes nothing,
 *     the decision RPC checks the assigned, active reviewer who can open the
 *     Order — not the admin role, not orders.align_production;
 *   * assignment readdresses or unassigns every live UNRESOLVED handoff;
 *   * nothing is backfilled;
 *   * the notification types reach the Orders feed and open the Order at the
 *     card; the page reads the table beside the versions, offers the controls
 *     from the rules module only, and draws no second production button.
 *
 * Run:
 *   npx tsx --test src/lib/orders/operationsHandoffSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ORDER_NOTIFICATION_TYPES } from '@/lib/notifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import type { Notification } from '@/lib/types'

const ROOT = process.cwd()
// CRLF-safe: git checks files out CRLF on this machine and `$`-anchored
// patterns cannot reach past a \r.
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const stripSql = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n')

const MIGRATION_FILE = 'supabase/migrations/20261229000000_order_operations_handoff.sql'
const MIGRATION = read(MIGRATION_FILE)
const SQL = stripSql(MIGRATION)
const PAGE = read('src/app/orders/[id]/page.tsx')
const CARD = read('src/app/orders/[id]/OrderStatusWorkspace.tsx')
const LIB = read('src/lib/orders/operationsHandoff.ts')

const fnBody = (name: string) => {
  const start = SQL.indexOf(`create or replace function public.${name}`)
  assert.ok(start >= 0, `${name} is defined`)
  const end = SQL.indexOf(`comment on function public.${name}`, start)
  return SQL.slice(start, end > 0 ? end : undefined)
}

describe('the migration is one additive, forward-only file', () => {
  test('it exists exactly once and sorts after every migration before it', () => {
    const all = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    const mine = all.filter(f => f.includes('order_operations_handoff'))
    assert.deepEqual(mine, ['20261229000000_order_operations_handoff.sql'])
    const before = all.filter(f => f < '20261229000000_order_operations_handoff.sql')
    assert.ok(before.includes('20261228000000_personal_module_order.sql'))
    assert.ok(before.includes('20261119000000_order_submission_pi_review_gate_versions_and_production.sql'),
      'the versions table and the alignment function it re-emits predate it')
  })

  test('it creates the two tables and alters no existing one', () => {
    assert.match(SQL, /create table if not exists public\.order_operations_handoffs/)
    assert.match(SQL, /create table if not exists public\.order_operations_reviewers/)
    const alters = [...SQL.matchAll(/alter table (?:if exists )?public\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(alters)].sort(), ['order_operations_handoffs', 'order_operations_reviewers'],
      'no existing table is altered — orders, order_pi_versions and the alignment columns keep their shape')
    assert.doesNotMatch(SQL, /drop table/)
    assert.doesNotMatch(SQL, /alter table public\.orders\b/)
  })

  test('it re-emits no other approval door, and hooks the versions table instead', () => {
    for (const fn of [
      'approve_order_submission', 'approve_pi_review',
      'propose_order_pi_revision', 'reject_order_pi_revision', 'replace_order_submission_parse',
      'orders_guard_amendable_columns', 'order_pi_versions_guard', 'in_production_alignment',
      'submit_pi_for_review', 'resolve_permission', 'actor_has_module_permission',
    ]) {
      assert.doesNotMatch(SQL, new RegExp(`create or replace function public\\.${fn}\\(`), `${fn} must not be redefined`)
    }
    assert.match(SQL, /create trigger order_pi_versions_record_operations_handoff\s+after insert or update of status on public\.order_pi_versions/)
    assert.match(SQL, /if new\.status <> 'approved' then\s+return null/)
    assert.match(SQL, /if tg_op = 'UPDATE' and old\.status = 'approved' then\s+return null/, 'only the moment a version BECOMES approved')
  })

  test('approve_order_pi_revision is re-emitted word for word, plus ONLY the reviewer lock, taken before the Order', () => {
    const SOURCE = read('supabase/migrations/20261124000000_order_submission_reserved_number_gate_removed_and_boe_item_codes.sql')
    const fullBody = (text: string) => {
      const start = text.indexOf('create or replace function public.approve_order_pi_revision(')
      assert.ok(start >= 0)
      const end = text.indexOf('\n$$;', start)
      assert.ok(end > start)
      return text.slice(start, end + 4)
    }
    const before = fullBody(SOURCE).split('\n')
    const after = fullBody(MIGRATION).split('\n')
    const LOCK = "  perform 1 from public.order_operations_reviewers where duty = 'pi_handoff' for share;"
    const added = after.filter(l => !before.includes(l))
    assert.ok(added.includes(LOCK), 'the one statement it adds is the reviewer-row SHARE lock')
    assert.deepEqual(added.filter(l => !/^\s*--/.test(l) && l.trim() !== ''), [LOCK],
      'nothing else is added: no check, transition, history row or notification changes')
    assert.deepEqual(before.filter(l => !after.includes(l)), [], 'nothing is removed or rewritten')
    const body = fnBody('approve_order_pi_revision')
    const lock = body.indexOf("from public.order_operations_reviewers where duty = 'pi_handoff' for share")
    assert.ok(lock > 0 && lock < body.indexOf('from public.orders where id = v_ver.order_id for update'),
      'the reviewer row is locked BEFORE the Order — the order that cannot deadlock against the assignment')
    assert.match(SQL, /revoke execute on function public\.approve_order_pi_revision\(uuid, uuid, jsonb\)\s*\n\s*from public, anon, authenticated;\s*\ngrant\s+execute on function public\.approve_order_pi_revision\(uuid, uuid, jsonb\) to service_role;/,
      'still service-role only')
    assert.match(SQL, /raise exception 'ASSERT: approve_order_pi_revision must lock the reviewer row before the Order'/,
      'the apply-time assertion reads the installed order back')
  })

  test('the existing functions it re-emits: the revision door (one lock) and the alignment door, made the SAME door', () => {
    const defs = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1])
    assert.deepEqual([...new Set(defs)].sort(), [
      'approve_order_pi_revision',
      'decide_order_operations_handoff', 'operations_reviewer_can_open_order',
      'operations_reviewer_covers_all_orders', 'order_operations_handoff_set_alignment',
      'order_operations_handoffs_guard', 'order_pi_versions_record_operations_handoff',
      'set_order_operations_reviewer', 'set_order_production_alignment',
    ])
    const align = fnBody('set_order_production_alignment')
    assert.match(align, /where h\.order_id = p_order_id and h\.superseded_at is null/, 'it looks for the live handoff first')
    // …but only once the reviewer row and then the Order are held: asked
    // unlocked, a revision approval could commit between the question and the
    // legacy branch's Order lock, and the legacy branch would align an Order
    // whose new version nobody accepted.
    const rev = align.indexOf("from public.order_operations_reviewers where duty = 'pi_handoff' for share")
    const ord = align.indexOf('perform 1 from public.orders where id = p_order_id for update')
    assert.ok(rev > 0 && rev < ord, 'the reviewer row before the Order')
    assert.ok(ord < align.indexOf('from public.order_operations_handoffs h'), 'the Order before the handoff question')
    assert.match(align, /return public\.decide_order_operations_handoff\(\s*v_live,\s*case when coalesce\(p_aligned, false\) then 'accepted' else 'clarification_needed' end,\s*v_note\)/,
      'on a handoff Order BOTH directions route through the handoff decision')
    // The legacy branch is the 20261119 rule, word for word where it matters.
    assert.match(align, /public\.actor_has_module_permission\('orders', 'align_production'\)/)
    assert.match(align, /ORDER_PRODUCTION_ALIGNMENT_CLOSED/)
    assert.match(align, /'unchanged', true/)
    assert.match(align, /'production_alignment_changed'/)
    assert.doesNotMatch(align, /role\s*=\s*'admin'/)
    assert.match(SQL, /p\.prosrc like '%public\.decide_order_operations_handoff\(%'/, 'the apply-time assertion pins the routing')
  })

  test('it is idempotent per version, and per re-run', () => {
    assert.match(SQL, /constraint order_operations_handoffs_version_key unique \(pi_version_id\)/)
    assert.match(SQL, /if exists \(select 1 from public\.order_operations_handoffs h where h\.pi_version_id = new\.id\) then\s+return null/)
    assert.match(SQL, /create unique index if not exists order_operations_handoffs_one_live_per_order\s+on public\.order_operations_handoffs \(order_id\) where superseded_at is null/)
    for (const stmt of ['alter type notification_type add value if not exists', 'create or replace function', 'drop trigger if exists', 'drop policy if exists', 'create index if not exists']) {
      assert.ok(SQL.includes(stmt), stmt)
    }
  })

  test('it backfills nothing', () => {
    assert.doesNotMatch(SQL, /insert into public\.order_operations_handoffs\s*\([^;]*?\)\s*select/i,
      'no INSERT ... SELECT over existing Orders')
    assert.doesNotMatch(SQL, /insert into public\.order_operations_reviewers[\s\S]*?values \('pi_handoff', '[0-9a-f-]{36}'/,
      'no guessed reviewer uuid')
    assert.doesNotMatch(MIGRATION, /58ec48e3-d252-4660-b61b-4db48fb58e9e/, 'no hard-coded person')
    assert.doesNotMatch(SQL, /full_name\s*(=|ilike|like)\s*'/, 'nobody is identified by display name')
    assert.doesNotMatch(SQL, /update public\.orders\s+set production_alignment[\s\S]{0,200}where production_alignment/, 'no blanket rewrite of existing alignments')
  })
})

describe('one operations decision: acceptance is alignment, at the database', () => {
  test('accepting aligns; flagging or withdrawing un-aligns; the writes go through the production_alignment context', () => {
    const decide = fnBody('decide_order_operations_handoff')
    assert.match(decide, /perform public\.order_operations_handoff_set_alignment\(\s*v_h\.order_id, v_actor, true, v_reason,/, 'accepting aligns')
    assert.match(decide, /perform public\.order_operations_handoff_set_alignment\(\s*v_h\.order_id, v_actor, false, v_reason,/, 'flagging or withdrawing un-aligns')
    const setter = fnBody('order_operations_handoff_set_alignment')
    assert.match(setter, /set_config\('boe\.production_alignment_context', 'production_alignment', true\)/)
    assert.match(setter, /set_config\('boe\.production_alignment_context', '', true\)/)
    assert.match(setter, /'production_alignment_changed'/, 'the same history event the old door writes')
    assert.match(setter, /if v_order\.production_alignment = v_target then\s+return false/, 'idempotent: no change, no event')
    assert.match(SQL, /revoke execute on function public\.order_operations_handoff_set_alignment\(uuid, uuid, boolean, text, jsonb\) from public, anon, authenticated/)
  })

  test('a later version RESETS the alignment — recorded, never silently', () => {
    const trg = fnBody('order_pi_versions_record_operations_handoff')
    assert.match(trg, /if v_alignment = 'aligned' then\s+perform public\.order_operations_handoff_set_alignment\(\s*new\.order_id, new\.decided_by, false, null,/)
    assert.match(trg, /'reason', 'pi_version_approved'/)
    assert.match(trg, /'covered_version_number', v_prior\.version_number/, 'the reset says what the alignment had covered')
    assert.match(trg, /v_alignment, v_prior\.status/, 'the handoff snapshots the alignment BEFORE the reset, and the prior decision')
    assert.doesNotMatch(trg, /update public\.orders/, 'the trigger never writes orders directly')
  })

  test('a withdrawal keeps the acceptance on record; the guard refuses erasing or editing a decision', () => {
    const decide = fnBody('decide_order_operations_handoff')
    assert.match(decide, /v_withdraw := v_h\.status = 'accepted'/)
    assert.match(decide, /acceptance_withdrawn_by = v_actor, acceptance_withdrawn_at = v_now, acceptance_withdrawn_reason = v_reason/)
    assert.match(decide, /'operations_handoff_acceptance_withdrawn'/)
    assert.match(SQL, /acceptance_withdrawn_reason\s+text/)
    const guard = fnBody('order_operations_handoffs_guard')
    assert.match(guard, /old\.status = 'accepted' and new\.status = 'awaiting'/)
    assert.match(guard, /ORDER_OPERATIONS_HANDOFF_ACCEPTED_IS_PERMANENT/)
    assert.match(guard, /ORDER_OPERATIONS_HANDOFF_DECISION_IS_AN_EVENT/)
    assert.match(guard, /ORDER_OPERATIONS_HANDOFF_FROZEN/)
    assert.match(guard, /if public\.in_test_data_cleanup\(\) then\s+return old/)
    assert.match(guard, /ORDER_OPERATIONS_HANDOFF_PERMANENT/)
  })
})

describe('authority lives at the database', () => {
  test('clients read only; anon reads nothing; every write goes through a definer', () => {
    for (const t of ['order_operations_handoffs', 'order_operations_reviewers']) {
      assert.match(SQL, new RegExp(`alter table public\\.${t} enable row level security`))
      assert.match(SQL, new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated`))
      assert.match(SQL, new RegExp(`grant select on table public\\.${t} to authenticated`))
      assert.doesNotMatch(SQL, new RegExp(`grant (insert|update|delete|all)[^;]*on table public\\.${t}`))
    }
    assert.match(SQL, /create policy "order_operations_handoffs_select"[\s\S]*?using \(public\.can_view_order\(order_id\)\)/,
      'visibility is the Order\'s own')
    assert.match(SQL, /create policy "order_operations_handoffs_module_entry_gate"[\s\S]*?as restrictive/)
    assert.match(SQL, /create policy "order_operations_reviewers_admin_select"[\s\S]*?u\.role = 'admin'/)
  })

  test('the RPCs are SECURITY DEFINER with a pinned search_path, authenticated may call the doors, anon may not', () => {
    for (const sig of ['decide_order_operations_handoff(uuid, text, text)', 'set_order_operations_reviewer(uuid)', 'set_order_production_alignment(uuid, boolean, text)']) {
      const esc = sig.replace(/[()]/g, '\\$&')
      assert.match(SQL, new RegExp(`revoke execute on function public\\.${esc} from public, anon`))
      assert.match(SQL, new RegExp(`grant\\s+execute on function public\\.${esc} to authenticated`))
    }
    for (const name of ['decide_order_operations_handoff', 'set_order_operations_reviewer', 'set_order_production_alignment',
                        'order_operations_handoff_set_alignment', 'order_operations_handoffs_guard', 'order_pi_versions_record_operations_handoff',
                        'operations_reviewer_can_open_order', 'operations_reviewer_covers_all_orders']) {
      const body = fnBody(name)
      assert.match(body, /security definer/, name)
      assert.match(body, /set search_path = public, pg_temp/, name)
    }
    for (const trg of ['order_operations_handoffs_guard()', 'order_pi_versions_record_operations_handoff()']) {
      assert.match(SQL, new RegExp(`revoke execute on function public\\.${trg.replace(/[()]/g, '\\$&')} from public, anon, authenticated`))
    }
  })

  test('the decision is the assigned reviewer\'s — active, able to open the Order — not an admin\'s, not the approver\'s', () => {
    const body = fnBody('decide_order_operations_handoff')
    assert.match(body, /v_actor\s+uuid := public\.assert_order_submission_actor\(\)/, 'the caller is auth.uid(), active and not deleted')
    assert.match(body, /if v_h\.assigned_to <> v_actor then\s+raise exception 'Only the assigned operations reviewer/)
    assert.match(body, /if v_h\.assigned_to is null then\s+raise exception 'ORDER_OPERATIONS_HANDOFF_UNASSIGNED/)
    assert.match(body, /if not public\.can_view_order_as_actor\(v_h\.order_id\) then/, 'the reviewer must still be able to open THIS Order')
    assert.doesNotMatch(body, /role = 'admin'/, 'the admin role grants nothing here')
    assert.doesNotMatch(body, /actor_has_module_permission\('orders', 'approve_order'\)/, 'approving is not accepting')
    assert.doesNotMatch(body, /actor_has_module_permission\('orders', 'align_production'\)/, 'holding align_production is not being the reviewer')
    // Locks and the checks under them, in the order that cannot deadlock with
    // approval or assignment: the reviewer row (SHARE), the Order, the handoff.
    assert.match(body, /perform 1 from public\.order_operations_reviewers where duty = 'pi_handoff' for share;\s*select \* into v_order from public\.orders where id = v_order_id for update;\s*select \* into v_h from public\.order_operations_handoffs where id = p_handoff_id for update/)
    for (const marker of ['ORDER_OPERATIONS_HANDOFF_CLOSED', 'ORDER_OPERATIONS_HANDOFF_SUPERSEDED', 'ORDER_OPERATIONS_HANDOFF_STALE',
                          'ORDER_OPERATIONS_HANDOFF_ALREADY_ACCEPTED', 'ORDER_OPERATIONS_HANDOFF_ALREADY_FLAGGED',
                          'ORDER_OPERATIONS_HANDOFF_REASON_REQUIRED', 'ORDER_OPERATIONS_HANDOFF_REASON_TOO_LONG']) {
      assert.ok(body.includes(marker), marker)
    }
    assert.match(body, /v\.status = 'approved' and v\.id <> v_h\.pi_version_id/, 'a newer approved version makes this one stale')
  })

  test('the reviewer is resolved under a SHARE lock, through an active record, only if they can open THIS Order', () => {
    const trg = fnBody('order_pi_versions_record_operations_handoff')
    assert.match(trg, /from public\.order_operations_reviewers r\s+where r\.duty = 'pi_handoff'\s+for share/,
      'read under the lock set_order_operations_reviewer() must wait for')
    assert.match(trg, /u\.id = v_configured and u\.is_active and coalesce\(u\.is_deleted, false\) = false/)
    assert.match(trg, /elsif not public\.operations_reviewer_can_open_order\(v_configured, new\.order_id\) then\s+v_reviewer := null;\s+v_unassigned := 'reviewer_cannot_open_order'/,
      'somebody who cannot open the Order is neither assigned nor notified')
    assert.match(trg, /v_reviewer, case when v_reviewer is null then null else v_now end, v_unassigned/)
    assert.match(trg, /if v_reviewer is null then\s+insert into public\.notifications[\s\S]*?where u\.role = 'admin' and u\.is_active/,
      'an unassigned handoff is announced to the administrators, so it cannot go unseen')
    // The ONLY admin reference is the "tell the administrators" query; nobody
    // is assigned in the reviewer's place.
    assert.equal((trg.match(/role = 'admin'/g) ?? []).length, 1)
    // Order visibility, restated for a given user: module entry + the Order's own rule.
    const open = fnBody('operations_reviewer_can_open_order')
    for (const branch of [/u\.role = 'admin' or public\.resolve_permission\(u\.id, 'orders', 'view'\)/,
                          /u\.team::text = 'operations'/, /o\.requested_by = u\.id/, /o\.assigned_to  = u\.id/,
                          /public\.resolve_permission\(u\.id, 'orders', 'view_all'\)/]) {
      assert.match(open, branch)
    }
    const all = fnBody('operations_reviewer_covers_all_orders')
    assert.doesNotMatch(all, /requested_by|assigned_to/, 'covering EVERY Order cannot rest on being named on one')
    assert.match(all, /u\.team::text = 'operations'/)
    assert.match(all, /resolve_permission\(u\.id, 'orders', 'view_all'\)/)
    for (const fn of ['operations_reviewer_can_open_order(uuid, uuid)', 'operations_reviewer_covers_all_orders(uuid)']) {
      assert.match(SQL, new RegExp(`revoke execute on function public\\.${fn.replace(/[()]/g, '\\$&')} from public, anon, authenticated`))
    }
    assert.match(SQL, /insert into public\.order_operations_reviewers \(duty, user_id, assigned_by, assigned_at\)\s+values \('pi_handoff', null, null, now\(\)\)\s+on conflict \(duty\) do nothing/,
      'the one lockable settings row exists from the start, with nobody assigned')
  })

  test('the approver is not told about their own approval; the earlier decision is kept; the decision door only SHARES the reviewer row', () => {
    const trg = fnBody('order_pi_versions_record_operations_handoff')
    const decide = fnBody('decide_order_operations_handoff')
    assert.equal((decide.match(/order_operations_reviewers/g) ?? []).length, 1,
      'the decision reads nothing from the reviewer row — it only takes it SHARE, first, so an assignment cannot hold the handoff while the decision holds the Order')
    assert.doesNotMatch(decide, /order_operations_reviewers[^;]*for update/, 'SHARE only: decisions never block each other on it')
    assert.match(trg, /if v_reviewer is not null and v_reviewer is distinct from new\.decided_by then/, 'the approver is not told about their own approval')
    assert.match(trg, /'order_operations_review_requested'::notification_type/)
    assert.match(trg, /update public\.order_operations_handoffs\s+set superseded_at = v_now,\s+superseded_by_version_id = new\.id\s+where order_id = new\.order_id\s+and superseded_at is null/,
      'the earlier version\'s decision is kept; only the supersession is stamped')
  })

  test('assignment: admin-only, validated through the record, and every live UNRESOLVED handoff follows it', () => {
    const body = fnBody('set_order_operations_reviewer')
    assert.match(body, /u\.role = 'admin' and u\.is_active and coalesce\(u\.is_deleted, false\) = false/)
    assert.match(body, /ORDER_OPERATIONS_REVIEWER_INACTIVE/)
    assert.match(body, /ORDER_OPERATIONS_REVIEWER_CANNOT_OPEN_ORDERS/)
    assert.match(body, /if not public\.operations_reviewer_covers_all_orders\(p_user_id\) then/,
      'orders.view alone is not enough: the reviewer must be able to open every Order')
    assert.doesNotMatch(body, /resolve_permission\(p_user_id, 'orders', 'view'\)\) then/, 'the weaker check is gone')
    // THE LOCK, before anything is read or written — and never on orders.
    const lock = body.indexOf("where duty = 'pi_handoff'\n     for update")
    assert.ok(lock > 0, 'the settings row is locked FOR UPDATE')
    assert.ok(lock < body.indexOf('insert into public.order_operations_reviewers'), '…before it is written')
    assert.ok(lock < body.indexOf('for v_h in'), '…and before the handoffs are read, so an approval in flight is waited for')
    assert.doesNotMatch(body, /from public\.orders[^;]*for (update|share|no key update)/,
      'the assignment takes no Order lock of its own; it reaches an Order only through the history row\'s foreign key (FOR KEY SHARE), while it holds the reviewer row exclusively')
    assert.match(body, /for update of h/, 'only handoff rows are locked in the loop')
    assert.match(body, /if p_user_id is not null and not public\.operations_reviewer_can_open_order\(p_user_id, v_h\.order_id\) then/,
      'and each handoff is still checked per Order')
    assert.match(body, /and h\.status <> 'accepted'[\s\S]*?and o\.status <> 'cancelled'/, 'awaiting AND flagged move; accepted ones do not')
    assert.match(body, /assigned_at = case when p_user_id is null then null else v_now end/, 'clearing unassigns')
    assert.match(body, /'operations_reviewer_unassigned' else 'operations_reviewer_assigned'/)
    assert.match(body, /'unassigned_handoffs', v_unassigned/)
  })
})

describe('the notifications reach the reader and open the Order at the card', () => {
  test('both types are on the Orders channel', () => {
    for (const t of ['order_operations_review_requested', 'order_operations_review_decided']) {
      assert.ok((ORDER_NOTIFICATION_TYPES as readonly string[]).includes(t), `${t} would be written but never shown`)
      assert.match(SQL, new RegExp(`alter type notification_type add value if not exists '${t}'`))
    }
  })
  test('the link is the Order, at the Operations review card', () => {
    const n = { id: 'n', user_id: 'u', task_id: null, entity_id: 'order-1', type: 'order_operations_review_requested', title: 't', body: null, is_read: false, created_at: '' } as unknown as Notification
    const meta = getNotificationMeta(n)
    assert.equal(meta.category, 'order')
    assert.equal(meta.href, '/orders/order-1#operations-review')
    assert.equal(meta.badge.label, 'Operations review')
    const d = getNotificationMeta({ ...n, type: 'order_operations_review_decided' } as unknown as Notification)
    assert.equal(d.href, '/orders/order-1#operations-review')
  })
})

describe('the queues and the Control Center', () => {
  const DASHBOARD = read('src/app/orders/page.tsx')
  const ALL = read('src/app/orders/all/page.tsx')
  const QUEUE = read('src/app/admin/control-center/action-queue/page.tsx')
  const CC = read('src/app/admin/control-center/page.tsx')
  const LAYOUT = read('src/components/layout/ControlCenterLayout.tsx')

  test('the dashboard counts the reader\'s own awaiting handoffs, the unassigned ones, and the flagged ones, inside its one group', () => {
    const group = DASHBOARD.slice(DASHBOARD.indexOf('] = await Promise.all(['), DASHBOARD.indexOf('setOrders(mapped)'))
    assert.equal((group.match(/\.from\('order_operations_handoffs'\)/g) ?? []).length, 3)
    assert.match(group, /\.eq\('assigned_to', viewerId\)/)
    assert.match(group, /\.is\('assigned_to', null\)/)
    assert.match(group, /\.eq\('status', 'clarification_needed'\)\.is\('superseded_at', null\)/)
    assert.match(DASHBOARD, /operationsReview:\s+opsMineRes\.error \? undefined/, 'absent, never zero, against a database without the table')
    assert.match(DASHBOARD, /operationsFlagged:\s+opsFlaggedRes\.error \? undefined/)
  })

  test('the Confirmed Orders list has the ?ops=awaiting queue — awaiting AND flagged — named in a banner with a way out', () => {
    assert.match(ALL, /ops:\s+enumParam<'all' \| 'awaiting'>\(\['all', 'awaiting'\], 'all'\)/)
    assert.match(ALL, /\.in\('status', \['awaiting', 'clarification_needed'\]\)/)
    assert.match(ALL, /opsFilter === 'awaiting' \? loadAwaitingOps\(\) : Promise\.resolve\(\)/, 'read only when asked for')
    assert.match(ALL, /return to === null \|\| to === profile\?\.id/, 'this reader\'s, or nobody\'s — never somebody else\'s queue')
    assert.match(ALL, /OPERATIONS_REVIEW_QUEUE_BANNER/)
    assert.match(ALL, /setListState\(\{ ops: 'all' \}\)/)
  })

  test('the Action Queue lists awaiting AND flagged handoffs, shows the reviewer\'s reason and an inactive reviewer, links to the card, skips cancelled Orders', () => {
    assert.match(QUEUE, /'order_operations_review'/)
    assert.match(QUEUE, /'order_operations_clarification'/)
    assert.match(QUEUE, /\.in\('status', \['awaiting', 'clarification_needed'\]\)\s*\.is\('superseded_at', null\)/)
    assert.match(QUEUE, /cannot accept — "\$\{r\.clarification_reason \?\? 'no reason recorded'\}"/, 'the reviewer\'s reason is on the row')
    assert.match(QUEUE, /reviewer inactive/)
    assert.match(QUEUE, /UNASSIGNED_REASON_LABEL\[r\.unassigned_reason \?\? 'no_reviewer'\]/, 'an unassigned row says WHY')
    assert.match(QUEUE, /if \(r\.order\?\.status === 'cancelled'\) continue/)
    assert.match(QUEUE, /case 'order_operations_review':\s+return `\/orders\/\$\{id\}#\$\{OPERATIONS_REVIEW_ANCHOR\}`/)
    assert.match(QUEUE, /case 'order_operations_clarification': return `\/orders\/\$\{id\}#\$\{OPERATIONS_REVIEW_ANCHOR\}`/)
  })

  test('Control Center assigns the reviewer through the RPC, from the live directory, by id, and reports what clearing unassigned', () => {
    assert.match(LAYOUT, /'operations-handoff'/)
    assert.match(CC, /tab === 'operations-handoff' && <OperationsReviewerTab members=\{members\} \/>/)
    assert.match(CC, /supabase\.rpc\('set_order_operations_reviewer', \{\s*p_user_id: choice \|\| null,\s*\}\)/)
    assert.match(CC, /unassigned: result\.unassigned_handoffs \?\? 0/)
    assert.match(CC, /eligibleOperationsReviewers\(members\)/)
    assert.doesNotMatch(CC, /\.from\('order_operations_reviewers'\)\s*\.(insert|update|upsert)/, 'never written directly')
    assert.match(CC, /OPERATIONS_REVIEWER_CLEAR_OPTION/, 'clearing is allowed and visible')
    assert.doesNotMatch(CC, /Nitish|Nishant/, 'nobody is named in code')
  })
})

describe('the Order page', () => {
  test('reads the handoffs beside the versions, in the same group, through one named query', () => {
    const loader = PAGE.slice(PAGE.indexOf('const loadPiHandoff'), PAGE.indexOf('const reloadActivity'))
    assert.match(loader, /handoffsQuery\(\),\s*\]\)/, 'in the Promise.all, not after it')
    assert.equal((PAGE.match(/\.from\('order_operations_handoffs'\)/g) ?? []).length, 1, 'one query, named once')
    assert.equal((PAGE.match(/handoffsQuery\(\)/g) ?? []).length, 2, 'the load and the narrow refresh')
    assert.match(loader, /setHandoffs\(\[\]\)/, 'the no-source branch leaves a named empty state')
  })
  test('the decision goes through the RPC, then re-reads the handoff and the Order row (alignment moved)', () => {
    assert.match(PAGE, /supabase\.rpc\('decide_order_operations_handoff', \{\s*p_handoff_id: live\.id,\s*p_decision: decision,\s*p_reason: reason,\s*\}\)/)
    const fn = PAGE.slice(PAGE.indexOf('const decideHandoff'), PAGE.indexOf('const decideHandoff') + 2200)
    // …plus the document submissions, because accepting a PI version accepts
    // the files sent with it (20261231000000 §11e).
    assert.match(fn, /await Promise\.all\(\[reloadHandoffs\(\), reloadOrderRow\(\), docSubs\.reload\(\)\]\)/)
    assert.doesNotMatch(fn, /loadOrder\(\)/)
  })
  test('ONE production decision on the page: no header Align button when a handoff exists', () => {
    assert.match(PAGE, /alignAction: operationsSplit\.live \? null : production\?\.action/)
    assert.equal((PAGE.match(/rpc\('set_order_production_alignment'/g) ?? []).length, 1, 'the legacy door stays for the legacy Order')
  })
  test('the decision is drawn once, on the attention strip, and there is no separate card', () => {
    const body = PAGE.slice(PAGE.indexOf('<OrdersLayout'))
    assert.doesNotMatch(PAGE, /OrderOperationsReviewCard/)
    assert.equal((body.match(/<OperationsReviewActions/g) ?? []).length, 1)
    assert.ok(body.indexOf('<OrderAttentionBar') < body.indexOf('<OperationsReviewActions'))
    assert.ok(body.indexOf('<OperationsReviewActions') < body.indexOf('<OrderDocumentsRow>'))
    assert.match(body, /id=\{operationsReviewOpen \? OPERATIONS_REVIEW_ANCHOR : undefined\}/, 'the notification links still land')
    assert.equal((body.match(/<OperationsHandoffDecisionModal/g) ?? []).length, 1)
  })
  test('the strip offers the controls only from the view; withdrawing lives in the header overflow', () => {
    assert.match(CARD, /view\.actions\.cannotAccept &&/)
    assert.match(CARD, /view\.actions\.accept &&/)
    assert.match(CARD, /view\.status === 'accepted'\) return null/)
    assert.match(PAGE, /canWithdrawAcceptance: operationsView\?\.kind === 'recorded' && operationsView\.actions\.withdraw/)
    assert.match(LIB, /OPERATIONS_HANDOFF_NOT_RECORDED_LABEL = 'Not recorded'/)
    assert.match(LIB, /ACCEPTANCE \(this file\)|ACCEPTANCE is the operations reviewer/)
    assert.match(LIB, /does not say any manufacturing work is done/)
  })
})
