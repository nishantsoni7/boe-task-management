/**
 * Repository check: one quantity, one authority, on every surface that shows it.
 *
 * Why a source check
 * ------------------
 * These are component behaviours — which value a handler derives from, whether
 * a response is checked, what happens to a typed value when a save fails.
 * Exercising them needs a live Supabase, a session and a rendered page; the
 * invariants are about the ORDER of operations, which is exactly what stays
 * green in every other test while an edit quietly reverts.
 *
 * The defect these lock down
 * --------------------------
 * A quantity edit "sometimes" survived and sometimes snapped back. Two
 * independent mechanisms:
 *
 *  1. ADMIN. On blur the page fired a PATCH, ignored the response, cleared the
 *     typed value, and only then re-fetched the whole inquiry. A rejected save
 *     therefore reverted the box silently, and even a successful one showed the
 *     pre-edit number for the length of the round-trip because the pending
 *     value was gone before the fresh data arrived. Nothing flushed quantity
 *     before Preview or Generate either — handleSaveItemEdits writes only the
 *     rate and the note — so the PDF could be built from the old quantity while
 *     the screen showed the new one.
 *  2. CUSTOMER. The project list derived each change from the `cart` captured
 *     by the current render, so two taps before a re-render both started from
 *     the same snapshot and one was lost.
 *
 * Run:
 *   npx tsx --test src/app/api/showroom/inquiry/quantityAuthority.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const ADMIN_PAGE   = read('src/app/showroom-admin/inquiry/[inquiryId]/page.tsx')
const LIST_PAGE    = read('src/app/showroom/project-list/page.tsx')
const ITEM_ROUTE   = read('src/app/api/showroom/inquiry-items/[itemId]/route.ts')

/** The body of a top-level `const name = ...` up to the next top-level const. */
function block(source: string, declaration: string): string {
  const start = source.indexOf(declaration)
  assert.ok(start > -1, `${declaration} must exist`)
  const rest = source.slice(start + declaration.length)
  const end = rest.search(/\n {2}const [a-zA-Z]/)
  return end === -1 ? rest : rest.slice(0, end)
}

describe('admin — a quantity is saved before it is believed', () => {
  const saveQuantity = block(ADMIN_PAGE, 'const saveQuantity = async')

  test('the PATCH response is checked', () => {
    // The whole bug in one line: the old code awaited the fetch and never
    // looked at what came back.
    assert.match(saveQuantity, /if \(!res\.ok\)/)
  })

  test('a failed save keeps the typed value and reports the failure', () => {
    assert.match(saveQuantity, /setQtyError\(/)
    assert.match(saveQuantity, /return false/)
    // `clearPending` must not run on the failure path — it appears once, after
    // the confirmation.
    const failureBranch = saveQuantity.slice(
      saveQuantity.indexOf('if (!res.ok)'),
      saveQuantity.indexOf('const { item: saved }'),
    )
    assert.equal(failureBranch.includes('clearPending'), false)
  })

  test('state takes the quantity the SERVER confirmed, not the one typed', () => {
    assert.match(saveQuantity, /const \{ item: saved \}/)
    assert.match(saveQuantity, /applyConfirmedQuantity\([\s\S]*?saved\.quantity/)
  })

  test('the typed value is cleared only after the confirmation is applied', () => {
    // Clearing first is what made the input fall back to the pre-edit snapshot.
    const applyAt = saveQuantity.indexOf('applyConfirmedQuantity')
    const clearAt = saveQuantity.indexOf('clearPending')
    assert.ok(applyAt > -1 && clearAt > applyAt, 'clearPending must follow the state update')
  })

  test('a quantity change no longer re-fetches the whole inquiry', () => {
    // The PATCH already returns the saved row; the extra round-trip was the
    // window in which the old value was on screen.
    assert.equal(saveQuantity.includes('reloadInquiry'), false)
  })
})

describe('admin — an invalid entry resolves to its own last value', () => {
  const onBlur = block(ADMIN_PAGE, 'const handleQtyBlur = async')

  test('blur parses through the shared rule rather than a bare parseInt', () => {
    assert.match(onBlur, /parseQuantityInput\(pendingQty\[item\.id\], item\.quantity\)/)
  })

  test('an unchanged or invalid entry is dropped, never written', () => {
    assert.match(onBlur, /if \(!parsed\.valid \|\| !parsed\.changed\)/)
    assert.match(onBlur, /clearPending\(item\.id\)/)
  })

  test('only a valid change reaches the server', () => {
    assert.match(onBlur, /saveQuantity\(item\.id, parsed\.value\)/)
  })
})

describe('admin — the document cannot disagree with the screen', () => {
  test('Preview flushes pending quantities first, and stops if that fails', () => {
    const preview = block(ADMIN_PAGE, 'const handlePreviewQuotation = async')
    assert.match(preview, /if \(!\(await flushPendingQuantities\(\)\)\)/)
    // Preview reads the DATABASE, so the flush has to precede the request.
    assert.ok(preview.indexOf('flushPendingQuantities') < preview.indexOf('/api/showroom/quotation/'))
  })

  test('Generate flushes pending quantities before building the payload', () => {
    const download = block(ADMIN_PAGE, 'const handleDownloadQuotation = async')
    assert.match(download, /if \(!\(await flushPendingQuantities\(\)\)\)/)
    assert.ok(download.indexOf('flushPendingQuantities') < download.indexOf('const payload'))
  })

  test('the payload sends the quantity the screen is showing', () => {
    assert.match(ADMIN_PAGE, /quantity:\s*effectiveQuantity\(i\.quantity, pendingQty\[i\.id\]\)/)
  })

  test('an invalid quantity blocks generation instead of being sent', () => {
    const flush = block(ADMIN_PAGE, 'const flushPendingQuantities = async')
    assert.match(flush, /hasInvalidQuantity\(/)
    assert.match(flush, /return false/)
  })
})

describe('admin — money follows the number in the box', () => {
  test('the subtotal uses the effective quantity', () => {
    assert.match(
      ADMIN_PAGE,
      /effectiveRate \* effectiveQuantity\(i\.quantity, pendingQty\[i\.id\]\)/,
    )
  })

  test('each line total uses the effective quantity', () => {
    assert.match(ADMIN_PAGE, /const lineQty\s*= effectiveQuantity\(item\.quantity, pendingQty\[item\.id\]\)/)
    assert.match(ADMIN_PAGE, /const lineTotal = effectiveRate \* lineQty/)
  })

  test('no money figure reads the raw snapshot quantity any more', () => {
    for (const stale of ['* i.quantity', '* item.quantity']) {
      assert.equal(ADMIN_PAGE.includes(stale), false, `stale quantity in a total: ${stale}`)
    }
  })
})

describe('admin — a failed refresh is not mistaken for a rejected save', () => {
  test('reloadInquiry reports failure instead of silently keeping stale state', () => {
    const reload = block(ADMIN_PAGE, 'const reloadInquiry = async')
    assert.match(reload, /return true/)
    assert.match(reload, /setSaveError\(/)
    assert.match(reload, /return false/)
  })
})

describe('customer — each change builds on the last committed value', () => {
  test('the list derives from the ref, never from the render’s cart', () => {
    assert.match(LIST_PAGE, /changeQuantity\(cartRef\.current, productId, delta\)/)
    assert.match(LIST_PAGE, /removeFromCart\(cartRef\.current, productId\)/)
    assert.equal(/changeQuantity\(cart,/.test(LIST_PAGE), false, 'stale render snapshot')
    assert.equal(/removeFromCart\(cart,/.test(LIST_PAGE), false, 'stale render snapshot')
  })

  test('there is exactly one write path, and it moves ref, state and storage together', () => {
    const commit = block(LIST_PAGE, 'const commitCart =')
    assert.match(commit, /cartRef\.current = next/)
    assert.match(commit, /setCart\(next\)/)
    assert.match(commit, /localStorage\.setItem\('boe_cart', JSON\.stringify\(next\)\)/)
    // No other place may write the cart key.
    assert.equal((LIST_PAGE.match(/setItem\('boe_cart'/g) ?? []).length, 1)
  })
})

describe('the persistence endpoint', () => {
  test('validates the quantity rather than trusting the client', () => {
    assert.match(ITEM_ROUTE, /quantity must be a positive integer/)
    assert.match(ITEM_ROUTE, /Number\.isInteger\(quantity\) \|\| quantity < 1/)
  })

  test('targets the resolved item and returns the saved row', () => {
    assert.match(ITEM_ROUTE, /\.eq\('id', item!\.id\)/)
    assert.match(ITEM_ROUTE, /\.select\(\)[\s\S]{0,40}\.single\(\)/)
    assert.match(ITEM_ROUTE, /NextResponse\.json\(\{ item: data \}\)/)
  })

  test('still refuses a caller who does not own the inquiry', () => {
    assert.match(ITEM_ROUTE, /callerRole !== 'admin' && inq\.salesperson_id !== callerId/)
    assert.match(ITEM_ROUTE, /status: 403/)
  })
})
