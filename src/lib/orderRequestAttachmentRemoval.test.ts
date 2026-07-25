/**
 * Removing ONE selected reference attachment — the decision rule.
 *
 * SCOPE, STATED HONESTLY: this repo has no component-test harness (no
 * vitest/jest/RTL, and adding one is a new heavy dependency that was not
 * approved), so the modal's async orchestration — storage delete → RPC →
 * fallback discard — CANNOT be executed here. What IS covered is
 * `planReferenceRemoval`, the pure decision that chooses between those paths and
 * blocks the unsafe ones. The orchestration itself is covered by the SQL
 * assertions (server-side refusals) plus code review; see the report.
 *
 * Run:
 *   npx tsx --test src/lib/orderRequestAttachmentRemoval.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { planReferenceRemoval, type RemovableFile } from './orderRequestAttachments'

const PATH = 'req-1/references/uuid-drawing.pdf'
const ATT  = '11111111-2222-3333-4444-555555555555'

function file(over: Partial<RemovableFile> = {}): RemovableFile {
  return { category: 'reference', uploadedPath: null, attachmentId: null, ...over }
}
const idle = { hasDraft: false, removalInFlight: false }
const live = { hasDraft: true,  removalInFlight: false }

describe('pre-upload removal is purely local', () => {
  test('a never-uploaded file is dropped locally, with no server work', () => {
    assert.deepEqual(planReferenceRemoval(file(), idle), { kind: 'local' })
  })

  test('still local when a draft exists but this file was not uploaded', () => {
    // The usual case: an earlier submit created the draft and uploaded the Main
    // PI, then the user adds another reference before retrying.
    assert.deepEqual(planReferenceRemoval(file(), live), { kind: 'local' })
  })

  test('local when the file was uploaded but its draft is already gone', () => {
    // After a discard, the object no longer exists — removing it again would be
    // a pointless (and failure-prone) server round trip.
    const f = file({ uploadedPath: PATH, attachmentId: ATT })
    assert.deepEqual(planReferenceRemoval(f, idle), { kind: 'local' })
  })
})

describe('post-upload removal targets exactly one object and one row', () => {
  test('returns the storage path AND the metadata row id', () => {
    const f = file({ uploadedPath: PATH, attachmentId: ATT })
    assert.deepEqual(planReferenceRemoval(f, live), {
      kind: 'remote', storagePath: PATH, attachmentId: ATT,
    })
  })
})

describe('unsafe removals are blocked before any server call', () => {
  test('the Main PI is never individually removable', () => {
    const f = file({ category: 'main_pi', uploadedPath: PATH, attachmentId: ATT })
    const plan = planReferenceRemoval(f, live)
    assert.equal(plan.kind, 'blocked')
    assert.match(plan.kind === 'blocked' ? plan.reason : '', /Main PI/)
  })

  test('a Main PI is blocked even when nothing was uploaded', () => {
    // The rule is about the category, not about upload state.
    assert.equal(planReferenceRemoval(file({ category: 'main_pi' }), idle).kind, 'blocked')
  })

  test('a second removal is refused while one is in flight (double-click guard)', () => {
    const f = file({ uploadedPath: PATH, attachmentId: ATT })
    const plan = planReferenceRemoval(f, { hasDraft: true, removalInFlight: true })
    assert.equal(plan.kind, 'blocked')
    assert.match(plan.kind === 'blocked' ? plan.reason : '', /still being removed/)
  })

  test('the in-flight guard outranks every other case, including local', () => {
    // Nothing may proceed concurrently — a "local" removal still mutates the
    // list the in-flight removal is indexing into.
    assert.equal(planReferenceRemoval(file(), { hasDraft: false, removalInFlight: true }).kind, 'blocked')
  })

  test('an uploaded file with no row id is blocked, never half-removed', () => {
    // Deleting the object without being able to address its row is exactly the
    // dangling-metadata state the whole design exists to prevent.
    const f = file({ uploadedPath: PATH, attachmentId: null })
    const plan = planReferenceRemoval(f, live)
    assert.equal(plan.kind, 'blocked')
    assert.match(plan.kind === 'blocked' ? plan.reason : '', /cancel and start again/i)
  })
})

describe('the plan is a pure function of its inputs', () => {
  test('it does not mutate the file it is given', () => {
    const f = file({ uploadedPath: PATH, attachmentId: ATT })
    const snapshot = { ...f }
    planReferenceRemoval(f, live)
    assert.deepEqual(f, snapshot)
  })

  test('repeated calls give the same answer', () => {
    const f = file({ uploadedPath: PATH, attachmentId: ATT })
    assert.deepEqual(planReferenceRemoval(f, live), planReferenceRemoval(f, live))
  })
})
