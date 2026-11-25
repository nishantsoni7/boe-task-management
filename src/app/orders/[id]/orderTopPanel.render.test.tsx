/**
 * THE TOP OF THE ORDER PAGE: A FACTS LINE AND ONE CARD (owner, 25 Nov 2026). He marked two box-heavy versions
 * 4/10 and 5/10: "too many boxes and cards on top ... classy and professional". The five facts are ONE line of
 * plain text under the order number; everything else above the products is ONE card (.order-top): the notices as
 * quiet rows, the PI card, then the Sales highlight and the Notes as plain text.
 *
 * These pin the structure (the line, then one card holding the notices and the PI card, the products outside it),
 * that the highlight is plain text, and that the CSS cannot bring the boxes back.
 *
 * Run:
 *   npx tsx --test "src/app/orders/**\/orderTopPanel.render.test.tsx"
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { OrderHighlightRemarkBanner } from '@/components/orders/PiHighlightRemark'
import { OrderStatusStrip } from './OrderRedesign'
import { orderBarGates } from '@/lib/orders/orderBarGates'

const noop = () => {}
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const css = read('src/app/globals.css')
const page = read('src/app/orders/[id]/page.tsx')
// The block sits just above the phone phases (four phone tests scan from a phone marker to the end of the file).
const block = css.slice(css.indexOf('CONFIRMED ORDER: THE TOP OF THE PAGE'), css.indexOf('PHONE PHASE 3 — FINANCE'))

describe('the page: the facts line, then ONE card', () => {
  const line = page.indexOf('<OrderStatusStrip')
  const open = page.indexOf('<div className="order-top">')
  const close = page.indexOf('</OrderDocumentsRow>\n        </div>')

  test('the facts line comes first, then one card that holds the notices and the PI card', () => {
    assert.equal((page.match(/className="order-top"/g) ?? []).length, 1)
    assert.ok(line > 0 && open > line && close > open)
    const inside = page.slice(open, close)
    assert.equal(inside.includes('<OrderStatusStrip'), false, 'the facts are not inside the card')
    assert.ok(inside.indexOf('<OrderAttentionBar') < inside.indexOf('<OrderDocumentsRow>'), 'the notices, then the PI card')
    assert.ok(inside.includes('<OrderHighlightRemark') && inside.includes('aria-label="Order notes"'), 'the highlight and the Notes are in it')
  })

  test('the products and the folded rows stay outside it, as cards of their own', () => {
    assert.ok(page.indexOf('<div className="order-products order-products--joined">') > close)
    assert.ok(page.indexOf('<OrderDetailSections') > close)
  })

  test('the highlight is drawn bare inside the card', () => {
    assert.match(page, /<OrderHighlightRemark\s+supabase=\{supabase\}\s+submissionId=\{order\.source_order_submission_id \?\? null\}\s+refreshKey=\{order\.updated_at\}\s+bare\s*\/>/)
  })
})

describe('the facts line: plain text, not cells', () => {
  const gates = orderBarGates({
    advance: null, dueDate: '10 Jan 2027', daysToDue: 47,
  } as Parameters<typeof orderBarGates>[0])
  const html = renderToStaticMarkup(
    <OrderStatusStrip
      erp={{ label: 'Aligned · PI V1', tone: 'green', line: 'Aligned on 19 Nov 2026' }}
      production={{ label: 'Running', tone: 'blue' }}
      isSample={false} sampleLabel={null}
      bar={{ ...gates, onOpen: noop }}
    />,
  )

  test('a status is a dot and a word, with no inline pill colours', () => {
    assert.equal((html.match(/order-stage-badge--plain/g) ?? []).length, 2)
    assert.equal(/background:#[0-9A-Fa-f]{3,6};color:/.test(html), false, 'no filled pill')
  })

  test('without the bar the strip is exactly what it was (filled pills), for any other caller', () => {
    const old = renderToStaticMarkup(
      <OrderStatusStrip erp={{ label: 'Aligned', tone: 'green', line: null }} production={{ label: 'Running', tone: 'blue' }} isSample={false} sampleLabel={null} />,
    )
    assert.equal(old.includes('order-stage-badge--plain'), false)
    assert.ok(old.includes('style="background:'))
  })

  test('CSS: the line has no background, border or card of its own', () => {
    const rule = block.match(/\n\.order-stages--bar \{([^}]*)\}/)
    assert.ok(rule)
    assert.ok(/background: transparent; border: 0; border-radius: 0/.test(rule[1]))
    const cell = block.match(/\n\.order-stages--bar > \.order-stage \{([^}]*)\}/)
    assert.ok(cell)
    assert.ok(/background: transparent; border: 0; border-radius: 0/.test(cell[1]))
    assert.match(block, /\.order-bar-chip \{ display: inline; min-height: 0; padding: 0; border-radius: 0; background: transparent;/)
  })
})

describe('the bare highlight: a label and the text, no card of its own', () => {
  const html = renderToStaticMarkup(<OrderHighlightRemarkBanner bare remark={'Walnut finish\nmatch the swatch'} />)

  test('it keeps the label, the BOE-only tag and the text as typed', () => {
    assert.ok(html.includes('aria-label="Internal highlight"'))
    assert.ok(html.includes('Internal highlight'))
    assert.ok(html.includes('BOE only'))
    assert.ok(html.includes('Walnut finish\nmatch the swatch'))
  })

  test('the tone is a dot, like the notices', () => {
    assert.ok(html.includes('class="order-highlight-dot"'))
    assert.equal(html.includes('<svg'), true, 'only the lock of the BOE-only tag is an icon')
  })

  test('it carries NO inline chrome (no border, shadow or fill): the card frames it', () => {
    assert.equal(/style=/.test(html), false)
    assert.ok(html.includes('order-highlight--bare'))
  })

  test('nothing is drawn without a remark, bare or not', () => {
    assert.equal(renderToStaticMarkup(<OrderHighlightRemarkBanner bare remark={null} />), '')
  })

  test('the card version is unchanged without the prop', () => {
    const card = renderToStaticMarkup(<OrderHighlightRemarkBanner remark="x" />)
    assert.ok(card.includes('box-shadow:inset 4px 0 0 #C48A1A'))
    assert.equal(card.includes('order-highlight--bare'), false)
  })
})

describe('the card\'s styles', () => {
  test('ONE frame: the card has the border and the radius, and it does not clip (the PI Details popover opens inside it)', () => {
    const rule = block.match(/\n\.order-top \{([^}]*)\}/)
    assert.ok(rule, 'a .order-top rule')
    assert.ok(/border: 1px solid #E4DED7/.test(rule[1]) && /border-radius: 14px/.test(rule[1]))
    assert.equal(/overflow/.test(rule[1]), false)
  })

  test('the notices are quiet rows: no tint, no frame, no thick left edge, a dot for the tone', () => {
    const rule = block.match(/\.order-top \.order-notice \{([^}]*)\}/)
    assert.ok(rule)
    assert.ok(/background: transparent; border: 0; border-radius: 0/.test(rule[1]))
    assert.equal(/border-left/.test(rule[1]), false)
    assert.match(block, /\.order-top \.order-notice-icon svg \{ display: none; \}/)
    assert.match(block, /\.order-top \.order-notice-icon \{[^}]*border-radius: 50%;/)
  })

  test('the strip cells, the footer and the Needs-your-action block have no box: bands ruled by horizontal lines, the four columns by light vertical ones', () => {
    const strip = block.match(/\.order-pic \.order-pic-strip \{([^}]*)\}/)
    assert.ok(strip)
    assert.ok(/background: transparent; border: 0; border-radius: 0/.test(strip[1]))
    assert.match(block, /\.order-pic-footer \{[^}]*border-top: 1px solid #ECE7E0;/)
    assert.match(block, /\.order-doc-changes--you \{[^}]*border: 0; border-bottom: 1px solid #ECE7E0; border-radius: 0; box-shadow: none;/)
    assert.match(block, /\.order-pic-strip > :not\(:first-child\) \{ border-left: 1px solid #ECE7E0; \}/)
  })

  test('the Sales highlight and the Notes share one label style and one text size', () => {
    assert.match(block, /\.order-top \.order-notes-head,\s*\.order-highlight--bare > div \{[^}]*min-height: 20px[^}]*font-size: 13px/)
    assert.match(block, /\.order-top \.order-notes-body, \.order-highlight--bare > p \{[^}]*font-size: 14px/)
  })

  test('the CSS lives ABOVE the phone phases, never after them', () => {
    assert.ok(css.indexOf('CONFIRMED ORDER: THE TOP OF THE PAGE') < css.indexOf('PHONE PHASE 3 — FINANCE'))
    assert.ok(css.indexOf('CONFIRMED ORDER: THE DETAILS BELOW THE PRODUCTS, ALL OPEN') < css.indexOf('PHONE PHASE 3 — FINANCE'))
  })

  test('an empty footer takes no space, and a single one spans the card', () => {
    assert.match(block, /\.order-pic-footer:empty \{ display: none; \}/)
    assert.ok(block.indexOf('.order-pic-footer {') < block.indexOf('.order-pic-footer:empty'), 'the hiding rule comes after the drawing rule')
    assert.match(block, /\.order-pic-footer > :only-child \{ grid-column: 1 \/ -1; \}/)
  })

  test('on a phone the cells stack with a line between them, the footer stacks, and the notice buttons are 44px', () => {
    assert.match(block, /@container \(max-width: 640px\) \{[\s\S]*?\.order-pic-strip > \.order-doc-section \{ padding: 14px 0; border-left: 0; border-top: 1px solid #ECE7E0; \}/)
    assert.match(block, /@container \(max-width: 640px\) \{[\s\S]*?\.order-pic-footer \{ grid-template-columns: minmax\(0, 1fr\);/)
    assert.match(block, /@media \(max-width: 640px\) \{[\s\S]*?\.order-notice-actions \.boe-btn \{ flex: 1 1 0; min-height: 44px; \}/)
  })
})
