/**
 * FABRIC AND FINISH — the current standing, who may move it, what the dialog
 * may submit, and the guarantees the migration has to hold.
 *
 * TWO HALVES, DELIBERATELY. The first is the browser's courtesy: what the card
 * reads and what Save will let through. The second reads
 * 20261227000000_order_fabric_finish_approvals.sql and asserts the rules that
 * actually matter are stated THERE — append-only, evidence required exactly
 * where it means something, the authority re-derived, the bucket private. A
 * client-side check that is not backed by one of those is decoration, and these
 * would fail if somebody removed the backing.
 *
 * No database and no network: the SQL is read as a file.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderApprovals.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EVIDENCE_BAD_TYPE_MESSAGE,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_REQUIRED_MESSAGE,
  EVIDENCE_SAME_FILE_MESSAGE,
  EVIDENCE_TOO_LARGE_MESSAGE,
  approvalHistory,
  approvalStanding,
  canRecordApproval,
  checkApprovalDraft,
  describeApprovalFailure,
  evidenceObjectPath,
  needsEvidence,
  type ApprovalDraft,
  type ApprovalStatus,
  type PersistedApprovalEvent,
} from './orderApprovals'

const ORDER = '11111111-2222-3333-4444-555555555555'
const when = (iso: string) => iso.slice(0, 10)

function event(over: Partial<PersistedApprovalEvent> = {}): PersistedApprovalEvent {
  return {
    id: 'e1', order_id: ORDER, approval_kind: 'fabric', status: 'partially_approved',
    evidence_path: `orders/${ORDER}/fabric/a.png`,
    actor_id: 'u1', created_at: '2026-09-10T05:00:00Z',
    ...over,
  }
}

const standing = (events: PersistedApprovalEvent[]) => approvalStanding({ events, formatWhen: when })
const kind = (events: PersistedApprovalEvent[], k: 'fabric' | 'finish') =>
  standing(events).kinds.find(x => x.kind === k)

// ── The current standing ──────────────────────────────────────────────────────

describe('where fabric and finish stand', () => {
  test('AN ORDER WITH NO EVENTS IS NOT APPROVED ON BOTH, and nothing is stored', () => {
    const s = standing([])
    assert.deepEqual(s.kinds.map(k => k.kind), ['fabric', 'finish'])
    assert.ok(s.kinds.every(k => k.status === 'not_approved'))
    assert.ok(s.kinds.every(k => k.tone === 'red'))
  })

  test('NOT APPROVED CARRIES NO DATE — nothing happened to date', () => {
    assert.equal(kind([], 'fabric')?.at, null)
    // Even a deliberate revert: the event is kept, the card still shows no
    // "approved on", because nothing was.
    const reverted = kind([event({ status: 'not_approved', evidence_path: null })], 'fabric')
    assert.equal(reverted?.status, 'not_approved')
    assert.equal(reverted?.at, null)
    assert.equal(reverted?.evidencePath, null)
  })

  test('a Partial status carries its date and its proof', () => {
    const k = kind([event()], 'fabric')
    assert.equal(k?.status, 'partially_approved')
    assert.equal(k?.tone, 'amber')
    assert.equal(k?.at, '2026-09-10')
    assert.equal(k?.evidencePath, `orders/${ORDER}/fabric/a.png`)
  })

  test('a Full status is green and carries its date', () => {
    const k = kind([event({ status: 'fully_approved' })], 'fabric')
    assert.equal(k?.tone, 'green')
    assert.equal(k?.at, '2026-09-10')
  })

  test('THE NEWEST EVENT WINS, whatever order the rows arrive in', () => {
    const rows = [
      event({ id: 'e1', status: 'partially_approved', created_at: '2026-09-10T05:00:00Z' }),
      event({ id: 'e2', status: 'fully_approved', created_at: '2026-09-20T05:00:00Z' }),
    ]
    assert.equal(kind(rows, 'fabric')?.status, 'fully_approved')
    assert.equal(kind([...rows].reverse(), 'fabric')?.status, 'fully_approved')
  })

  test('THE TWO KINDS ARE TRACKED SEPARATELY', () => {
    const rows = [
      event({ id: 'e1', approval_kind: 'fabric', status: 'fully_approved' }),
      event({ id: 'e2', approval_kind: 'finish', status: 'partially_approved',
              evidence_path: `orders/${ORDER}/finish/b.png` }),
    ]
    assert.equal(kind(rows, 'fabric')?.status, 'fully_approved')
    assert.equal(kind(rows, 'finish')?.status, 'partially_approved')
    assert.equal(kind(rows, 'fabric')?.evidencePath, `orders/${ORDER}/fabric/a.png`)
    assert.equal(kind(rows, 'finish')?.evidencePath, `orders/${ORDER}/finish/b.png`)
  })

  test('a row this build cannot name is dropped rather than shown wrong', () => {
    const rows = [
      event({ id: 'e1', status: 'fully_approved', created_at: '2026-09-10T05:00:00Z' }),
      event({ id: 'e2', status: 'sort_of_approved', created_at: '2026-09-20T05:00:00Z' }),
      event({ id: 'e3', approval_kind: 'lacquer', created_at: '2026-09-21T05:00:00Z' }),
    ]
    assert.equal(kind(rows, 'fabric')?.status, 'fully_approved')
    assert.equal(standing(rows).kinds.length, 2)
  })
})

// ── The history ───────────────────────────────────────────────────────────────

describe('the approval history', () => {
  const rows = [
    event({ id: 'e1', status: 'partially_approved', created_at: '2026-09-10T05:00:00Z' }),
    event({ id: 'e2', status: 'fully_approved', created_at: '2026-09-20T05:00:00Z' }),
    event({ id: 'e3', status: 'not_approved', evidence_path: null,
            created_at: '2026-09-05T05:00:00Z', actor_id: 'ghost' }),
  ]
  const history = () => approvalHistory({
    events: rows, namesById: new Map([['u1', 'Nishant Soni']]), formatWhen: when,
  })

  test('every event survives, newest first', () => {
    assert.deepEqual(history().map(e => e.id), ['e2', 'e1', 'e3'])
  })

  test('each names its actor, and an unknown one says so rather than being blank', () => {
    assert.equal(history()[0].actorName, 'Nishant Soni')
    assert.equal(history()[2].actorName, 'Unknown user')
  })

  test('a revert is kept in the history with its actor and timestamp', () => {
    const revert = history().find(e => e.status === 'not_approved')
    assert.ok(revert)
    assert.equal(revert?.at, '2026-09-05')
    assert.equal(revert?.evidencePath, null, 'and needs no proof')
  })
})

// ── Who may move one ──────────────────────────────────────────────────────────

describe('who may record an approval', () => {
  const base = { viewerId: 'u1', role: 'member', assignedTo: 'u1', viewingAs: false }

  test('THE ASSIGNED SALESPERSON MAY', () => {
    assert.equal(canRecordApproval(base), true)
  })

  test('AN ADMIN MAY, assigned or not', () => {
    assert.equal(canRecordApproval({ ...base, role: 'admin', assignedTo: 'somebody-else' }), true)
  })

  test('A MANAGER MAY, assigned or not', () => {
    assert.equal(canRecordApproval({ ...base, role: 'manager', assignedTo: 'somebody-else' }), true)
  })

  test('AN UNRELATED EMPLOYEE MAY NOT', () => {
    assert.equal(canRecordApproval({ ...base, viewerId: 'u9', assignedTo: 'u1' }), false)
  })

  test('VIEW AS IS ALWAYS READ-ONLY, whoever is being viewed as', () => {
    for (const role of ['admin', 'manager', 'member']) {
      assert.equal(canRecordApproval({ ...base, role, viewingAs: true }), false, role)
    }
  })

  test('an unknown viewer may not', () => {
    assert.equal(canRecordApproval({ ...base, viewerId: null }), false)
  })

  test('THE SALESPERSON IS MATCHED BY ID, NEVER BY NAME', () => {
    // An unassigned Order gives nobody authority by being unassigned.
    assert.equal(canRecordApproval({ ...base, assignedTo: null }), false)
    // And two different ids never match however alike they look.
    assert.equal(canRecordApproval({ ...base, viewerId: 'u1 ', assignedTo: 'u1' }), false)
  })
})

// ── What Save will let through ────────────────────────────────────────────────

const draft = (
  kind: 'fabric' | 'finish', status: ApprovalStatus, current: ApprovalStatus,
  file: { name: string; size: number; type: string } | null = null,
): ApprovalDraft => ({ kind, status, current, file })

const png = (name = 'proof.png', size = 1000) => ({ name, size, type: 'image/png' })

describe('what the update dialog may submit', () => {
  test('nothing changed, nothing submitted', () => {
    const check = checkApprovalDraft([
      draft('fabric', 'not_approved', 'not_approved'),
      draft('finish', 'not_approved', 'not_approved'),
    ])
    assert.equal(check.ok, false)
  })

  test('FABRIC PARTIAL NEEDS A FABRIC PROOF', () => {
    assert.equal(checkApprovalDraft([
      draft('fabric', 'partially_approved', 'not_approved'),
      draft('finish', 'not_approved', 'not_approved'),
    ]).ok, false)

    const ok = checkApprovalDraft([
      draft('fabric', 'partially_approved', 'not_approved', png()),
      draft('finish', 'not_approved', 'not_approved'),
    ])
    assert.equal(ok.ok, true)
    if (ok.ok) assert.deepEqual(ok.changed.map(d => d.kind), ['fabric'])
  })

  test('FABRIC FULL NEEDS ONE TOO', () => {
    assert.equal(checkApprovalDraft([draft('fabric', 'fully_approved', 'partially_approved')]).ok, false)
    assert.equal(checkApprovalDraft([draft('fabric', 'fully_approved', 'partially_approved', png())]).ok, true)
  })

  test('FINISH PARTIAL AND FULL NEED THEIR OWN', () => {
    assert.equal(checkApprovalDraft([draft('finish', 'partially_approved', 'not_approved')]).ok, false)
    assert.equal(checkApprovalDraft([draft('finish', 'partially_approved', 'not_approved', png())]).ok, true)
    assert.equal(checkApprovalDraft([draft('finish', 'fully_approved', 'not_approved', png())]).ok, true)
  })

  test('BOTH CHANGED TOGETHER NEEDS TWO SEPARATE FILES', () => {
    const same = checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved', png('one.png', 5000)),
      draft('finish', 'fully_approved', 'not_approved', png('one.png', 5000)),
    ])
    assert.equal(same.ok, false)
    if (!same.ok) assert.equal(same.message, EVIDENCE_SAME_FILE_MESSAGE)

    const two = checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved', png('fabric.png', 5000)),
      draft('finish', 'fully_approved', 'not_approved', png('finish.png', 6000)),
    ])
    assert.equal(two.ok, true)
    if (two.ok) assert.deepEqual(two.changed.map(d => d.kind), ['fabric', 'finish'])
  })

  test('AN UNCHANGED APPROVED STATUS IS NOT ASKED FOR ANOTHER FILE', () => {
    const check = checkApprovalDraft([
      // Fabric is already Fully Approved and stays there.
      draft('fabric', 'fully_approved', 'fully_approved'),
      draft('finish', 'partially_approved', 'not_approved', png()),
    ])
    assert.equal(check.ok, true)
    if (check.ok) assert.deepEqual(check.changed.map(d => d.kind), ['finish'])
  })

  test('A NEW APPROVED STATE ON AN ALREADY-APPROVED KIND DOES NEED NEW EVIDENCE', () => {
    assert.equal(needsEvidence({ status: 'fully_approved', current: 'partially_approved' }), true)
    assert.equal(checkApprovalDraft([draft('fabric', 'fully_approved', 'partially_approved')]).ok, false)
  })

  test('REVERTING TO NOT APPROVED NEEDS NO SCREENSHOT', () => {
    assert.equal(needsEvidence({ status: 'not_approved', current: 'fully_approved' }), false)
    const check = checkApprovalDraft([draft('fabric', 'not_approved', 'fully_approved')])
    assert.equal(check.ok, true)
    if (check.ok) assert.equal(check.changed[0].kind, 'fabric')
  })

  test('AN INVALID FILE TYPE IS REJECTED', () => {
    const check = checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved',
            { name: 'proof.pdf', size: 1000, type: 'application/pdf' }),
    ])
    assert.equal(check.ok, false)
    if (!check.ok) assert.equal(check.message, EVIDENCE_BAD_TYPE_MESSAGE)
  })

  test('AN OVERSIZED FILE IS REJECTED', () => {
    const check = checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved', png('big.png', EVIDENCE_MAX_BYTES + 1)),
    ])
    assert.equal(check.ok, false)
    if (!check.ok) assert.equal(check.message, EVIDENCE_TOO_LARGE_MESSAGE)
    // And exactly at the limit is fine.
    assert.equal(checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved', png('edge.png', EVIDENCE_MAX_BYTES)),
    ]).ok, true)
  })

  test('an empty file is not a screenshot', () => {
    const check = checkApprovalDraft([
      draft('fabric', 'fully_approved', 'not_approved', png('empty.png', 0)),
    ])
    assert.equal(check.ok, false)
    if (!check.ok) assert.equal(check.message, EVIDENCE_REQUIRED_MESSAGE)
  })
})

// ── Where a proof goes ────────────────────────────────────────────────────────

describe('the evidence object key', () => {
  test('names the Order and the kind, which is what the policy authorizes on', () => {
    const path = evidenceObjectPath({ orderId: ORDER, kind: 'fabric', objectId: 'abc', fileName: 'x.png' })
    assert.equal(path, `orders/${ORDER}/fabric/abc.png`)
  })

  test('FABRIC AND FINISH NEVER SHARE A FOLDER', () => {
    const f = evidenceObjectPath({ orderId: ORDER, kind: 'fabric', objectId: 'abc', fileName: 'x.png' })
    const n = evidenceObjectPath({ orderId: ORDER, kind: 'finish', objectId: 'abc', fileName: 'x.png' })
    assert.notEqual(f, n)
  })

  test('EVERY UPLOAD IS A NEW KEY — nothing is ever overwritten', () => {
    const a = evidenceObjectPath({ orderId: ORDER, kind: 'fabric', objectId: 'one', fileName: 'x.png' })
    const b = evidenceObjectPath({ orderId: ORDER, kind: 'fabric', objectId: 'two', fileName: 'x.png' })
    assert.notEqual(a, b)
  })

  test('a hostile filename cannot climb out of the folder', () => {
    const path = evidenceObjectPath({
      orderId: ORDER, kind: 'fabric', objectId: 'abc', fileName: '../../etc/passwd',
    })
    assert.equal(path, `orders/${ORDER}/fabric/abc.png`)
    assert.equal(path.includes('..'), false)
  })

  test('and the key matches the shape the table will accept', () => {
    const path = evidenceObjectPath({ orderId: ORDER, kind: 'finish', objectId: 'abc', fileName: 'shot.WEBP' })
    assert.match(path, /^orders\/[0-9a-f-]{36}\/(fabric|finish)\/[A-Za-z0-9._-]{1,120}$/)
  })
})

// ── Failures ──────────────────────────────────────────────────────────────────

describe('a refusal is one quiet sentence, chosen by its code', () => {
  test('each known code has its own wording', () => {
    assert.equal(describeApprovalFailure({ message: 'ORDER_APPROVAL_FORBIDDEN: nope' }),
      'Only the salesperson on this Order, an admin or a manager can update these.')
    assert.equal(describeApprovalFailure({ message: 'ORDER_APPROVAL_EVIDENCE_REQUIRED: x' }),
      EVIDENCE_REQUIRED_MESSAGE)
    assert.equal(describeApprovalFailure({ message: 'ORDER_APPROVAL_EVIDENCE_REUSED: x' }),
      EVIDENCE_SAME_FILE_MESSAGE)
  })

  test('AN UNKNOWN FAILURE NEVER PRINTS THE SERVER’S OWN WORDS', () => {
    const said = describeApprovalFailure({ message: 'PGRST301: jwt expired for tenant 42' })
    assert.equal(said, 'That could not be saved just now.')
    assert.equal(said.includes('jwt'), false)
    assert.equal(said.includes('42'), false)
  })
})

// ── The guarantees that actually matter ───────────────────────────────────────

describe('the migration holds every rule the browser only mirrors', () => {
  const sql = readFileSync(join(process.cwd(),
    'supabase/migrations/20261227000000_order_fabric_finish_approvals.sql'), 'utf8')

  test('the table exists, with RLS enabled AND forced', () => {
    assert.match(sql, /create table if not exists public\.order_approval_events/)
    assert.match(sql, /alter table public\.order_approval_events enable row level security/)
    assert.match(sql, /alter table public\.order_approval_events force row level security/)
  })

  test('IT IS APPEND-ONLY: no UPDATE or DELETE policy, and a trigger that refuses both', () => {
    assert.equal(/create policy[^;]*on public\.order_approval_events\s*\n\s*for update/i.test(sql), false)
    assert.equal(/create policy[^;]*on public\.order_approval_events\s*\n\s*for delete/i.test(sql), false)
    assert.match(sql, /grant select, insert on table public\.order_approval_events to authenticated/)
    assert.match(sql, /create trigger order_approval_events_append_only\s*\n\s*before update or delete/)
    assert.match(sql, /ORDER_APPROVAL_EVENT_IMMUTABLE/)
    // And the migration checks itself.
    assert.match(sql, /it must have none/)
  })

  test('SELECT follows Order visibility and INSERT follows the write authority', () => {
    assert.match(sql, /create policy "order_approval_events_select"[\s\S]*?using \(public\.can_view_order\(order_id\)\)/)
    assert.match(sql, /create policy "order_approval_events_insert"[\s\S]*?public\.can_record_order_approval\(order_id\)/)
    // A permitted writer still cannot file an event under somebody else's name.
    assert.match(sql, /and actor_id = auth\.uid\(\)/)
  })

  test('ANON AND PUBLIC ARE REVOKED, and the migration refuses to finish otherwise', () => {
    assert.match(sql, /revoke all on table public\.order_approval_events from public, anon, authenticated/)
    assert.match(sql, /is granted to anon or public/)
  })

  test('the write authority is salesperson-by-ID, admin or manager — and active', () => {
    const fn = sql.slice(sql.indexOf('function public.can_record_order_approval'),
                         sql.indexOf('revoke execute on function public.can_record_order_approval'))
    assert.match(fn, /u\.role in \('admin', 'manager'\)/)
    assert.match(fn, /o\.assigned_to = auth\.uid\(\)/)
    assert.match(fn, /u\.is_active/)
    assert.match(fn, /coalesce\(u\.is_deleted, false\) = false/)
    // Never a name comparison.
    assert.equal(/full_name/.test(fn), false)
  })

  test('EVIDENCE IS REQUIRED EXACTLY WHERE IT MEANS SOMETHING, at the row', () => {
    assert.match(sql, /constraint order_approval_events_evidence_matches_status check \([\s\S]*?\(status in \('partially_approved', 'fully_approved'\)\)\s*\n\s*= \(nullif\(btrim/)
  })

  test('the RPC re-derives everything under a row lock', () => {
    const fn = sql.slice(sql.indexOf('function public.record_order_approval_event'))
    assert.match(fn, /from public\.orders where id = p_order_id for update/)
    assert.match(fn, /ORDER_APPROVAL_FORBIDDEN/)
    assert.match(fn, /ORDER_APPROVAL_EVIDENCE_REQUIRED/)
    assert.match(fn, /ORDER_APPROVAL_EVIDENCE_PATH/)
    assert.match(fn, /ORDER_APPROVAL_EVIDENCE_MISSING/)
    assert.match(fn, /ORDER_APPROVAL_EVIDENCE_REUSED/)
    assert.match(fn, /ORDER_APPROVAL_UNCHANGED/)
    // It appends. It never updates a row.
    assert.match(fn, /insert into public\.order_approval_events/)
    assert.equal(/update public\.order_approval_events/.test(fn), false)
  })

  test('every definer function pins its search path and is granted narrowly', () => {
    for (const fn of ['can_record_order_approval(uuid)',
                      'record_order_approval_event(uuid, text, text, text)']) {
      assert.match(sql, new RegExp(`revoke execute on function public\\.${fn.replace(/[().]/g, m => '\\' + m)} from public, anon`))
      assert.match(sql, new RegExp(`grant  execute on function public\\.${fn.replace(/[().]/g, m => '\\' + m)} to authenticated`))
    }
    assert.equal((sql.match(/set search_path = public, pg_temp/g) ?? []).length >= 4, true)
    // The append-only trigger is executable by nobody at all.
    assert.match(sql, /revoke execute on function public\.order_approval_events_append_only\(\) from public, anon, authenticated/)
  })

  test('THE BUCKET IS PRIVATE, IMAGES ONLY, AND ITS FILES ARE PERMANENT', () => {
    assert.match(sql, /'order-approval-evidence',\s*\n\s*false,\s*\n\s*5242880/)
    assert.match(sql, /array\['image\/png', 'image\/jpeg', 'image\/webp'\]/)
    // Read follows Order visibility; write follows the same authority as the row.
    assert.match(sql, /create policy "order_approval_evidence_select"[\s\S]*?can_view_order/)
    assert.match(sql, /create policy "order_approval_evidence_insert"[\s\S]*?can_record_order_approval/)
    // No UPDATE and no DELETE policy: an uploaded proof cannot be swapped.
    assert.equal(/create policy "order_approval_evidence_update"/.test(sql), false)
    assert.equal(/create policy "order_approval_evidence_delete"/.test(sql), false)
    assert.match(sql, /proofs would not be permanent/)
  })

  test('the key grammar the policy decodes matches the one the app writes', () => {
    assert.match(sql, /split_part\(p_name, '\/', 1\) <> 'orders'/)
    assert.match(sql, /split_part\(p_name, '\/', 3\) not in \('fabric', 'finish'\)/)
    // Fails closed on a malformed key rather than raising.
    assert.match(sql, /else null/)
  })

  test('the index the card actually reads by exists', () => {
    assert.match(sql, /create index if not exists order_approval_events_current_idx\s*\n\s*on public\.order_approval_events \(order_id, approval_kind, created_at desc, id desc\)/)
  })

  test('and it changes nothing about the rules this project already had', () => {
    for (const forbidden of ['approve_order_submission', 'finance_payment_requests',
                             'set_order_production_alignment', 'order_submissions',
                             'alter table public.orders']) {
      assert.equal(sql.includes(forbidden), false, forbidden + ' must not be touched')
    }
  })
})
