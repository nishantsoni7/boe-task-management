/**
 * CASH HANDOVER WITH ACCEPTANCE — the pure half, and the source contracts that
 * keep the banner on every Finance page and the database doors closed.
 *
 * NONE OF THIS IS THE AUTHORIZATION. create / accept / dispute / cancel / remind
 * re-derive the actor and the state in SQL (20270410000100); the can_* flags the
 * browser reads are the server's answer, not the browser's.
 *
 * Run:
 *   npx tsx --test src/lib/finance/handover.test.ts
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  handoverDraftError,
  handoverErrorMessage,
  handoverHeadline,
  handoverReasonError,
  handoverRole,
  handoverSeverity,
  isHandoverFeatureMissing,
  isOpenHandover,
  HANDOVER_STATUS_LABEL,
  OPEN_HANDOVER_STATUSES,
  readHandover,
  readHandovers,
  sortMyHandovers,
  sumRupees,
  waitingFor,
  type Handover,
} from './handover'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

function raw(over: Record<string, unknown> = {}) {
  return {
    id: 'h1', human_id: 'H-0001', status: 'pending',
    giver_id: 'ashok', giver_name: 'Ashok', recipient_id: 'owner', recipient_name: 'Owner',
    total_amount: 12500.5, handed_at: '2026-10-20T10:00:00Z', note: null,
    created_at: '2026-10-20T10:00:00Z', age_hours: 5,
    can_accept: true, can_dispute: true, can_cancel: false, can_remind: false,
    items: [{ payment_id: 'p1', human_payment_id: 'P-AA-0001', client_name: 'Acme', amount: 12500.5, payment_mode: 'paytm', payment_date: '2026-10-19' }],
    events: [{ event_type: 'created', actor_id: 'ashok', actor_name: 'Ashok', note: null, created_at: '2026-10-20T10:00:00Z' }],
    ...over,
  }
}

function h(over: Record<string, unknown> = {}): Handover {
  const parsed = readHandover(raw(over))
  assert.ok(parsed)
  return parsed
}

describe('reading the RPC JSON', () => {
  test('a full row is read field for field', () => {
    const x = h()
    assert.equal(x.humanId, 'H-0001')
    assert.equal(x.totalAmount, 12500.5)
    assert.equal(x.items[0].humanPaymentId, 'P-AA-0001')
    assert.equal(x.canAccept, true)
    assert.equal(x.events[0].eventType, 'created')
  })

  test('a row without an id or with an unknown status is dropped, not guessed', () => {
    assert.equal(readHandover({ status: 'pending' }), null)
    assert.equal(readHandover(raw({ status: 'weird' })), null)
    assert.equal(readHandover(null), null)
    assert.deepEqual(readHandovers('nope'), [])
    assert.equal(readHandovers([raw(), { nonsense: true }]).length, 1)
  })

  test('a can_* flag is true only when the server said exactly true', () => {
    const x = h({ can_accept: 'yes', can_dispute: 1, can_cancel: undefined })
    assert.equal(x.canAccept, false)
    assert.equal(x.canDispute, false)
    assert.equal(x.canCancel, false)
  })

  test('an unknown event type is skipped', () => {
    const x = h({ events: [{ event_type: 'exploded', created_at: 'x' }] })
    assert.equal(x.events.length, 0)
  })
})

describe('who is looking, and how loud the card is', () => {
  test('role follows the viewer, and an outsider is an observer', () => {
    const x = h()
    assert.equal(handoverRole(x, 'owner'), 'recipient')
    assert.equal(handoverRole(x, 'ashok'), 'giver')
    assert.equal(handoverRole(x, 'someone'), 'observer')
    assert.equal(handoverRole(x, null), 'observer')
  })

  test('severity escalates with age: fresh, late at 24h, overdue at 72h', () => {
    assert.equal(handoverSeverity({ status: 'pending', ageHours: 0 }), 'fresh')
    assert.equal(handoverSeverity({ status: 'pending', ageHours: 23.9 }), 'fresh')
    assert.equal(handoverSeverity({ status: 'pending', ageHours: 24 }), 'late')
    assert.equal(handoverSeverity({ status: 'pending', ageHours: 71.9 }), 'late')
    assert.equal(handoverSeverity({ status: 'pending', ageHours: 72 }), 'overdue')
  })

  test('a disputed handover is "disputed" at any age', () => {
    assert.equal(handoverSeverity({ status: 'disputed', ageHours: 1 }), 'disputed')
    assert.equal(handoverSeverity({ status: 'disputed', ageHours: 500 }), 'disputed')
  })

  test('only pending is open: "not received" (disputed) is final since 20270418000000', () => {
    assert.equal(isOpenHandover({ status: 'pending' }), true)
    assert.equal(isOpenHandover({ status: 'disputed' }), false)
    assert.equal(isOpenHandover({ status: 'accepted' }), false)
    assert.equal(isOpenHandover({ status: 'cancelled' }), false)
    assert.deepEqual([...OPEN_HANDOVER_STATUSES], ['pending'])
    assert.equal(HANDOVER_STATUS_LABEL.disputed, 'Not received')
  })

  test('waitingFor reads in hours then days', () => {
    assert.equal(waitingFor(0.2), 'just now')
    assert.equal(waitingFor(1), '1 hour')
    assert.equal(waitingFor(5.9), '5 hours')
    assert.equal(waitingFor(24), '1 day')
    assert.equal(waitingFor(49), '2 days')
    assert.equal(waitingFor(Number.NaN), 'just now')
  })

  test('the headline is written from the viewer\'s own seat', () => {
    const x = h()
    assert.match(handoverHeadline(x, 'recipient'), /Ashok handed you cash/)
    assert.match(handoverHeadline(x, 'giver'), /Owner has not accepted your handover/)
    assert.match(handoverHeadline(x, 'observer'), /Owner has not accepted the cash from Ashok/)
    const d = h({ status: 'disputed' })
    assert.match(handoverHeadline(d, 'giver'), /Owner did not receive your handover/)
    assert.match(handoverHeadline(d, 'recipient'), /You did not receive the cash from Ashok/)
  })

  test('the recipient\'s cards come first, then louder, then older', () => {
    const asGiver = h({ id: 'g', giver_id: 'me', recipient_id: 'o', age_hours: 200 })
    const asRecipientFresh = h({ id: 'r1', giver_id: 'o', recipient_id: 'me', age_hours: 2 })
    const asRecipientOverdue = h({ id: 'r2', giver_id: 'o', recipient_id: 'me', age_hours: 100 })
    const disputed = h({ id: 'r3', giver_id: 'o', recipient_id: 'me', status: 'disputed', age_hours: 1 })
    const order = sortMyHandovers([asGiver, asRecipientFresh, asRecipientOverdue, disputed], 'me').map(x => x.id)
    assert.deepEqual(order, ['r3', 'r2', 'r1', 'g'])
  })
})

describe('the create form and the reasons', () => {
  const ok = { recipientId: 'u', paymentIds: ['p'], handedAt: '2026-01-01T10:00' }

  test('a complete draft has no error', () => {
    assert.equal(handoverDraftError(ok), null)
  })

  test('each missing piece is named', () => {
    assert.match(handoverDraftError({ ...ok, recipientId: '' }) ?? '', /who you are handing/)
    assert.match(handoverDraftError({ ...ok, paymentIds: [] }) ?? '', /at least one payment/)
    assert.match(handoverDraftError({ ...ok, handedAt: '' }) ?? '', /date and time/)
    assert.match(handoverDraftError({ ...ok, handedAt: 'not a date' }) ?? '', /valid date/)
  })

  test('more than 50 payments, or a future handover, is refused like the RPC does', () => {
    const many = Array.from({ length: 51 }, (_, i) => `p${i}`)
    assert.match(handoverDraftError({ ...ok, paymentIds: many }) ?? '', /at most 50/)
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString()
    assert.match(handoverDraftError({ ...ok, handedAt: future }) ?? '', /future/)
  })

  test('money is summed in paise', () => {
    assert.equal(sumRupees([0.1, 0.2]), 0.3)
    assert.equal(sumRupees([]), 0)
    assert.equal(sumRupees([12500.5, 99.99]), 12600.49)
  })

  test('a reason needs a few words and has a ceiling', () => {
    assert.ok(handoverReasonError(''))
    assert.ok(handoverReasonError('  a '))
    assert.equal(handoverReasonError('received less'), null)
    assert.ok(handoverReasonError('x'.repeat(501)))
  })
})

describe('the server\'s refusals, in words', () => {
  test('the code is dropped and the sentence kept', () => {
    assert.equal(
      handoverErrorMessage({ message: 'HANDOVER_NOT_HOLDER: you are not holding the cash of payment P-AA-0001.' }),
      'you are not holding the cash of payment P-AA-0001.',
    )
    assert.equal(
      handoverErrorMessage({ message: 'CUSTODY_MODE_NOT_APPLICABLE: only PNB and Paytm.' }),
      'only PNB and Paytm.',
    )
  })

  test('anything else is a generic sentence, never raw database text', () => {
    assert.equal(handoverErrorMessage({ message: 'duplicate key value violates unique constraint' }),
      'Something went wrong. Please try again.')
    assert.equal(handoverErrorMessage(null), 'Something went wrong. Please try again.')
  })

  test('a database without the migration is recognised', () => {
    assert.equal(isHandoverFeatureMissing({ code: 'PGRST202' }), true)
    assert.equal(isHandoverFeatureMissing({ code: '42883' }), true)
    assert.equal(isHandoverFeatureMissing({ message: 'Could not find the function public.finance_handover_list' }), true)
    assert.equal(isHandoverFeatureMissing({ code: '42501', message: 'permission denied' }), false)
    assert.equal(isHandoverFeatureMissing(null), false)
  })
})

describe('source contracts', () => {
  const LAYOUT = read('src/components/layout/FinanceLayout.tsx')
  const MODULES = read('src/app/modules/page.tsx')
  const BANNER = read('src/components/finance/HandoverBanner.tsx')
  const CARD = read('src/components/finance/HandoverCard.tsx')
  const NOTIFS = read('src/lib/notifications.ts')
  const SQL = read('supabase/migrations/20270410000100_finance_cash_handovers.sql')
  const ENUM = read('supabase/migrations/20270410000000_finance_handover_notification_types.sql')

  test('the banner is drawn by the Finance layout, so it is on EVERY Finance page', () => {
    assert.match(LAYOUT, /<HandoverBanner \/>/)
    assert.match(LAYOUT, /Hand over cash/)
  })

  test('and on the home screen, for recipients without Finance access', () => {
    // On the launcher, "Cash handed to you" in the For you panel, whatever the
    // person's Finance access: Accept is right there, through the same
    // accept_cash_handover door and the same "Yes, I received" confirmation as
    // the handover page. Any item makes the panel exist, Finance or not.
    const PANEL = readFileSync(join(process.cwd(), 'src/app/modules/AttentionPanel.tsx'), 'utf8').replace(/\r/g, '')
    assert.match(PANEL, /handoverRole\(h, viewerId\) === 'recipient' && h\.canAccept/)
    assert.match(PANEL, /await accept\.mutateAsync\(h\.id\)/)
    assert.match(PANEL, /<HandoverConfirmDialog/)
    assert.match(PANEL, /Accept only after the cash is in your hands/)
    assert.match(PANEL, /const show = s\.itemCount > 0 \|\|/)
    assert.match(MODULES, /<AttentionPanel/)
  })

  test('the banner has no dismiss control', () => {
    const code = BANNER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    assert.doesNotMatch(code, /dismiss|onClose|setHidden|localStorage/i)
  })

  test('the card announces itself as an alert for the people involved', () => {
    assert.match(CARD, /role=\{open && role !== 'observer' \? 'alert' : 'group'\}/)
  })

  test('accepting asks for confirmation before it writes', () => {
    assert.match(CARD, /Accept only after the cash is in your hands/)
  })

  test('every new notification type is in the Finance feed list and the enum migration', () => {
    for (const t of ['requested', 'accepted', 'disputed', 'cancelled', 'reminder']) {
      assert.ok(NOTIFS.includes(`'finance_handover_${t}'`), t)
      assert.ok(ENUM.includes(`'finance_handover_${t}'`), t)
    }
  })

  test('the enum values are alone in their migration (Postgres cannot use them in the same transaction)', () => {
    assert.doesNotMatch(ENUM, /create table|create or replace function/i)
  })

  test('writes are revoked from clients and every RPC pins its search_path', () => {
    assert.match(SQL, /revoke all on public\.finance_cash_handovers\s+from public, anon, authenticated/)
    assert.match(SQL, /revoke all on public\.finance_cash_handover_items\s+from public, anon, authenticated/)
    assert.match(SQL, /revoke all on public\.finance_cash_handover_events from public, anon, authenticated/)
    const defs = SQL.match(/security definer\s+set search_path = public, pg_temp/g) ?? []
    const secdef = SQL.match(/security definer/g) ?? []
    assert.equal(defs.length, secdef.length)
  })

  test('only the recipient accepts or disputes; only the giver (or an admin) cancels', () => {
    assert.match(SQL, /v_h\.recipient_user_id <> v_actor[\s\S]{0,200}only the person it was handed to can accept/)
    assert.match(SQL, /only the person it was handed to can dispute/)
    assert.match(SQL, /v_h\.giver_user_id <> v_actor and not v_admin/)
  })

  test('acceptance writes the custody events idempotently, keyed by the item', () => {
    assert.match(SQL, /append_payment_custody_events_internal/)
    assert.match(SQL, /'handover:' \|\| v_item\.item_id::text/)
  })

  test('a handover moves no money: no allocation, no payment status or amount write', () => {
    const code = SQL.replace(/--.*$/gm, '')
    assert.doesNotMatch(code, /finance_payment_allocations/)
    assert.doesNotMatch(code, /update\s+public\.finance_payment_requests/i)
  })

  test('the reminder sweep is executable by the service role only', () => {
    assert.match(SQL, /revoke all on function public\.finance_handover_send_reminders\(\) from public, anon, authenticated;\s*grant execute on function public\.finance_handover_send_reminders\(\) to service_role;/)
  })

  test('the cron route is registered and guarded by CRON_SECRET', () => {
    const cfg = JSON.parse(read('vercel.json'))
    assert.ok(cfg.crons.some((c: { path: string }) => c.path === '/api/finance/handovers/remind'))
    const route = read('src/app/api/finance/handovers/remind/route.ts')
    assert.match(route, /CRON_SECRET/)
    assert.match(route, /timingSafeEqual/)
  })
})
