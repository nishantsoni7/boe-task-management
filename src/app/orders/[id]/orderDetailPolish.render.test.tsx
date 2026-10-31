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

describe('the notifications: one banner per item, tinted by kind', () => {
  const hold = orderAttentionItems({
    ...open, productionAligned: false,
    advanceBelowLabel: 'Production on hold: advance below 40% — see Payment',
    advanceBelowParts: { title: 'Production on hold', detail: 'Verified advance is below 40%.' },
  })

  test('a banner leads with its title, then one short reason', () => {
    const html = renderToStaticMarkup(<OrderAttentionBar items={hold} />)
    assert.equal(hold.length, 1)
    assert.match(html, /<strong class="order-notice-title">Production on hold<\/strong><span class="order-notice-detail">Verified advance is below 40%\.<\/span>/)
    assert.doesNotMatch(text(html), /needs? attention/)
    assert.match(html, /aria-label="Production on hold"/, 'a screen reader hears the issue, not a count')
    assert.equal(attentionAriaLabel(hold), 'Production on hold')
  })

  test('amber for waiting work, blue for a changed PI, red for a flagged or wrong thing — an icon and the words always say it', () => {
    const html = renderToStaticMarkup(<OrderAttentionBar items={hold} />)
    assert.ok(hold[0].tone === 'amber')
    assert.match(html, /order-notice order-notice--amber/)
    assert.match(html, /order-notice-icon/)
    assert.match(css, /\.order-notice--amber \{[^}]*background: #FFF7E6;[^}]*border-left-color: #E08A00/)
    assert.match(css, /\.order-notice--blue \{[^}]*background: #EEF4FF;[^}]*border-left-color: #2F6BFF/)
    assert.match(css, /\.order-notice--red \{[^}]*background: #FFF0EE;[^}]*border-left-color: #D92D20/)
    // Side by side, sharing the row, rather than one full-width line each
    // (owner, 2026-10-31); a phone keeps one under the other.
    assert.match(css, /\.order-notices \{ display: flex; flex-wrap: wrap; gap: 8px; \}/)
    assert.match(css, /\.order-notice \{ flex: 1 1 360px;/)
    assert.match(css, /@media \(max-width: 640px\) \{ \.order-notice \{ flex-basis: 100%; \}/)
    const revision = orderAttentionItems({ ...open, pendingPiRevision: true })
    assert.equal(revision[0].tone, 'blue')
    assert.match(renderToStaticMarkup(<OrderAttentionBar items={revision} />), /order-notice--blue/)
  })

  test('the permitted action sits on the right of the operations-review banner, and an unavailable one is simply not drawn', () => {
    const items = orderAttentionItems({ ...open, operationsReview: { versionNumber: 1, status: 'awaiting', unassigned: false } })
    const withAction = renderToStaticMarkup(<OrderAttentionBar items={items} actions={<button type="button">Accept for production</button>} />)
    assert.ok(withAction.indexOf('order-notice-text') < withAction.indexOf('order-notice-actions'))
    assert.match(withAction, /<div class="order-notice-actions"><button type="button">Accept for production<\/button><\/div>/)
    assert.doesNotMatch(renderToStaticMarkup(<OrderAttentionBar items={items} />), /order-notice-actions/)
    assert.match(css, /\.order-notice-actions \{[^}]*margin-left: auto/)
  })

  test('several issues are ALL kept, one banner each; red stays for the overdue one', () => {
    const items = orderAttentionItems({
      ...open, productionAligned: false, isOverdue: true, hasDueDate: true,
      advanceBelowLabel: 'x', advanceBelowParts: { title: 'Production on hold', detail: 'Verified advance is below 40%.' },
      awaitingVerificationCount: 2,
    })
    assert.deepEqual(items.map(i => i.key), ['overdue', 'advance_below', 'awaiting_verification'])
    const html = renderToStaticMarkup(<OrderAttentionBar items={items} />)
    assert.match(html, /aria-label="3 items need attention"/)
    assert.equal((html.match(/class="order-notice order-notice--/g) ?? []).length, 3)
    assert.match(html, /order-notice order-notice--red"><span class="order-notice-icon">.*?<strong class="order-notice-title">Due date has passed/)
    assert.match(text(html), /Production on hold Verified advance is below 40%\./)
    assert.match(text(html), /2 payments awaiting Finance verification/)
  })

  test('a confirm-to-upload gap is no banner: the Important dates card flags it (owner, 2026-10-31)', () => {
    const workspace = readFileSync('src/lib/orders/orderWorkspace.ts', 'utf8')
    assert.ok(!workspace.includes('upload_gap'))
    assert.ok(!workspace.includes('days apart'))
    const redesign = readFileSync('src/app/orders/[id]/OrderRedesign.tsx', 'utf8')
    assert.ok(redesign.includes('uploadGapLabel(timeline.uploadGapDays)'), 'the dates card keeps its flag')
  })

  test('the pendency approval form drops under the row instead of squeezing its words', () => {
    assert.match(css, /\.order-ff-pend-item \{\s*display: flex;\s*flex-wrap: wrap;/)
  })

  test('an item with no separate reason uses its label as the title — every existing condition still draws', () => {
    const items = orderAttentionItems({ ...open, hasSalesperson: false })
    assert.deepEqual(items.map(i => i.label), ['Salesperson not set'])
    assert.match(renderToStaticMarkup(<OrderAttentionBar items={items} />), /<strong class="order-notice-title">Salesperson not set<\/strong>/)
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

  test('what happened first (title, then detail), then who, then when — three clear places', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[entry()]} />)
    const body = html.slice(html.indexOf('order-activity-body'))
    assert.ok(body.indexOf('order-activity-title') < body.indexOf('order-activity-detail'))
    assert.ok(body.indexOf('order-activity-detail') < body.indexOf('order-activity-by'))
    assert.ok(body.indexOf('order-activity-by') < body.indexOf('order-activity-when'))
    assert.match(html, /<div class="order-activity-by">Ops Olivia<\/div><div class="order-activity-when">2 Oct 2026, 06:02 pm<\/div>/)
  })

  test('key events are listed in a navigation on the right, and each is a button that jumps to its entry', () => {
    const html = renderToStaticMarkup(<OrderActivityList items={[
      entry({ key: 'a', label: 'Order amended', important: true }),
      entry({ key: 'b', label: 'Note added' }),
    ]} />)
    assert.match(html, /<nav class="order-activity-nav" aria-label="Key events">/)
    assert.equal((html.match(/class="order-activity-nav-link"/g) ?? []).length, 1)
    assert.match(html, /id="activity-a"/)
    assert.match(html, /order-activity-item--key/)
    assert.doesNotMatch(renderToStaticMarkup(<OrderActivityList items={[entry()]} />), /order-activity-nav"/, 'no key events, no navigation')
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
    assert.match(css, /\.order-activity-item \{[^}]*border-top: 1px solid #E4DED7/)
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
    assert.match(css, /\.order-docs-side \{ border-top: 1px solid #F1EEE9; \}/)
    assert.match(css, /\.order-docs-side \.order-doc-section \+ \.order-doc-section \{ grid-template-columns|\.order-docs-side \.order-doc-section \+ \.order-doc-section \{ border-top: 0; border-left: 1px solid #F1EEE9; \}/)
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
    assert.match(note, /color: #686D6C/)
    assert.doesNotMatch(note, /#8C94A6|#6B7384/, 'not the lighter greys the page used before the rebrand')
  })
})
