/**
 * THE SHARED READINESS ANSWER.
 *
 * The property that matters most here is NEGATIVE: this module must not invent
 * a requirement. Every rule it reports has a database gate behind it, and a
 * screen that nags about an optional field teaches people to ignore the screen.
 * Several tests below exist only to prove absences.
 *
 * Run:
 *   npx tsx --test src/lib/orders/piReadiness.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  PI_CLIENT_NAME_REQUIREMENT,
  PI_COMMERCIAL_FIELDS,
  PI_HAS_CONFIGURABLE_GST_RATE,
  piReadiness,
  piReadinessFirstSection,
  piReadinessIsEditable,
  type PiReadinessItem,
  type PiReadinessSource,
} from './piReadiness'

const complete: PiReadinessSource = {
  client_name: 'Marigold Interiors',
  source_workbook_path: 'submissions/abc/original/pi.xlsx',
  parse_blocking_issues: [],
}

/**
 * The body of piReadiness() alone — the function that decides what is missing.
 *
 * Classification constants elsewhere in the module legitimately name derived
 * fields; only this function may not.
 */
function requirementLogic(): string {
  const src = readFileSync(join(process.cwd(), 'src/lib/orders/piReadiness.ts'), 'utf8')
  const at = src.indexOf('export function piReadiness(')
  assert.ok(at > 0, 'piReadiness() not found')
  const rest = src.slice(at)
  const end = rest.indexOf('\nfunction summarize')
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter(l => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('/*'))
    .join('\n')
}

const goodItem: PiReadinessItem = {
  item_sequence: 1,
  product_name: 'Oak sideboard',
  hasRepresentativeImage: true,
}

// ══ 1. The dead end that prompted this ═══════════════════════════════════════

describe('the missing client name', () => {
  test('blocks a payment, which is the exact manual-test dead end', () => {
    const r = piReadiness('payment', { ...complete, client_name: null })
    assert.equal(r.ready, false)
    assert.deepEqual(r.missing.map(m => m.key), ['client_name'])
    assert.match(r.summary!, /Before a payment can be added/)
  })

  test('blocks submission too, from the SAME answer', () => {
    // One module, so the two surfaces cannot disagree about the same record.
    const r = piReadiness('submission', { ...complete, client_name: '' }, [goodItem])
    assert.ok(r.missing.some(m => m.key === 'client_name'))
  })

  test('whitespace is not a client name', () => {
    for (const value of ['', '   ', '\t', '\n ']) {
      const r = piReadiness('payment', { ...complete, client_name: value })
      assert.equal(r.ready, false, `"${value}" was accepted`)
    }
  })

  test('a present name clears it, and the PI is ready for payment', () => {
    const r = piReadiness('payment', complete)
    assert.equal(r.ready, true)
    assert.deepEqual(r.missing, [])
    assert.equal(r.summary, null)
  })

  test('points at the editor section that supplies it', () => {
    assert.equal(PI_CLIENT_NAME_REQUIREMENT.section, 'client')
    const r = piReadiness('payment', { ...complete, client_name: null })
    assert.equal(piReadinessFirstSection(r), 'client')
    assert.equal(piReadinessIsEditable(r), true)
  })
})

// ══ 2. Everything at once, not one refusal at a time ═════════════════════════

describe('a record missing several things', () => {
  const bare: PiReadinessSource = {
    client_name: null,
    source_workbook_path: null,
    parse_blocking_issues: ['a', 'b'],
  }

  test('reports them TOGETHER', () => {
    const r = piReadiness('submission', bare, [])
    const keys = r.missing.map(m => m.key)
    assert.ok(keys.includes('client_name'))
    assert.ok(keys.includes('source_workbook'))
    assert.ok(keys.includes('parse_blocking_issues'))
    assert.ok(keys.includes('products'))
    assert.ok(r.missing.length >= 4,
      'the whole remaining distance, not just its first step')
  })

  test('the summary counts them rather than naming only the first', () => {
    const r = piReadiness('submission', bare, [])
    assert.match(r.summary!, /\d+ things are needed/)
  })

  test('a single missing thing is named, not counted', () => {
    const r = piReadiness('payment', { ...complete, client_name: null })
    assert.match(r.summary!, /client name is needed/i)
    assert.ok(!/1 things/.test(r.summary!))
  })
})

// ══ 3. What no editor can fix ════════════════════════════════════════════════

describe('workbook problems', () => {
  test('are marked as needing a re-import, not an edit', () => {
    const r = piReadiness('submission', { ...complete, parse_blocking_issues: ['x'] }, [goodItem])
    const issue = r.missing.find(m => m.key === 'parse_blocking_issues')!
    assert.equal(issue.needsReimport, true)
    assert.match(issue.label, /re-imported/)
  })

  test('a list of ONLY those offers no edit action', () => {
    // Offering "Edit PI details" for a problem no form owns is a lie.
    const r = piReadiness('submission', { ...complete, parse_blocking_issues: ['x'] }, [goodItem])
    assert.equal(r.ready, false)
    assert.equal(piReadinessIsEditable(r), false)
    assert.equal(piReadinessFirstSection(r), null)
  })

  test('a mixed list opens at the section that CAN be fixed', () => {
    const r = piReadiness('submission',
      { client_name: null, source_workbook_path: null, parse_blocking_issues: ['x'] }, [goodItem])
    assert.equal(piReadinessIsEditable(r), true)
    assert.equal(piReadinessFirstSection(r), 'client')
  })

  test('the issue count is pluralised honestly', () => {
    const one = piReadiness('submission', { ...complete, parse_blocking_issues: ['x'] }, [goodItem])
    assert.match(one.missing.find(m => m.key === 'parse_blocking_issues')!.label, /^1 problem\b/)
    const many = piReadiness('submission', { ...complete, parse_blocking_issues: ['x', 'y'] }, [goodItem])
    assert.match(many.missing.find(m => m.key === 'parse_blocking_issues')!.label, /^2 problems\b/)
  })

  test('a non-array parse_blocking_issues is treated as none, never as a crash', () => {
    for (const value of [undefined, null, 'nonsense', 3, {}]) {
      const r = piReadiness('submission',
        { ...complete, parse_blocking_issues: value }, [goodItem])
      assert.equal(r.ready, true, `${JSON.stringify(value)} produced a requirement`)
    }
  })
})

// ══ 4. Product lines ═════════════════════════════════════════════════════════

describe('product lines', () => {
  test('at least one is required to submit', () => {
    const r = piReadiness('submission', complete, [])
    assert.deepEqual(r.missing.map(m => m.key), ['products'])
  })

  test('incomplete lines are COUNTED, not listed one by one', () => {
    const items = [goodItem, { ...goodItem, product_name: null }, { ...goodItem, item_sequence: null }]
    const r = piReadiness('submission', complete, items)
    const issue = r.missing.find(m => m.key === 'product_lines_incomplete')!
    assert.match(issue.label, /^2 product lines\b/)
    assert.equal(r.missing.length, 1, 'one sentence a reader can act on, not two')
  })

  test('each of the three line requirements is caught', () => {
    for (const bad of [
      { ...goodItem, item_sequence: null },
      { ...goodItem, product_name: '  ' },
      { ...goodItem, hasRepresentativeImage: false },
    ]) {
      const r = piReadiness('submission', complete, [bad])
      assert.ok(r.missing.some(m => m.key === 'product_lines_incomplete'),
        `not caught: ${JSON.stringify(bad)}`)
    }
  })

  test('an UNKNOWN image state is not treated as missing', () => {
    // `undefined` means the caller did not read images; guessing "absent" would
    // invent a requirement out of a gap in the caller's own query.
    const r = piReadiness('submission', complete, [{ item_sequence: 1, product_name: 'X' }])
    assert.equal(r.ready, true)
  })

  test('lines are not consulted at all for a PAYMENT', () => {
    // The payment surface does not read product lines and must not be made to
    // fetch them just to ask this question.
    const r = piReadiness('payment', complete, [])
    assert.equal(r.ready, true)
  })

  test('omitting items entirely reports NO line requirement', () => {
    const r = piReadiness('submission', complete)
    assert.ok(!r.missing.some(m => m.section === 'products'),
      'silence about what was not asked, rather than a guess')
  })
})

// ══ 5. What is deliberately NOT required ═════════════════════════════════════

describe('optional fields', () => {
  test('are never reported, however empty the record is', () => {
    // Every one of these is legitimately absent on a real PI. A screen that
    // nags about them is a screen people learn to ignore.
    const r = piReadiness('submission', complete, [goodItem])
    assert.equal(r.ready, true)
    assert.deepEqual(r.missing, [])
  })

  test('the requirement logic names no optional field', () => {
    // SCOPED TO piReadiness() ITSELF, not the whole module.
    //
    // The module also CLASSIFIES the commercial fields, which means naming
    // gst_amount and grand_total in order to record that no human may type
    // them. A whole-file scan reads that classification as a requirement — the
    // opposite of what it says. What must be true is that the function which
    // GENERATES requirements never mentions them.
    const code = requirementLogic()
    for (const optional of [
      'contact_number', 'bill_to_phone', 'ship_to_phone',
      'billing_address', 'shipping_address', 'bill_to_name', 'ship_to_name',
      'billing_percentage', 'due_date', 'dispatch_commitment',
      'gst_amount', 'discount_amount', 'transportation_amount',
    ]) {
      assert.ok(!code.includes(optional),
        `${optional} is optional; requiring it would be an invented rule`)
    }
  })

  test('a derived total is never a requirement', () => {
    const code = requirementLogic()
    for (const derived of ['grand_total', 'total_before_gst', 'subtotal_after_discount',
                           'gst_amount', 'gross_product_amount']) {
      assert.ok(!code.includes(derived),
        `${derived} is calculated, not supplied — it must not generate a requirement`)
    }
  })
})

// ══ 6. The module's own shape ════════════════════════════════════════════════

describe('the answer itself', () => {
  test('`ready` and `missing` can never disagree', () => {
    const cases: Array<[PiReadinessSource, PiReadinessItem[]]> = [
      [complete, [goodItem]],
      [{ ...complete, client_name: null }, [goodItem]],
      [{ client_name: null, source_workbook_path: null, parse_blocking_issues: ['x'] }, []],
    ]
    for (const [sub, items] of cases) {
      for (const purpose of ['payment', 'submission'] as const) {
        const r = piReadiness(purpose, sub, items)
        assert.equal(r.ready, r.missing.length === 0)
        assert.equal(r.summary === null, r.ready)
      }
    }
  })

  test('every requirement carries a key, a label and a section', () => {
    const r = piReadiness('submission',
      { client_name: null, source_workbook_path: null, parse_blocking_issues: ['x'] }, [])
    for (const m of r.missing) {
      assert.ok(m.key.length > 0)
      assert.ok(m.label.length > 0)
      assert.ok(['client', 'schedule', 'products', 'workbook'].includes(m.section))
    }
  })

  test('keys are unique, so a caller can key a list by them', () => {
    const r = piReadiness('submission',
      { client_name: null, source_workbook_path: null, parse_blocking_issues: ['x'] }, [])
    assert.equal(new Set(r.missing.map(m => m.key)).size, r.missing.length)
  })

  test('it reads nothing but the fields it declares', () => {
    // A pure function of its arguments: no clock, no network, no database.
    const src = readFileSync(join(process.cwd(), 'src/lib/orders/piReadiness.ts'), 'utf8')
    assert.ok(!/supabase|fetch\(|Date\.now|new Date/.test(src))
  })
})

// ══ 7. The commercial classification ═════════════════════════════════════════

describe('which commercial fields a human may edit', () => {
  test('input and derived do not overlap', () => {
    const overlap = PI_COMMERCIAL_FIELDS.input
      .filter(f => (PI_COMMERCIAL_FIELDS.derived as readonly string[]).includes(f))
    assert.deepEqual(overlap, [], 'a field cannot be both typed and calculated')
  })

  test('every forbidden figure is on the derived list', () => {
    for (const f of ['gross_product_amount', 'subtotal_after_discount',
                     'total_before_gst', 'gst_amount', 'grand_total']) {
      assert.ok((PI_COMMERCIAL_FIELDS.derived as readonly string[]).includes(f),
        `${f} must never be a text box`)
    }
  })

  test('derivable is a STRICT SUBSET of derived, and smaller', () => {
    // The distinction that matters. A figure can be both "no human should type
    // this" and "BOE has never known how to compute it".
    for (const f of PI_COMMERCIAL_FIELDS.derivable) {
      assert.ok((PI_COMMERCIAL_FIELDS.derived as readonly string[]).includes(f))
    }
    assert.ok(PI_COMMERCIAL_FIELDS.derivable.length < PI_COMMERCIAL_FIELDS.derived.length,
      'if everything derived were derivable, there would be no blocker to record')
  })

  test('total_before_gst, gst_amount and grand_total are NOT derivable', () => {
    // Read from named workbook cells. The arithmetic behind them lives in a
    // spreadsheet formula this system has never read.
    for (const f of ['total_before_gst', 'gst_amount', 'grand_total']) {
      assert.ok(!(PI_COMMERCIAL_FIELDS.derivable as readonly string[]).includes(f),
        `${f} cannot be recomputed without inventing arithmetic`)
    }
  })

  test('and the parser still says so', () => {
    // Re-read from source, so the classification cannot quietly rot if the
    // parser ever starts deriving these.
    const parser = readFileSync(join(process.cwd(), 'src/lib/pi/masterSheetParser.ts'), 'utf8')
    assert.match(parser, /totalBeforeGst:\s+'I\d+'/, 'total before GST is read from a cell')
    assert.match(parser, /grandTotal:\s+'I\d+'/, 'grand total is read from a cell')
    assert.match(parser, /const grossProductAmount = products\.reduce/, 'gross IS derived')
    assert.match(parser, /const expectedSubtotal = grossProductAmount - discount/,
      'the subtotal IS derived')
    assert.match(parser, /The workbook's figure has been kept/,
      'and a disagreement keeps the workbook, not the computation')
  })

  test('there is no configurable GST rate, and the source agrees', () => {
    assert.equal(PI_HAS_CONFIGURABLE_GST_RATE, false)
    const parser = readFileSync(join(process.cwd(), 'src/lib/pi/masterSheetParser.ts'), 'utf8')
    assert.ok(!/gst_?rate/i.test(parser), 'a GST rate appeared in the parser')
  })
})
