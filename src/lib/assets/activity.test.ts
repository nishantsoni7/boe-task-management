/**
 * Asset activity timeline — presentation tests.
 *
 * These cover the half of the feature that runs in the browser: ordering,
 * titles, and how a stored event renders. The half that matters most — that
 * the rows exist at all, that no client can write or rewrite them, and that a
 * failed action logs nothing — is database behaviour and is scripted in
 * docs/Module Docs/asset-activity-verification.sql.
 *
 * Run:
 *   npx tsx --test src/lib/assets/activity.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSET_ACTIVITY_EVENTS,
  assetActivityActorName,
  assetActivityDetailLines,
  assetActivityEmployeeName,
  assetActivityTitle,
  assetActivityTone,
  sortAssetActivity,
  type AssetActivityEntry,
} from './activity'

function entry(over: Partial<AssetActivityEntry> = {}): AssetActivityEntry {
  return {
    id: 'a1',
    asset_id: 'asset-1',
    asset_code_snapshot: 'BOE-AST-000001',
    asset_name_snapshot: 'Dell XPS 15',
    event_type: 'asset_created',
    actor_id: null,
    employee_id: null,
    event_at: '2026-08-01T10:00:00.000Z',
    summary: 'Asset created',
    details: null,
    source_type: null,
    source_id: null,
    created_at: '2026-08-01T10:00:00.100Z',
    ...over,
  }
}

describe('event vocabulary', () => {
  test('every event this phase writes has a title and a tone', () => {
    for (const event of ASSET_ACTIVITY_EVENTS) {
      assert.notEqual(assetActivityTitle(event), '', `${event} has no title`)
      assert.ok(
        ['neutral', 'positive', 'warning', 'critical'].includes(assetActivityTone(event)),
        `${event} has no tone`,
      )
    }
  })

  test('the vocabulary is exactly what the migrations write', () => {
    // Two generations, both live:
    //   20260727000000 — creation, edits, custody, change requests
    //   20260728–30    — warranty, transfer, recovery, service, documents,
    //                    retirement
    // The list is asserted in full so an event added to a migration without a
    // title and a tone here shows up as a failure rather than as an untitled
    // line in somebody's audit history.
    assert.deepEqual([...ASSET_ACTIVITY_EVENTS], [
      'asset_created',
      'asset_edited',
      'asset_assigned',
      'assignment_accepted',
      'asset_returned',
      'asset_marked_lost',
      'edit_requested',
      'removal_requested',
      'edit_request_approved',
      'edit_request_rejected',
      'removal_request_approved',
      'removal_request_rejected',
      'warranty_updated',
      'asset_transferred',
      'asset_recovered',
      'asset_sent_for_repair',
      'asset_returned_from_repair',
      'service_record_added',
      'service_record_corrected',
      'invoice_uploaded',
      'warranty_document_uploaded',
      'document_uploaded',
      'document_removed',
      'asset_retired',
      'asset_disposed',
      'asset_restored',
    ])
  })

  test('an event type from a later phase still renders readably', () => {
    // Repair and warranty events arrive in Tasks 4 and 5 without a migration
    // to this map; they must not render as a blank line.
    assert.equal(assetActivityTitle('repair_recorded'), 'Repair recorded')
    assert.equal(assetActivityTone('repair_recorded'), 'neutral')
  })
})

describe('sortAssetActivity', () => {
  test('newest first', () => {
    const rows = [
      entry({ id: 'old', event_at: '2026-07-01T09:00:00Z', created_at: '2026-07-01T09:00:00Z' }),
      entry({ id: 'new', event_at: '2026-08-01T09:00:00Z', created_at: '2026-08-01T09:00:00Z' }),
    ]
    assert.deepEqual(sortAssetActivity(rows).map(r => r.id), ['new', 'old'])
  })

  test('two rows written by one transaction keep the order they happened', () => {
    // An approved edit request writes the approval and the resulting
    // asset_edited at the same event_at (now() is transaction time). created_at
    // is clock_timestamp(), which does advance, so it decides.
    const rows = [
      entry({ id: 'approval', event_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00.001Z' }),
      entry({ id: 'edited',   event_at: '2026-08-01T10:00:00Z', created_at: '2026-08-01T10:00:00.002Z' }),
    ]
    assert.deepEqual(sortAssetActivity(rows).map(r => r.id), ['edited', 'approval'])
  })

  test('does not mutate the caller array', () => {
    const rows = [
      entry({ id: 'old', event_at: '2026-07-01T09:00:00Z' }),
      entry({ id: 'new', event_at: '2026-08-01T09:00:00Z' }),
    ]
    sortAssetActivity(rows)
    assert.deepEqual(rows.map(r => r.id), ['old', 'new'])
  })
})

describe('assetActivityDetailLines', () => {
  test('an edit lists only the fields that changed', () => {
    const lines = assetActivityDetailLines(entry({
      event_type: 'asset_edited',
      details: {
        changes: [
          { field: 'asset_name', label: 'Name', old: 'Old laptop', new: 'Dell XPS 15' },
          { field: 'location',   label: 'Location', old: null, new: 'Store Room' },
        ],
      },
    }))
    assert.deepEqual(lines, [
      { label: 'Name', value: 'Old laptop → Dell XPS 15' },
      { label: 'Location', value: '— → Store Room' },
    ])
  })

  test('an edit event with no changes renders nothing', () => {
    // The database never writes such a row (a no-op save logs no event at
    // all); this is the client refusing to invent one either.
    assert.deepEqual(assetActivityDetailLines(entry({ event_type: 'asset_edited', details: { changes: [] } })), [])
  })

  test('a row without details renders nothing', () => {
    assert.deepEqual(assetActivityDetailLines(entry({ details: null })), [])
  })

  test('stored enum-ish values are humanised, free text is left alone', () => {
    const lines = assetActivityDetailLines(entry({
      event_type: 'asset_edited',
      details: {
        changes: [
          { field: 'asset_type', label: 'Type', old: 'laptop_desktop', new: 'mouse_keyboard' },
          { field: 'serial_no',  label: 'Serial No.', old: 'AB_12', new: 'CD_34' },
        ],
      },
    }))
    assert.equal(lines[0].value, 'laptop desktop → mouse keyboard')
    assert.equal(lines[1].value, 'AB_12 → CD_34', 'a serial number is not prose and must not be rewritten')
  })

  test('creation shows type, serial and initial location', () => {
    const lines = assetActivityDetailLines(entry({
      event_type: 'asset_created',
      details: { asset_type: 'laptop_desktop', serial_no: 'SN-9', location: 'Design Department', asset_code: 'BOE-AST-000004' },
    }))
    assert.deepEqual(lines, [
      { label: 'Type', value: 'laptop desktop' },
      { label: 'Serial No.', value: 'SN-9' },
      { label: 'Location', value: 'Design Department' },
    ])
  })

  test('a custody event shows the status movement', () => {
    const lines = assetActivityDetailLines(entry({
      event_type: 'asset_assigned',
      details: { previous_status: 'available', new_status: 'assigned' },
    }))
    assert.deepEqual(lines, [{ label: 'Status', value: 'available → assigned' }])
  })

  test('a request decision shows the reason and the review note', () => {
    const lines = assetActivityDetailLines(entry({
      event_type: 'edit_request_rejected',
      details: { reason: 'Serial number is wrong', review_note: 'Checked the box — it matches' },
    }))
    assert.deepEqual(lines, [
      { label: 'Reason', value: 'Serial number is wrong' },
      { label: 'Review note', value: 'Checked the box — it matches' },
    ])
  })

  test('blank notes are omitted rather than rendered empty', () => {
    assert.deepEqual(assetActivityDetailLines(entry({
      event_type: 'edit_request_approved',
      details: { reason: '  ', review_note: '' },
    })), [])
  })
})

describe('name resolution', () => {
  const lookup = { 'u-1': 'Nishant Soni', 'u-2': 'Priya Sharma' }

  test('the live name wins, so a corrected spelling shows everywhere', () => {
    const row = entry({ actor_id: 'u-1', details: { actor_name: 'Nishant S' } })
    assert.equal(assetActivityActorName(row, lookup), 'Nishant Soni')
  })

  test('the snapshot carries the name after the user record is gone', () => {
    // actor_id is ON DELETE SET NULL, so a removed user leaves only what was
    // written at event time.
    const row = entry({ actor_id: null, details: { actor_name: 'Former Employee' } })
    assert.equal(assetActivityActorName(row, lookup), 'Former Employee')
  })

  test('an unknown actor with no snapshot resolves to null, not a guess', () => {
    assert.equal(assetActivityActorName(entry({ actor_id: 'u-9' }), lookup), null)
  })

  test('the employee falls back to the requester name on request events', () => {
    const row = entry({
      event_type: 'edit_requested',
      employee_id: null,
      details: { requester_name: 'Aditya' },
    })
    assert.equal(assetActivityEmployeeName(row, lookup), 'Aditya')
  })

  test('the employee resolves from the live map when present', () => {
    const row = entry({ event_type: 'asset_assigned', employee_id: 'u-2', details: { employee_name: 'P. Sharma' } })
    assert.equal(assetActivityEmployeeName(row, lookup), 'Priya Sharma')
  })
})
