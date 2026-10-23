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
  adjustmentError,
  cashEntryLabel,
  cashOutError,
  handoverCash,
  handoverContentsLabel,
  readCashBalance,
  readCashBalances,
  handoverDraftError,
  handoverErrorMessage,
  handoverHeadline,
  handoverReasonError,
  handoverRole,
  handoverSeverity,
  isHandoverFeatureMissing,
  isOpenHandover,
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

  test('only pending and disputed are open', () => {
    assert.equal(isOpenHandover({ status: 'pending' }), true)
    assert.equal(isOpenHandover({ status: 'disputed' }), true)
    assert.equal(isOpenHandover({ status: 'accepted' }), false)
    assert.equal(isOpenHandover({ status: 'cancelled' }), false)
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
    assert.match(handoverHeadline(d, 'giver'), /disputed your handover/)
    assert.match(handoverHeadline(d, 'recipient'), /You disputed/)
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
    assert.match(handoverDraftError({ ...ok, paymentIds: [] }) ?? '', /payment or enter a cash amount/)
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
    assert.match(MODULES, /<HandoverBanner \/>/)
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

describe('typed cash and cash in hand (20270412000000)', () => {
  const money = (n: number) => `Rs${n}`
  const CASH_SQL = read('supabase/migrations/20270412000000_finance_handover_cash_balance.sql')
  const strip = (s: string) => s.replace(/--.*$/gm, '')

  test('a handover row carries its typed cash line', () => {
    const x = h({ cash_from_hand: 300, cash_new: 200.5, cash_new_source: 'Acme at office' })
    assert.equal(x.cashFromHand, 300)
    assert.equal(x.cashNew, 200.5)
    assert.equal(x.cashNewSource, 'Acme at office')
    assert.equal(handoverCash(x), 500.5)
  })

  test('an old row without cash fields reads as no typed cash', () => {
    const x = h()
    assert.equal(x.cashFromHand, 0)
    assert.equal(x.cashNew, 0)
    assert.equal(x.cashNewSource, null)
  })

  test('the contents label names payments, cash, or both', () => {
    assert.equal(handoverContentsLabel(h(), money), '1 payment')
    assert.equal(handoverContentsLabel(h({ items: [], cash_new: 50, cash_new_source: 'tin' }), money), 'Rs50 cash')
    assert.equal(handoverContentsLabel(h({ cash_from_hand: 10 }), money), '1 payment + Rs10 cash')
  })

  const base = { recipientId: 'u', paymentIds: [] as string[], handedAt: '2026-01-01T10:00' }

  test('a cash-only draft is valid; an empty one is not', () => {
    assert.equal(handoverDraftError({ ...base, cashNew: '500', cashNewSource: 'Acme' }), null)
    assert.equal(handoverDraftError({ ...base, cashFromHand: '100', available: 200 }), null)
    assert.match(handoverDraftError(base) ?? '', /payment or enter a cash amount/)
    assert.match(handoverDraftError({ ...base, cashNew: '0' }) ?? '', /payment or enter a cash amount/)
  })

  test('new cash needs a source; from-hand cannot exceed what is available', () => {
    assert.match(handoverDraftError({ ...base, cashNew: '500' }) ?? '', /where the new cash came from/)
    assert.match(handoverDraftError({ ...base, cashNew: '500', cashNewSource: 'ab' }) ?? '', /where the new cash came from/)
    assert.match(handoverDraftError({ ...base, cashFromHand: '300', available: 200 }) ?? '', /more than the cash you have available/)
  })

  test('a typed amount with three decimals is refused, never rounded', () => {
    assert.match(handoverDraftError({ ...base, cashNew: '10.555', cashNewSource: 'x shop' }) ?? '', /two decimal places/)
  })

  test('balances are read field for field, unknown entry kinds dropped', () => {
    const b = readCashBalance({
      balance: '650', reserved: 100, available: 550,
      entries: [
        { id: 'e1', delta: -600, kind: 'handover_out', handover_human_id: 'H-0002', counterpart_name: 'Nita', created_at: 'x' },
        { id: 'e2', delta: 50, kind: 'mystery', created_at: 'x' },
        { id: 'e3', delta: -100, kind: 'cash_out', cash_out_kind: 'bank_deposit', note: 'slip 1', created_at: 'x' },
      ],
    })
    assert.equal(b.balance, 650); assert.equal(b.available, 550)
    assert.deepEqual(b.entries.map(e => e.id), ['e1', 'e3'])
    assert.equal(cashEntryLabel(b.entries[0]), 'Handed to Nita (H-0002)')
    assert.equal(cashEntryLabel(b.entries[1]), 'Deposited in the bank: slip 1')
    const all = readCashBalances({ allowed: true, can_adjust: 'yes', rows: [{ user_id: 'u1', full_name: 'Owner', balance: 5, reserved: 0, available: 5 }, {}] })
    assert.equal(all.allowed, true); assert.equal(all.canAdjust, false); assert.equal(all.rows.length, 1)
  })

  test('cash out and adjustment forms mirror the database rules', () => {
    assert.equal(cashOutError({ amount: '100', kind: 'bank_deposit', note: 'slip 44', available: 200 }), null)
    assert.match(cashOutError({ amount: '300', kind: 'bank_deposit', note: 'slip 44', available: 200 }) ?? '', /more than/)
    assert.match(cashOutError({ amount: '100', kind: 'bank_deposit', note: 'x', available: 200 }) ?? '', /short note/)
    assert.match(cashOutError({ amount: '100', kind: 'nope', note: 'slip 44', available: 200 }) ?? '', /what happened/)
    assert.equal(adjustmentError({ amount: '50', direction: 'remove', reason: 'counted short', available: 100 }), null)
    assert.match(adjustmentError({ amount: '150', direction: 'remove', reason: 'counted short', available: 100 }) ?? '', /below/)
    assert.equal(adjustmentError({ amount: '150', direction: 'add', reason: 'opening', available: 0 }), null)
    assert.match(adjustmentError({ amount: '10', direction: 'add', reason: '', available: 0 }) ?? '', /reason/)
  })

  test('create_cash_handover has exactly one signature after the migration', () => {
    assert.match(CASH_SQL, /drop function if exists public\.create_cash_handover\(uuid, uuid\[\], timestamptz, text, text\);/)
    assert.match(CASH_SQL, /grant execute on function public\.create_cash_handover\(uuid, uuid\[\], timestamptz, text, text, numeric, numeric, text\) to authenticated/)
  })

  test('the ledger is append-only and only the RPCs write it', () => {
    assert.match(CASH_SQL, /revoke all on public\.finance_cash_balance_entries from public, anon, authenticated;/)
    assert.match(CASH_SQL, /grant select on public\.finance_cash_balance_entries to authenticated;/)
    assert.match(CASH_SQL, /before update or delete on public\.finance_cash_balance_entries/)
    for (const fn of ['finance_cash_balance', 'finance_cash_reserved', 'finance_cash_available', 'finance_cash_lock']) {
      assert.ok(CASH_SQL.includes(`revoke all on function public.${fn}(uuid) from public, anon, authenticated;`), fn)
    }
  })

  test('every write to a balance takes the person lock first; adjust is admin only', () => {
    const code = strip(CASH_SQL)
    assert.match(code, /perform public\.finance_cash_lock\(v_actor\);\s*if v_from_hand > public\.finance_cash_available\(v_actor\)/)
    assert.match(code, /perform public\.finance_cash_lock\(least\(v_h\.giver_user_id, v_h\.recipient_user_id\)\)/)
    assert.match(code, /u\.role = 'admin'[\s\S]{0,120}only an administrator can adjust cash in hand/)
  })

  test('still not financial: no payment amount, total or allocation is written', () => {
    const code = strip(CASH_SQL)
    assert.doesNotMatch(code, /finance_payment_allocations/)
    assert.doesNotMatch(code, /update\s+public\.finance_payment_requests/i)
  })

  test('the form sends the three cash arguments by name', () => {
    const hook = read('src/hooks/queries/useHandovers.ts')
    for (const arg of ['p_cash_from_hand', 'p_cash_new', 'p_cash_new_source']) assert.ok(hook.includes(arg), arg)
  })
})
