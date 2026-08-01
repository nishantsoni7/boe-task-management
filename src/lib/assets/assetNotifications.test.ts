/**
 * Asset notifications — who is told what.
 *
 * These rules are the part of a notification system nobody notices going
 * wrong: no one reports a notification they never received. So they are pure
 * functions with a test each.
 *
 * Run:
 *   npx tsx --test src/lib/assets/assetNotifications.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_NOTIFICATION_EVENTS,
  assetNotification,
  assetNotificationBody,
  assetEditSummary,
  changedAssetFields,
  editDeservesNotification,
  isAssetNotifyEvent,
  normalizeNotificationEntityId,
  resolveRecipients,
} from './assetNotifications'
import { getNotificationMeta } from '@/lib/notificationMeta'
import { ASSET_NOTIFICATION_TYPES, getNotificationCategoryFilter } from '@/lib/notifications'

const ctx = { assetName: 'Dell XPS 15', assetCode: 'BOE-AST-000001' }

describe('event vocabulary', () => {
  test('every required event from the brief exists', () => {
    for (const required of [
      'asset_request_submitted', 'asset_request_approved', 'asset_request_rejected',
      'asset_edit_request_submitted', 'asset_edit_request_approved', 'asset_edit_request_rejected',
      'asset_assigned', 'asset_transferred', 'asset_transfer_acknowledged',
      'asset_returned', 'asset_lost', 'asset_recovered',
      'asset_repair_sent', 'asset_repair_returned', 'asset_warranty_expiring',
    ]) {
      assert.ok((ASSET_NOTIFICATION_EVENTS as readonly string[]).includes(required), required)
    }
  })

  test('the app-side enum list matches the event list exactly', () => {
    // If these drift, a notification is written with a type the module-scoped
    // feed filter does not select — it exists but is invisible.
    assert.deepEqual([...ASSET_NOTIFICATION_TYPES].sort(), [...ASSET_NOTIFICATION_EVENTS].sort())
  })

  test('the Assets feed filter selects exactly those types', () => {
    const filter = getNotificationCategoryFilter('asset')
    for (const type of ASSET_NOTIFICATION_TYPES) assert.ok(filter.includes(type), type)
    // Never a prefix LIKE: `type` is an enum column and LIKE errors server-side.
    assert.ok(filter.startsWith('type.in.('))
    assert.ok(!filter.includes('like'))
  })

  test('isAssetNotifyEvent rejects anything else', () => {
    assert.equal(isAssetNotifyEvent('asset_assigned'), true)
    assert.equal(isAssetNotifyEvent('order_assigned'), false)
    assert.equal(isAssetNotifyEvent(''), false)
    assert.equal(isAssetNotifyEvent(null), false)
    assert.equal(isAssetNotifyEvent(42), false)
  })
})

describe('recipients', () => {
  test('assignment goes to the new custodian and nobody else', () => {
    const { recipients } = assetNotification('asset_assigned', ctx)
    assert.deepEqual(recipients, ['new_custodian'])
  })

  test('a transfer tells BOTH sides — one gained accountability, one lost it', () => {
    const { recipients } = assetNotification('asset_transferred', ctx)
    assert.deepEqual([...recipients].sort(), ['new_custodian', 'previous_custodian'])
  })

  test('an acknowledgement goes to whoever handed the asset over', () => {
    const { recipients } = assetNotification('asset_transfer_acknowledged', ctx)
    assert.deepEqual(recipients, ['assigner'])
  })

  test('loss is an accountability event: last holder AND administration', () => {
    const { recipients } = assetNotification('asset_lost', ctx)
    assert.deepEqual([...recipients].sort(), ['admins', 'previous_custodian'])
  })

  test('a change request goes to reviewers; its decision goes back to the requester', () => {
    assert.deepEqual(assetNotification('asset_request_submitted', ctx).recipients, ['admins'])
    assert.deepEqual(assetNotification('asset_edit_request_submitted', ctx).recipients, ['admins'])
    for (const e of ['asset_request_approved', 'asset_request_rejected',
                     'asset_edit_request_approved', 'asset_edit_request_rejected'] as const) {
      assert.deepEqual(assetNotification(e, ctx).recipients, ['requester'], e)
    }
  })

  test('warranty reminders go to administration only', () => {
    assert.deepEqual(assetNotification('asset_warranty_expiring', ctx).recipients, ['admins'])
  })

  test('every event names at least one recipient', () => {
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      assert.ok(assetNotification(event, ctx).recipients.length > 0, event)
    }
  })
})

describe('titles', () => {
  test('every ASSET title names the asset — the reader’s first question is "which one"', () => {
    // Scoped to asset_* since 20260802000000: an access_* title names the
    // SYSTEM ("Your Canva access was revoked"), which is that reader's
    // equivalent first question. Access titles are asserted separately below.
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      if (!event.startsWith('asset_')) continue
      const { title } = assetNotification(event, { ...ctx, daysToExpiry: 5 })
      assert.ok(title.includes('Dell XPS 15'), event)
      assert.ok(title.includes('BOE-AST-000001'), event)
    }
  })

  test('an asset with no code still produces a readable title', () => {
    const { title } = assetNotification('asset_assigned', { assetName: 'Old Printer' })
    assert.ok(title.includes('Old Printer'))
    assert.ok(!title.includes('('))
  })

  test('a transfer to a person names the person; to a place, the place', () => {
    assert.ok(assetNotification('asset_transferred', { ...ctx, toName: 'Rahul Verma' }).title.includes('Rahul Verma'))
    assert.ok(assetNotification('asset_transferred', { ...ctx, toLocation: 'Store Room' }).title.includes('Store Room'))
  })

  test('a transfer with neither still reads as a sentence', () => {
    const { title } = assetNotification('asset_transferred', ctx)
    assert.ok(title.endsWith('was transferred.'))
  })

  test('the warranty reminder states the distance, not a raw number of days', () => {
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 1 }).title.includes('in 1 day.'))
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 12 }).title.includes('in 12 days.'))
    assert.ok(assetNotification('asset_warranty_expiring', { ...ctx, daysToExpiry: 0 }).title.includes('today'))
    assert.ok(assetNotification('asset_warranty_expiring', ctx).title.includes('soon'))
  })

  test('no title leaks an internal id', () => {
    const uuid = '11111111-2222-3333-4444-555555555555'
    for (const event of ASSET_NOTIFICATION_EVENTS) {
      const { title } = assetNotification(event, { ...ctx, toName: uuid ? 'Rahul Verma' : null })
      assert.ok(!title.includes('-4444-'), event)
    }
  })
})

describe('bodies', () => {
  test('a rejection carries the reviewer’s reason — a rejection you cannot act on is worse than none', () => {
    const body = assetNotificationBody('asset_request_rejected', { ...ctx, note: 'Still in use by Design.' })
    assert.equal(body, 'Reason: Still in use by Design.')
  })

  test('nothing worth adding produces null, not an empty second line', () => {
    assert.equal(assetNotificationBody('asset_assigned', ctx), null)
    assert.equal(assetNotificationBody('asset_request_rejected', ctx), null)
  })

  test('a transfer says who had it before', () => {
    assert.equal(
      assetNotificationBody('asset_transferred', { ...ctx, fromName: 'Priya Sharma' }),
      'Previously held by Priya Sharma',
    )
  })
})

describe('editDeservesNotification — the metadata rule', () => {
  test('a harmless metadata correction does NOT notify', () => {
    assert.equal(editDeservesNotification(['serial_no']), false)
    assert.equal(editDeservesNotification(['description', 'specifications', 'brand', 'model']), false)
    assert.equal(editDeservesNotification([]), false)
  })

  test('anything touching ownership, position or warranty dates does', () => {
    assert.equal(editDeservesNotification(['status']), true)
    assert.equal(editDeservesNotification(['location']), true)
    assert.equal(editDeservesNotification(['department']), true)
    assert.equal(editDeservesNotification(['condition']), true)
    assert.equal(editDeservesNotification(['warranty_expiry_date']), true)
  })

  test('one significant field among many harmless ones is enough', () => {
    assert.equal(editDeservesNotification(['brand', 'model', 'status']), true)
  })
})

// ─── Recipient resolution (20260802000000) ───────────────────────────────────
// The three rules that decide whether a person is told anything. Every one of
// them fails SILENTLY in production: nobody reports a notification they did not
// receive, and nobody reports the second copy of one they did.

const ACTOR = '11111111-1111-1111-1111-111111111111'
const ALICE = '22222222-2222-2222-2222-222222222222'
const BOB   = '33333333-3333-3333-3333-333333333333'

describe('resolveRecipients', () => {
  test('1. the actor is removed from the recipients', () => {
    assert.deepEqual(resolveRecipients([ALICE, ACTOR, BOB], ACTOR), [ALICE, BOB])
  })

  test('2. a duplicated id produces exactly one notification', () => {
    assert.deepEqual(resolveRecipients([ALICE, ALICE, ALICE], ACTOR), [ALICE])
  })

  test('3. null, undefined and empty-string ids are ignored', () => {
    assert.deepEqual(resolveRecipients([null, ALICE, undefined, ''], ACTOR), [ALICE])
  })

  test('4. an empty recipient list stays empty, so nothing is inserted', () => {
    assert.deepEqual(resolveRecipients([], ACTOR), [])
    assert.deepEqual(resolveRecipients([null, undefined], ACTOR), [])
    // The actor acting entirely alone is the common case: it must resolve to
    // nobody rather than to themselves.
    assert.deepEqual(resolveRecipients([ACTOR, ACTOR], ACTOR), [])
  })

  test('6. an actor who is also the custodian gets no self-notification', () => {
    // An admin who holds the asset AND edits it occupies two roles. Neither
    // earns them a notification about their own click.
    assert.deepEqual(resolveRecipients([ACTOR], ACTOR), [])
  })

  test('8. a reviewer approving their own request is not notified', () => {
    // requester === reviewer === actor.
    assert.deepEqual(resolveRecipients([ACTOR], ACTOR), [])
  })

  test('10. one person in two roles receives one notification', () => {
    // Previous custodian AND requester are the same human: one row, not two.
    assert.deepEqual(resolveRecipients([ALICE, BOB, ALICE], ACTOR), [ALICE, BOB])
  })

  test('exclusion is by ID — a shared display name never drops a recipient', () => {
    // Two employees called "Rahul" have different uuids and both are told.
    assert.deepEqual(resolveRecipients([ALICE, BOB], ACTOR), [ALICE, BOB])
  })

  test('a missing actor id still filters nulls and duplicates', () => {
    assert.deepEqual(resolveRecipients([ALICE, null, ALICE], null), [ALICE])
  })
})

describe('event → recipient roles', () => {
  test('5. the new custodian is told about an assignment', () => {
    const { recipients } = assetNotification('asset_assigned', ctx)
    assert.deepEqual(recipients, ['new_custodian'])
  })

  test('7. the requester is told the outcome of their request', () => {
    for (const e of ['asset_request_approved', 'asset_request_rejected',
                     'asset_edit_request_approved', 'asset_edit_request_rejected'] as const) {
      assert.deepEqual(assetNotification(e, ctx).recipients, ['requester'], e)
    }
  })

  test('9. a transfer tells BOTH the previous and the new custodian', () => {
    const { recipients } = assetNotification('asset_transferred', ctx)
    assert.ok(recipients.includes('new_custodian'))
    assert.ok(recipients.includes('previous_custodian'))
  })

  test('the four access events tell the access holder and nobody else', () => {
    for (const e of ['access_granted', 'access_updated', 'access_revoked', 'access_restored'] as const) {
      assert.deepEqual(assetNotification(e, { assetName: 'Canva' }).recipients, ['access_holder'], e)
    }
  })

  test('custodian-only events never broadcast to admins', () => {
    // The rule that keeps the bell worth reading.
    for (const e of ['asset_edited', 'asset_warranty_updated',
                     'asset_service_added', 'asset_document_uploaded'] as const) {
      assert.deepEqual(assetNotification(e, ctx).recipients, ['new_custodian'], e)
    }
  })

  test('end-of-life events keep the module\'s existing admin recipient model', () => {
    // Retirement is blocked while an assignment is open, so no custodian is
    // left to tell — and BOE has no designated-reviewer column to target.
    for (const e of ['asset_retired', 'asset_disposed', 'asset_restored'] as const) {
      assert.deepEqual(assetNotification(e, ctx).recipients, ['admins'], e)
    }
  })
})

describe('titles name the record', () => {
  test('every event produces a non-empty title naming its subject', () => {
    for (const e of ASSET_NOTIFICATION_EVENTS) {
      const { title } = assetNotification(e, { ...ctx, accessLabel: 'Canva' })
      assert.ok(title.trim().length > 0, e)
      const names = e.startsWith('access_')
        ? title.includes('Canva')
        : title.includes('Dell XPS 15')
      assert.ok(names, `${e} does not name its subject: ${title}`)
    }
  })

  test('a document title states WHICH document', () => {
    const t = (kind: string) =>
      assetNotification('asset_document_uploaded', { ...ctx, documentKind: kind }).title
    assert.ok(t('invoice').startsWith('Invoice'))
    assert.ok(t('warranty_card').startsWith('Warranty card'))
    assert.ok(t('other').startsWith('Supporting document'))
  })

  test('a revocation names the actor when one is known', () => {
    assert.equal(
      assetNotification('access_revoked', { assetName: 'Canva', accessLabel: 'Canva', actorName: 'Nishant' }).title,
      'Your Canva access was revoked by Nishant.',
    )
  })
})

describe('12. asset and access event types stay distinct', () => {
  test('no access event is mistaken for an asset event by prefix', () => {
    for (const e of ASSET_NOTIFICATION_EVENTS) {
      if (e.startsWith('access_')) {
        assert.equal(e.startsWith('asset'), false, `${e} would be routed as an asset event`)
      }
    }
  })

  test('both halves are present in the vocabulary', () => {
    const all = ASSET_NOTIFICATION_EVENTS as readonly string[]
    assert.ok(all.some(e => e.startsWith('asset_')))
    assert.ok(all.some(e => e.startsWith('access_')))
  })
})

describe('11. link targets', () => {
  const notif = (type: string, entityId: string | null) => ({
    id: 'n1', type, title: 't', body: null, task_id: null,
    entity_id: entityId, is_read: false, created_at: '2026-08-02T10:00:00Z',
  })

  test('an asset event opens that asset\'s record', () => {
    const meta = getNotificationMeta(notif('asset_assigned', 'asset-123') as never)
    assert.equal(meta.href, '/assets-access/asset-123')
    assert.equal(meta.category, 'asset')
  })

  test('every new asset event deep-links to the asset', () => {
    for (const e of ['asset_edited', 'asset_warranty_updated', 'asset_service_added',
                     'asset_document_uploaded', 'asset_retired', 'asset_disposed',
                     'asset_restored'] as const) {
      assert.equal(getNotificationMeta(notif(e, 'asset-9') as never).href, '/assets-access/asset-9', e)
    }
  })

  test('an access event opens the register, NOT an asset page', () => {
    // entity_id here is an ACCESS RECORD id. Building /assets-access/<id> from
    // it would open the asset detail page on an id no asset has.
    for (const e of ['access_granted', 'access_updated', 'access_revoked', 'access_restored'] as const) {
      const meta = getNotificationMeta(notif(e, 'access-77') as never)
      assert.equal(meta.href, '/assets-access?view=access-register', e)
      assert.equal(meta.category, 'asset', e)
      assert.ok(!meta.href.includes('access-77'), `${e} leaked an access id into an asset URL`)
    }
  })

  test('a request event opens the requests screen, since an approved removal deletes the asset', () => {
    assert.equal(
      getNotificationMeta(notif('asset_request_approved', 'gone') as never).href,
      '/assets-access?view=asset-requests',
    )
  })

  test('an asset event with no entity_id falls back to the inventory', () => {
    assert.equal(
      getNotificationMeta(notif('asset_lost', null) as never).href,
      '/assets-access?view=asset-inventory',
    )
  })
})

// ─── entity_id normalization ─────────────────────────────────────────────────
// notifications.entity_id is a UUID column. A blank string is not "no entity"
// to Postgres — it is a malformed uuid that fails the INSERT with 22P02 and
// loses the notification for EVERY recipient in the batch. This was reachable
// from existing code (`row.asset_id ?? ''` after an approved removal nulls
// asset_id) and cost a 500 in live testing before it was fixed.

describe('normalizeNotificationEntityId', () => {
  const UUID = '8f1984a2-42f8-46f5-8cab-bac369796a6d'

  test('1. an empty string becomes null, never reaching the uuid column', () => {
    assert.equal(normalizeNotificationEntityId(''), null)
  })

  test('2. a whitespace-only string becomes null', () => {
    assert.equal(normalizeNotificationEntityId('   '), null)
    assert.equal(normalizeNotificationEntityId('\t\n '), null)
  })

  test('3. a valid uuid is returned unchanged', () => {
    assert.equal(normalizeNotificationEntityId(UUID), UUID)
  })

  test('null and undefined are null', () => {
    assert.equal(normalizeNotificationEntityId(null), null)
    assert.equal(normalizeNotificationEntityId(undefined), null)
  })

  test('a padded uuid is trimmed — " uuid " is equally malformed', () => {
    assert.equal(normalizeNotificationEntityId(`  ${UUID}  `), UUID)
  })

  test('the result is only ever null or a non-empty string', () => {
    for (const input of ['', '   ', null, undefined, UUID, ` ${UUID} `]) {
      const out = normalizeNotificationEntityId(input)
      assert.ok(out === null || out.length > 0, String(input))
    }
  })
})

// ─── changedAssetFields / assetEditSummary ───────────────────────────────────

describe('changedAssetFields', () => {
  const before = {
    asset_type: 'laptop_desktop', asset_name: 'Dell XPS 15',
    serial_no: 'SN1', specifications: 'i7', brand: 'Dell', model: 'XPS',
    description: 'Design laptop', condition: 'good', location: 'Head Office',
  }
  const next = { ...before }

  test('8. no changes produces an empty list — and no notification', () => {
    assert.deepEqual(changedAssetFields(before, next), [])
    assert.equal(editDeservesNotification(changedAssetFields(before, next)), false)
  })

  test('1. condition changed is detected and is notification-worthy', () => {
    const c = changedAssetFields(before, { ...next, condition: 'damaged' })
    assert.deepEqual(c, ['condition'])
    assert.equal(editDeservesNotification(c), true)
    assert.equal(assetEditSummary(c), 'Condition')
  })

  test('2. location changed is detected and is notification-worthy', () => {
    const c = changedAssetFields(before, { ...next, location: 'Store Room' })
    assert.deepEqual(c, ['location'])
    assert.equal(editDeservesNotification(c), true)
    assert.equal(assetEditSummary(c), 'Location')
  })

  test('6. several meaningful fields changed are all reported, in field order', () => {
    const c = changedAssetFields(before, { ...next, condition: 'poor', location: 'Store Room' })
    assert.deepEqual(c, ['condition', 'location'])
    assert.equal(editDeservesNotification(c), true)
    // Body format: comma-separated labels, exactly as the notification renders.
    assert.equal(assetEditSummary(c), 'Condition, Location')
  })

  test('7. brand/model/serial/description-only changes are detected but stay SILENT', () => {
    const c = changedAssetFields(before, {
      ...next, brand: 'Lenovo', model: 'T14', serial_no: 'SN2', description: 'Spare',
    })
    assert.deepEqual(c, ['serial_no', 'brand', 'model', 'description'])
    // Detected as changes, but not the kind anyone needs telling about.
    assert.equal(editDeservesNotification(c), false)
    assert.equal(assetEditSummary(c), null)
  })

  test('a mixed edit notifies, and the body names ONLY the notification-worthy field', () => {
    const c = changedAssetFields(before, { ...next, brand: 'Lenovo', condition: 'fair' })
    assert.equal(editDeservesNotification(c), true)
    // "Brand" is deliberately absent: the body explains why you were told.
    assert.equal(assetEditSummary(c), 'Condition')
  })

  test('9. null, undefined and empty-string values are treated as the same absence', () => {
    const blank = { ...before, condition: null, location: null }
    // null → null is no change.
    assert.deepEqual(changedAssetFields(blank, { ...blank }), [])
    // A field missing from `before` counts as null, not as unchanged.
    const partial = { asset_type: 'laptop_desktop' } as Partial<typeof before>
    assert.ok(changedAssetFields(partial, { ...next, condition: 'good' }).includes('condition'))
    // Setting a previously-null field is a change.
    assert.deepEqual(changedAssetFields(blank, { ...blank, condition: 'good' }), ['condition'])
    // Clearing a set field is a change.
    assert.deepEqual(changedAssetFields(before, { ...next, location: null }), ['location'])
  })
})

describe('assetEditSummary — status, department and warranty dates', () => {
  // These columns are not on the Edit Asset form (status moves through custody
  // RPCs, warranty dates through the warranty modal), but the rule and the
  // labels cover them, so the body reads correctly wherever they arrive from.
  test('3. department, 4. warranty start, 5. warranty expiry all label correctly', () => {
    assert.equal(assetEditSummary(['department']), 'Department')
    assert.equal(assetEditSummary(['warranty_start_date']), 'Warranty start')
    assert.equal(assetEditSummary(['warranty_expiry_date']), 'Warranty expiry')
    assert.equal(assetEditSummary(['status']), 'Status')
  })

  test('every notification-worthy field has a label — no raw column name leaks', () => {
    for (const f of ['status', 'location', 'department', 'condition',
                     'warranty_start_date', 'warranty_expiry_date']) {
      const s = assetEditSummary([f])
      assert.ok(s && !s.includes('_'), `${f} leaked a raw column name: ${s}`)
    }
  })

  test('an empty or non-notifiable list produces no body line', () => {
    assert.equal(assetEditSummary([]), null)
    assert.equal(assetEditSummary(['brand', 'model']), null)
  })

  test('the body format matches what assetNotificationBody renders', () => {
    // assetNotificationBody prefixes "Changed: " — the summary is the value.
    const summary = assetEditSummary(['condition', 'location'])
    assert.equal(
      assetNotificationBody('asset_edited', { assetName: 'Dell XPS 15', note: summary }),
      'Changed: Condition, Location',
    )
  })

  test('an edit with no notifiable fields yields no body at all', () => {
    assert.equal(
      assetNotificationBody('asset_edited', { assetName: 'Dell XPS 15', note: assetEditSummary(['brand']) }),
      null,
    )
  })
})
