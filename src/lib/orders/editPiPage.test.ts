/**
 * The full-page Edit PI: its addresses, its hand-back, and the name the
 * original Excel downloads under.
 *
 * Run:
 *   npx tsx --test src/lib/orders/editPiPage.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  EDIT_PI_OUTCOME_NOTICE,
  draftEditPiPageHref,
  editPiPageHref,
  editPiReturnHref,
  originalWorkbookFileName,
  readEditPiOutcome,
} from './editPiPage'

describe('where Edit PI lives', () => {
  test('one page for an Order, one for a draft', () => {
    assert.equal(editPiPageHref('o-1'), '/orders/o-1/edit-pi')
    assert.equal(draftEditPiPageHref('s-1'), '/orders/drafts/s-1/edit-pi')
  })

  test('it hands back one known word, and nothing else is read', () => {
    assert.equal(editPiReturnHref('/orders/o-1', 'proposed'), '/orders/o-1?edit_pi=proposed')
    for (const word of ['proposed', 'dates', 'saved', 'applied'] as const) {
      assert.equal(readEditPiOutcome(word), word)
      assert.ok(EDIT_PI_OUTCOME_NOTICE[word].length > 0)
    }
    for (const junk of [null, '', 'PROPOSED', '<script>', 'approved']) assert.equal(readEditPiOutcome(junk), null)
  })

  test('a proposal says the current PI stays in force until an Admin approves', () => {
    assert.match(EDIT_PI_OUTCOME_NOTICE.proposed, /stays in force until then/)
  })
})

describe('the original Excel', () => {
  test('downloads under the name Sales uploaded, as an .xlsx', () => {
    assert.equal(originalWorkbookFileName({ workbookName: 'Rivoli PI Final.xlsx', versionNumber: 1 }, '0526'), 'Rivoli PI Final.xlsx')
    assert.equal(originalWorkbookFileName({ workbookName: 'Rivoli PI', versionNumber: 1 }, '0526'), 'Rivoli PI.xlsx')
  })

  test('a record with no kept name gets a readable one — never the storage uuid', () => {
    assert.equal(originalWorkbookFileName({ workbookName: null, versionNumber: 2 }, '0526'), 'Order 0526 PI V2.xlsx')
    assert.equal(originalWorkbookFileName({ workbookName: '  ', versionNumber: 1 }, null), 'PI V1.xlsx')
  })

  test('a name with path characters is made safe', () => {
    assert.equal(originalWorkbookFileName({ workbookName: '../x/PI:1.xlsx', versionNumber: 1 }, null), '.._x_PI_1.xlsx')
  })

  test('the Order page signs the stored workbook itself, under that name', () => {
    const page = readFileSync('src/app/orders/[id]/page.tsx', 'utf8')
    assert.ok(page.includes("mode === 'download' ? { download: originalWorkbookFileName(version, order?.display_number ?? null) } : undefined"))
  })
})
