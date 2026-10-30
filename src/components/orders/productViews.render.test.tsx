/**
 * The product list's three tabs (owner, 2026-10-30). Rendered, not read as
 * text: what each tab shows for a product, and that typing is offered only to
 * the people the sheet's read says may type.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { FabricFinishData, FabricFinishLine, LineValues } from '@/lib/orders/fabricFinishCost'
import { PRODUCT_VIEWS, ProductViewBody, ProductViewSummary, ProductViewTabs, type ProductViewRow } from './ProductViews'
import { productCostSummary } from '@/lib/orders/productCostColumns'

const values = (over: Partial<LineValues> = {}): LineValues => ({
  fabricMetresPerPiece: null, fabricPricePerMetre: null, packingCostPerPiece: null, packingType: null, finish: [], ...over,
})
const entry = (heading: string, value: string, imagePath: string | null = null) => ({ heading, value, imagePath })

const line = (seq: string, quantity: number, sheet: LineValues, typed: LineValues | null = null): FabricFinishLine => ({
  itemSequence: seq, itemId: seq, productName: `Product ${seq}`, productCode: null, quantity, sortOrder: 0,
  sheet, typed, typedByName: null, typedAt: null,
})

const FOUR = (fabric: string, wood: string, metal: string, marble: string) => [
  entry('Fabric Approval', fabric), entry('Wood Finish Approval', wood), entry('Metal Finish', metal), entry('Marble/Rope Approval', marble),
]

const LINES = [
  line('BE0001', 20, values({ fabricMetresPerPiece: 1.25, fabricPricePerMetre: 600, packingCostPerPiece: 440, finish: [entry('Fabric Approval', 'NA'), entry('Marble/Rope Approval', 'NA')] })),
  line('BE0002', 5, values({ fabricMetresPerPiece: 0, fabricPricePerMetre: 600, packingCostPerPiece: 1250, packingType: 'BCF', finish: FOUR('PENDING', 'PENDING', 'PENDING', 'PENDING') })),
  line('BE0003', 4, values({ fabricMetresPerPiece: 1.5, fabricPricePerMetre: 1250, packingCostPerPiece: 350, finish: FOUR('GF Furry SR.10', 'Close to this', 'NA', 'NA') })),
]

const data = (over: Partial<FabricFinishData> = {}): FabricFinishData => ({
  submissionId: 's1', status: 'draft', orderId: null, orderStatus: null, displayNumber: null, clientName: null,
  workbookName: null, sheetReadAt: '2026-10-29T05:00:00Z', canEdit: true,
  piFabricCost: { amount: 22500, meaning: 'numeric', text: null },
  piPackingCost: { amount: 16450, meaning: 'numeric', text: null },
  lines: LINES,
  ...over,
})

const rows: ProductViewRow[] = LINES.map(l => ({
  id: l.itemSequence,
  itemSequence: l.itemSequence,
  label: l.productName as string,
  code: l.itemSequence,
  image: compact => <i>{compact ? 'small picture' : 'picture'}</i>,
  product: l.productName,
  quantity: l.quantity,
}))

const body = (view: 'cost' | 'approvals', over: Partial<Parameters<typeof ProductViewBody>[0]> = {}) => renderToStaticMarkup(
  <ProductViewBody
    view={view}
    rows={rows}
    data={data()}
    isMobile={false}
    variant="pi"
    submissionId="s1"
    pieces={29}
    animate={false}
    onChanged={() => undefined}
    {...over}
  />,
)

describe('the three tabs', () => {
  test('Product details, F&P Cost and Approvals, in that order', () => {
    assert.deepEqual(PRODUCT_VIEWS.map(v => v.label), ['Product details', 'F&P Cost', 'Approvals'])
  })

  test('the open tab is marked, and only Approvals carries the pending count', () => {
    const html = renderToStaticMarkup(<ProductViewTabs view="cost" onChange={() => undefined} pending={32} />)
    assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
    assert.ok(/aria-pressed="true"[^>]*>F&amp;P Cost/.test(html))
    assert.ok(/Approvals<span class="pv-count">32/.test(html))
  })

  test('nothing pending, or not read yet: no count', () => {
    for (const pending of [0, null]) {
      assert.ok(!renderToStaticMarkup(<ProductViewTabs view="details" onChange={() => undefined} pending={pending} />).includes('pv-count'))
    }
  })
})

describe('the F&P Cost tab', () => {
  test('metres, rate and amount for the fabric; rate, amount and type for the packing', () => {
    const html = body('cost')
    for (const heading of ['Fabric m / pc', 'Total m', '₹ / m', 'Fabric ₹', 'Packing ₹ / pc', 'Packing ₹', 'Type']) {
      assert.ok(html.includes(heading), heading)
    }
    assert.ok(html.includes('25 m') && html.includes('₹15,000') && html.includes('₹8,800'))
    assert.ok(html.includes('No fabric'), 'zero metres reads as no fabric, not as ₹0')
  })

  test('the totals row is the workbook’s rounded sum, and the code, picture, product and quantity stay', () => {
    const html = body('cost')
    assert.ok(html.includes('₹20,000') || html.includes('₹22,500'))
    assert.ok(html.includes('BE0001') && html.includes('>picture<') && html.includes('Product BE0003'))
    assert.ok(html.includes('>29<'), 'pieces across the lines')
  })

  test('a value typed in the app is marked', () => {
    const typed = [line('BE0001', 1, values({ fabricPricePerMetre: 600 }), values({ fabricPricePerMetre: 650 }))]
    assert.ok(body('cost', { data: data({ lines: typed }) }).includes('pv-typed'))
    assert.ok(!body('cost').includes('pv-typed'))
  })
})

describe('the Approvals tab', () => {
  test('one column per kind of approval', () => {
    const html = body('approvals')
    for (const heading of ['Fabric approval', 'Wood finish', 'Metal finish', 'Marble / rope']) assert.ok(html.includes(heading), heading)
  })

  test('a product with nothing approved says so once, across the columns', () => {
    const html = body('approvals')
    assert.equal((html.match(/No Fabric and Finish approval done/g) ?? []).length, 1)
    assert.ok(/colSpan="4"|colspan="4"/.test(html))
  })

  test('a part-approved product shows what is settled and what is still pending', () => {
    const html = body('approvals')
    assert.ok(html.includes('NA'))
    assert.equal((html.match(/>Pending</g) ?? []).length, 2, 'wood and metal on BE0001')
  })

  test('approved values are shown as the workbook wrote them', () => {
    const html = body('approvals')
    assert.ok(html.includes('GF Furry SR.10') && html.includes('Close to this'))
    assert.ok(html.includes('1 of 3 approved'))
  })

  test('several headings of one kind stack in one cell, each named', () => {
    const several = [line('B1', 1, values({ finish: [entry('Fabric 1', 'Morocco 03'), entry('Seat Fabric', 'Morocco 07'), entry('Wood Finish Approval', 'Acacia')] }))]
    const html = body('approvals', { data: data({ lines: several }), rows: [{ ...rows[0], id: 'B1', itemSequence: 'B1' }] })
    assert.ok(html.includes('Fabric 1') && html.includes('Seat Fabric') && html.includes('Morocco 07'))
  })
})

describe('who may type, and the states around it', () => {
  test('Edit is offered per product only when the read says so', () => {
    assert.equal((body('cost').match(/pv-edit"/g) ?? []).length, 3)
    assert.ok(!body('cost', { data: data({ canEdit: false }) }).includes('pv-edit'))
    assert.ok(body('cost', { data: data({ canEdit: false }) }).includes('Values can be typed'))
  })

  test('while reading, and when the read is refused, a plain line and no table', () => {
    assert.ok(body('cost', { data: undefined }).includes('Reading the cost sheet'))
    assert.ok(body('cost', { data: null }).includes('could not be read'))
    assert.ok(!body('cost', { data: null }).includes('<table'))
  })

  test('a phone gets cards with the compact picture, never a table', () => {
    const html = body('approvals', { isMobile: true })
    assert.ok(!html.includes('<table') && html.includes('small picture') && html.includes('pv-card'))
  })

  test('the columns line up with the page they sit on', () => {
    assert.ok(body('cost').includes('pv-table--pi'))
    assert.ok(body('cost', { variant: 'order' }).includes('pv-table--order'))
  })

  test('the slide plays only once someone has switched', () => {
    assert.ok(!body('cost').includes('pv-animate'))
    assert.ok(body('cost', { animate: true }).includes('pv-animate'))
  })
})

describe('the figures in the header', () => {
  test('both totals, whether each matches the PI, and the approved count', () => {
    const html = renderToStaticMarkup(<ProductViewSummary summary={productCostSummary(data())} />)
    assert.ok(html.includes('Matches the PI'))
    assert.ok(html.includes('1 of 3 approved'))
  })
})
