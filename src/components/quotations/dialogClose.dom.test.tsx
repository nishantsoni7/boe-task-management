// New quotation's Cancel and × did nothing on a page opened straight at ?new=1 (owner, 18 Nov 2026), and no
// quotation dialog answered Escape. Runs the real dialogs in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NewQuotation } from './ListScreen'
import { CropDialog } from './CropDialog'

function newQuotation() {
  let closed = 0
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } } })
  const ui = mount(createElement(QueryClientProvider, { client: qc },
    createElement(NewQuotation, { onClose: () => { closed++ }, onCreated: () => {}, create: async () => 'id' })))
  return { ui, closed: () => closed }
}

describe('New quotation closes', () => {
  test('Cancel and × close it, even with a client typed in', () => {
    const { ui, closed } = newQuotation()
    ui.type(ui.one<HTMLInputElement>('input'), 'Babylon Resort')
    ui.click(ui.button('Cancel'))
    ui.click(ui.one('button[aria-label="Close"]'))
    assert.equal(closed(), 2)
    ui.unmount()
  })
  test('Escape closes an empty one, and keeps one with a client typed in (like a tap outside)', () => {
    const empty = newQuotation()
    empty.ui.press('Escape')
    assert.equal(empty.closed(), 1)
    empty.ui.unmount()
    const typed = newQuotation()
    typed.ui.type(typed.ui.one<HTMLInputElement>('input'), 'Babylon Resort')
    typed.ui.press('Escape')
    assert.equal(typed.closed(), 0)
    typed.ui.unmount()
  })
  test('closing takes ?new=1 out of the address with the History API, not router.replace', () => {
    const list = readFileSync('src/components/quotations/ListScreen.tsx', 'utf8')
    assert.match(list, /const closeNew = \(\) => window\.history\.replaceState\(null, '', '\/quotations'\)/)
    assert.ok(!list.includes("router.replace('/quotations')"))
  })
})

describe('the other quotation dialogs answer Escape', () => {
  test('Crop & rotate closes on Escape', () => {
    let closed = 0
    // The dialog loads the picture with new Image(); the harness does not install it globally.
    Object.defineProperty(globalThis, 'Image', { value: window.Image, configurable: true, writable: true })
    const ui = mount(createElement(CropDialog, { src: 'data:image/png;base64,', onClose: () => { closed++ }, onUse: () => {} }))
    ui.press('Escape')
    assert.equal(closed, 1)
    ui.unmount()
  })
  test('every quotation dialog uses the shared dialog keyboard hook', () => {
    for (const f of ['ListScreen', 'ImportDialog', 'StudioDialog', 'CropDialog', 'MyDetails', 'VersionsCard']) {
      const src = readFileSync(`src/components/quotations/${f}.tsx`, 'utf8')
      assert.match(src, /const dialogRef = useDialogFocus</, f)
      assert.match(src, /ref=\{dialogRef\} tabIndex=\{-1\} className=\{s\.modal\}/, f)
    }
  })
})

describe('deep-link parameters leave the address with the History API', () => {
  test('finance new request, received payment, deleted order, saved product', () => {
    const files = ['src/app/finance/page.tsx', 'src/app/finance/received/ReceivedPaymentsView.tsx', 'src/app/orders/all/page.tsx', 'src/components/inventory/ProductDetailScreen.tsx']
    for (const f of files) assert.match(readFileSync(f, 'utf8'), /window\.history\.replaceState\(null, ''/, f)
  })
})
