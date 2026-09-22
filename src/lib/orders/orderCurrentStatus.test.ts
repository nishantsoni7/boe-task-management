/**
 * CURRENT STATUS — what the two new cards say, and what they refuse to say.
 *
 * The point of these is not that the words are pretty. It is that the section
 * reports the RECORD and never a guess: fabric and finish come from the same
 * standing the detail card draws, the picture count is the stored rows rather
 * than the URLs one reader managed to sign, an Order with nothing recorded says
 * so in words, and no line anywhere claims a manufacturing stage, a QC result,
 * a packing record or a CAD file — because no table in this system holds one.
 *
 * No database and no network.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderCurrentStatus.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  DESIGN_DRAWINGS_LABEL,
  DESIGN_DRAWINGS_NOTE,
  DESIGN_DRAWINGS_UNSUPPORTED,
  DESIGN_IMAGES_NONE,
  DESIGN_NO_PROOF,
  DESIGN_PROOF_ON_FILE,
  MANUFACTURING_PRODUCTION_LABEL,
  MANUFACTURING_STAGE_LABEL,
  MANUFACTURING_UNTRACKED_NOTE,
  countDesignImages,
  describeDesignFiles,
  describeManufacturingStatus,
  type CurrentStatusLine,
} from './orderCurrentStatus'
import { approvalStanding, type PersistedApprovalEvent } from './orderApprovals'
import { describeProductionAlignment } from './productionAlignment'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const when = (iso: string) => `on ${iso}`

function event(over: Partial<PersistedApprovalEvent> = {}): PersistedApprovalEvent {
  return {
    id: over.id ?? 'e1',
    order_id: 'o1',
    approval_kind: over.approval_kind ?? 'fabric',
    status: over.status ?? 'fully_approved',
    evidence_path: over.evidence_path ?? null,
    actor_id: over.actor_id ?? 'u1',
    created_at: over.created_at ?? '2026-09-01',
    ...over,
  } as PersistedApprovalEvent
}

const standing = (events: PersistedApprovalEvent[] = []) =>
  approvalStanding({ events, formatWhen: when })

const line = (lines: readonly CurrentStatusLine[], key: string): CurrentStatusLine => {
  const found = lines.find(l => l.key === key)
  assert.ok(found, `no ${key} line`)
  return found
}

const alignment = (over: Partial<Parameters<typeof describeProductionAlignment>[0]> = {}) =>
  describeProductionAlignment({
    alignment: 'not_aligned',
    alignedByName: null,
    alignedAt: null,
    note: null,
    orderStatus: 'running',
    canAlign: false,
    ...over,
  })

// ── Design Files ──────────────────────────────────────────────────────────────

describe('Design Files reports the approval log, not a second opinion of it', () => {
  test('fabric and finish carry the standing’s own status and tone', () => {
    const view = describeDesignFiles({
      approvals: standing([
        event({ id: 'a', approval_kind: 'fabric', status: 'fully_approved' }),
        event({ id: 'b', approval_kind: 'finish', status: 'partially_approved' }),
      ]),
      images: { representative: 0, customization: 0 },
      productCount: 0,
    })

    assert.equal(line(view.lines, 'fabric').value, 'Fully Approved')
    assert.equal(line(view.lines, 'fabric').tone, 'green')
    assert.equal(line(view.lines, 'finish').value, 'Partially Approved')
    assert.equal(line(view.lines, 'finish').tone, 'amber')
  })

  test('an Order with no events at all reads Not Approved on both — the truthful default', () => {
    const view = describeDesignFiles({
      approvals: standing([]),
      images: { representative: 0, customization: 0 },
      productCount: 0,
    })
    for (const key of ['fabric', 'finish']) {
      assert.equal(line(view.lines, key).value, 'Not Approved')
      assert.equal(line(view.lines, key).detail, DESIGN_NO_PROOF)
    }
  })

  test('a screenshot on record is reported as existing — and its key never leaves the model', () => {
    const view = describeDesignFiles({
      approvals: standing([
        event({ approval_kind: 'fabric', status: 'fully_approved', evidence_path: 'orders/o1/secret.png' }),
      ]),
      images: { representative: 0, customization: 0 },
      productCount: 0,
    })
    assert.equal(line(view.lines, 'fabric').detail, DESIGN_PROOF_ON_FILE)
    assert.equal(
      JSON.stringify(view).includes('secret.png'), false,
      'the storage key is not carried into the card',
    )
  })

  test('the pictures are counted, and one file is not "1 files"', () => {
    const one = describeDesignFiles({
      approvals: standing([]),
      images: { representative: 1, customization: 0 },
      productCount: 1,
    })
    assert.equal(line(one.lines, 'images').value, '1 file')
    assert.equal(line(one.lines, 'images').detail, '1 representative · 0 customization · 1 product line')

    const many = describeDesignFiles({
      approvals: standing([]),
      images: { representative: 5, customization: 7 },
      productCount: 5,
    })
    assert.equal(line(many.lines, 'images').value, '12 files')
    assert.match(line(many.lines, 'images').detail ?? '', /5 product lines/)
  })

  test('no pictures says so, and claims no qualifier it does not have', () => {
    const view = describeDesignFiles({
      approvals: standing([]),
      images: { representative: 0, customization: 0 },
      productCount: 4,
    })
    assert.equal(line(view.lines, 'images').value, DESIGN_IMAGES_NONE)
    assert.equal(line(view.lines, 'images').detail, null)
  })

  test('CAD and drawings are reported as NOT RECORDED, never filled in from another file', () => {
    const view = describeDesignFiles({
      approvals: standing([
        event({ approval_kind: 'fabric', evidence_path: 'orders/o1/fabric.png' }),
      ]),
      images: { representative: 9, customization: 3 },
      productCount: 3,
    })
    const drawings = line(view.lines, 'drawings')
    assert.equal(drawings.label, DESIGN_DRAWINGS_LABEL)
    assert.equal(drawings.value, DESIGN_DRAWINGS_UNSUPPORTED)
    assert.equal(drawings.unsupported, true, 'so the screen can mute it rather than dress it as a state')
    assert.equal(drawings.detail, DESIGN_DRAWINGS_NOTE)
  })

  test('every line states a word, so no line depends on colour alone', () => {
    const view = describeDesignFiles({
      approvals: standing([]),
      images: { representative: 2, customization: 0 },
      productCount: 1,
    })
    for (const l of view.lines) {
      assert.ok(l.value.trim() !== '', `${l.key} says nothing`)
    }
  })
})

describe('the picture count is the record, not the reader’s view of it', () => {
  test('rows are counted by role', () => {
    assert.deepEqual(
      countDesignImages([
        { role: 'representative' }, { role: 'customization' }, { role: 'customization' },
      ]),
      { representative: 1, customization: 2 },
    )
  })

  test('a role this build does not know is not counted as either', () => {
    assert.deepEqual(
      countDesignImages([{ role: 'representative' }, { role: 'moodboard' }]),
      { representative: 1, customization: 0 },
    )
  })

  test('no rows is zero, never a blank', () => {
    assert.deepEqual(countDesignImages([]), { representative: 0, customization: 0 })
  })
})

// ── Manufacturing Status ──────────────────────────────────────────────────────

describe('Manufacturing Status reports the two records that exist, and names the rest as absent', () => {
  test('an unaligned live Order is amber and says what it is waiting on', () => {
    const view = describeManufacturingStatus({
      production: alignment(),
      orderStatus: 'running',
      orderStatusLabel: 'Running',
    })
    const production = line(view.lines, 'production')
    assert.equal(production.label, MANUFACTURING_PRODUCTION_LABEL)
    assert.equal(production.value, 'Not Aligned')
    assert.equal(production.tone, 'amber')
    assert.match(production.detail ?? '', /Head of Manufacturing/)
  })

  test('the same gap on a dispatched or cancelled Order is neutral — nothing waits on it now', () => {
    for (const status of ['dispatched', 'cancelled']) {
      const view = describeManufacturingStatus({
        production: alignment({ orderStatus: status }),
        orderStatus: status,
        orderStatusLabel: status === 'dispatched' ? 'Dispatched' : 'Cancelled',
      })
      assert.equal(line(view.lines, 'production').tone, 'neutral', status)
    }
  })

  test('an aligned Order is green and names who aligned it and when', () => {
    const view = describeManufacturingStatus({
      production: alignment({
        alignment: 'aligned', alignedByName: 'Priya', alignedAt: '12 Sep 2026',
      }),
      orderStatus: 'running',
      orderStatusLabel: 'Running',
    })
    const production = line(view.lines, 'production')
    assert.equal(production.value, 'Aligned')
    assert.equal(production.tone, 'green')
    assert.equal(production.detail, 'Aligned by Priya · 12 Sep 2026')
  })

  test('the stage is the Order’s own status, in words and WITHOUT a second pill', () => {
    const view = describeManufacturingStatus({
      production: alignment(),
      orderStatus: 'ready_for_dispatch',
      orderStatusLabel: 'Ready for Dispatch',
    })
    const stage = line(view.lines, 'stage')
    assert.equal(stage.label, MANUFACTURING_STAGE_LABEL)
    assert.equal(stage.value, 'Ready for Dispatch')
    assert.equal(stage.tone, null, 'the command header already says this in colour')
  })

  test('an Order whose row has not been read yet shows the stage and no invented alignment', () => {
    const view = describeManufacturingStatus({
      production: null,
      orderStatus: 'running',
      orderStatusLabel: 'Running',
    })
    assert.equal(view.lines.some(l => l.key === 'production'), false)
    assert.equal(line(view.lines, 'stage').value, 'Running')
  })

  test('it says plainly that manufacturing, QC and packaging are not recorded', () => {
    const view = describeManufacturingStatus({
      production: alignment({ alignment: 'aligned', alignedByName: 'Priya', alignedAt: 'today' }),
      orderStatus: 'running',
      orderStatusLabel: 'Running',
    })
    assert.equal(view.note, MANUFACTURING_UNTRACKED_NOTE)
    for (const word of ['Manufacturing stage', 'QC', 'packaging']) {
      assert.ok(view.note.includes(word), `${word} is not named as untracked`)
    }
  })

  test('NOTHING infers progress from the Order merely existing or from a due date', () => {
    const view = describeManufacturingStatus({
      production: alignment(),
      orderStatus: 'running',
      orderStatusLabel: 'Running',
    })
    const said = view.lines.map(l => `${l.label} ${l.value} ${l.detail ?? ''}`).join(' ').toLowerCase()
    for (const invented of ['in progress', 'complete', '%', 'due', 'qc passed', 'packed']) {
      assert.equal(said.includes(invented), false, `the card claims "${invented}"`)
    }
  })
})
