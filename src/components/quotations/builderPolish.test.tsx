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
import type { QuoteLine } from '@/lib/quotations/math'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const SCREEN = read('src/components/quotations/BuilderScreen.tsx')
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
  dimension_unit: 'in', project_type: '', seats: null, lead_time_weeks: null, lead_time_reason: '', ...over,
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
    assert.match(rule('.pl'), /grid-template-columns: 180px minmax\(0, 1fr\) 250px;/, 'the picture column is wide enough for the new frame')
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
    assert.match(html, /<label class="field c7"><span>Product<\/span>/)
    assert.match(html, /<label class="field c5"><span>Dimensions \(in\)<\/span>/)
  })
  test('the value that is already stored still travels with every save, or the database would wipe it (it rewrites the lines)', () => {
    const doc = saveDoc(header(), [], [line({ finish: 'PU' })], '2026-11-14T00:00:00Z')
    assert.equal(doc.lines[0].finish, 'PU')
  })
})

describe('contact person and email (items 5 and 7)', () => {
  test('both left the main block and sit in Advanced, with the phone and the delivery state staying on top', () => {
    const basic = SCREEN.slice(SCREEN.indexOf('className={s.clientGrid}'), SCREEN.indexOf('className={s.advBtn}'))
    assert.ok(basic.includes('q-phone') && basic.includes('q-state') && basic.includes('q-client-name'))
    assert.ok(!basic.includes('q-contact') && !basic.includes('q-email'))
    const adv = SCREEN.slice(SCREEN.indexOf('id="q-advanced"'), SCREEN.indexOf('</section>', SCREEN.indexOf('id="q-advanced"')))
    assert.ok(adv.includes('id="q-contact"') && adv.includes('id="q-email"') && adv.includes('id="q-role"'))
  })
  test('a save still carries the contact, the role, the email and the delivery state (quotation_save clears the ones a header leaves out)', () => {
    const doc = saveDoc(header(), [], [line()], '2026-11-14T00:00:00Z')
    for (const k of ['contact_name', 'contact_phone', 'contact_role', 'client_email', 'supply_state', 'client_type'] as const) {
      assert.equal(doc.header[k], header()[k], k)
    }
    assert.match(SCREEN, /saveDoc\(\{ \.\.\.h, lead_time_weeks: effectiveLeadTime\(h, areas\) \}/, 'the builder sends the whole header')
  })
  test('a wrong email opens the advanced section, where the box is, before saying so', () => {
    assert.match(SCREEN, /const EMAIL_PROBLEM = 'Check the email address\.'/)
    assert.match(SCREEN, /if \(problem === EMAIL_PROBLEM\) setAdvOpen\(true\)/)
  })
})

describe('the page rows (items 8 and 9)', () => {
  const between = (from: string, to: string) => SCREEN.slice(SCREEN.indexOf(from), SCREEN.indexOf(to))
  test('the status strip is its own full-width card, above the Client and Share cards', () => {
    assert.ok(SCREEN.indexOf('s.statusCard') < SCREEN.indexOf('className={s.topRow}'))
    assert.ok(SCREEN.indexOf('className={s.statusBar}') < SCREEN.indexOf('className={s.topRow}'))
    assert.match(CSS, /\.statusCard \.statusBar \{ border-bottom: 0;/)
  })
  test('the Client card (60%) and the Share card (40%) share one row, and Share carries the two downloads and the WhatsApp message', () => {
    const top = between('className={s.topRow}', 'aria-labelledby="q-products"')
    assert.ok(top.includes('aria-labelledby="q-client"') && top.includes('aria-labelledby="q-share"'))
    for (const w of ['Download PDF', 'Download Excel', 'Open WhatsApp with the message', 'Create client link', 'Turn the link off']) assert.ok(top.includes(w), w)
    assert.match(rule('.topRow'), /grid-template-columns: minmax\(0, 3fr\) minmax\(0, 2fr\);/)
  })
  test('the downloads are made from the saved quotation: disabled while there are unsaved changes', () => {
    const share = between('aria-labelledby="q-share"', 'aria-labelledby="q-products"')
    assert.match(share, /dirty\s*\? <button type="button" className=\{s\.btn\} disabled><Printer/)
    assert.match(share, /onClick=\{downloadExcel\} disabled=\{dirty \|\| busy \|\| lines\.length === 0\}/)
  })
  test('Terms and notes (textareas stacked) and History share one row; the bottom grid no longer holds Share or History', () => {
    const pair = between('className={s.pair}', 'className={s.bottom}')
    assert.ok(pair.includes('id="q-terms"') && pair.includes('<h2>History</h2>'))
    assert.ok(!pair.includes('s.grid2'), 'the two notes boxes are stacked, not side by side')
    const bottom = between('className={s.bottom}', '{importing && profile')
    assert.ok(!bottom.includes('Share with the client') && !bottom.includes('<h2>History</h2>'))
    for (const w of ['RequestCard', 'VersionsCard', 'PriceCard', 'PiCard']) assert.ok(bottom.includes(w), w)
    assert.match(rule('.pair'), /repeat\(2, minmax\(0, 1fr\)\);/)
  })
  test('the Share card is one fixed column whose button labels wrap: on a 320 px phone a label that does not wrap used to push every button past the card', () => {
    assert.ok(SCREEN.includes('className={`${s.cardBody} ${s.shareBody}`}'))
    assert.match(rule('.shareBody'), /grid-template-columns: minmax\(0, 1fr\);/)
    assert.match(rule('.shareBody .btn'), /white-space: normal;/)
  })
  test('under 1024 px the two rows stack, and on a phone the download buttons share the width', () => {
    assert.match(CSS, /@media \(max-width: 1023px\) \{\s*\.topRow, \.pair \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    assert.match(CSS, /\.shareDl \.btn \{ flex: 1 1 140px; justify-content: center; \}/)
  })
})
