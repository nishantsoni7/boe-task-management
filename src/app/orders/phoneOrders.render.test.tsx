// ORDERS ON A PHONE, Phase 3 (owner, 2026-11-05, "phones: content first").
//
// Below 768px every Orders page puts its list, table or record on the first
// screen; desktop and tablet are unchanged. These tests pin the phone rules
// (one block at the end of globals.css, all inside the phone media query) and
// the few markup hooks the pages gained for them.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { PiFormatButton } from '@/components/orders/PiFormatLink'
import { PI_FORMAT_ACTION } from '@/lib/orders/piFormat'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const css = read('src/app/globals.css')
const start = css.indexOf('PHONE PHASE 3 — ORDERS (owner')
// The Orders block runs to the next Phase 3 block (several modules append theirs).
const nextBlock = css.indexOf('PHONE PHASE 3 —', start + 20)
const block = css.slice(start, nextBlock < 0 ? undefined : css.lastIndexOf('/* ═', nextBlock))
const dashboard = read('src/app/orders/page.tsx')
const drafts = read('src/app/orders/drafts/page.tsx')
const bdpi = read('src/app/orders/bdpi/page.tsx')
const plan = read('src/app/orders/[id]/OrderPaymentPlan.tsx')

/** The declarations of the first rule in the block whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const at = block.indexOf(`\n  ${selector} {`)
  assert.ok(at > -1, `${selector} has a phone rule`)
  return block.slice(at, block.indexOf('}', at))
}

describe('the phone rules', () => {
  test('are one block at the end of globals.css, all inside the phone media query', () => {
    assert.ok(start > -1)
    const media = block.indexOf('@media (max-width: 767px) {')
    assert.ok(media > -1)
    // Everything after the heading comment is that one media block: nothing
    // reaches a desktop or a tablet.
    const body = block.slice(media)
    let depth = 0
    let closedAt = -1
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '{') depth++
      if (body[i] === '}') { depth--; if (depth === 0) { closedAt = i; break } }
    }
    assert.ok(closedAt > 0)
    assert.equal(body.slice(closedAt + 1).trim(), '', 'nothing after the media block')
  })

  test('/orders: six figures as two rows of three tiles, the lines under them dropped', () => {
    assert.match(rule('.od-ov-grid'), /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
    assert.match(rule('.od-ov-sub, .od-ov-detail'), /display: none/)
    assert.match(rule('.od-board-tab'), /min-height: 44px/)
    assert.match(rule('.od-board-tabs'), /flex-wrap: nowrap;[^}]*overflow-x: auto/)
  })

  test('header text buttons become 44px icons and keep their words for a screen reader', () => {
    assert.match(rule('.boe-page-header .orders-hdr-iconbtn'), /width: 44px; min-width: 44px; height: 44px/)
    const label = rule('.boe-page-header .orders-hdr-iconbtn .orders-hdr-label')
    assert.match(label, /clip: rect\(0, 0, 0, 0\)/)
    assert.doesNotMatch(label, /display: none/, 'hidden visually, not from assistive technology')
    assert.match(rule('.boe-page-header .orders-hdr-primary'), /width: 40px;[^}]*background: #B9472E/)
    assert.match(rule('.boe-page-header:has(.orders-hdr-iconbtn)'), /flex-wrap: nowrap/)
  })

  test('the Payment plan: goods as cards, nothing 900px wide, sums two to a row', () => {
    assert.match(rule('.opp-grid'), /display: block; min-width: 0/)
    assert.match(rule('.opp-grid colgroup, .opp-grid thead'), /display: none/)
    assert.match(rule('.opp-grid .opp-qty'), /min-height: 44px/)
    assert.match(rule('.opp-tile, .opp-tile-bal'), /flex-basis: 50%/)
  })

  test('the Confirmed Order: a number no bigger than 24px, the back arrow beside it', () => {
    assert.match(rule('.order-detail-page .order-command-number'), /font-size: 24px/)
    const back = rule('.order-detail-page > .order-back')
    assert.match(back, /width: 44px; height: 44px/)
    assert.match(back, /font-size: 0/, 'the words stay the link’s name; only the arrow shows')
  })

  test('Customize image learning: 44px tabs, 40px filter pills', () => {
    assert.match(rule('.cil-tab'), /min-height: 44px/)
    assert.match(rule('.cil-filters .pi-regen-chip'), /min-height: 40px/)
  })
})

describe('the markup the phone rules hang on', () => {
  test('Download PI Format keeps its link and its words, in a label the phone can hide', () => {
    const html = renderToStaticMarkup(<PiFormatButton />)
    assert.match(html, /class="boe-btn boe-btn-ghost orders-hdr-iconbtn"/)
    assert.ok(html.includes(`href="${PI_FORMAT_ACTION.href}"`))
    assert.ok(html.includes(`<span class="orders-hdr-label">${PI_FORMAT_ACTION.label}</span>`))
  })

  test('/orders: Upload PI and Select an order carry the icon hooks', () => {
    assert.ok(dashboard.includes('className="boe-btn boe-btn-primary orders-hdr-iconbtn orders-hdr-primary"'))
    assert.ok(dashboard.includes('<span className="orders-hdr-label">{NEW_ORDER_ACTION.label}</span>'))
    assert.ok(dashboard.includes('<span className="orders-hdr-label">{FOCUS_ADD_LABEL}</span>'))
  })

  test('PI Drafts: a one-line phone header and cards that pack into three lines', () => {
    assert.ok(drafts.includes('phoneSubtitle={phoneSubtitle}'))
    for (const hook of ['drafts-card', 'drafts-card-head', 'drafts-card-facts', 'drafts-card-value', 'drafts-card-actions']) {
      assert.ok(drafts.includes(`className="${hook}"`), hook)
    }
    assert.ok(drafts.includes('(isMobile ? listCards : listTable)('), 'the same choice of layout as before')
  })

  test('Old orders: the list first, New BDPI behind the header’s + on a phone', () => {
    assert.ok(bdpi.includes('className="boe-phone-only boe-header-icon boe-header-icon--add" aria-label="New BDPI"'))
    assert.ok(bdpi.includes("className={`opp bdpi-upload${uploadOpen ? ' is-open' : ''}`}"))
    assert.ok(bdpi.includes('className="opp-sub bdpi-intro"'))
    assert.match(rule('.bdpi-upload'), /display: none/)
    assert.match(rule('.bdpi-upload.is-open'), /position: fixed;[^}]*bottom: 0/)
  })

  test('the Payment plan names every figure cell, body and foot', () => {
    for (const label of ['Ordered', 'Sent', 'This lot', 'Left', 'Items', 'Packing', 'Fabric', 'Total']) {
      assert.equal((plan.match(new RegExp(`data-label="${label}"`, 'g')) ?? []).length, 2, label)
    }
  })
})
