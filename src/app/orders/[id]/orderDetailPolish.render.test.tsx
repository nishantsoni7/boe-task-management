/**
 * CONFIRMED ORDER DETAIL — the five presentation changes, rendered.
 *
 *   1  the production summary (status first, one short line)       → orderWorkspace.render.test.tsx
 *   2  the attention strip (one issue = title + reason)
 *   3  the compact PI version strip + Edit PI on the Main PI row    → piEditor / orderDocumentSubmissions tests
 *   4  Design files beside Client PO, compact empty states
 *   5  typography, and a quiet Activity trail
 *
 * Presentation only: nothing here decides a permission, a status or a rule.
 *
 * Run:
 *   npx tsx --test "src/app/orders/*\/orderDetailPolish.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderActivityList, OrderAttentionBar, activityTitle, type OrderActivityItem } from './OrderWorkspace'
import { attentionAriaLabel, orderAttentionItems, type OrderAttentionInput } from '@/lib/orders/orderWorkspace'

const css = readFileSync('src/app/globals.css', 'utf8').replace(/\r/g, '')
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const open: OrderAttentionInput = {
  status: 'running', productionAligned: true, hasSalesperson: true, hasDueDate: true, hasLeadSource: true,
  isOverdue: false, awaitingVerificationCount: 0, pendingChangeRequests: 0, pendingPiRevision: false,
  documentsFailed: false, documentsOutdated: false,
}

describe('the attention strip: one issue is a title and a reason; several stay as compact rows', () => {
  const hold = orderAttentionItems({
    ...open, productionAligned: false,
    advanceBelowLabel: 'Production on hold: advance below 40% — see Payment',
    advanceBelowParts: { title: 'Production on hold', detail: 'Verified advance is below 40%.' },
  })

  test('a single issue leads with its title, then one short reason — and never says "1 item needs attention"', () => {
    const html = renderToStaticMarkup(<OrderAttentionBar items={hold} />)
    assert.equal(hold.length, 1)
    assert.match(html, /<strong class="order-attention-title">Production on hold<\/strong><span class="order-attention-detail">Verified advance is below 40%\.<\/span>/)
    assert.doesNotMatch(text(html), /needs? attention/)
    assert.match(html, /aria-label="Production on hold"/, 'a screen reader hears the issue, not a count')
    assert.equal(attentionAriaLabel(hold), 'Production on hold')
  })

  test('it is amber and never relies on colour alone: an icon and the words say it', () => {
    const html = renderToStaticMarkup(<OrderAttentionBar items={hold} />)
    assert.ok(hold[0].tone === 'amber')
    assert.match(html, /order-attention-icon/)
    assert.doesNotMatch(html, /order-attention-item--red/)
    assert.match(css, /\.order-attention \{[^}]*background: rgba\(232,160,48,0\.10\)/)
  })

  test('the permitted action stays on the right, and an unavailable one is simply not drawn', () => {
    const withAction = renderToStaticMarkup(<OrderAttentionBar items={hold} actions={<button type="button">Align production again</button>} />)
    assert.ok(withAction.indexOf('order-attention-message') < withAction.indexOf('order-attention-actions'))
    assert.match(withAction, /<div class="order-attention-actions"><button type="button">Align production again<\/button><\/div>/)
    assert.doesNotMatch(renderToStaticMarkup(<OrderAttentionBar items={hold} />), /order-attention-actions/)
    // wraps below the message on a narrow screen
    assert.match(css, /\.order-attention \{[^}]*flex-wrap: wrap/)
    assert.match(css, /\.order-attention-actions \{ width: 100%; margin-left: 0; \}/)
  })

  test('several issues are ALL kept, as compact rows under a count; red stays for the overdue one', () => {
    const items = orderAttentionItems({
      ...open, productionAligned: false, isOverdue: true, hasDueDate: true,
      advanceBelowLabel: 'x', advanceBelowParts: { title: 'Production on hold', detail: 'Verified advance is below 40%.' },
      awaitingVerificationCount: 2,
    })
    assert.deepEqual(items.map(i => i.key), ['overdue', 'advance_below', 'awaiting_verification'])
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    assert.match(text(html), /3 items need attention/)
    assert.equal((html.match(/<li /g) ?? []).length, 3)
    assert.match(html, /order-attention-item order-attention-item--red"><strong class="order-attention-title">Due date has passed/)
    assert.match(text(html), /Production on hold Verified advance is below 40%\./)
    assert.match(text(html), /2 payments awaiting Finance verification/)
  })

  test('an item with no separate reason uses its label as the title — every existing condition still draws', () => {
    const items = orderAttentionItems({ ...open, hasSalesperson: false })
    assert.deepEqual(items.map(i => i.label), ['Salesperson not set'])
    assert.match(renderToStaticMarkup(<OrderAttentionBar items={items} />), /<strong class="order-attention-title">Salesperson not set<\/strong>/)
  })

  test('nothing to say, nothing drawn', () => {
    assert.equal(renderToStaticMarkup(<OrderAttentionBar items={[]} />), '')
  })
})

describe('Activity: quiet, ordered, and complete', () => {
  const entry = (over: Partial<OrderActivityItem> = {}): OrderActivityItem => ({
    key: 'k', label: 'Production alignment changed', detail: 'Not Aligned → Aligned', lines: [], actor: 'Ops Olivia',
    when: '2 Oct 2026, 06:02 pm', dot: <span className="order-activity-dot" />, fromPi: false, ...over,
  })

  test('title first, then the detail, then who and when', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[entry()]} />)
    const body = html.slice(html.indexOf('order-activity-body'))
    assert.ok(body.indexOf('order-activity-title') < body.indexOf('order-activity-detail'))
    assert.ok(body.indexOf('order-activity-detail') < body.indexOf('order-activity-meta'))
    assert.match(html, /Ops Olivia · 2 Oct 2026, 06:02 pm/)
  })

  test('an unread event gets a small mark and a word for a screen reader — not a badge on every row', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[entry({ key: 'a', isNew: true }), entry({ key: 'b', isNew: true }), entry({ key: 'c' })]} />)
    assert.equal((html.match(/order-activity-unread/g) ?? []).length, 2)
    assert.equal((html.match(/New since your last visit<\/span>/g) ?? []).length, 2, 'the accessible indication is kept')
    assert.doesNotMatch(html, />New<\/span>/, 'no NEW badge per event')
    // the header still carries the count
    assert.match(text(html), /2 new since your last visit/)
    assert.doesNotMatch(renderToStaticMarkup(<OrderActivityList items={[entry()]} />), /new since your last visit/i, 'already read: no marks, no count')
  })

  test('no tinted fill on any event; thin separators; the coloured accent is the marker the page chooses', () => {
    assert.match(css, /\.order-activity-item--new \{\s*margin: 0;\s*\}/)
    assert.doesNotMatch(css, /\.order-activity-item--new \{[^}]*background/)
    assert.match(css, /\.order-activity-item \{[^}]*border-top: 1px solid rgba\(0,0,0,0\.07\)/)
  })

  test('event order, details, amendment lines and the PI marker are untouched', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[
      entry({ key: 'a', label: 'Order amended', lines: ['Total value: ₹1,00,000 → ₹1,20,000'] }),
      entry({ key: 'b', label: 'PI uploaded', fromPi: true, detail: null }),
    ]} />)
    assert.ok(html.indexOf('Order amended') < html.indexOf('PI uploaded'))
    assert.match(html, /<li>Total value: ₹1,00,000 → ₹1,20,000<\/li>/)
    assert.match(html, /order-activity-pi/)
  })

  test('an event type that arrives as snake_case reads as a sentence; real labels are untouched', () => {
    assert.equal(activityTitle('document_submission_operations_accepted'), 'Document submission operations accepted')
    assert.equal(activityTitle('Production alignment changed'), 'Production alignment changed')
    assert.equal(activityTitle('PI V2'), 'PI V2')
  })

  test('view-all / pagination is the same', () => {
    const many = Array.from({ length: 8 }, (_, i) => entry({ key: String(i) }))
    const html = renderToStaticMarkup(<OrderActivityList items={many} />)
    assert.equal((html.match(/<li class="order-activity-item/g) ?? []).length, 5)
    assert.match(text(html), /View all 8 events/)
  })
})

describe('Documents and typography stay local to this page', () => {
  test('Design files and Client PO sit side by side below Main PI, divided; they stack on a narrow card', () => {
    assert.match(css, /@container \(min-width: 760px\) \{[\s\S]*?\.order-docs-side \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\);/)
    assert.match(css, /\.order-docs-side \{ border-top: 1px solid #F0F2F5; \}/)
    assert.match(css, /\.order-docs-side \.order-doc-section \+ \.order-doc-section \{ grid-template-columns|\.order-docs-side \.order-doc-section \+ \.order-doc-section \{ border-top: 0; border-left: 1px solid #F0F2F5; \}/)
  })

  test('long file names wrap; nothing pushes a control off-screen', () => {
    assert.match(css, /\.order-doc-file-name \{ overflow-wrap: anywhere; min-width: 0; \}/)
    assert.match(css, /\.order-doc-file \{[^}]*max-width: 100%/)
  })

  test('the sizes: 16px section headings, 14px information, 12.5–13px supporting text, bold labels, regular values', () => {
    const rule = (sel: string) => css.slice(css.indexOf(`\n${sel} {`), css.indexOf('}', css.indexOf(`\n${sel} {`)))
    assert.match(rule('.order-docs-title'), /font-size: 16px/)
    assert.doesNotMatch(rule('.order-docs-title'), /text-transform: uppercase/)
    assert.match(rule('.order-ff-title'), /font-size: 16px/)
    assert.match(rule('.order-sum-group-head'), /font-size: 16px/)
    assert.match(rule('.order-sum-value'), /font-size: 14px/)
    assert.match(rule('.order-doc-dates dd'), /font-size: 14px/)
    assert.match(rule('.order-doc-note'), /font-size: 12\.5px/)
    assert.match(rule('.order-activity-meta'), /font-size: 12\.5px/)
    assert.match(rule('.order-doc-dates dt'), /font-weight: 700/)
    assert.doesNotMatch(rule('.order-doc-dates dt'), /uppercase/, 'no tiny uppercase captions')
  })

  test('supporting text is darker than it was (contrast)', () => {
    const note = css.slice(css.indexOf('\n.order-doc-note {'), css.indexOf('}', css.indexOf('\n.order-doc-note {')))
    assert.match(note, /color: #5B6474/)
    assert.doesNotMatch(note, /#8C94A6/)
  })
})
