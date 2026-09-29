/**
 * HIDE AMOUNTS — the rule that finds a figure, the session preference, and the
 * walk that masks and restores a rendered tree.
 *
 * There is no DOM in this repository, so the walk is exercised on a small fake
 * tree that has exactly the parts applyAmountMask reads (nodeType, nodeValue,
 * childNodes, attributes). The real page is checked in a browser.
 *
 * Run:
 *   npx tsx --test src/lib/orders/amountMask.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AMOUNT_MASK,
  AMOUNTS_HIDDEN_STORAGE_KEY,
  applyAmountMask,
  hasAmount,
  maskAmounts,
  readAmountsHidden,
  writeAmountsHidden,
  type MaskMemory,
  type MaskableNode,
} from './amountMask'
import { formatInr } from '@/lib/pi/previewView'
import { formatMoney } from '@/lib/finance/piPaymentView'
import { describeMiddleman } from './piInternalDetails'

describe('every way this page prints money is found', () => {
  const printed = [
    formatInr(118000), formatInr(1234567.5), formatInr(-2500), formatInr(0),
    formatMoney('47200'), formatMoney(3500.2),
    describeMiddleman({ middleman_commission: 'yes', middleman_recipient: 'A', middleman_commission_basis: 'amount', middleman_commission_amount: 25000 }),
    'Declare an amount above ₹0 and below 40% of the grand total.',
    '₹ 4,00,000 still needed',
  ]
  for (const text of printed) {
    test(`"${text}" carries a figure and none survives masking`, () => {
      assert.ok(hasAmount(text))
      assert.ok(!/₹\s?\d/.test(maskAmounts(text)), maskAmounts(text))
    })
  }

  test('the whole figure goes: sign, grouping and paise', () => {
    assert.equal(maskAmounts(formatInr(1234567.5)), AMOUNT_MASK)
    assert.equal(maskAmounts(formatInr(-2500)), AMOUNT_MASK)
    assert.equal(maskAmounts('Yes — Site agent, ₹25,000.00'), `Yes — Site agent, ${AMOUNT_MASK}`)
  })

  test('two figures in one sentence are both masked', () => {
    assert.equal(maskAmounts('₹1,000 of ₹5,000'), `${AMOUNT_MASK} of ${AMOUNT_MASK}`)
  })

  test('labels, statuses, percentages, dates and the dash for "no figure" are left alone', () => {
    for (const keep of ['Product value', '40%', '25.42% payment is currently attached', '20 Sep 2026', '—', 'Awaiting verification', '3 payments']) {
      assert.equal(maskAmounts(keep), keep)
      assert.ok(!hasAmount(keep))
    }
  })

  test('the mask is the same width whatever it replaces', () => {
    assert.equal(maskAmounts('₹1'), maskAmounts('₹9,99,99,999.99'))
  })
})

describe('the preference is kept for the browser session and never throws', () => {
  const store = () => {
    const values = new Map<string, string>()
    return {
      values,
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => { values.set(k, v) },
      removeItem: (k: string) => { values.delete(k) },
    }
  }

  test('hidden by default, and only an explicit choice hides', () => {
    assert.equal(readAmountsHidden(store()), false)
    assert.equal(readAmountsHidden(null), false)
    const s = store(); s.setItem(AMOUNTS_HIDDEN_STORAGE_KEY, 'maybe')
    assert.equal(readAmountsHidden(s), false)
  })

  test('written on hide, removed on show, and read back on the next load', () => {
    const s = store()
    writeAmountsHidden(s, true)
    assert.equal(readAmountsHidden(s), true, 'a reload in the same session still hides')
    writeAmountsHidden(s, false)
    assert.equal(readAmountsHidden(s), false)
    assert.equal(s.values.size, 0, 'showing leaves nothing behind')
  })

  test('blocked or absent storage degrades to "not hidden" and does not throw', () => {
    const blocked = {
      getItem: () => { throw new Error('denied') },
      setItem: () => { throw new Error('denied') },
      removeItem: () => { throw new Error('denied') },
    }
    assert.equal(readAmountsHidden(blocked), false)
    assert.doesNotThrow(() => writeAmountsHidden(blocked, true))
    assert.doesNotThrow(() => writeAmountsHidden(null, true))
  })

  test('it is a session preference — sessionStorage, never localStorage or the database', () => {
    const component = readFileSync(join(process.cwd(), 'src/components/orders/AmountMask.tsx'), 'utf8')
    assert.ok(component.includes('window.sessionStorage'))
    for (const other of ['localStorage', 'supabase', 'document.cookie']) {
      assert.ok(!component.includes(other), `${other} must not hold a display preference`)
    }
  })
})

// ── A fake tree with the parts the walk reads ─────────────────────────────────

type FakeNode = MaskableNode & { attrs?: Record<string, string> }
const text = (value: string): FakeNode => ({ nodeType: 3, nodeValue: value, childNodes: [] })
const element = (tagName: string, children: FakeNode[], attrs: Record<string, string> = {}): FakeNode => ({
  nodeType: 1, nodeValue: null, childNodes: children, tagName, attrs,
  getAttribute(name) { return name in this.attrs! ? this.attrs![name] : null },
  setAttribute(name, value) { this.attrs![name] = value },
})
const memory = (): MaskMemory => new WeakMap()

describe('masking a rendered tree, and restoring it', () => {
  const build = () => {
    const price = text(formatInr(48000))
    const label = text('Grand total')
    const bar = element('div', [text('Received: 27% of the PI total')], { 'aria-label': `Advance ${formatInr(10000)} of ${formatInr(37200)}`, title: 'Awaiting Finance' })
    const root = element('main', [element('span', [label]), element('strong', [price]), bar, element('script', [text('const x = "₹1,000"')])])
    return { root, price, label, bar }
  }

  test('every figure goes — text and the attributes a screen reader would speak — and labels stay readable', () => {
    const { root, price, label, bar } = build()
    applyAmountMask(root, true, memory())
    assert.equal(price.nodeValue, AMOUNT_MASK)
    assert.equal(label.nodeValue, 'Grand total')
    assert.equal(bar.attrs!['aria-label'], `Advance ${AMOUNT_MASK} of ${AMOUNT_MASK}`)
    assert.equal(bar.attrs!.title, 'Awaiting Finance')
  })

  test('script text is not touched', () => {
    const { root } = build()
    applyAmountMask(root, true, memory())
    assert.equal((root.childNodes[3].childNodes[0] as FakeNode).nodeValue, 'const x = "₹1,000"')
  })

  test('showing again restores every figure exactly', () => {
    const { root, price, bar } = build()
    const m = memory()
    applyAmountMask(root, true, m)
    applyAmountMask(root, false, m)
    assert.equal(price.nodeValue, formatInr(48000))
    assert.equal(bar.attrs!['aria-label'], `Advance ${formatInr(10000)} of ${formatInr(37200)}`)
  })

  test('running it twice changes nothing more, so the observer cannot loop', () => {
    const { root, price } = build()
    const m = memory()
    applyAmountMask(root, true, m)
    let writes = 0
    let value = price.nodeValue
    Object.defineProperty(price, 'nodeValue', { get: () => value, set: v => { writes += 1; value = v } })
    applyAmountMask(root, true, m)
    assert.equal(writes, 0)
  })

  test('a figure React draws while hidden is masked on the next pass, and the new value is what is restored', () => {
    const { root, price } = build()
    const m = memory()
    applyAmountMask(root, true, m)
    price.nodeValue = formatInr(51000)          // React rewrote the text node
    applyAmountMask(root, true, m)
    assert.equal(price.nodeValue, AMOUNT_MASK)
    applyAmountMask(root, false, m)
    assert.equal(price.nodeValue, formatInr(51000), 'restored to the CURRENT figure, not a stale one')
  })

  test('restoring never overwrites text the page changed in the meantime', () => {
    const { root, price } = build()
    const m = memory()
    applyAmountMask(root, true, m)
    price.nodeValue = 'Not stated'
    applyAmountMask(root, false, m)
    assert.equal(price.nodeValue, 'Not stated')
  })
})

describe('the page wires it through the header and around every figure it draws', () => {
  const page = readFileSync(join(process.cwd(), 'src/app/orders/drafts/[submissionId]/page.tsx'), 'utf8').replace(/\r/g, '')

  test('a toggle sits in the header actions, next to Back', () => {
    const actions = page.slice(page.indexOf('actions={<>'), page.indexOf('</>}', page.indexOf('actions={<>')))
    assert.ok(actions.includes('<AmountsToggle hidden={amountsHidden} onChange={setAmountsHidden} />'))
    assert.ok(actions.includes('{backButton}'))
  })

  test('the region wraps the whole page AND its dialogs — payment details and the submit sequence included', () => {
    const open = page.indexOf('<AmountMaskRegion hidden={amountsHidden}>')
    const close = page.indexOf('</AmountMaskRegion>')
    assert.ok(open > 0 && close > open)
    for (const inside of ['<PiPaymentStatusCard', '<PiProductTableHead', '<PiCommercialBreakdown', '<PiSubmitConfirmModal',
      '<PiPaymentDetailsModal', '<AddPiPaymentModal', '<PiApproveOrderModal', '<PiCompletionPanel']) {
      const at = page.indexOf(inside)
      assert.ok(at > open && at < close, `${inside} is inside the masked region`)
    }
    assert.equal((page.match(/<AmountMaskRegion/g) ?? []).length, 1)
  })

  test('it is a display preference: no permission, no write, no query string', () => {
    const line = page.slice(page.indexOf('const [amountsHidden'), page.indexOf('const [amountsHidden') + 200)
    assert.ok(line.includes('useAmountsHidden()'))
    for (const banned of ['amountsHidden ?', 'amountsHidden &&']) {
      // Nothing about who may see or do anything reads the preference.
      const uses = page.split(banned).length - 1
      assert.equal(uses, 0, `${banned} would make a permission depend on a display preference`)
    }
  })

  test('the toggle is a real, named, pressed-state button', () => {
    const toggle = readFileSync(join(process.cwd(), 'src/components/orders/AmountMask.tsx'), 'utf8')
    assert.ok(toggle.includes('aria-pressed={hidden}'))
    assert.ok(toggle.includes("'Hide amounts'") && toggle.includes("'Show amounts'"))
    assert.ok(toggle.includes('type="button"'))
  })
})
