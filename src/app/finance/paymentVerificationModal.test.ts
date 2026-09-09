/**
 * THE APPROVAL MODAL IS A PAYMENT VERIFICATION SCREEN.
 *
 * WHAT THIS FILE IS FOR
 * ---------------------
 * An approver opening P-AA-0011 is doing one job: matching a payment against a
 * bank statement and then deciding. The first scan has to answer how much came
 * in, through which account, on what date — and then, as context, what the
 * money is for and who raised it.
 *
 * The dialog used to answer those in the wrong order and more than once. The
 * band across the top read Amount / Client / Payment Date, so the ACCOUNT — the
 * thing being reconciled — was buried two cards down in a "Routing" grid. And
 * the destination was stated three times: a "What this payment is for" card
 * naming PI Draft 417, a "Payment Against" field naming PI Draft 417 again, and
 * an "Order Number" field saying "No Order yet — PI Draft", which is the same
 * fact phrased as an absence.
 *
 * WHAT IS PINNED HERE IS HIERARCHY AND WORDING, NOTHING ELSE. The approval RPC,
 * the three decisions, the note rules and the notifications are asserted to be
 * exactly as they were — a layout pass over a decision surface is precisely
 * where a silently changed outcome would hide.
 *
 * Run:
 *   npx tsx --test src/app/finance/paymentVerificationModal.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PAGE = 'src/app/finance/page.tsx'
const source = readFileSync(join(process.cwd(), PAGE), 'utf8')

/** The review dialog alone — the page holds five other modals. */
const modal = (() => {
  const from = source.indexOf('function AdminReviewModal(')
  const to   = source.indexOf('// ── Delete confirm modal (admin only)')
  assert.ok(from > -1 && to > from, 'the review modal could not be located')
  return source.slice(from, to)
})()

/** Source with comments stripped — assertions about what the CODE draws. */
const code = modal.split('\n')
  .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
  .join('\n')

describe('the top strip is a payment verification summary', () => {
  test('it is Amount, Payment Mode, Payment Date — in that order', () => {
    const band = code.slice(code.indexOf('<FigureBand>'), code.indexOf('</FigureBand>'))
    const cells = [...band.matchAll(/<FigureCell label="([^"]+)"/g)].map(m => m[1])
    assert.deepEqual(cells, ['Amount', 'Payment Mode', 'Payment Date'])
  })

  test('the client is no longer one of them', () => {
    const band = code.slice(code.indexOf('<FigureBand>'), code.indexOf('</FigureBand>'))
    assert.ok(!band.includes('label="Client"'),
      'who the money is from is context, not the figure being reconciled')
  })

  test('the amount still leads, and the mode is a step below it — not equal to it', () => {
    const band = code.slice(code.indexOf('<FigureBand>'), code.indexOf('</FigureBand>'))
    assert.ok(/label="Amount"[^\n]*\blead\b/.test(band), 'the amount keeps display weight')
    assert.ok(/label="Payment Mode"[^\n]*\bstrong\b/.test(band), 'the account is set stronger than a plain cell')
    assert.ok(!/label="Payment Mode"[^\n]*\blead\b/.test(band), 'but it does not compete with the amount')
    assert.ok(!/label="Payment Date"[^\n]*\b(lead|strong)\b/.test(band), 'the date stays a plain cell')
  })

  test('the mode reads as information, never as a second status badge', () => {
    // A tinted pill beside the real status badge in the header would read as
    // state. FigureCell draws every cell on the same surface, with no tint and
    // no border of its own.
    const cell = source.slice(source.indexOf('function FigureCell('),
                              source.indexOf('const REVIEW_DECISIONS'))
    assert.ok(cell.includes('background: colors.raised'), 'one surface for every cell')
    assert.ok(!/borderRadius:\s*'999/.test(cell), 'no pill')
    assert.ok(!/tint/i.test(cell), 'no status tint')
  })

  test('the account comes from the shared resolver, so a legacy row still names one', () => {
    assert.ok(code.includes('paymentDestinationLabel(r.payment_mode, r.received_in)'))
  })
})

describe('the destination is one fact, so it is one field', () => {
  test('it is called Against, and it appears exactly once', () => {
    assert.equal((code.match(/label="Against"/g) ?? []).length, 1)
    assert.ok(code.includes('value={paymentAgainstDisplay(destination)}'),
      'read through the shared helper the table and the requester popup also read')
  })

  test('the three retired ways of saying the same thing are gone', () => {
    for (const gone of [
      'PaymentDestinationSummary',   // "What this payment is for" card
      'label="Payment Against"',     // the Routing grid's copy of it
      'label="Order Number"',        // "No Order yet — PI Draft"
    ]) {
      assert.ok(!code.includes(gone), `${gone} restates the destination a second time`)
    }
  })

  test('the Routing card itself is gone', () => {
    assert.ok(!modal.includes('<SectionHeader>Routing</SectionHeader>'))
    // Its Payment Mode field moved up into the band rather than being dropped.
    assert.ok(!code.includes('<PaymentDestinationLine'),
      'the mode is in the figure band now, not in a grid below it')
  })

  test('no explanation of where the interface got the value survives', () => {
    // Implementation language. An approver does not need to be told which table
    // a field was read from.
    //
    // COMMENTS ARE STRIPPED FIRST, deliberately: the code above DOCUMENTS these
    // sentences as removed, and scanning the raw text would fail on the very
    // paragraph explaining why they went.
    for (const sentence of ['From this payment', 'Read from the record itself', 'never typed']) {
      assert.ok(!code.includes(sentence), `"${sentence}" is plumbing, not information`)
    }
  })

  test('the requester-facing detail modal is untouched by this pass', () => {
    // Deliberate scope: this change is the VERIFICATION screen. The other modal
    // on this page still carries its own destination card, and is a separate
    // decision.
    const details = source.slice(source.indexOf('function DetailsModal('),
                                 source.indexOf('function NewPaymentConfirmationModal('))
    assert.ok(details.includes('<PaymentDestinationSummary'),
      'the requester popup keeps what it had')
  })
})

describe('optional evidence takes space only when it exists', () => {
  test('no empty-state row is rendered for proof, reference or note', () => {
    for (const empty of ["'Not attached'", "'Not provided'", "'No notes provided'", 'renderEmpty']) {
      assert.ok(!code.includes(empty), `${empty} is a row whose content is the absence of content`)
    }
  })

  test('each of the three is guarded on its own value', () => {
    assert.ok(code.includes('{r.proof_note && <MetaItem label="Reference"'))
    assert.ok(code.includes('{r.sales_note && <MetaItem label="Note"'))
    // The proof heading travels into the component that knows whether there is
    // a proof — the host cannot know without repeating the query.
    assert.ok(/heading=\{<SectionHeader>Payment Proof<\/SectionHeader>\}/.test(code))
  })

  test('all three stored columns still have somewhere to appear', () => {
    assert.ok(code.includes('r.proof_note'), 'the reference')
    assert.ok(code.includes('r.sales_note'), 'the note')
    assert.ok(code.includes('<PaymentProofView'), 'the attachment')
  })
})

describe('the submitter is kept, and kept secondary', () => {
  test('it is a field in the details column, not the header line', () => {
    assert.ok(code.includes('label="Submitted by"'))
    assert.ok(code.includes('r.submitted_by_name'), 'the name is still shown')
    assert.ok(!code.includes('`Submitted by ${r.submitted_by_name}'),
      'the header sentence that gave the submitter top billing is gone')
  })

  test('the header subtitle now says what the dialog is', () => {
    assert.ok(code.includes("const subtitleLine = 'Payment verification'"))
    assert.ok(code.includes('submittedLine={subtitleLine}'))
  })
})

describe('the decision keeps its prominence, and its wiring', () => {
  test('Decision and Activity are both in the right-hand column, in that order', () => {
    const right = code.slice(code.indexOf('const right = ('))
    const decision = right.indexOf('Decision')
    const activity = right.indexOf('<PaymentRequestActivity')
    assert.ok(decision > -1 && activity > decision, 'Activity sits below the Decision')
  })

  test('the three decisions and the note rules are exactly as they were', () => {
    assert.ok(source.includes("{ key: 'approve',             label: 'Verify Payment',"))
    assert.ok(source.includes("{ key: 'needs_clarification', label: 'Needs Clarification',"))
    assert.ok(source.includes("{ key: 'reject',              label: 'Reject',"))
    assert.ok(code.includes("const noteRequired = action === 'needs_clarification' || action === 'reject'"))
  })

  test('APPROVAL LOGIC IS UNTOUCHED — the RPC, the status write and both notifications', () => {
    assert.ok(code.includes("supabase.rpc('approve_finance_payment_request'"))
    assert.ok(code.includes("status:     action === 'needs_clarification' ? 'needs_clarification' : 'rejected'"))
    for (const event of [
      'finance_approved_suspense', 'finance_approved_linked',
      'finance_clarification', 'finance_rejected',
    ]) {
      assert.ok(code.includes(event), `${event} must still be sent`)
    }
  })

  test('and this pass added no read and no write of its own', () => {
    // One destination read, which the modal already had. No new query.
    assert.equal((code.match(/usePaymentDestination\(/g) ?? []).length, 1)
    assert.equal((code.match(/\.from\(/g) ?? []).length, 1, 'the single status update, unchanged')
    assert.equal((code.match(/\.rpc\(/g) ?? []).length, 1, 'the single approval RPC, unchanged')
  })
})
