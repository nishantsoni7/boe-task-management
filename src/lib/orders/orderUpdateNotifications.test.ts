/**
 * ORDER UPDATE NOTIFICATIONS — the four rules, asserted.
 *
 *   1. RECIPIENT RESOLUTION — who falls into which category, and what the
 *      Control Center switches do to that.
 *   2. ACTOR EXCLUSION — nobody is ever told about their own action, and no
 *      configuration can switch that off.
 *   3. WORDING — the sentence names the Order, what moved and who moved it,
 *      and repeats old/new values only where they are short and safe.
 *   4. THE EVENT MAP IS THE DEFINITION OF "MEANINGFUL" — and it agrees with
 *      the migration, the notification category list and the write funnel.
 *
 * Reads repository files only. No database, no network.
 *
 * Run:
 *   npx tsx --test "src/lib/orders/orderUpdateNotifications.test.ts"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ORDER_UPDATE_EVENT_KEYS,
  ORDER_UPDATE_NOTIFICATION_TYPES,
  ORDER_UPDATE_RECIPIENTS_DEFAULT,
  ORDER_UPDATE_RECIPIENT_LABEL,
  ORDER_UPDATE_RECIPIENT_ROLES,
  activityTypesForEvent,
  describeOrderUpdate,
  isOrderUpdateEvent,
  orderUpdateRolesFor,
  readRecipientConfig,
  resolveOrderUpdateRecipients,
  type OrderUpdateCandidate,
  type OrderUpdateRecipientRole,
} from './orderUpdateNotifications'
import { ORDER_NOTIFICATION_TYPES } from '@/lib/notifications'
import { insertUserNotifications, type NotificationInsert } from '@/lib/notificationWrites'
import {
  ORDER_UNREAD_TYPES,
  oldestUnreadAt,
  unreadUpdateCounts,
  unreadUpdateLabel,
} from './orderUnreadUpdates'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261202000000_order_update_notifications.sql'

// ── The cast ──────────────────────────────────────────────────────────────────

const SALESPERSON = 'u-sales'

const people: Record<string, OrderUpdateCandidate> = {
  admin:        { id: 'u-admin',  role: 'admin',  designation_level: null,          team: 'management' },
  superAdmin:   { id: 'u-super',  role: 'member', designation_level: 'super_admin', team: 'management' },
  salesperson:  { id: SALESPERSON, role: 'member', designation_level: null,         team: 'sales' },
  bdm:          { id: 'u-bdm',    role: 'member', designation_level: null,          team: 'bdm' },
  bystander:    { id: 'u-other',  role: 'member', designation_level: null,          team: 'design' },
  departedAdmin:{ id: 'u-gone',   role: 'admin',  designation_level: null,          team: 'management', is_deleted: true },
}

const everyone = Object.values(people)
const order = { assignedTo: SALESPERSON }
const allOn = { ...ORDER_UPDATE_RECIPIENTS_DEFAULT }

const resolve = (over: Partial<Parameters<typeof resolveOrderUpdateRecipients>[0]> = {}) =>
  resolveOrderUpdateRecipients({
    candidates: everyone, order, config: allOn, actorId: null, ...over,
  })

// ══ 1. Recipient resolution ═══════════════════════════════════════════════════

describe('which category a person falls into', () => {
  test('each of the four is decided by exactly the column it names', () => {
    assert.deepEqual(orderUpdateRolesFor(people.admin, order), ['admin'])
    assert.deepEqual(orderUpdateRolesFor(people.superAdmin, order), ['super_admin'])
    assert.deepEqual(orderUpdateRolesFor(people.salesperson, order), ['salesperson'])
    assert.deepEqual(orderUpdateRolesFor(people.bdm, order), ['bdm'])
  })

  test('somebody who matches nothing is in no category at all', () => {
    assert.deepEqual(orderUpdateRolesFor(people.bystander, order), [])
  })

  test('a person can be several at once, and is counted once', () => {
    const adminSalesperson: OrderUpdateCandidate =
      { id: SALESPERSON, role: 'admin', designation_level: 'super_admin', team: 'bdm' }
    assert.deepEqual(orderUpdateRolesFor(adminSalesperson, order),
      ['super_admin', 'admin', 'salesperson', 'bdm'])
    const ids = resolveOrderUpdateRecipients({
      candidates: [adminSalesperson, adminSalesperson], order, config: allOn, actorId: null,
    })
    assert.deepEqual(ids, [SALESPERSON], 'one row per person, never four')
  })

  test('the salesperson is THE person the Order names — never a whole team', () => {
    // Somebody else in sales is not the salesperson on this Order.
    const otherSalesPerson: OrderUpdateCandidate =
      { id: 'u-sales-2', role: 'member', designation_level: null, team: 'sales' }
    assert.deepEqual(orderUpdateRolesFor(otherSalesPerson, order), [])
  })

  test('an Order with no salesperson resolves nobody through that category', () => {
    assert.deepEqual(orderUpdateRolesFor(people.salesperson, { assignedTo: null }), [])
  })
})

describe('who is notified', () => {
  test('with everything on: every associated person, and nobody else', () => {
    assert.deepEqual(resolve(), ['u-admin', 'u-super', SALESPERSON, 'u-bdm'])
  })

  test('a NON-ASSOCIATED person receives nothing, whatever is switched on', () => {
    assert.ok(!resolve().includes('u-other'))
  })

  test('a departed employee is never notified, even as an administrator', () => {
    assert.ok(!resolve().includes('u-gone'))
  })

  test('a disabled category silences exactly that category and nothing else', () => {
    const noBdm = resolve({ config: { ...allOn, bdm: false } })
    assert.ok(!noBdm.includes('u-bdm'))
    assert.deepEqual(noBdm, ['u-admin', 'u-super', SALESPERSON])

    const noAdmin = resolve({ config: { ...allOn, admin: false } })
    assert.ok(!noAdmin.includes('u-admin'))
    assert.ok(noAdmin.includes('u-super'), 'a Super Admin is a separate switch')
  })

  test('every category off means nobody at all — and that is a skip, not a failure', () => {
    const off = { super_admin: false, admin: false, salesperson: false, bdm: false }
    assert.deepEqual(resolve({ config: off }), [])
  })

  test('a person in two categories survives one of them being switched off', () => {
    const adminBdm: OrderUpdateCandidate =
      { id: 'u-both', role: 'admin', designation_level: null, team: 'bdm' }
    const ids = resolveOrderUpdateRecipients({
      candidates: [adminBdm], order, config: { ...allOn, bdm: false }, actorId: null,
    })
    assert.deepEqual(ids, ['u-both'], 'still an administrator')
  })
})

// ══ 2. Actor exclusion ════════════════════════════════════════════════════════

describe('the actor is never told about their own action', () => {
  test('an administrator who changes something does not hear about it', () => {
    const ids = resolve({ actorId: 'u-admin' })
    assert.ok(!ids.includes('u-admin'))
    assert.deepEqual(ids, ['u-super', SALESPERSON, 'u-bdm'], 'and everybody else still does')
  })

  test('a salesperson who changes the status does not hear about it', () => {
    const ids = resolve({ actorId: SALESPERSON })
    assert.ok(!ids.includes(SALESPERSON))
    assert.ok(ids.includes('u-admin'))
  })

  test('NO CONFIGURATION CAN TURN THIS OFF — the rule is not a switch', () => {
    for (const role of ORDER_UPDATE_RECIPIENT_ROLES) {
      const onlyThis = {
        super_admin: false, admin: false, salesperson: false, bdm: false, [role]: true,
      } as Record<OrderUpdateRecipientRole, boolean>
      assert.ok(!resolve({ actorId: 'u-admin', config: onlyThis }).includes('u-admin'), role)
    }
  })

  test('and the write funnel refuses the same row a second time', async () => {
    // Belt and braces: even if a future call site resolved recipients some
    // other way, insertUserNotifications drops a row addressed to the actor.
    const sent: NotificationInsert[][] = []
    const client = {
      from: () => ({
        insert: (rows: NotificationInsert[]) => {
          sent.push(rows)
          return Promise.resolve({ error: null })
        },
      }),
    }
    const rows: NotificationInsert[] = [
      { user_id: 'u-admin', entity_id: 'o1', type: 'order_update_status', title: 'x' },
      { user_id: 'u-bdm',   entity_id: 'o1', type: 'order_update_status', title: 'x' },
    ]
    const result = await insertUserNotifications(client, rows, { actorId: 'u-admin' })
    assert.equal(result.selfSuppressed, 1)
    assert.equal(result.inserted, 1)
    assert.deepEqual(sent[0].map(r => r.user_id), ['u-bdm'])
    assert.equal(result.error, null, 'suppression is never an error')
  })
})

// ══ 3. The configuration ══════════════════════════════════════════════════════

describe('reading the stored configuration', () => {
  test('no rows at all means the seeded default: everything on', () => {
    assert.deepEqual(readRecipientConfig(null), ORDER_UPDATE_RECIPIENTS_DEFAULT)
    assert.deepEqual(readRecipientConfig([]), ORDER_UPDATE_RECIPIENTS_DEFAULT)
  })

  test('a stored false is respected; a missing row keeps the default', () => {
    const config = readRecipientConfig([{ recipient_role: 'bdm', enabled: false }])
    assert.equal(config.bdm, false)
    assert.equal(config.admin, true, 'undecided is not off')
  })

  test('an unknown key is ignored rather than trusted', () => {
    const config = readRecipientConfig([
      { recipient_role: 'accounts', enabled: false },
      { recipient_role: 42, enabled: false },
    ])
    assert.deepEqual(config, ORDER_UPDATE_RECIPIENTS_DEFAULT)
  })

  test('the four keys are the migration\'s four, exactly', () => {
    const sql = read(MIGRATION)
    for (const role of ORDER_UPDATE_RECIPIENT_ROLES) {
      assert.ok(sql.includes(`'${role}'`), `${role} is missing from the migration`)
    }
    // The CHECK closes the set on the database side too.
    assert.match(sql, /check \(recipient_role in \('super_admin', 'admin', 'salesperson', 'bdm'\)\)/)
    // And every one is seeded, so nothing depends on the fail-open default.
    assert.match(sql, /values \('super_admin', true\), \('admin', true\), \('salesperson', true\), \('bdm', true\)/)
  })

  test('every category has words an administrator can read', () => {
    for (const role of ORDER_UPDATE_RECIPIENT_ROLES) {
      assert.ok(ORDER_UPDATE_RECIPIENT_LABEL[role].length > 0, role)
    }
    // The BDM label says what it actually resolves to, rather than implying a
    // per-Order association this database has never recorded.
    assert.match(ORDER_UPDATE_RECIPIENT_LABEL.bdm, /department/i)
  })

  test('the configuration is admin-only, and fail-closed for everyone else', () => {
    const sql = read(MIGRATION)
    assert.match(sql, /alter table public\.order_notification_recipients enable row level security/)
    assert.match(sql, /order_notification_recipients_admin_select[\s\S]*?u\.role = 'admin'/)
    assert.match(sql, /order_notification_recipients_admin_update[\s\S]*?u\.role = 'admin'/)
    // No employee policy exists, so a non-admin SELECT returns nothing and a
    // non-admin write is refused by RLS rather than by the page.
    assert.equal(/for select to authenticated\s*\n\s*using \(exists \(select 1 from public\.users u where u\.id = auth\.uid\(\) and u\.role = 'member'/.test(sql), false)
  })
})

// ══ 4. What counts as meaningful ══════════════════════════════════════════════

describe('the event map is the definition of "meaningful"', () => {
  test('four events, four notification types, all distinct', () => {
    assert.deepEqual(ORDER_UPDATE_EVENT_KEYS, ['status', 'amended', 'production', 'payment'])
    assert.equal(new Set(ORDER_UPDATE_NOTIFICATION_TYPES).size, 4)
  })

  test('every type exists in the database enum', () => {
    const sql = read(MIGRATION)
    for (const type of ORDER_UPDATE_NOTIFICATION_TYPES) {
      assert.ok(
        sql.includes(`add value if not exists '${type}'`),
        `${type} is not added to notification_type`,
      )
    }
  })

  test('every type reaches the Orders feed, the bell and mark-all-read', () => {
    for (const type of ORDER_UPDATE_NOTIFICATION_TYPES) {
      assert.ok((ORDER_NOTIFICATION_TYPES as readonly string[]).includes(type),
        `${type} would be written but never shown`)
    }
  })

  test('the list badge counts exactly those four and nothing else', () => {
    assert.deepEqual([...ORDER_UNREAD_TYPES], [...ORDER_UPDATE_NOTIFICATION_TYPES])
  })

  test('an unlisted activity event raises nothing', () => {
    const all = ORDER_UPDATE_EVENT_KEYS.flatMap(k => [...activityTypesForEvent(k)])
    for (const bookkeeping of [
      'order_product_codes_assigned',
      'order_created_from_pi_submission',
      'order_created_from_request',
      'created',
      'note_added',
    ]) {
      assert.ok(!all.includes(bookkeeping), `${bookkeeping} must not raise a notification`)
    }
  })

  test('the events that DO matter are all covered', () => {
    const all = ORDER_UPDATE_EVENT_KEYS.flatMap(k => [...activityTypesForEvent(k)])
    for (const meaningful of [
      'status_changed', 'order_amended', 'production_alignment_changed',
      'payment_verified', 'payment_rejected',
    ]) {
      assert.ok(all.includes(meaningful), `${meaningful} should raise a notification`)
    }
  })

  test('an unknown event name is refused before anything is read', () => {
    for (const bad of ['', 'STATUS', 'anything', null, 42, {}]) {
      assert.equal(isOrderUpdateEvent(bad), false, String(bad))
    }
    assert.equal(isOrderUpdateEvent('status'), true)
  })

  test('nothing anywhere notifies on a timestamp', () => {
    const sql = read(MIGRATION)
    assert.equal(/create trigger[\s\S]*?on public\.orders/i.test(sql), false,
      'a row trigger on orders would fire on every updated_at')
    // The route's own reads, with its prose removed: this is about what it
    // QUERIES, and the header explains at length why it does not watch a
    // timestamp.
    const route = read('src/app/api/orders/[id]/notify/route.ts')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    assert.ok(route.includes("from('order_activity_log')"),
      'the event source is the audit log')
    assert.equal(route.includes('updated_at'), false,
      'no timestamp column is read, compared or notified on')
    assert.ok(route.includes(".eq('actor_id', user.id)"),
      'and only an event the caller themselves performed may be announced')
  })
})

// ══ 5. The wording ════════════════════════════════════════════════════════════

const say = (
  event: Parameters<typeof describeOrderUpdate>[0],
  activity: { event_type: string; payload: Record<string, unknown> },
  actor: string | null = 'Ashok',
) => describeOrderUpdate(event, 'BOE-147', actor, activity)

describe('what the notification says', () => {
  test('a status change names the Order, both states and the person', () => {
    const m = say('status', { event_type: 'status_changed', payload: { from: 'running', to: 'dispatched' } })
    assert.equal(m?.title, 'BOE-147 status changed from Running to Dispatched by Ashok.')
    assert.equal(m?.type, 'order_update_status')
  })

  test('a cancellation carries its reason on the second line, not in the sentence', () => {
    const m = say('status', {
      event_type: 'status_changed',
      payload: { from: 'running', to: 'cancelled', reason: 'Customer withdrew' },
    })
    assert.equal(m?.title, 'BOE-147 status changed from Running to Cancelled by Ashok.')
    assert.equal(m?.body, 'Reason: Customer withdrew')
  })

  test('a status that did not actually move says nothing', () => {
    assert.equal(say('status', { event_type: 'status_changed', payload: { from: 'running', to: 'running' } }), null)
  })

  test('a due date change shows the movement — short, safe, and the whole point', () => {
    const m = say('amended', {
      event_type: 'order_amended',
      payload: { changes: { due_date: { from: '2026-09-24', to: '2026-09-28' } } },
    }, 'Nitish')
    assert.equal(m?.title, 'BOE-147 due date changed from 2026-09-24 to 2026-09-28 by Nitish.')
  })

  test('a confirm date and a lead source do the same', () => {
    assert.match(
      say('amended', { event_type: 'order_amended', payload: { changes: { confirm_date: { from: null, to: '2026-09-01' } } } })?.title ?? '',
      /confirm date changed from — to 2026-09-01 by Ashok\./,
    )
    assert.match(
      say('amended', { event_type: 'order_amended', payload: { changes: { lead_source: { from: 'website', to: 'reference' } } } })?.title ?? '',
      /lead source changed from Website to Reference by Ashok\./,
    )
  })

  test('FREE TEXT AND MONEY ARE NAMED, NEVER REPEATED', () => {
    // A client name is something somebody typed, and a one-line summary is not
    // where it belongs. The field is named; the values stay on the page.
    const m = say('amended', {
      event_type: 'order_amended',
      payload: { changes: { client_name: { from: 'Old Pvt Ltd', to: 'New Pvt Ltd' } } },
    })
    assert.equal(m?.title, 'BOE-147 client name was changed by Ashok.')
    assert.ok(!m?.title.includes('Old Pvt Ltd'))

    const money = say('amended', {
      event_type: 'order_amended',
      payload: { changes: { total_value: { from: 100, to: 200 } } },
    })
    assert.equal(money?.title, 'BOE-147 total order value was changed by Ashok.')
  })

  test('several fields at once are listed, and the values left to the trail', () => {
    const m = say('amended', {
      event_type: 'order_amended',
      payload: {
        reason: 'Client asked',
        changes: {
          due_date:    { from: '2026-09-24', to: '2026-09-28' },
          lead_source: { from: 'website', to: 'reference' },
        },
      },
    })
    assert.equal(m?.title, 'BOE-147 was amended by Ashok: due date, lead source.')
    assert.equal(m?.body, 'Client asked')
  })

  test('an amendment with no change list still names what kind it was', () => {
    assert.equal(
      say('amended', { event_type: 'order_workbook_replaced', payload: { reason: 'Wrong file' } })?.title,
      'BOE-147 — PI workbook was replaced by Ashok.',
    )
    assert.equal(
      say('amended', { event_type: 'order_products_amended', payload: {} })?.title,
      'BOE-147 — products were amended by Ashok.',
    )
  })

  test('production alignment says which way it moved', () => {
    assert.equal(
      say('production', { event_type: 'production_alignment_changed', payload: { from: 'not_aligned', to: 'aligned' } })?.title,
      'BOE-147 was aligned for production by Ashok.',
    )
    assert.equal(
      say('production', { event_type: 'production_alignment_changed', payload: { from: 'aligned', to: 'not_aligned' } })?.title,
      'BOE-147 was moved back to not aligned by Ashok.',
    )
  })

  test('a payment states the ALLOCATED figure, in rupees, to the paise', () => {
    const m = say('payment', {
      event_type: 'payment_verified',
      payload: { allocated_amount: 150000, payment_amount: 900000, human_payment_id: 'PAY-0012' },
    }, 'Nishant')
    assert.equal(m?.title, 'Payment of ₹1,50,000.00 verified for BOE-147 by Nishant.')
    assert.equal(m?.body, 'Payment PAY-0012')
    assert.equal(m?.type, 'order_update_payment')
  })

  test('a rejection and an unlink read as what they are', () => {
    assert.match(
      say('payment', { event_type: 'payment_rejected', payload: { allocated_amount: 5000 } })?.title ?? '',
      /rejected for BOE-147/,
    )
    assert.match(
      say('payment', { event_type: 'payment_unlinked', payload: {} })?.title ?? '',
      /^A payment unlinked from BOE-147/,
    )
  })

  test('an unknown actor drops the attribution rather than inventing one', () => {
    const m = say('status', { event_type: 'status_changed', payload: { from: 'running', to: 'on_hold' } }, null)
    assert.equal(m?.title, 'BOE-147 status changed from Running to On Hold.')
    assert.ok(!m?.title.includes('by'))
  })

  test('every sentence names the Order', () => {
    for (const [event, activity] of [
      ['status',     { event_type: 'status_changed', payload: { from: 'running', to: 'on_hold' } }],
      ['amended',    { event_type: 'order_amended', payload: { changes: { due_date: { from: 'a', to: 'b' } } } }],
      ['production', { event_type: 'production_alignment_changed', payload: { to: 'aligned' } }],
      ['payment',    { event_type: 'payment_verified', payload: { allocated_amount: 1 } }],
    ] as const) {
      assert.ok(say(event, activity)?.title.includes('BOE-147'), event)
    }
  })
})

// ══ 6. Per-user unread ════════════════════════════════════════════════════════

describe('the unread state the list reads', () => {
  test('counts per Order, and ignores a row that names none', () => {
    const counts = unreadUpdateCounts([
      { entity_id: 'o1' }, { entity_id: 'o1' }, { entity_id: 'o2' }, { entity_id: null },
    ])
    assert.equal(counts.get('o1'), 2)
    assert.equal(counts.get('o2'), 1)
    assert.equal(counts.size, 2)
  })

  test('the badge says the count only when the count tells you something', () => {
    assert.equal(unreadUpdateLabel(1), 'NEW UPDATE')
    assert.equal(unreadUpdateLabel(2), '2 NEW UPDATES')
    assert.equal(unreadUpdateLabel(0), null)
    assert.equal(unreadUpdateLabel(-1), null)
  })

  test('"new since" is the OLDEST unread, so nothing unseen hides behind it', () => {
    assert.equal(oldestUnreadAt([
      { entity_id: 'o1', created_at: '2026-09-08T10:00:00Z' },
      { entity_id: 'o1', created_at: '2026-09-05T10:00:00Z' },
      { entity_id: 'o1', created_at: '2026-09-09T10:00:00Z' },
    ]), '2026-09-05T10:00:00Z')
  })

  test('missing and unparseable timestamps are ignored, never treated as zero', () => {
    assert.equal(oldestUnreadAt([{ entity_id: 'o1', created_at: null }]), null)
    assert.equal(oldestUnreadAt([
      { entity_id: 'o1', created_at: 'not a date' },
      { entity_id: 'o1', created_at: '2026-09-05T10:00:00Z' },
    ]), '2026-09-05T10:00:00Z')
    assert.equal(oldestUnreadAt([]), null)
  })

  test('unread is ONE row per person — never a column on the Order', () => {
    const sql = read(MIGRATION)
    assert.equal(/alter table public\.orders/i.test(sql), false,
      'the orders table must not gain an update flag')
    assert.equal(/order_has_update/i.test(sql), false)

    // And the read/mark path is scoped to the caller by the route itself.
    const markRead = read('src/app/api/notifications/mark-read/route.ts')
    assert.ok(markRead.includes("query.eq('entity_id', entityId as string)"))
    assert.ok(markRead.includes(".eq('user_id', user.id)"),
      'every mark-read statement is scoped to the caller')
  })

  test('the index that serves it is partial on unread, and covers the lookup', () => {
    const sql = read(MIGRATION)
    assert.match(sql, /create index if not exists notifications_entity_unread_idx\s*\n\s*on public\.notifications \(user_id, type, entity_id\)\s*\n\s*where is_read = false;/)
  })
})
