/**
 * ONE ANSWER, READ BY EVERY SURFACE THAT ASKS IT.
 *
 * The dead end manual testing found was not a missing field. It was learning
 * about the missing fields ONE REFUSAL AT A TIME: submitting named the client,
 * fixing that named a product line, fixing that named an image. Every round trip
 * a fresh disappointment, and no screen able to say how far there was left to go.
 *
 * piReadiness answers the whole question once. What this file protects is that
 * the surfaces actually READ that answer, and read the SAME one — because three
 * screens each deriving "is this ready" from their own subset is how they start
 * disagreeing, and a reviewer told a PI is ready by one screen and refused by
 * another has no way to tell which is right.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piReadinessWiring.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { piReadiness } from './piReadiness'
import {
  describeApprovalReadiness,
  approvalBlockedIncomplete,
  APPROVAL_BLOCKED_PAYMENT_AWAITING,
  APPROVAL_BLOCKED_NO_LINES,
  APPROVAL_BLOCKED_BLOCKING_ISSUES,
} from './finalApproval'

const read = (p: string) => readFileSync(p, 'utf8')
const PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const SECTIONS = 'src/app/orders/drafts/[submissionId]/piDetailSections.tsx'


/** A PI that is complete in every way the readiness check cares about. */
const COMPLETE = {
  client_name: 'Acme Interiors',
  source_workbook_path: 'orders/submissions/x/original/pi.xlsx',
  parse_blocking_issues: [],
}
const LINES = [{ item_sequence: 1, product_name: 'Oak sideboard', hasRepresentativeImage: true }]

// ══ 1. The approval control reads it ═════════════════════════════════════════

describe('management approval is blocked by the same list', () => {
  const base = {
    status: 'submitted',
    awaitingVerificationAmount: 0,
    paymentPosition: 'standard_met' as const,
    neededForStandard: null,
    hasBlockingIssues: false,
    productCount: 1,
    deletionClaimed: false,
  }

  test('a complete PI is approvable', () => {
    const r = describeApprovalReadiness({ ...base, incompleteSummary: null })
    assert.equal(r.ready, true)
    assert.equal(r.blocker, null)
  })

  test('an incomplete one is refused, with the whole list in the sentence', () => {
    const summary = piReadiness('submission', { ...COMPLETE, client_name: null }, LINES).summary
    assert.ok(summary !== null)
    const r = describeApprovalReadiness({ ...base, incompleteSummary: summary })
    assert.equal(r.ready, false)
    assert.ok(r.blocker!.includes(summary), 'the reviewer is told WHAT is missing')
    assert.match(r.blocker!, /Order created from it would be missing/,
      'and why it matters at this moment rather than the last one')
  })

  test('it is the LAST blocker, never the first', () => {
    // Everything above it is somebody else's outstanding task — a payment is
    // still with Finance, the money has not arrived, the workbook has problems —
    // and each is a bigger obstacle. Reporting an absent client name ahead of
    // undecided money puts the smallest thing first and reads as the only one.
    const incomplete = 'Before this PI can be submitted, client name is needed.'
    assert.equal(
      describeApprovalReadiness({ ...base, awaitingVerificationAmount: '1', incompleteSummary: incomplete }).blocker,
      APPROVAL_BLOCKED_PAYMENT_AWAITING)
    assert.equal(
      describeApprovalReadiness({ ...base, hasBlockingIssues: true, incompleteSummary: incomplete }).blocker,
      APPROVAL_BLOCKED_BLOCKING_ISSUES)
    assert.equal(
      describeApprovalReadiness({ ...base, productCount: 0, incompleteSummary: incomplete }).blocker,
      APPROVAL_BLOCKED_NO_LINES)
  })

  test('an absent field defaults to "nothing missing", not to blocked', () => {
    // The property is optional so every existing caller keeps compiling. It must
    // therefore mean "not known here" and never "incomplete" — a caller that had
    // not been updated would otherwise silently stop approving anything.
    assert.equal(describeApprovalReadiness(base).ready, true)
  })

  test('the sentence never invents a requirement of its own', () => {
    const out = approvalBlockedIncomplete('Before this PI can be submitted, 2 things are needed.')
    assert.ok(out.startsWith('Before this PI can be submitted, 2 things are needed.'),
      'the readiness wording is carried through verbatim')
  })
})


// ══ 2. The submit surface reads it, and it is the SAME value ═════════════════
//
// THERE WERE THREE SURFACES. The third was the Verify Finance dialog, which
// showed a finance authority what would stop the approval before they signed
// the PI off. 20261226000000 removed that step — there is no PI-level finance
// sign-off, so there is no dialog and no third reader. The two that remain are
// the submit control and the approval control, and they still read ONE
// computation, which is what this section has always been about.

describe('the two surfaces read one computation, not two', () => {
  const page = read(PAGE)

  test('piReadiness is called for submission exactly once on the page', () => {
    const calls = [...page.matchAll(/piReadiness\(\s*'(\w+)'/g)].map(m => m[1])
    assert.deepEqual(calls.sort(), ['payment', 'submission'],
      'one payment answer and one submission answer, and no third')
  })

  test('both surfaces are handed that one value', () => {
    // The submit control.
    assert.ok(page.includes('readiness={actions.canSubmit ? submissionReadiness : null}'),
      'missing wiring: the submit control')
    // The approval control, through describeApprovalReadiness.
    assert.match(page,
      /incompleteSummary: submissionReadiness\.ready \? null : submissionReadiness\.summary/)
  })

  test('no surface re-derives a requirement of its own', () => {
    // The failure this prevents: a screen that checks `client_name` itself and
    // then disagrees with the list beside it.
    const panel = read(SECTIONS)
    assert.ok(!/client_name/.test(panel),
      'the workflow panel must read the shared answer, not the column')
  })
})

// ══ 3. The list is offered as actions only where a form can act ══════════════

describe('the missing list offers a way in only where one exists', () => {
  const panel = read(SECTIONS)

  test('a workbook problem is never given an edit control', () => {
    assert.ok(panel.includes('requirement.needsReimport'),
      'the panel distinguishes what a form can fix')
    assert.ok(panel.includes('a corrected workbook is needed'))
  })

  test('an incomplete product line is counted, not given a guessed row', () => {
    assert.ok(panel.includes("requirement.section !== 'products'"),
      'the list counts lines rather than naming one, so no button can mean a row')
  })

  test('the readiness list is shown to the owner, not to a reviewer', () => {
    assert.match(panel, /\{ownerActions && readinessBlocked && \(/,
      'a reviewer is not the person who fills these in')
  })
})
