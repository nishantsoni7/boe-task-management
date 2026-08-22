/**
 * THE PRODUCT EDITOR, ACTUALLY RENDERED.
 *
 * The dialog's job is as much what it REFUSES to offer as what it accepts. A
 * quantity or a rate is the output of a formula in the PI workbook that this
 * system has never read — the parser transcribes the result and warns when its
 * own two derivations disagree — so a text box over either would be BOE
 * inventing a figure the spreadsheet did not produce.
 *
 * The failure this guards against is subtle and would ship silently: an input
 * added "for completeness", or a figure rendered as a `disabled` field. A
 * greyed-out box over a price does not read as "this cannot be typed"; it reads
 * as "somebody has the permission to turn this on", and the answer is nobody.
 *
 * So this renders the REAL exports the PI detail page opens and reads the markup
 * that comes out. It does not test padding: a design decision that will change
 * is not a test anybody keeps.
 *
 * Run:
 *   npx tsx --test src/components/orders/piProductEdit.render.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  PiProductEditModal,
  PiProductReorderModal,
  PI_PRODUCT_FIELDS,
  PI_CHANGE_PI_ONLY,
} from './piReviewModals'

/** Text content, with the tags taken out — for "does it SAY this" checks. */
const text = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/').replace(/\s+/g, ' ')

const buttonLabels = (html: string): string[] =>
  [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => text(m[1]).trim())

const LINE = {
  sequence: 'B-014',
  name: 'Oak sideboard',
  quantity: '2',
  rate: 'Rs. 50,000',
  total: 'Rs. 1,00,000',
}

const CURRENT = {
  item_sequence: 'B-014',
  source_product_code: 'OAK-SB-6',
  product_name: 'Oak sideboard',
  dimensions: '1830 x 450 x 800',
  material: 'Solid oak',
  customization: 'Matte finish',
}

const editor = (over: Partial<Parameters<typeof PiProductEditModal>[0]> = {}) =>
  renderToStaticMarkup(
    <PiProductEditModal
      line={LINE}
      current={CURRENT}
      saving={false}
      failure={null}
      onCancel={() => {}}
      onSave={() => {}}
      onChangePi={() => {}}
      {...over}
    />)

/**
 * THE FIELD SET, WRITTEN OUT INDEPENDENTLY.
 *
 * Not derived from PI_PRODUCT_FIELDS. A test that reads the same list the code
 * reads proves the code agrees with itself — adding `quantity` to that list
 * would pass every "one control per field" check while putting a text box over
 * a workbook formula. This is the second copy, on purpose, and it is the one
 * that has to be edited deliberately.
 */
const EXPECTED_FIELDS = [
  'item_sequence', 'source_product_code', 'product_name',
  'dimensions', 'material', 'customization',
] as const

/** Everything the workbook computes. None of it may become a field. */
const FORBIDDEN_FIELDS = [
  'quantity', 'cost_per_piece', 'total_amount', 'rate', 'unit_cost',
  'discount_amount', 'fabric_cost', 'packing_cost', 'transportation_amount',
  'gst_amount', 'grand_total', 'subtotal_after_discount', 'total_before_gst',
  'image_storage_path', 'sort_order', 'submission_id', 'id',
] as const

describe('the editable product fields are descriptive, and only those', () => {
  test('the field table is exactly the six descriptive columns', () => {
    assert.deepEqual(PI_PRODUCT_FIELDS.map(f => f.key), [...EXPECTED_FIELDS],
      'a field was added or removed — was it deliberate?')
  })

  test('no money key can reach the field table', () => {
    const keys = new Set<string>(PI_PRODUCT_FIELDS.map(f => f.key))
    for (const forbidden of FORBIDDEN_FIELDS) {
      assert.ok(!keys.has(forbidden),
        `${forbidden} is computed by the workbook and must never be a form field`)
    }
  })

  test('the labels never name a figure either', () => {
    const labels = PI_PRODUCT_FIELDS.map(f => f.label.toLowerCase()).join(' | ')
    for (const word of ['quantity', 'rate', 'cost', 'price', 'total', 'amount', 'gst']) {
      assert.ok(!labels.includes(word), `a field is labelled "${word}"`)
    }
  })
})

describe('the product editor offers descriptions and never a figure', () => {
  test('every descriptive field has a real input', () => {
    const html = editor()
    for (const f of PI_PRODUCT_FIELDS) {
      assert.ok(text(html).includes(f.label), `${f.label} is not shown`)
    }
    // Six fields, six controls: one text input and five textareas, or whatever
    // the field table says. Counted, so a field silently dropped is caught.
    const controls = (html.match(/<(input|textarea)\b/g) ?? []).length
    assert.equal(controls, EXPECTED_FIELDS.length,
      'one control per descriptive field, and nothing else')
  })

  test('there is no input over a quantity, a rate or a line total', () => {
    const html = editor()
    // The figures ARE shown — a person editing a line needs to see which line —
    // but as text.
    assert.ok(text(html).includes('Rs. 50,000'), 'the rate is shown')
    assert.ok(text(html).includes('Rs. 1,00,000'), 'the line total is shown')
    // And never inside a form control, disabled or otherwise.
    for (const control of html.match(/<(input|textarea)\b[^>]*>/g) ?? []) {
      for (const figure of ['50,000', '1,00,000']) {
        assert.ok(!control.includes(figure), `a figure reached a form control: ${control}`)
      }
    }
    assert.ok(!/name="quantity"|name="cost_per_piece"|name="total_amount"/.test(html))
  })

  test('no figure is rendered as a disabled control', () => {
    // THE FAILURE MODE THIS EXISTS FOR. A disabled input reads as a permission
    // problem — "who can turn this on?" — when the truth is that nobody types
    // these at all. Nothing in this dialog is disabled while it is idle.
    // Narrowed to FORM CONTROLS deliberately: the Save button is disabled while
    // nothing has changed, which is correct and unrelated. What must never be
    // disabled is a field, because a disabled field is the shape of a value
    // somebody could be given permission to type.
    const html = editor()
    for (const control of html.match(/<(input|textarea)\b[^>]*>/g) ?? []) {
      assert.ok(!control.includes('disabled'),
        `a field is rendered disabled: ${control}`)
    }
  })

  test('it says where a figure IS changed, and offers the way there', () => {
    const html = editor()
    const t = text(html)
    assert.ok(t.includes('PI workbook'), 'it names the workbook')
    assert.ok(/upload a corrected workbook/i.test(t), 'and what to do about it')
    assert.ok(buttonLabels(html).includes('Change PI'))
  })

  test('the Change PI control is absent where the reader may not use it', () => {
    const html = editor({ onChangePi: null })
    assert.ok(!buttonLabels(html).includes('Change PI'),
      'a control that would refuse is worse than no control')
    // The sentence stays: the reader still needs to know why there is no box.
    assert.ok(text(html).includes('PI workbook'))
  })

  test('saving is refused until something changed', () => {
    const html = editor()
    const save = html.match(/<button type="submit"[^>]*>/)?.[0] ?? ''
    assert.ok(save.includes('disabled'), 'nothing changed yet, so there is nothing to save')
  })

  test('an amendment asks for a reason, and a draft edit does not', () => {
    assert.ok(!text(editor()).includes('Reason for this amendment'))
    const amend = text(editor({ requireReason: true }))
    assert.ok(amend.includes('Reason for this amendment'))
    assert.ok(amend.includes('Required'))
  })

  test('a failure is announced, not swallowed', () => {
    const html = editor({ failure: 'ORDER_SUBMISSION_STALE: somebody else edited this' })
    assert.ok(html.includes('role="alert"'))
    assert.ok(text(html).includes('ORDER_SUBMISSION_STALE'),
      'the database’s own answer is shown, not replaced by a sentence of our own')
  })
})

describe('the reorder dialog moves lines and nothing else', () => {
  const LINES = [
    { id: 'a', sequence: 'B-1', name: 'Oak sideboard' },
    { id: 'b', sequence: 'B-2', name: 'Teak bed' },
    { id: 'c', sequence: 'B-3', name: 'Cane chair' },
  ]
  const reorder = (over: Partial<Parameters<typeof PiProductReorderModal>[0]> = {}) =>
    renderToStaticMarkup(
      <PiProductReorderModal
        lines={LINES}
        saving={false}
        failure={null}
        onCancel={() => {}}
        onSave={() => {}}
        {...over}
      />)

  test('every line is listed, in the order given', () => {
    const t = text(reorder())
    const at = (name: string) => t.indexOf(name)
    assert.ok(at('Oak sideboard') < at('Teak bed'))
    assert.ok(at('Teak bed') < at('Cane chair'))
  })

  test('it says plainly that nothing is added, removed or repriced', () => {
    const t = text(reorder())
    assert.match(t, /adds nothing, removes nothing, and moves no figure/i)
  })

  test('the ends cannot be moved past themselves', () => {
    const html = reorder()
    const moves = [...html.matchAll(/<button type="button"[^>]*aria-label="Move ([^"]*)"[^>]*>/g)]
    assert.equal(moves.length, 6, 'up and down on each of three lines')
    // First line's up and last line's down are the two that must be disabled.
    const disabled = moves.filter(m => m[0].includes('disabled')).map(m => m[1])
    assert.deepEqual(disabled.sort(), ['Move Cane chair down', 'Move Oak sideboard up'].map(l => l.replace('Move ', '')).sort())
  })

  test('saving is refused until the order actually moved', () => {
    const save = reorder().match(/<button type="submit"[^>]*>/)?.[0] ?? ''
    assert.ok(save.includes('disabled'))
  })

  test('an amendment asks for a reason here too', () => {
    assert.ok(text(reorder({ requireReason: true })).includes('Reason for this amendment'))
  })
})

describe('what needs a corrected workbook is stated once, in one list', () => {
  test('the list names money, products and images', () => {
    const joined = PI_CHANGE_PI_ONLY.join(' | ').toLowerCase()
    for (const expected of ['quantity', 'rate', 'adding a product', 'removing a product',
                            'discount', 'gst', 'product image']) {
      assert.ok(joined.includes(expected), `${expected} must be named`)
    }
  })

  test('it never promises an editor for any of them', () => {
    for (const entry of PI_CHANGE_PI_ONLY) {
      assert.ok(!/edit|change here|update below/i.test(entry),
        `"${entry}" reads as though a form could fix it`)
    }
  })
})
