/**
 * The Confirmed Orders list's Value column is the Subtotal (owner, 2026-10-19):
 * products minus discount — never fabric, packing, transport or GST.
 *
 * Run:
 *   npx tsx --test src/lib/orders/orderListValue.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ORDER_LIST_SOURCE_PI_EMBED,
  advanceBelowStandard,
  cancelledOrderGapText,
  compareOrderNumber,
  factoryStatus,
  orderListFlags,
  orderListSubtotal,
} from './orderListValue'
import { PRODUCTION_ALIGNMENT_LABEL } from './productionAlignment'

describe('project code order and the cancelled gap (owner, 2026-10-31)', () => {
  const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')

  test('the highest project code is on top, whenever each PI was uploaded', () => {
    const asUploaded = ['0542', '0541', '0540', '0528', '0538', '0537', '0536', '0534', '0527']
    assert.deepEqual([...asUploaded].sort((a, b) => compareOrderNumber(b, a)),
      ['0542', '0541', '0540', '0538', '0537', '0536', '0534', '0528', '0527'])
  })

  test('the list opens that way, and a stale ?sort=newest link falls back to it', () => {
    assert.ok(page.includes("sort:     enumParam<SortKey>(['number_desc', 'number_asc', 'value_desc', 'value_asc'], 'number_desc'),"))
    assert.ok(page.includes('default:            return compareOrderNumber(b.display_number, a.display_number)'))
    assert.ok(page.includes("isSet={sortKey !== 'number_desc'}"))
  })

  test('the upload date is no longer a sort', () => {
    assert.equal(/'newest'|'oldest'|Newest first|Oldest first/.test(page), false)
  })

  test('a gap says it is cancelled and who it was, and nothing more', () => {
    assert.equal(cancelledOrderGapText('Vikrant Ji'), 'Cancelled order · Vikrant Ji')
    assert.equal(cancelledOrderGapText('  Vikrant Ji '), 'Cancelled order · Vikrant Ji')
    assert.equal(cancelledOrderGapText('  '), 'Cancelled order')
    assert.equal(cancelledOrderGapText(null), 'Cancelled order')
  })

  test('the table and the phone card both draw it, and the row still spans all nine columns', () => {
    assert.equal((page.match(/\{cancelledOrderGapText\(o\.client_name\)\}/g) ?? []).length, 2, 'table and phone card')
    assert.equal((page.match(/<col /g) ?? []).length, 9)
    assert.ok(page.includes('<td colSpan={8} title={o.client_name}>'), 'beside the Project code cell')
    assert.ok(page.includes("cancelled && 'orders-gap-row'"))
    assert.ok(page.includes('className="orders-list-card orders-gap-card"'))
    assert.ok(page.includes('{!cancelled && <ProjectFlags sample={o.sample} commission={o.commission} />}'))
  })

  test('the stripes hold on the table cells, which set their own background', () => {
    const css = readFileSync('src/app/globals.css', 'utf8')
    assert.ok(css.includes('.fin-table tbody tr.orders-gap-row td {'))
    assert.ok(css.includes('.fin-table tbody tr.orders-gap-row:hover td {'))
    assert.ok(css.indexOf('.fin-table tbody tr.orders-gap-row td {') > css.indexOf('.fin-table tbody tr.has-update td {'),
      'after the update tint, which has the same weight')
  })
})

describe('the Value column is the Subtotal', () => {
  test('Order 0524: the PI subtotal, not the Grand Total', () => {
    // Products 12,53,000, no discount; fabric/packing/transport take it to
    // 13,25,500 before GST; Grand Total 15,64,090 (the Order's total_value).
    assert.equal(orderListSubtotal({
      total_value: '1564090.00', total_product_value: '1253000.00',
      source_pi: { subtotal_after_discount: '1253000.00', grand_total: '1564090.00' },
    }), 1253000)
  })

  test('a discount comes off: the subtotal after discount, not the product value', () => {
    assert.equal(orderListSubtotal({
      total_value: 118000, total_product_value: 100000,
      source_pi: { subtotal_after_discount: 90000, grand_total: 118000 },
    }), 90000)
  })

  test('a hand-amended value no longer matches the PI: the Order\'s own product value', () => {
    assert.equal(orderListSubtotal({
      total_value: 200000, total_product_value: 150000,
      source_pi: { subtotal_after_discount: 90000, grand_total: 118000 },
    }), 150000)
  })

  test('no source PI, or one this reader cannot read: the product value; nothing known: null', () => {
    assert.equal(orderListSubtotal({ total_value: 5000, total_product_value: 4000, source_pi: null }), 4000)
    assert.equal(orderListSubtotal({ total_value: 5000, total_product_value: null, source_pi: undefined }), null)
    assert.equal(orderListSubtotal({ total_value: null, total_product_value: '', source_pi: null }), null)
  })

  test('an array-shaped embed is read the same way', () => {
    assert.equal(orderListSubtotal({
      total_value: 118000, total_product_value: 100000,
      source_pi: [{ subtotal_after_discount: 90000, grand_total: 118000 }],
    }), 90000)
  })

  test('the list reads it in its ONE query, and shows and sorts by it — never total_value', () => {
    const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
    assert.ok(page.includes(ORDER_LIST_SOURCE_PI_EMBED), 'the embed, through the source PI foreign key')
    assert.ok(page.includes('subtotal: orderListSubtotal(o)'))
    assert.equal((page.match(/fmtAmount\(o\.total_value\)/g) ?? []).length, 0, 'the Grand Total is never drawn as Value')
    assert.equal((page.match(/fmtAmount\(o\.subtotal\)/g) ?? []).length, 2, 'table and phone card')
    assert.ok(page.includes('compareValue(a.subtotal, b.subtotal, -1)') && page.includes('compareValue(a.subtotal, b.subtotal, 1)'))
  })
})

describe('columns, markers and Factory Status (owner, 2026-10-19)', () => {
  test('Sample and commission come from the source PI; a hidden commission is no icon', () => {
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: 'sample_order', commission: { middleman_commission: 'yes' } } }), { sample: 'sample_order', commission: true }, 'legacy: the advance reason')
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: 'against_client_po', commission: { middleman_commission: 'no' } } }), { sample: null, commission: false })
    assert.deepEqual(orderListFlags({ source_pi: { subtotal_after_discount: 1, grand_total: 1, advance_exception_reason_code: null, commission: null } }), { sample: null, commission: false }, 'RLS gave no commission row')
    assert.deepEqual(orderListFlags({ source_pi: null }), { sample: null, commission: false })
    assert.deepEqual(orderListFlags({ source_pi: [{ subtotal_after_discount: 1, grand_total: 1, commission: [{ middleman_commission: 'Yes' }] }] }), { sample: null, commission: true })
  })

  test('Factory Status: Aligned once Operations accepted, else Not Aligned, the Order page\'s own words', () => {
    assert.deepEqual(factoryStatus('aligned'), { aligned: true, label: PRODUCTION_ALIGNMENT_LABEL.aligned })
    assert.deepEqual(factoryStatus('aligned'), { aligned: true, label: 'Aligned' })
    assert.deepEqual(factoryStatus('not_aligned'), { aligned: false, label: PRODUCTION_ALIGNMENT_LABEL.not_aligned })
    assert.deepEqual(factoryStatus(null), { aligned: false, label: 'Not Aligned' })
  })

  test('the table: Project Code, Client, Product Value, Advance, Factory Status, Pendencies, Sales Person, Confirmed, Due — no Requested by, no Status', () => {
    const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
    const head = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'))
    const cols = [...head.matchAll(/<SortHeader label="([^"]+)"|<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1] ?? m[2])
    assert.deepEqual(cols, ['Project Code', 'Client', 'Product Value', 'Advance', 'Factory Status', 'Pendencies', 'Sales Person', 'Confirmed', 'Due'])
    assert.equal(page.includes('requested_by_name} />'), false, 'no Requested by cell')
    assert.ok(page.includes('production_alignment'))
    // Symbols only, named by tooltip and accessible label.
    assert.ok(page.includes('title={SAMPLE_TYPE_LABEL[sample]} aria-label={SAMPLE_TYPE_LABEL[sample]} role="img"'))
    assert.equal(page.includes('<StatusBadge'), false, 'no Status pill in the table or the cards')
    // The markers at the right edge of the code cell.
    assert.ok(page.includes('className="fin-ordno orders-code-cell"'))
    assert.ok(page.includes('sample_type, sample_type_set_at'), "the Order's own sample choice is read")
    assert.ok(page.includes('title={COMMISSION_ICON_LABEL} aria-label={COMMISSION_ICON_LABEL} role="img"'))
  })
})

describe('the Advance column (owner, 2026-11-01)', () => {
  const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')

  test('below 40 is below; 40 is not; no figure is never red', () => {
    for (const below of [0, 35.5, 39.99, '39.99', '0']) assert.equal(advanceBelowStandard(below), true, String(below))
    for (const met of [40, '40', '40.00', 40.01, 100, 250]) assert.equal(advanceBelowStandard(met), false, String(met))
    for (const none of [null, undefined, '', '  ', 'NaN']) assert.equal(advanceBelowStandard(none), false, String(none))
  })

  test('it is read beside the list, again on Refresh, and a failed read leaves dashes', () => {
    assert.ok(page.includes("supabase.rpc('orders_advance_percent')"))
    assert.ok(page.includes('setAdvance(new Map(error ? [] :'), 'a failed read draws no old figure')
    assert.match(page, /loadPendencies\(\),\s+loadAdvance\(\),/)
    assert.ok(page.includes('await Promise.all([loadOrders(), loadUnread(), loadAdvance()])'))
  })

  test('the table and the phone card draw it, and a cancelled Order has none', () => {
    assert.equal((page.match(/<AdvanceCell percent=\{advance\.get\(o\.id\)\} \/>/g) ?? []).length, 2)
    const table = page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>'))
    assert.ok(table.indexOf('{cancelled ? (') < table.indexOf('<td colSpan={8}'))
    assert.ok(table.indexOf('<td colSpan={8}') < table.indexOf('<AdvanceCell'), 'inside the not-cancelled branch')
  })
})

describe('the table redesign (owner, 2026-10-31)', () => {
  const page = readFileSync('src/app/orders/all/page.tsx', 'utf8')
  const css = readFileSync('src/app/globals.css', 'utf8')
  const rule = (selector: string) => {
    const at = css.indexOf(`\n${selector} {`)
    assert.notEqual(at, -1, selector)
    return css.slice(at, css.indexOf('}', at))
  }

  test('Project Code and Factory Status are narrow, and the widths fit the table floor', () => {
    const widths = [...page.matchAll(/<col(?: style=\{\{ width: '([\d.]+)(px|%)' \}\})? \/>/g)]
    assert.equal(widths.length, 9)
    assert.deepEqual(widths.map(m => m[1] ? `${m[1]}${m[2]}` : 'auto'),
      ['116px', 'auto', '11%', '96px', '136px', '116px', '12.4%', '9.6%', '9.6%'])

    const floor = Number(/\.fin-table--orders \{ min-width: (\d+)px; \}/.exec(css)?.[1])
    assert.equal(floor, 1120)
    const taken = widths.reduce((sum, m) => sum + (m[2] === 'px' ? Number(m[1]) : m[2] === '%' ? floor * Number(m[1]) / 100 : 0), 0)
    // The longest client still has a column at the floor.
    assert.ok(floor - taken >= 170, `Client is left ${floor - taken}px`)
  })

  test('money and its Advance sit on the right with air after them; only those columns do', () => {
    assert.ok(page.includes('<SortHeader label="Product Value" className="fin-num"'))
    assert.ok(page.includes('<th className="fin-num" title="Verified payments as a percentage of Total before GST">Advance</th>'))
    assert.equal((page.match(/<td className="fin-num">/g) ?? []).length, 2)
    assert.equal((page.match(/orders-after-value/g) ?? []).length, 2, 'heading and cell')
    assert.ok(css.includes('.fin-table--orders .orders-after-value { padding-left: 24px; }'))
  })

  test('a good state is a dot and a word, a problem is a pill', () => {
    assert.ok(page.includes("className={f.aligned ? 'orders-status-ok' : 'fin-pill fin-pill--zero'}"))
    assert.equal(page.includes('fin-pill--full'), false)
    assert.ok(rule('.orders-status-ok::before').includes('background: #3F9B6E'))
  })

  test('the update moves under the code as a line, and the phone card keeps its badge', () => {
    const table = page.slice(page.indexOf('<tbody>'), page.indexOf('</tbody>'))
    assert.ok(table.includes('{updateNote}'))
    assert.equal(table.includes('order-update-badge'), false)
    assert.ok(table.indexOf('orders-code-line') < table.indexOf('orders-update-note'), 'code and markers first, the note under them')
    assert.ok(rule('.orders-code-line').includes('display: flex'))
    assert.equal(css.includes('.orders-code-cell .orders-list-flags { float: right; }'), false, 'a float would drop below the note')
    const cards = page.slice(page.indexOf('<ul className="orders-list-cards"'), page.indexOf('</ul>'))
    assert.equal((cards.match(/order-update-badge/g) ?? []).length, 2)
  })

  test('the Confirmed date really is muted: the shared cell colour outweighs .fin-muted', () => {
    assert.ok(page.includes('<td className="fin-muted">{fmtDate(o.confirm_date)}</td>'))
    assert.ok(css.includes('.fin-table--orders td.fin-muted { color: #686D6C; }'))
  })

  test('the Sales Person is the name alone, and an Order with nobody shows a dash', () => {
    assert.equal(page.includes('FinancePerson'), false)
    assert.ok(page.includes('<td title={o.assigned_to_name}>{o.assigned_to_name || <span className="fin-muted">—</span>}</td>'))
  })

  test('one name for one thing: Project code, never Order no.; Sales Person, never Assignee', () => {
    assert.equal(/Order no\.|order number|'Assignee'|by assignee|All assignees/.test(page), false)
    assert.ok(page.includes('placeholder="Project code, client or person…"'))
    assert.ok(page.includes("?? 'Sales Person'"))
    // The URL parameter keeps its name, so a saved link still opens the same view.
    assert.ok(page.includes('assignee: idParam(),'))
  })

  test('it stays this table\'s: nothing here changes a Finance list', () => {
    const block = css.slice(css.indexOf('/* ── The Confirmed Orders table (owner, 2026-10-31) ──'), css.indexOf('/* A good state is a dot and a word'))
    const selectors = [...block.matchAll(/^([.][^{\n]+)\{/gm)].flatMap(m => m[1].split(',')).map(s => s.trim())
    assert.ok(selectors.length >= 5)
    for (const s of selectors) assert.ok(s.startsWith('.fin-table--orders'), s)
    assert.ok(css.indexOf('.fin-table--orders td { height: 48px;') > css.indexOf('\n.fin-table td {'), 'after the shared rule of the same weight')
    assert.ok(css.indexOf('.fin-table--orders td { height: 48px;') > css.indexOf('.fin-table tbody tr.orders-gap-row td {'), 'and the gap row keeps its own height by weight, not by order')
  })
})

describe('the sample choice (20270320000000)', () => {
  test("the Order's own choice wins once made — even 'not a sample'; else the PI's; else the legacy reason", () => {
    const pi = { subtotal_after_discount: 1, grand_total: 1, sample_type: 'sampling_needed', advance_exception_reason_code: 'sample_order' }
    assert.equal(orderListFlags({ source_pi: pi }).sample, 'sampling_needed', 'the PI choice beats the legacy reason')
    assert.equal(orderListFlags({ sample_type: 'sample_order', sample_type_set_at: '2026-10-19T00:00:00Z', source_pi: pi }).sample, 'sample_order')
    assert.equal(orderListFlags({ sample_type: null, sample_type_set_at: '2026-10-19T00:00:00Z', source_pi: pi }).sample, null, 'cleared on the Order')
    assert.equal(orderListFlags({ sample_type: 'sample_order', sample_type_set_at: null, source_pi: { ...pi, sample_type: null, advance_exception_reason_code: null } }).sample, null, 'an Order value without a set_at is not a choice')
  })
})
