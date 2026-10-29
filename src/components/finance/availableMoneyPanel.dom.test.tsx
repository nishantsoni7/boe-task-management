/**
 * "Money already received from this client" — the panel inside Add payment,
 * run for real in a DOM (Payments counted once, 20270505000000).
 *
 * Run: npm run test:file -- src/components/finance/availableMoneyPanel.dom.test.tsx
 */
import { mount } from '@/lib/testing/domHarness'
import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { AvailableMoneyPanel, AVAILABLE_MONEY_HEADING, USE_THIS_MONEY_LABEL } from './AvailableMoneyPanel'
import type { AvailablePayment } from '@/lib/finance/availableMoney'

let cleanup: (() => void) | null = null
afterEach(() => { cleanup?.(); cleanup = null })

/** The panel waits for the amount and date to stay still before it asks. */
const afterSearch = () => act(async () => { await new Promise(r => setTimeout(r, 420)) })

const match: AvailablePayment = {
  payment_id: 'p1', payment_number: 'P-AB-0123', amount: 50000, available: 50000,
  payment_date: '2026-10-12', payment_mode: 'hdfc', status: 'approved_linked', verified: true,
  closed_pi_reference: 'PID-00231',
}

function panel(props: { amount: string; date: string; rows?: AvailablePayment[]; useAnswer?: string | null }) {
  const asked: [string, string][] = []
  const used: string[] = []
  const ui = mount(
    <AvailableMoneyPanel
      amount={props.amount}
      paymentDate={props.date}
      search={async (a, d) => { asked.push([a, d]); return props.rows ?? [match] }}
      onUse={async id => { used.push(id); return props.useAnswer ?? null }}
    />,
  )
  cleanup = () => ui.unmount()
  return { ui, asked, used }
}

describe('AvailableMoneyPanel', () => {
  test('shows nothing and asks nothing until the amount and date are filled in', async () => {
    const { ui, asked } = panel({ amount: '', date: '2026-10-21' })
    await afterSearch()
    assert.equal(asked.length, 0)
    assert.doesNotMatch(ui.text(), new RegExp(AVAILABLE_MONEY_HEADING))
  })

  test('with no match the form looks exactly as before', async () => {
    const { ui, asked } = panel({ amount: '50000', date: '2026-10-21', rows: [] })
    await afterSearch()
    assert.deepEqual(asked, [['50000', '2026-10-21']])
    assert.equal(ui.text(), '')
  })

  test('a match shows the payment, its tracker, where it was, and Use this money', async () => {
    const { ui } = panel({ amount: '50000', date: '2026-10-21' })
    await afterSearch()
    const text = ui.text()
    assert.match(text, new RegExp(AVAILABLE_MONEY_HEADING))
    assert.match(text, /P-AB-0123/)
    assert.match(text, /₹50,000/)
    assert.match(text, /Recorded/)
    assert.match(text, /Verified/)
    assert.match(text, /Was on PID-00231, which was closed/)
    assert.ok(ui.button(USE_THIS_MONEY_LABEL))
  })

  test('Use this money hands the payment to the page; a refusal is said in place', async () => {
    const { ui, used } = panel({ amount: '50000', date: '2026-10-21', useAnswer: 'This payment is already on this record.' })
    await afterSearch()
    ui.click(ui.button(USE_THIS_MONEY_LABEL))
    await ui.settle()
    assert.deepEqual(used, ['p1'])
    assert.match(ui.one('[role="alert"]').textContent ?? '', /already on this record/)
  })
})
