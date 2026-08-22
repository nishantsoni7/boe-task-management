/**
 * PI PRODUCT EDITING — what migration 20261002000000 promises, and what it
 * deliberately refuses.
 *
 * The refusal is the interesting half. Quantity, rate, line total, adding a
 * line and removing one all move money, and this system cannot recompute what
 * the money becomes. That is a blocker with evidence, not a scoping choice, and
 * these tests hold the evidence in place.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION = 'supabase/migrations/20261002000000_order_submission_product_edit.sql'
const sql = readFileSync(join(process.cwd(), MIGRATION), 'utf8')
const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')
const edit = code.slice(code.indexOf('function public.update_order_submission_item_details'))
const editBody = edit.slice(0, edit.indexOf('$$;') + 3)
const reorder = code.slice(code.indexOf('function public.reorder_order_submission_items'))
const reorderBody = reorder.slice(0, reorder.indexOf('$$;') + 3)

describe('the descriptive fields', () => {
  test('are exactly six, and none of them feeds a total', () => {
    const list = editBody.slice(editBody.indexOf('c_fields constant text[]'))
    const declared = list.slice(0, list.indexOf('];'))
    for (const f of ['item_sequence', 'source_product_code', 'product_name',
                     'dimensions', 'material', 'customization']) {
      assert.ok(declared.includes(`'${f}'`), `${f} is missing`)
    }
    assert.equal((declared.match(/'/g) ?? []).length / 2, 6)
  })

  test('and the money columns are never assigned', () => {
    const upd = editBody.slice(editBody.indexOf('update public.order_submission_items set'))
    const stmt = upd.slice(0, upd.indexOf('where id = p_item_id'))
    for (const f of ['quantity', 'cost_per_piece', 'total_amount', 'sort_order',
                     'submission_id', 'image_storage_path', 'image_sha256']) {
      assert.ok(!new RegExp(`\\b${f}\\s*=`).test(stmt), `it assigns ${f}`)
    }
  })
})

describe('the money half, refused with its reason', () => {
  test('quantity, rate and line total are named and blocked', () => {
    const list = editBody.slice(editBody.indexOf('c_money constant text[]'))
    const declared = list.slice(0, list.indexOf('];'))
    for (const f of ['quantity', 'cost_per_piece', 'total_amount']) {
      assert.ok(declared.includes(`'${f}'`))
    }
    assert.match(editBody, /ORDER_SUBMISSION_MONEY_NOT_EDITABLE/)
  })

  test('the refusal SAYS WHY, and points somewhere useful', () => {
    // "Unknown field" would be true and useless. The reader needs to know that
    // the workbook is the authority on this number.
    assert.match(editBody, /reads total_before_gst from the workbook rather than computing it/)
    assert.match(editBody, /re-import/)
  })

  test('the blocker is recorded with its evidence, not just asserted', () => {
    assert.match(sql, /WHY THE MONEY HALF IS BLOCKED/)
    assert.match(sql, /total_before_gst\s+from cell I120/)
    assert.match(sql, /would double-count/)
    assert.match(sql, /as applicable/)
  })

  test('and the evidence still matches the parser', () => {
    // Re-read from source, so the blocker cannot outlive its own reason.
    const parser = readFileSync(join(process.cwd(), 'src/lib/pi/masterSheetParser.ts'), 'utf8')
    assert.match(parser, /totalBeforeGst:\s+'I120'/)
    assert.match(parser, /grandTotal:\s+'I122'/)
    assert.match(parser, /zero-because-already-charged/)
    assert.match(parser, /The workbook's figure has been kept/)
  })

  test('no commercial total is assigned anywhere in the migration', () => {
    for (const f of ['gross_product_amount', 'subtotal_after_discount',
                     'total_before_gst', 'gst_amount', 'grand_total']) {
      assert.ok(!new RegExp(`\\b${f}\\s*=[^=]`).test(code), `the migration assigns ${f}`)
    }
  })
})

describe('reordering', () => {
  test('requires the WHOLE set, exactly once each', () => {
    // A partial list would leave the unnamed lines colliding on the unique
    // sort_order index; a repeated id would too.
    assert.match(reorderBody, /ORDER_SUBMISSION_BAD_ORDER/)
    assert.match(reorderBody, /count\(distinct x\)/)
  })

  test('moves in TWO passes, so a swap cannot collide', () => {
    // sort_order is unique per submission. A single pass fails the moment two
    // lines exchange places.
    assert.match(reorderBody, /sort_order = sort_order \+ 1000000/)
  })

  test('writes nothing when the order did not change', () => {
    assert.match(reorderBody, /if not v_changed then/)
    const noop = reorderBody.slice(reorderBody.indexOf('if not v_changed then'))
    const block = noop.slice(0, noop.indexOf('end if;'))
    assert.ok(!block.includes('update public.order_submission_items'))
  })

  test('and touches no money', () => {
    const stmts = [...reorderBody.matchAll(/update public\.order_submission_items[\s\S]*?;/g)]
      .map(m => m[0])
    for (const s of stmts) {
      for (const f of ['quantity', 'cost_per_piece', 'total_amount']) {
        assert.ok(!new RegExp(`\\b${f}\\s*=`).test(s), `reorder assigns ${f}`)
      }
    }
  })
})

describe('the shape both functions share', () => {
  for (const [name, body] of [
    ['update_order_submission_item_details', editBody],
    ['reorder_order_submission_items', reorderBody],
  ] as const) {
    test(`${name} locks the PI, not the item`, () => {
      assert.match(body, /from public\.order_submissions\s*\n?\s*where id = [\w.]+ for update/)
    })
    test(`${name} accepts either authority`, () => {
      assert.match(body, /v_is_admin or v_is_owner/)
      assert.match(body, /NOT_EDITABLE/)
    })
    test(`${name} uses row_version, never a timestamp`, () => {
      assert.match(body, /row_version is distinct from p_expected_version/)
    })
    test(`${name} requires a reason after submission`, () => {
      assert.match(body, /REASON_REQUIRED/)
    })
  }
})

describe('the migration itself', () => {
  test('is forward-only and dependency-checked BOTH ways', () => {
    assert.ok(Number(MIGRATION.split('/').pop()!.split('_')[0]) > 20261001000000)
    assert.match(code, /DEPENDENCY MISSING: 20260930000000/)
    // And on the action set — the rule 20260923000000 broke.
    assert.match(code, /DEPENDENCY MISSING: 20261001000000 must be applied first/)
  })

  test('its actions are declared in the action set', () => {
    const actions = readFileSync(
      join(process.cwd(), 'supabase/migrations/20261001000000_order_submission_activity_actions.sql'), 'utf8')
    assert.ok(actions.includes("'product_details_updated'"))
    assert.ok(actions.includes("'product_details_amended_by_admin'"))
  })

  test('drops nothing an earlier migration owns', () => {
    assert.ok(!/drop (table|column|policy|constraint|function)/i.test(code))
  })
})
