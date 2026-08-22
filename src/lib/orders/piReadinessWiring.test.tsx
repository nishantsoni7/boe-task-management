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
import { renderToStaticMarkup } from 'react-dom/server'

import { piReadiness } from './piReadiness'
import {
  describeApprovalReadiness,
  approvalBlockedIncomplete,
  APPROVAL_BLOCKED_FINANCE,
  APPROVAL_BLOCKED_NO_LINES,
  APPROVAL_BLOCKED_BLOCKING_ISSUES,
} from './finalApproval'
import { PiFinanceVerifyModal } from '@/components/orders/piReviewModals'

const read = (p: string) => readFileSync(p, 'utf8')
const PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const SECTIONS = 'src/app/orders/drafts/[submissionId]/piDetailSections.tsx'

const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')

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
    financeVerified: true,
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
    // Everything above it is somebody else's outstanding task — finance has not
    // signed off, the money has not arrived, the workbook has problems — and
    // each is a bigger obstacle. Reporting an absent client name ahead of an
    // unverified PI puts the smallest thing first and reads as the only one.
    const incomplete = 'Before this PI can be submitted, client name is needed.'
    assert.equal(
      describeApprovalReadiness({ ...base, financeVerified: false, incompleteSummary: incomplete }).blocker,
      APPROVAL_BLOCKED_FINANCE)
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

// ══ 2. The finance dialog reads it ═══════════════════════════════════════════

describe('finance sees what will stop the approval, and is not refused for it', () => {
  const dialog = (incompleteSummary: string | null) => renderToStaticMarkup(
    <PiFinanceVerifyModal
      client="Acme Interiors"
      grandTotal="Rs. 3,10,000"
      advanceLabel="40% standard"
      incompleteSummary={incompleteSummary}
      saving={false}
      failure={null}
      onCancel={() => {}}
      onConfirm={() => {}}
    />)

  test('a complete PI says nothing about it', () => {
    assert.ok(!text(dialog(null)).includes('cannot be approved'))
  })

  test('an incomplete one names it', () => {
    const t = text(dialog('Before this PI can be submitted, client name is needed.'))
    assert.ok(t.includes('client name is needed'))
    assert.match(t, /cannot be approved until it is supplied/)
  })

  test('and the confirm control is NOT disabled by it', () => {
    // Finance signs off on the FIGURES. Whether the PI carries a client name is
    // not their decision, and a dialog that refused them would be this screen
    // inventing an authority the database does not have.
    const html = dialog('Before this PI can be submitted, client name is needed.')
    const confirm = [...html.matchAll(/<button\b[^>]*>/g)].map(m => m[0])
    assert.ok(confirm.some(b => !b.includes('disabled')),
      'at least one control is still pressable')
  })
})

// ══ 3. The submit surface reads it, and it is the SAME value ═════════════════

describe('the three surfaces read one computation, not three', () => {
  const page = read(PAGE)

  test('piReadiness is called for submission exactly once on the page', () => {
    const calls = [...page.matchAll(/piReadiness\(\s*'(\w+)'/g)].map(m => m[1])
    assert.deepEqual(calls.sort(), ['payment', 'submission'],
      'one payment answer and one submission answer, and no third')
  })

  test('all three surfaces are handed that one value', () => {
    for (const surface of [
      'readiness={actions.canSubmit ? submissionReadiness : null}',   // submit
      'incompleteSummary={submissionReadiness.ready ? null : submissionReadiness.summary}',
    ]) {
      assert.ok(page.includes(surface), `missing wiring: ${surface}`)
    }
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

// ══ 4. The list is offered as actions only where a form can act ══════════════

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
