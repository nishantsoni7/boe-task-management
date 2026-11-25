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
const PANEL = read('src/components/quotations/TopPanel.tsx')
const CSS = read('src/components/quotations/quotations.module.css')
// The text of one CSS rule: from its selector to the closing brace.
const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`)
  assert.ok(at >= 0, `${selector} is in the stylesheet`)
  return CSS.slice(at, CSS.indexOf('}', at) + 1)
}
// Quotation page version 2 (25 Nov 2026) is appended last so it wins over the older rules: its own rule for a selector, and its media queries.
const V2 = CSS.slice(CSS.indexOf('/* ── Quotation page version 2'))
const v2rule = (selector: string) => {
  const at = V2.indexOf(`\n${selector} {`)
  assert.ok(at >= 0, `${selector} is in the version 2 block`)
  return V2.slice(at + 1, V2.indexOf('}', at) + 1)
}
const LEAD_QUOTES = read('src/components/salesLeads/LeadQuotes.tsx')

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
  <LineRow l={l} n={1} area={null} unit="in" editable qty={2} total={77000} first last url={p => `https://img.example/${p}`}
    onChange={() => {}} onUpload={() => {}} onImprove={() => {}} onView={() => {}} onRemove={() => {}} onMove={() => {}} onDuplicate={() => {}} />)

describe('the product picture (item 2; version 2 of 25 Nov 2026)', () => {
  test('it is a 152 px square tile, shown whole and never cropped, with the product\'s number on it', () => {
    assert.match(v2rule('.plPicBtn'), /width: 152px; height: 152px;/)
    assert.match(v2rule('.plPicEmpty'), /width: 152px; height: 152px;/)
    assert.match(rule('.plPicImg'), /object-fit: contain;/)
    assert.ok(!/object-fit: cover/.test(rule('.plPicImg')), 'no cover')
    assert.match(v2rule('.plNo'), /position: absolute; left: 8px; top: 8px;/)
    assert.match(v2rule('.pl'), /grid-template-columns: 152px minmax\(0, 1fr\) 300px; grid-template-areas: "pic mid right" "pic strip strip" "open open open";/, 'picture | boxes | numbers, the strip under the boxes, what it opens across the whole product')
  })
  test('on a phone the tile is 104 px square beside the boxes, and the pop-up strip does not crop either', () => {
    assert.match(V2, /@media \(max-width: 767px\) \{[\s\S]*?\.plPic, \.plPicBtn, \.plPicEmpty \{ width: 104px; \}\s*\.plPicBtn, \.plPicEmpty \{ height: 104px; \}/)
    assert.match(CSS, /\.viewerThumb img \{[^}]*object-fit: contain;/)
  })
  test('the rows are no longer shaded every other one (zebra gone)', () => {
    assert.match(v2rule('.pl:nth-of-type(even)'), /background: var\(--boe-surface\);/)
  })
})

describe('Finish is no longer a box (item 3)', () => {
  test('the product row has no Finish box; Product and Dimensions fill the first row, Material and Remarks the second', () => {
    const html = draw(line({ finish: 'PU' }))
    assert.ok(!html.includes('aria-label="Finish"') && !html.includes('<span>Finish</span>'))
    // two columns (owner, 15 Nov 2026): Product and Material are 5 of 12, Dimensions and Remarks are 7 of 12
    assert.match(html, /<label class="field c5"><span>Product<\/span><input aria-label="Product name" class="input plName"/)
    assert.match(html, /<label class="field c7"><span>Dimensions<\/span>/, 'the unit is inside the box, not in the label (version 2)')
    assert.match(html, /<label class="field c5 grow"><span>Material<\/span>/)
    assert.match(html, /<label class="field c7 grow"><span class="labRow">Remarks \/ customization<span class="clientTag" title="The client reads this">/)
    assert.match(v2rule('.plName'), /font-weight: 600; font-size: 16px;/)
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
  test('the top is the request (when there is one) and ONE panel, then the products, the totals, and the Client card under the totals (25 Nov 2026)', () => {
    const order = ['className={s.topStack}', '<RequestCard', '<TopPanel', 'aria-label="Products and costing"', 'id="q-extra"', '<ClientCard'].map(i => SCREEN.indexOf(i))
    assert.ok(order.every(i => i > 0), 'every part is on the page')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order')
    assert.match(rule('.topStack'), /gap: 12px;/)
    assert.match(rule('.panel'), /border-radius: var\(--boe-radius-panel\);/)
    assert.match(rule('.prow'), /grid-template-columns: 64px minmax\(0, 1fr\);/)
    for (const gone of ['.band', '.bandTwo', '.strip', '.steps', '.leadStrip', '.askStrip', '.shareFoot']) assert.ok(!CSS.includes(`${gone} {`), `${gone} is gone`)
  })
  test('the Share row carries the two downloads, the client link and WhatsApp', () => {
    for (const w of ['Download PDF', 'Download Excel', 'WhatsApp', 'Copy link', 'Create client link', 'Turn the client link off']) assert.ok(PANEL.includes(w), w)
  })
  test('the downloads are made from the saved quotation: disabled while there are unsaved changes', () => {
    assert.match(PANEL, /dirty\s*\? <button type="button" className=\{s\.btn\} disabled title="Save first"><Printer/)
    assert.match(PANEL, /onClick=\{onExcel\} disabled=\{dirty \|\| busy \|\| lineCount === 0\}/)
  })
  test('Terms and notes (textareas stacked) and History share one row; the bottom grid no longer holds Share or History', () => {
    const pair = between('className={s.pair}', 'className={s.bottom}')
    assert.ok(pair.includes('id="q-terms"') && pair.includes('<h2>History</h2>'))
    assert.ok(!pair.includes('s.grid2'), 'the two notes boxes are stacked, not side by side')
    const bottom = between('className={s.bottom}', '{importing && profile')
    assert.ok(!bottom.includes('Share with the client') && !bottom.includes('<h2>History</h2>'))
    // the Quotation request card moved to the top row and the PI draft card is gone (owner, 18 Nov 2026); Price approval moved into the Status card (23 Nov 2026): Versions is left
    assert.ok(bottom.includes('VersionsCard'))
    for (const w of ['RequestCard', 'PiCard', 'PriceCard', 'PriceBlock']) assert.ok(!bottom.includes(w), `${w} is not at the bottom any more`)
    assert.match(rule('.pair'), /repeat\(2, minmax\(0, 1fr\)\);/)
  })
  test('a button label wraps inside its card rather than push past it: on a 320 px phone a label that does not wrap used to widen the whole card', () => {
    assert.match(rule('.acts2'), /flex-wrap: wrap;/)
    assert.match(rule('.card'), /min-width: 0;/)
  })
  test('under 1200 px the Client fields are two columns, under 1024 px Terms and History stack, and on a phone every grid is one column', () => {
    assert.match(CSS, /@media \(max-width: 1199px\) \{[^@]*\.fgrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/)
    assert.match(CSS, /@media \(max-width: 1023px\) \{\s*\.pair \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.match(CSS, /\.grid2, \.grid3, \.grid4, \.fgrid, \.leadEdit \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })
})

describe('the tidy-up of 18 Nov 2026 (owner: request on top, no PI draft card, City, one-line Saved, no Total)', () => {
  const between = (from: string, to: string) => SCREEN.slice(SCREEN.indexOf(from), SCREEN.indexOf(to))
  test('the Quotation request card is the first card of the top row, before Status; the Needs you strip is gone (23 Nov 2026: its words are in the Status card)', () => {
    assert.ok(SCREEN.indexOf('<RequestCard') < SCREEN.indexOf('<TopPanel'))
    assert.ok(!SCREEN.includes('Needs you') && !SCREEN.includes('Go there'))
  })
  test('the PI draft card and the PI-format download are gone; a PI draft is made in Lead Management now, and the panel only opens one that exists (25 Nov 2026)', () => {
    assert.ok(!/PiCard|downloadPi|Download in PI format/.test(SCREEN + PANEL))
    for (const gone of ['onConfirm', 'canConfirm', 'makePiDraft', 'piProblems', 'Show which']) assert.ok(!(SCREEN + PANEL).includes(gone), `${gone} is gone from the quotation page`)
    assert.ok(PANEL.includes('Open the PI draft') && PANEL.includes('href={draftDetailHref(base.pi.id)}'))
    assert.ok(LEAD_QUOTES.includes("'Create PI draft'"), 'the button on the lead\'s quotation line')
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
  test('Versions takes the bottom row (a card alone takes the whole row)', () => {
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
  test('the header carries no status (24 Nov 2026: the lead is the status) and, on a phone, "Saved" leaves it too; Print / PDF is not in the header at all (23 Nov 2026: it is Download PDF in the panel)', () => {
    const actions = SCREEN.slice(SCREEN.indexOf('const actions = ('), SCREEN.indexOf('const body = ('))
    assert.ok(!actions.includes('StatusPill') && actions.includes('s.hideOnPhone'))
    assert.ok(!actions.includes('Print / PDF') && !actions.includes('/print'))
  })
  test('the rhythm: 24 px between rows, 16 px between cards, a 16 px section heading, nothing under 12 px (BOE identity)', () => {
    assert.match(rule('.builder'), /gap: 24px;/)
    assert.match(rule('.topStack'), /gap: 12px;/)
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

describe('the numbers panel of a product (owner, 15 Nov 2026; version 2 of 25 Nov 2026)', () => {
  const area: QuoteArea = { key: 'r', name: 'BOHO ROOM', style: '', multiplier: 56, unit_label: 'rooms' }
  const HINT = { name: 'Bed', ordered: { last: 7300, last_at: '2026-06-01', min: 2650, max: 11550, count: 39 }, quoted: null }
  const drawWith = (l: QuoteLine, o: { area?: QuoteArea | null; editable?: boolean; hint?: typeof HINT } = {}) => renderToStaticMarkup(
    <LineRow l={l} n={1} area={o.area ?? null} unit="in" editable={o.editable ?? true} qty={2} total={77000} first last url={p => `https://img.example/${p}`} hint={o.hint}
      onChange={() => {}} onUpload={() => {}} onImprove={() => {}} onView={() => {}} onRemove={() => {}} onMove={() => {}} onDuplicate={() => {}} />)
  const panel = (html: string) => html.slice(html.indexOf('class="plRight"'))

  test('its parts come in this order: Quantity × Price, the price help, the line total with its sum written out, Optional; the tools are in the strip after it', () => {
    const right = panel(drawWith(line(), { hint: HINT }))
    const order = ['class="qp"', '<span>Quantity</span>', '<span>Price before GST</span>', 'class="helpBox"', 'class="sug"', 'class="plFoot', 'Line total', '₹77,000', '2 pieces × ₹38,500', 'Optional', 'leave out of the total', 'class="plStrip"', 'aria-label="Move up"']
    const at = order.map(p => right.indexOf(p))
    assert.ok(at.every(i => i >= 0), `every part is drawn: ${order.filter((_, i) => at[i] < 0).join(', ')}`)
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'in that order')
  })
  test('a product without a price says "No price yet" instead of a total; an optional one says it is not in the total', () => {
    const none = panel(drawWith(line({ unit_price: null })))
    assert.match(none, /Line total<\/span><span class="chip chWait">No price yet<\/span>/)
    assert.ok(none.includes('2 pieces') && !none.includes('2 pieces ×'))
    const opt = panel(drawWith(line({ is_optional: true })))
    assert.ok(opt.includes('class="plFoot plFootOpt"') && opt.includes('Optional · not in the total'))
  })
  test('Quantity is one box holding the number and its unit; the rupee sign is inside the price box, not in its label', () => {
    const right = panel(drawWith(line()))
    assert.match(right, /<div class="qtyBox"><input aria-label="Quantity" class="qtyIn"[^>]*type="number"[^>]*\/><span class="qtyUnit">pieces<\/span><\/div>/)
    assert.match(right, /<span class="rupeeBox"><span class="rs" aria-hidden="true">₹<\/span><input aria-label="Unit price \(₹, before GST\)" class="rupeeIn"/)
    assert.ok(!right.includes('Price ₹ before GST'))
    assert.ok(panel(drawWith(line({ qty: 1 }))).includes('<span class="qtyUnit">piece</span>'), 'one piece')
  })
  test('the price box is a text box with a number keypad that shows the price with its commas (13,500) while nobody is typing in it', () => {
    const box = panel(drawWith(line({ unit_price: 13500 }))).match(/<input aria-label="Unit price \(₹, before GST\)"[^>]*>/)?.[0] ?? ''
    assert.match(box, /type="text"/)
    assert.match(box, /inputMode="numeric"/i)
    assert.match(box, /value="13,500"/)
  })
  test('in an area (was a room type) the "per room / in total" choice sits in the same box as the number, not in a box of its own', () => {
    const right = panel(drawWith(line({ area_key: 'r', qty_mode: 'per_unit' }), { area }))
    assert.match(right, /<div class="qtyBox"><input aria-label="Quantity per room" class="qtyIn"[\s\S]*?<select aria-label="Quantity is" class="qtySel"[\s\S]*?<option value="per_unit"[^>]*>per (?:<!-- -->)?room<\/option><option value="fixed">in total<\/option><\/select><\/div>/)
    assert.ok(!right.includes('qtyUnit'))
  })
  test('the price help is part of the panel only when there is something to suggest, and a locked quotation has no tools', () => {
    assert.ok(!drawWith(line()).includes('class="sug"'))
    assert.ok(drawWith(line()).includes('<div class="helpBox"></div>'), 'empty, so the stylesheet hides it')
    const locked = panel(drawWith(line(), { editable: false, hint: HINT }))
    assert.ok(!locked.includes('plTools') && !locked.includes('aria-label="Move up"'), 'no tools')
    assert.ok(!locked.includes('sugUse'), 'no Use')
    assert.ok(locked.includes('class="plFoot') && locked.includes('2 pieces'), 'the line total and the count still show')
  })
  test('the numbers column is set off by a line on its left and is as tall as the boxes; the line total sits under a rule; an empty help box takes no room', () => {
    assert.match(v2rule('.plRight'), /display: flex; flex-direction: column;[^}]*align-self: stretch; padding: 0 0 0 24px; border: 0; border-left: 1px solid var\(--boe-border\);/)
    assert.match(v2rule('.plFoot'), /margin: 0; padding: 10px 0 0; border-top: 1px solid var\(--boe-border\);/)
    assert.match(v2rule('.qp'), /grid-template-columns: minmax\(0, 1\.1fr\) 12px minmax\(0, 1fr\);/, 'Quantity × Price')
    assert.match(v2rule('.qtyIn'), /width: 48px;/)
    assert.match(v2rule('.helpBox:empty'), /display: none;/)
    assert.ok(!CSS.includes('nth-child(n+3)'), 'the old two-track rule is gone')
  })
  test('under 1024 px the numbers go under the picture and the boxes; on a phone everything stacks and the buttons are 44 px', () => {
    assert.match(V2, /@media \(max-width: 1023px\) \{\s*\.pl \{ grid-template-columns: 152px minmax\(0, 1fr\); grid-template-areas: "pic mid" "pic strip" "right right" "open open"; \}/)
    const phone = V2.slice(V2.indexOf('@media (max-width: 767px)'))
    assert.match(phone, /\.pl \{ grid-template-columns: 104px minmax\(0, 1fr\); grid-template-areas: "pic mid" "right right" "strip strip" "open open";/)
    for (const r of ['.plAct { width: 44px; height: 44px; }', '.plTools .iconBtn { width: 44px; height: 44px; }', '.stripBtn { min-height: 44px; }']) assert.ok(phone.includes(r), r)
  })
})

describe('the top panel of 24 Nov 2026 (owner: smartly designed, no wasted height, the lead is the status, no price block)', () => {
  const at = (needle: string) => SCREEN.indexOf(needle)
  test('the "Saved." message is gone (the header says Saved); every other message stays', () => {
    assert.ok(!SCREEN.includes("text: 'Saved.'"))
    assert.ok(SCREEN.includes("setMsg(null) // the header's"), 'a save clears what was on screen and says nothing more')
    assert.ok(SCREEN.includes('Unsaved changes') && SCREEN.includes("tone: 'bad'") && SCREEN.includes('undo: () =>'))
  })
  test('Status and Lead (both drawn by LeadCard), Senior and Share are rows of ONE panel, in that order, before the products; a row with nothing to say draws nothing', () => {
    const order = ['<LeadCard', '<AskNote', 'aria-label="Share"', '<AskButton'].map(i => PANEL.indexOf(i))
    assert.ok(order.every(i => i > 0), 'every part is in the panel')
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in that order')
    assert.ok(at('<TopPanel') > 0 && at('<TopPanel') < at('aria-label="Products and costing"'))
    for (const file of ['LeadCard', 'AskCard']) {
      const src = read(`src/components/quotations/${file}.tsx`)
      assert.ok(src.includes('className={s.prow}') || src.includes('${s.prow}'), `${file} is a row of the panel`)
      assert.ok(!src.includes('s.card'), `${file} is not a card of its own`)
    }
  })
  test('the tracker, Mark sent and Negotiating are gone: the lead\'s stage is the status, read only, changed only in Lead Management (25 Nov 2026)', () => {
    assert.ok(!PANEL.includes('STEPS') && !PANEL.includes('Mark sent') && !PANEL.includes("onMove('sent')") && !PANEL.includes('<ol'))
    assert.ok(!CSS.includes('.steps') && !CSS.includes('.stepCur'))
    const lead = read('src/components/quotations/LeadCard.tsx')
    assert.ok(lead.includes('<StageChip') && lead.includes('Changed only in Lead Management.'), 'the Status row shows the stage chip and says where it changes')
    assert.ok(!lead.includes('moveLead('), 'nothing on this page moves the lead')
    const brief = read('src/components/quotations/LeadBrief.tsx')
    assert.ok(brief.includes('PATH_STAGES') && brief.includes('s.stage') && brief.includes('s.meter'), 'the chip and its five-step meter')
  })
  test('the prices-outside-the-limits block is not on the page, and nothing on the page asks for or decides a price; PriceBlock is kept for later', () => {
    for (const w of ['PriceBlock', 'priceBlocked', 'needsYou(', 'onAskPrice', 'onDecidePrice', 'requestPriceApproval', 'decidePrice']) assert.ok(!SCREEN.includes(w) && !PANEL.includes(w), w)
    assert.ok(read('src/components/quotations/PricingDesk.tsx').includes('export function PriceBlock'), 'kept for when the system is trained')
  })
  test('Create PI draft (in Lead Management now) moves a Draft to Negotiating first, because the database confirms only a Sent or Negotiating quotation', () => {
    assert.match(LEAD_QUOTES, /if \(q\.status === 'draft'\) await setStatus\(work\.supabase, q\.id, 'negotiating'\)\n\s*const r = await makePiDraft/)
    assert.ok(read('supabase/migrations/20270617000000_quotation_pricing_desk.sql').includes("q.status not in ('sent', 'negotiating')"), 'the rule this works around')
    assert.match(LEAD_QUOTES, /Nothing is sent to anyone: the PI stays a Draft until you submit it there\./, 'its tooltip')
  })
  test('the ⋯ menu (the Orders menu) holds only turning the client link off and Delete: nothing on the panel changes a status (25 Nov 2026)', () => {
    assert.ok(!PANEL.includes('Other outcome') && !CSS.includes('.outcomes') && !CSS.includes('.quietRow'))
    assert.ok(PANEL.includes("import { MoreActionsMenu, type MoreActionItem } from '@/app/orders/[id]/MoreActionsMenu'"))
    for (const w of ["label: 'Delete…'", "label: 'Turn the client link off'"]) assert.ok(PANEL.includes(w), w)
    for (const gone of ["label: 'Confirmed, no PI'", "label: 'Mark as lost…'", "label: 'Archive'", 'onMove', 'lostNote', 'Why was it lost?', '>Reopen<']) assert.ok(!PANEL.includes(gone), `${gone} is gone`)
    assert.match(SCREEN, /onClick=\{\(\) => moveTo\('negotiating'\)\}>Reopen<\/button>/, 'Reopen sits in the builder\'s lock notice')
  })
  test('the Share row explains in tooltips, not paragraphs', () => {
    assert.ok(!PANEL.includes('The message carries the link') && !PANEL.includes('shareFoot'))
    assert.match(PANEL, /WhatsApp opens with the text ready/)
  })
})
