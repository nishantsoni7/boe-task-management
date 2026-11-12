/**
 * Quotations, phase 1 (20270614000000): the printed quotation drawn from the real Resort Shamshabad quote, the
 * registration the database and the code share, and the client link's privacy.
 *
 * Run:
 *   npm run test:file -- src/components/quotations/quotations.test.tsx
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import '@/lib/testing/cssModuleStub'
import { QuotationDocument, type DocData } from './QuotationDocument'
import { classifyError, saveDoc, toLines } from '@/lib/quotations/api'
import type { QuoteLine } from '@/lib/quotations/math'
import { EXPECTATIONS, TERMS } from '@/lib/quotations/terms'
import '@/lib/permissions/modules'
import { getRegisteredModule } from '@/lib/permissions/registry'
import { isEngineGatedModule } from '@/lib/permissions/moduleVisibility'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const MIGRATION = read('supabase/migrations/20270614000000_quotations_module.sql')

const L = (n: number, area: string, name: string, size: string, price: number, over: Partial<QuoteLine> = {}): QuoteLine => ({
  key: `l${n}`, area_key: area, name, size_text: size, spec: '', material: 'Ash wood', finish: '', category: '',
  qty_mode: 'per_unit', qty: 1, unit_price: price, tax_rate: 18, image_path: null, is_optional: false, client_note: '',
  internal_note: 'NEVER-SHOWN-INTERNAL', ...over,
})

// QT-MVTPTT9W, 29 Oct 2026, as Base44 printed it (but IGST: the site is outside Rajasthan).
const REAL: DocData = {
  quote_no: 'QT-NS-01006', issued_at: '2026-11-12T04:30:00Z', valid_days: 7, client_name: 'Babylon Resort',
  project_name: 'Resort, Shamshabad', contact_name: null, salesperson: 'Nishant Soni', gst_mode: 'igst',
  discount_pct: 0, fabric_amount: 0, packing_amount: 0, transport_note: 'As per actual', notes: 'Given prices are ex-factory.',
  areas: [
    { key: 'a', name: 'Corporate room', style: 'Contemporary', multiplier: 18, unit_label: 'rooms' },
    { key: 'b', name: 'Boho room', style: 'Boho', multiplier: 56, unit_label: 'rooms' },
  ],
  lines: [
    L(1, 'a', 'Twin beds with back panel', `4'×6'6"×1'6" ×2`, 64000), L(2, 'a', 'Bedside table', `2'4"×1'6"×1'6"`, 10800),
    L(3, 'a', 'Study ledge', `4'6"×1'6"`, 18000), L(4, 'a', 'Study chair', `1'9"×1'9"×1'6"`, 8200),
    L(5, 'a', '2-seater sofa cum bed', `5'0"×2'8"×1'6"`, 46000), L(6, 'a', 'Centre table', `3'0"×2'0"×1'6"`, 14500),
    L(7, 'a', 'Wardrobe with luggage rack', `7'×2'×8'3"`, 102000),
    L(8, 'b', 'Bed', `6'0"×6'6"×1'6"`, 56000), L(9, 'b', 'Bedside table', `1'6"×1'6"×1'6"`, 11900, { qty: 2 }),
    L(10, 'b', 'Study table with lamp', `4'6"×1'6"`, 21000), L(11, 'b', 'Study chair', `1'9"×1'9"×1'6"`, 7800),
    L(12, 'b', '2-seater sofa', `5'6"×2'6"×1'6"`, 43000), L(13, 'b', 'Centre table', `3'0"×2'×1'6"`, 15000),
    L(14, 'b', 'Wardrobe with luggage rack', `6'6"×2'×8'6"`, 96000, { qty_mode: 'fixed', qty: 39 }),
    L(15, 'b', 'Luggage rack counter', `6'0"×2'7"×2'0"`, 23200), L(16, 'b', 'TV unit', `7'6"×4'`, 19000),
    L(17, 'b', 'Mirror', `1'9"×7'0"`, 5000, { is_optional: true, tax_rate: 12, client_note: 'Decor, quoted separately' }),
  ],
}

describe('the printed quotation (real Resort Shamshabad quote)', () => {
  const html = renderToStaticMarkup(<QuotationDocument doc={REAL} pictureUrl={p => `https://img.example/${p}`} />)
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

  test('totals: room types, subtotal, IGST and grand total, to the rupee', () => {
    assert.ok(text.includes('₹47,43,000'), 'Corporate room total')
    assert.ok(text.includes('₹1,54,36,800'), 'Boho room total')
    assert.ok(text.includes('Subtotal ₹2,01,79,800'))
    assert.ok(text.includes('IGST (18%) ₹36,32,364'))
    assert.ok(text.includes('Grand total ₹2,38,12,164'))
    assert.ok(!text.includes('CGST'))
  })

  test('room types with their multipliers, per-room quantities and sizes in inches', () => {
    assert.ok(text.includes('Boho room · Boho × 56 rooms'))
    assert.ok(text.includes('112'), '2 bedside tables per room × 56')
    assert.ok(text.includes('2 × 56'))
    assert.ok(text.includes('72 × 78 × 18 in'), "6'0\"×6'6\"×1'6\" shown in inches")
    assert.ok(text.includes('39'), 'a fixed quantity stays as typed')
  })

  test('an optional line shows its price but is not in the total, and says so', () => {
    assert.ok(text.includes('optional, not in the total'))
    assert.ok(text.includes('Decor, quoted separately'))
  })

  test('internal notes never reach the document', () => {
    assert.ok(!html.includes('NEVER-SHOWN-INTERNAL'))
  })

  test('the standard text: all 7 expectations and 23 terms, word for word from the PI sheet', () => {
    assert.equal(EXPECTATIONS.length, 7)
    assert.equal(TERMS.length, 23)
    for (const t of [...EXPECTATIONS, ...TERMS]) assert.ok(html.includes(t.title.replace(/&/g, '&amp;')), t.title)
    assert.ok(text.includes('sole area of jurisdiction will be Jodhpur'))
  })

  test('dates: issued and valid until, in Indian dates', () => {
    assert.ok(text.includes('12 Nov 2026'))
    assert.ok(text.includes('19 Nov 2026'))
  })
})

describe('the save document and errors', () => {
  test('a line saves exactly one quantity field, per room or fixed', () => {
    const d = saveDoc({} as never, REAL.areas, REAL.lines, '2026-11-12T00:00:00Z')
    assert.equal(d.lines[8].qty_per_unit, 2); assert.equal(d.lines[8].qty_fixed, null)
    assert.equal(d.lines[13].qty_fixed, 39); assert.equal(d.lines[13].qty_per_unit, null)
    assert.equal(d.expected_updated_at, '2026-11-12T00:00:00Z')
  })
  test('lines read back from the database keep their mode and numbers', () => {
    const [a, b] = toLines([
      { id: 'x', area_id: 'a', name: 'Bed', size_text: null, material: null, finish: null, qty_per_unit: '1.00', qty_fixed: null, unit_price: '56000', tax_rate: '18.00', image_path: null, is_optional: false, client_note: null },
      { id: 'y', area_id: null, name: 'Rack', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: '39.00', unit_price: null, tax_rate: '12.00', image_path: null, is_optional: true, client_note: null },
    ])
    assert.deepEqual([a.qty_mode, a.qty, a.unit_price, a.tax_rate], ['per_unit', 1, 56000, 18])
    assert.deepEqual([b.qty_mode, b.qty, b.unit_price, b.tax_rate, b.is_optional], ['fixed', 39, null, 12, true])
    // A 0% line stays 0% (it used to read back as 18%).
    const [c] = toLines([{ id: 'z', area_id: null, name: 'Book', size_text: null, material: null, finish: null, qty_per_unit: null, qty_fixed: '1', unit_price: '100', tax_rate: '0.00', image_path: null, is_optional: false, client_note: null }])
    assert.equal(c.tax_rate, 0)
  })
  test('before the migration is applied, the screens say "being set up", not a raw error', () => {
    assert.equal(classifyError({ code: 'PGRST202', message: 'Could not find the function public.quotation_my_access' }).kind, 'not_set_up')
    assert.equal(classifyError({ message: 'QUOTATION_STALE: this quotation was saved by somebody else after you opened it' }).kind, 'stale')
    assert.equal(classifyError({ message: 'QUOTATIONS_FORBIDDEN: you may not change this quotation', code: '42501' }).message, 'you may not change this quotation')
    assert.equal(classifyError({ message: 'Failed to fetch', status: 0 }).kind, 'network')
  })
})

describe('registration: the code and the migration agree', () => {
  test('module key, actions, engine gate', () => {
    const m = getRegisteredModule('quotations')
    assert.ok(m)
    assert.deepEqual(m.actions.map(a => a.actionKey).sort(), ['create', 'edit', 'view', 'view_all'])
    assert.ok(isEngineGatedModule('quotations'))
    assert.ok(MIGRATION.includes("pa.action_key in ('view', 'create', 'edit', 'view_all')"))
    assert.ok(MIGRATION.includes("('quotations', 'Quotations', 'Build quotations by room type, price them and share a client link.', '/quotations', 'live', null, 115)"))
  })
  test('the tables stay closed to client roles; only quotation_public is granted to anon', () => {
    assert.ok(MIGRATION.includes('revoke all on public.quotations, public.quotation_areas, public.quotation_lines, public.quotation_events\n  from public, anon, authenticated;'))
    const anonGrants = MIGRATION.match(/grant execute on function [^;]+ to anon[^;]*;/g) ?? []
    assert.deepEqual(anonGrants, ['grant execute on function public.quotation_public(text) to anon, authenticated;'])
    assert.ok(!/create policy [^;]+ on public\.quotation/.test(MIGRATION), 'no table policy: access is only through the functions')
  })
  test('the client link function never returns internal fields', () => {
    const fn = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.quotation_public'), MIGRATION.indexOf('-- Self-check'))
    for (const k of ['internal_notes', 'internal_note', 'share_token', 'owner_id', 'contact_phone', "'source'"]) {
      assert.ok(!fn.includes(`'${k.replace(/'/g, '')}', `), `quotation_public must not return ${k}`)
    }
  })
})
