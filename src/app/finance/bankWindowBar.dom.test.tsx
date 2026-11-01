/**
 * THE BOTTOM BAR OF THE WINDOW FOR A PENDING HDFC PAYMENT — run for real in a DOM.
 *
 * Run: npm run test:file -- src/app/finance/bankWindowBar.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BankWindowBar, type BankWindowAction } from './bankWindowBar'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

function open(over: { details?: boolean; action?: BankWindowAction | null; note?: string; sending?: boolean; error?: string | null } = {}) {
  const calls: string[] = []
  const ui = mount(
    <BankWindowBar
      details={over.details ?? false}
      action={over.action ?? null}
      note={over.note ?? ''}
      sending={over.sending ?? false}
      error={over.error ?? null}
      manage={<button>Edit</button>}
      onToggleDetails={() => calls.push('details')}
      onAsk={a => calls.push(`ask:${a}`)}
      onNote={n => calls.push(`note:${n}`)}
      onCancel={() => calls.push('cancel')}
      onSend={() => calls.push('send')}
    />,
  )
  cleanup = () => ui.unmount()
  return { ui, calls }
}

describe('the bottom bar', () => {
  test('it offers the whole-payment decisions, not Edit, beside the comparison', () => {
    const { ui, calls } = open()
    assert.equal(ui.all('button').filter(b => b.textContent === 'Edit').length, 0)
    ui.click(ui.button('Needs clarification'))
    ui.click(ui.button('Reject payment'))
    assert.deepEqual(calls, ['ask:needs_clarification', 'ask:reject'])
  })

  test('Details swaps the decisions for Edit, and offers the way back', () => {
    const { ui, calls } = open({ details: true })
    assert.equal(ui.all('button').filter(b => b.textContent === 'Reject payment').length, 0)
    assert.equal(ui.all('button').filter(b => b.textContent === 'Edit').length, 1)
    ui.click(ui.button('Back to the match'))
    assert.deepEqual(calls, ['details'])
  })

  test('a rejection needs a reason, and says Sales will see it', () => {
    const { ui } = open({ action: 'reject' })
    assert.ok(ui.text().includes('Sales will see this.'))
    assert.equal(ui.button('Reject payment').disabled, true)
  })

  test('a reason of spaces is no reason', () => {
    const { ui } = open({ action: 'reject', note: '   ' })
    assert.equal(ui.button('Reject payment').disabled, true)
  })

  test('with a reason it sends once, and Cancel backs out', () => {
    const { ui, calls } = open({ action: 'reject', note: 'Wrong client' })
    ui.click(ui.button('Reject payment'))
    ui.click(ui.button('Cancel'))
    assert.deepEqual(calls, ['send', 'cancel'])
  })

  test('a clarification asks its own question', () => {
    const { ui } = open({ action: 'needs_clarification', note: 'Which transfer?' })
    assert.ok(ui.text().includes('What do you need to know?'))
    assert.equal(ui.button('Send to Sales').disabled, false)
  })

  test('nothing can be pressed twice while it sends, and a refusal stays on the bar', () => {
    const { ui } = open({ action: 'reject', note: 'Wrong client', sending: true, error: 'Somebody else decided first' })
    assert.equal(ui.button('Saving…').disabled, true)
    assert.equal(ui.button('Cancel').disabled, true)
    assert.match(ui.one('[role="alert"]').textContent ?? '', /decided first/)
  })
})

describe('the window it belongs to', () => {
  const details = readFileSync(join(process.cwd(), 'src/app/finance/paymentRequestsDetails.tsx'), 'utf8')

  test('it is only for a pending HDFC payment, somebody who may decide, with bank access', () => {
    assert.ok(details.includes('const bankWindow = canVerify && verifiedAtTheBank && !!bankPanel && !!supabase && !!onCorrected'))
  })

  test('every decision still goes through the one door', () => {
    assert.ok(details.includes('onSend={handleDecide}'))
    assert.ok(!details.includes('decisionBelow'))
  })

  test('nothing is lost: proof, custody and activity are all behind Details', () => {
    assert.ok(details.includes('left={bankWindow ? <>{proofBlock}{custodyBlock}</> : left}'))
    assert.ok(details.includes('right={bankWindow ? activityBlock : right}'))
  })

  test('everybody else keeps the old window, cash payments too', () => {
    assert.ok(details.includes('{!bankWindow && decisionBlock}'))
    assert.ok(details.includes('width={bankWindow ? \'1040px\' : undefined}'))
    assert.ok(details.includes('footer={bankWindow ? bankFooter : footer}'))
  })
})
