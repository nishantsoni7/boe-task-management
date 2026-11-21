/**
 * The quotation builder polish, PR-A (owner's list of 13 Nov 2026; plan agreed 14 Nov): bigger and uncropped product pictures,
 * no Finish box, the contact person and the email under Advanced, the Client card beside a Share card, Terms and notes beside
 * History. No database change. The page is checked here as source text and the product row as a real render; the page as a
 * whole was also rendered in a browser (see the pull request).
 *
 * Run:
 *   npm run test:file -- src/components/quotations/builderPolish.test.tsx
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { LineRow } from './ProductLine'
import { saveDoc, type Header } from '@/lib/quotations/api'
import type { QuoteArea, QuoteLine } from '@/lib/quotations/math'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SCREEN = read('src/components/quotations/BuilderScreen.tsx')
const CLIENT = read('src/components/quotations/ClientCard.tsx')
const STATUS = read('src/components/quotations/StatusCard.tsx')
const SHARE = read('src/components/quotations/ShareCard.tsx')
const CSS = read('src/components/quotations/quotations.module.css')
// The text of one CSS rule: from its selector to the closing brace.
const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`)
  assert.ok(at >= 0, `${selector} is in the stylesheet`)
  return CSS.slice(at, CSS.indexOf('}', at) + 1)
}

const line = (over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: 'l1', area_key: null, name: 'Bed', size_text: '83 × 68', spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'fixed', qty: 2, unit_price: 38500, tax_rate: 18, image_path: null, is_optional: false, client_note: '', internal_note: '', ...over,
})
const header = (over: Partial<Header> = {}): Header => ({
  client_name: 'Aurora', project_name: 'Resort', contact_name: 'Rahul Mehta', contact_phone: '+91 90000 00001', contact_role: 'Architect',
  client_type: 'architect', supply_state: 'Rajasthan', gst_mode: 'cgst_sgst', discount_pct: 0, fabric_amount: 0, packing_amount: 0,
  transport_note: '', valid_days: 7, notes: '', internal_notes: '', client_email: 'rahul@aurora.example', company_name: '', client_gstin: '',
  dimension_unit: 'in', project_type: '', seats: null, lead_time_weeks: null, lead_time_reason: '', delivery_city: 'Jaipur', ...over,
})
const draw = (l: QuoteLine) => renderToStaticMarkup(
  <LineRow l={l} area={null} unit="in" editable qty={2} total={77000} first last url={p => `https://img.example/${p}`}
    onChange={() => {}} onUpload={() => {}} onImprove={() => {}} onView={() => {}} onRemove={() => {}} onMove={() => {}} onDuplicate={() => {}} />)

describe('the product picture (item 2)', () => {
  test('it is 25% bigger than the old 128 x 108 and shown whole, never cropped', () => {
    assert.match(rule('.plPicBtn'), /width: 160px; height: 135px;/)
    assert.match(rule('.plPicEmpty'), /width: 160px; height: 135px;/)
    assert.match(rule('.plPicImg'), /object-fit: contain;/)
    assert.ok(!/object-fit: cover/.test(rule('.plPicImg')), 'no cover')
    assert.match(rule('.pl'), /grid-template-columns: 180px minmax\(0, 1fr\) 296px;/, 'the picture column is wide enough for the new frame; the numbers column is wide enough for Quantity and Price side by side')
  })
  test('on a phone the frame is 140 x 118 (25% over the old 112 x 94) and the pop-up strip does not crop either', () => {
    assert.match(CSS, /@media \(max-width: 767px\) \{[\s\S]*?\.plPicBtn, \.plPicEmpty \{ width: 140px; height: 118px; flex-shrink: 0; \}/)
    assert.match(CSS, /\.viewerThumb img \{[^}]*object-fit: contain;/)
  })
})

describe('Finish is no longer a box (item 3)', () => {
  test('the product row has no Finish box; Product and Dimensions fill the first row', () => {
    const html = draw(line({ finish: 'PU' }))
    assert.ok(!html.includes('aria-label="Finish"') && !html.includes('<span>Finish</span>'))
    // two columns (owner, 15 Nov 2026): Product and Material are 5 of 12, Dimensions and Remarks are 7 of 12
    assert.match(html, /<label class="field c5"><span>Product<\/span>/)
    assert.match(html, /<label class="field c7"><span>Dimensions \(in\)<\/span>/)
    assert.match(html, /<label class="field c5"><span>Material<\/span>/)
    assert.match(html, /<label class="field c7"><span>Remarks \/ customization<\/span>/)
  })
  test('the value that is already stored still travels with every save, or the database would wipe it (it rewrites the lines)', () => {
    const doc = saveDoc(header(), [], [line({ finish: 'PU' })], '2026-11-14T00:00:00Z')
    assert.equal(doc.lines[0].finish, 'PU')
  })
})

describe('contact person and email (items 5 and 7)', () => {
  test('both left the main block and sit in Advanced, with the phone and the city staying on top (the state went down to Advanced on 18 Nov)', () => {
    const basic = CLIENT.slice(CLIENT.indexOf('className={s.fgrid}'), CLIENT.indexOf('{advOpen && ('))
    assert.ok(basic.includes('q-phone') && basic.includes('q-city') && basic.includes('q-client-name'))
    assert.ok(!basic.includes('q-contact') && !basic.includes('q-email') && !basic.includes('q-state'))
    const adv = CLIENT.slice(CLIENT.indexOf('id="q-advanced"'), CLIENT.indexOf('</section>', CLIENT.indexOf('id="q-advanced"')))
    assert.ok(adv.includes('id="q-contact"') && adv.includes('id="q-email"') && adv.includes('id="q-role"'))
  })
  test('a save still carries the contact, the role, the email, the city and the delivery state (quotation_save clears the ones a header leaves out)', () => {
    const doc = saveDoc(header(), [], [line()], '2026-11-14T00:00:00Z')
    for (const k of ['contact_name', 'contact_phone', 'contact_role', 'client_email', 'supply_state', 'delivery_city', 'client_type'] as const) {
      assert.equal(doc.header[k], header()[k], k)
    }
    assert.match(SCREEN, /saveDoc\(\{ \.\.\.header, lead_time_weeks: effectiveLeadTime\(h, areas\) \}/, 'the builder sends the whole header')
    assert.ok(SCREEN.includes('const header = costed.any ? { ...h, fabric_amount: costed.fabric, packing_amount: costed.packing } : h'), 'the whole header, with the two costing sums once a price was typed on the costing page')
  })
  test('a wrong email opens the advanced section, where the box is, before saying so', () => {
    assert.match(SCREEN, /const EMAIL_PROBLEM = 'Check the email address\.'/)
    assert.match(SCREEN, /if \(problem === EMAIL_PROBLEM\) setAdvOpen\(true\)/)
  })
})

describe('the page rows (items 8 and 9, redone on 18 Nov 2026)', () => {
  const between = (from: string, to: string) => SCREEN.slice(SCREEN.indexOf(from), SCREEN.indexOf(to))
  test('the top row is three compact cards (request, status, share), then the Client card, then the products', () => {
    const order = ['className={`${s.band}', '<RequestCard', '<StatusCard', '<ShareCard', '<ClientCard', 'aria-labelledby="q-products"'].map(i => SCREEN.indexOf(i))
    assert.ok(order.every(i => i > 0), 'every part is on the page')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order')
    assert.match(rule('.band'), /grid-template-columns: minmax\(0, \.9fr\) minmax\(0, 1\.5fr\) minmax\(0, 1\.1fr\);/)
    assert.match(rule('.bandTwo'), /grid-template-columns: minmax\(0, 1\.5fr\) minmax\(0, 1\.1fr\);/)
    assert.ok(SCREEN.includes("${hasRequest ? '' : s.bandTwo}"), 'a quotation that did not come from a request has a row of two cards')
  })
  test('Share carries the two downloads and the WhatsApp message', () => {
    for (const w of ['Download PDF', 'Download Excel', 'Open WhatsApp with the message', 'Create client link', 'Turn the link off']) assert.ok(SHARE.includes(w), w)
  })
  test('the downloads are made from the saved quotation: disabled while there are unsaved changes', () => {
    assert.match(SHARE, /dirty\s*\? <button type="button" className=\{s\.btn\} disabled><Printer/)
    assert.match(SHARE, /onClick=\{onExcel\} disabled=\{dirty \|\| busy \|\| lineCount === 0\}/)
  })
  test('Terms and notes (textareas stacked) and History share one row; the bottom grid no longer holds Share or History', () => {
    const pair = between('className={s.pair}', 'className={s.bottom}')
    assert.ok(pair.includes('id="q-terms"') && pair.includes('<h2>History</h2>'))
    assert.ok(!pair.includes('s.grid2'), 'the two notes boxes are stacked, not side by side')
    const bottom = between('className={s.bottom}', '{importing && profile')
    assert.ok(!bottom.includes('Share with the client') && !bottom.includes('<h2>History</h2>'))
    // the Quotation request card moved to the top row and the PI draft card is gone (owner, 18 Nov 2026): Versions and Price approval are left
    for (const w of ['VersionsCard', 'PriceCard']) assert.ok(bottom.includes(w), w)
    for (const w of ['RequestCard', 'PiCard']) assert.ok(!bottom.includes(w), `${w} is not at the bottom any more`)
    assert.match(rule('.pair'), /repeat\(2, minmax\(0, 1fr\)\);/)
  })
  test('a button label wraps inside its card rather than push past it: on a 320 px phone a label that does not wrap used to widen the whole card', () => {
    assert.match(rule('.acts2'), /flex-wrap: wrap;/)
    assert.match(rule('.card'), /min-width: 0;/)
  })
  test('under 1200 px the top row is two columns, under 1024 px Terms and History stack, and on a phone every grid is one column', () => {
    assert.match(CSS, /@media \(max-width: 1199px\) \{[^@]*\.band, \.bandTwo \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    assert.match(CSS, /@media \(max-width: 1023px\) \{\s*\.pair \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.match(CSS, /\.grid2, \.grid3, \.grid4, \.band, \.bandTwo, \.fgrid, \.leadEdit \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })
})

describe('the tidy-up of 18 Nov 2026 (owner: request on top, no PI draft card, City, one-line Saved, no Total)', () => {
  const between = (from: string, to: string) => SCREEN.slice(SCREEN.indexOf(from), SCREEN.indexOf(to))
  test('the Quotation request card is the first card of the top row: after the Needs you strip, before Status', () => {
    assert.ok(SCREEN.indexOf('<RequestCard') > SCREEN.indexOf('waiting.length > 0'))
    assert.ok(SCREEN.indexOf('<RequestCard') < SCREEN.indexOf('<StatusCard'))
  })
  test('the PI draft card and the PI-format download are gone, but a sent quotation can still become a PI from the Status card', () => {
    assert.ok(!/PiCard|downloadPi|Download in PI format/.test(SCREEN + STATUS))
    for (const w of ['Confirm → make PI draft', 'Open the PI draft', 'onClick={onConfirm}', 'Show which', 'Waiting for price approval']) assert.ok(STATUS.includes(w), w)
    assert.match(SCREEN, /const canConfirm = base\.may_edit && !base\.pi && \(base\.status === 'sent' \|\| base\.status === 'negotiating'\)/)
    assert.match(STATUS, /disabled=\{off \|\| piProblems\.length > 0 \|\| priceBlocked\}/, 'the same reasons the old card had for waiting')
  })
  test('the page header says Saved on one line and no longer carries the total', () => {
    const actions = between('const actions = (', 'const body = (')
    assert.ok(!actions.includes('Total') && !actions.includes('formatINR'), 'no Total in the header: it is in the totals card')
    assert.ok(actions.includes('s.saveState') && actions.includes('Saved') && actions.includes('Unsaved changes'))
    assert.match(rule('.saveState'), /white-space: nowrap;/)
    assert.match(rule('.saveState'), /flex-shrink: 0;/)
  })
  test('the Client card asks for the city; a well-known city fills the state and the tax, the state box is under Advanced', () => {
    assert.ok(CLIENT.indexOf('<span>Delivery state</span>') > CLIENT.indexOf('id="q-advanced"'))
    assert.match(CLIENT, /onChange=\{e => onCity\(e\.target\.value\)\}/)
    assert.match(SCREEN, /const st = stateOfCity\(v\)/)
    assert.match(SCREEN, /\.\.\.\(st \? \{ supply_state: st, gst_mode: gstModeForState\(st\) \} : \{\}\)/, 'an unknown city leaves the state and the tax alone')
    assert.ok(CLIENT.includes('maxLength={80}'), 'the database refuses more than 80 characters')
  })
  test('Versions and Price approval fill the bottom row; one alone takes the whole row', () => {
    assert.match(rule('.bottom'), /display: flex;/)
    assert.match(CSS, /\.bottom > \* \{ flex: 1 1 0; min-width: 0; \}/)
  })
})

describe('the capped page and its header (owner-approved layout, 18 Nov 2026)', () => {
  test('the builder asks the layout for a centred 1360 px column, as BoeOsLayout does for other modules', () => {
    assert.ok(SCREEN.includes('contentMaxWidth={1360}'))
    const layout = read('src/components/layout/QuotationsLayout.tsx')
    assert.ok(layout.includes('boe-main-content-capped') && layout.includes("'--boe-content-max'") || layout.includes('--boe-content-max'))
    assert.ok(layout.includes('contentMaxWidth?: number'))
  })
  test('on a phone the status pill and "Saved" leave the header (the Status card shows them) and Print keeps its name for a screen reader', () => {
    const actions = SCREEN.slice(SCREEN.indexOf('const actions = ('), SCREEN.indexOf('const body = ('))
    assert.ok(actions.includes('<span className={s.hideOnPhone}><StatusPill'))
    assert.ok(actions.includes('aria-label="Print / PDF"'))
  })
  test('the rhythm: 24 px between rows, 16 px between cards, a 16 px section heading, nothing under 12 px (BOE identity)', () => {
    assert.match(rule('.builder'), /gap: 24px;/)
    assert.match(rule('.band'), /gap: 16px;/)
    assert.match(rule('.builder .cardHead h2'), /font-size: 16px;/)
    const block = CSS.slice(CSS.indexOf("/* THE BUILDER'S TOP AREA"), CSS.indexOf('.advGrid {'))
    const sizes = [...block.matchAll(/font(?:-size)?: (?:\d+ )?(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]))
    assert.ok(sizes.length > 5 && sizes.every(n => n >= 12), `font sizes in the new block: ${sizes.join(', ')}`)
  })
})

describe('the suggested price: who sees "Why?" (owner, 15 Nov 2026)', () => {
  test('the builder hands the product rows the way to correct the logic only to the Pricing module\'s people, decided as the /pricing guard decides', () => {
    assert.match(SCREEN, /canAccessManagementModule\(\{ role: subject\.subjectRole, moduleKey: 'pricing', isModuleActive: true, permissions: subject\.subjectPermissionsByModule\.get\('pricing'\) \?\? \[\] \}\)/)
    assert.ok(SCREEN.includes('feedbackCtx={seesWhy ? {'), 'a person without Pricing gets no feedbackCtx, so no "Why?" and no form')
    assert.ok(read('src/app/pricing/layout.tsx').includes('moduleKey="pricing"'), 'the module this check mirrors')
  })
})

describe('the numbers panel of a product (owner, 15 Nov 2026)', () => {
  const area: QuoteArea = { key: 'r', name: 'BOHO ROOM', style: '', multiplier: 56, unit_label: 'rooms' }
  const HINT = { name: 'Bed', ordered: { last: 7300, last_at: '2026-06-01', min: 2650, max: 11550, count: 39 }, quoted: null }
  const drawWith = (l: QuoteLine, o: { area?: QuoteArea | null; editable?: boolean; hint?: typeof HINT } = {}) => renderToStaticMarkup(
    <LineRow l={l} area={o.area ?? null} unit="in" editable={o.editable ?? true} qty={2} total={77000} first last url={p => `https://img.example/${p}`} hint={o.hint}
      onChange={() => {}} onUpload={() => {}} onImprove={() => {}} onView={() => {}} onRemove={() => {}} onMove={() => {}} onDuplicate={() => {}} />)
  const panel = (html: string) => html.slice(html.indexOf('class="plRight"'))

  test('its parts come in this order: Quantity and Price, the suggestion, then the footer (Optional, the total, the tools, the piece count)', () => {
    const right = panel(drawWith(line(), { hint: HINT }))
    const order = ['class="qp"', '<span>Quantity</span>', '<span>Price before GST</span>', 'class="sug"', 'class="plFoot"', 'Optional', '₹77,000', 'aria-label="Move up"', '2 pieces']
    const at = order.map(p => right.indexOf(p))
    assert.ok(at.every(i => i >= 0), `every part is drawn: ${order.filter((_, i) => at[i] < 0).join(', ')}`)
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order')
  })
  test('Quantity is one box holding the number and its unit; the rupee sign is inside the price box, not in its label', () => {
    const right = panel(drawWith(line()))
    assert.match(right, /<div class="qtyBox"><input aria-label="Quantity" class="qtyIn"[^>]*type="number"[^>]*\/><span class="qtyUnit">pieces<\/span><\/div>/)
    assert.match(right, /<span class="rupeeBox"><span class="rs" aria-hidden="true">₹<\/span><input aria-label="Unit price \(₹, before GST\)" class="rupeeIn"/)
    assert.ok(!right.includes('Price ₹ before GST'))
  })
  test('in a room type the "per room / in total" choice sits in the same box as the number, not in a box of its own', () => {
    const right = panel(drawWith(line({ area_key: 'r', qty_mode: 'per_unit' }), { area }))
    assert.match(right, /<div class="qtyBox"><input aria-label="Quantity per room" class="qtyIn"[\s\S]*?<select aria-label="Quantity is" class="qtySel"[\s\S]*?<option value="per_unit"[^>]*>per (?:<!-- -->)?room<\/option><option value="fixed">in total<\/option><\/select><\/div>/)
    assert.ok(!right.includes('qtyUnit'))
  })
  test('the suggestion card is part of the panel only when there is something to suggest, and a locked quotation has no tools', () => {
    assert.ok(!drawWith(line()).includes('class="sug"'))
    const locked = panel(drawWith(line(), { editable: false, hint: HINT }))
    assert.ok(!locked.includes('plTools') && !locked.includes('aria-label="Move up"'), 'no tools')
    assert.ok(!locked.includes('sugUse'), 'no Use')
    assert.ok(locked.includes('class="plFoot"') && locked.includes('2 pieces'), 'the footer still shows the total and the count')
  })
  test('the panel is a bordered card as tall as the boxes beside it, with its footer at the bottom', () => {
    assert.match(rule('.plRight'), /display: flex; flex-direction: column;[^}]*align-self: stretch;[^}]*border: 1px solid var\(--boe-border\); border-radius: 12px;/)
    assert.match(rule('.plFoot'), /margin: auto -12px 0;[^}]*border-radius: 0 0 11px 11px;/)
    assert.match(rule('.qp'), /grid-template-columns: 150px minmax\(0, 1fr\);/)
    assert.match(rule('.qtyIn'), /width: 60px;/)
    assert.ok(!CSS.includes('nth-child(n+3)'), 'the old two-track rule is gone')
  })
  test('under 1200 px the panel sits under the boxes, lined up with them (up to 420 px wide); on a phone it is full width with 44 px controls', () => {
    assert.match(CSS, /@media \(max-width: 1199px\) \{[\s\S]*?\.plRight \{ grid-column: 2; justify-self: start; width: 100%; max-width: 420px; \}/)
    assert.match(CSS, /@media \(max-width: 767px\) \{[\s\S]*?\.plRight \{ grid-column: 1; justify-self: stretch; max-width: none; \}\s*\.qtyBox, \.rupeeBox \{ height: 44px; \}\s*\.qtyIn, \.rupeeIn, \.qtySel \{ font-size: 16px; \}\s*\.plTools \.iconBtn \{ width: 44px; height: 44px; \}/)
  })
})
