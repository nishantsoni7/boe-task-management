/**
 * SEND BACK TO THE SALESPERSON (20270619000000): the dialog, and where the page draws the button.
 *
 * Run:
 *   npx tsx --test "src/app/orders/[id]/orderSendBack.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { SendBackToSalesModal } from './OrderRevisionModals'
import { OrderAttentionBar } from './OrderWorkspace'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')
const noop = () => {}

describe('the dialog', () => {
  test('asks for the comment, says nothing in the PI changes, and names the button honestly', () => {
    const html = renderToStaticMarkup(
      <SendBackToSalesModal orderNumber="0547" versionLabel="PI V1" objection={null} saving={false} failure={null} onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Send back to the salesperson/)
    assert.match(html, /Order 0547 · PI V1/)
    assert.match(html, /Your comment for the salesperson/)
    assert.match(html, /Nothing in the PI changes/)
    assert.match(html, /<button[^>]*>Send to salesperson/)
    assert.doesNotMatch(html, /Operations said/)
  })

  test('shows what Operations said when the version is flagged, and a refusal in words', () => {
    const html = renderToStaticMarkup(
      <SendBackToSalesModal orderNumber="0547" versionLabel="PI V1" objection="Chair price should be 7,000." saving={false}
        failure="There is no other active salesperson on this Order to send it to." onClose={noop} onConfirm={noop} />,
    )
    assert.match(html, /Operations said: “Chair price should be 7,000\.”/)
    assert.match(html, /no other active salesperson/)
  })
})

describe('the page', () => {
  const page = read('src/app/orders/[id]/page.tsx')
  const body = page.slice(page.indexOf('<OrdersLayout'))

  test('draws the button on the Operations strip, for an administrator or an approver, never under View As', () => {
    assert.match(page, /const sendBackOffered = operationsReviewOpen && canSendBackToSales\(\{[\s\S]*?maySend: actingAsAdmin \|\| mayDecidePiAsAdmin,[\s\S]*?viewingAs: !!viewAsUserId,/)
    // After a send the same button says so and offers another (owner, 2026-11-12: four presses looked like nothing).
    const label = "{operationsSent && chainHolder === 'sales' ? SEND_BACK_AGAIN_LABEL : SEND_BACK_BUTTON_LABEL}"
    assert.ok(body.indexOf('<OrderAttentionBar') < body.indexOf(label))
    assert.ok(body.indexOf(label) < body.indexOf('<OrderStatusStrip'))
    assert.match(body, /onClick=\{\(\) => \{ setHandoffError\(null\); setSendBackOpen\(true\) \}\}/)
  })

  test('the write is the one RPC, then only the handoff and the history are re-read', () => {
    assert.match(page, /supabase\.rpc\('send_order_handoff_to_sales', \{\s+p_handoff_id: live\.id,\s+p_comment: comment,/)
    assert.match(page, /await Promise\.all\(\[reloadHandoffs\(\), reloadActivity\(\)\]\)/)
    assert.equal((body.match(/<SendBackToSalesModal/g) ?? []).length, 1)
  })

  test('the comment reaches the strip from the history, so it works before and after a reload', () => {
    assert.match(page, /latestSentToSales\(activity, operationsSplit\.live\.id\)/)
    assert.match(page, /sentBack: operationsChainBox,/)
    assert.match(page, /sentBackLine\(operationsSent, iso => \(iso \? fmtDateTime\(iso\) : '—'\), order\.assigned_to_name \?\? null\)/)
  })
})

describe('the strip after a send', () => {
  const view = (sent?: { head: string; comment: string }) => renderToStaticMarkup(
    <OrderAttentionBar items={[{
      key: 'operations_review', label: 'PI V1 flagged by operations: clarification needed', tone: 'red',
      title: 'PI V1 flagged by operations', detail: 'Nitish Bansal cannot accept PI V1 yet. Reason: price too low.',
      ...(sent ? { sent } : {}),
    }]} actions={<button type="button">Send another comment</button>} />,
  )

  test('says it went: its own line, with who it went to, when, and the comment, apart from Operations\' reason', () => {
    const html = view({ head: 'Sent back to Ashok Choudhary · 12 Nov 2026, 06:04 pm · by Nishant Soni', comment: 'Check the details and resubmit.' })
    assert.match(html, /data-sent-back="true"/)
    assert.match(html, /order-notice-sent-head[^>]*>[\s\S]*?Sent back to Ashok Choudhary · 12 Nov 2026, 06:04 pm · by Nishant Soni/)
    assert.match(html, /order-notice-sent-comment[^>]*>“Check the details and resubmit\.”/)
    assert.ok(html.indexOf('order-notice-detail') < html.indexOf('order-notice-sent'), 'Operations\' reason first, the send-back under it')
    assert.match(html, /<button[^>]*>Send another comment/)
  })

  test('draws nothing extra when nothing was sent', () => {
    assert.doesNotMatch(view(), /order-notice-sent|data-sent-back/)
  })
})
