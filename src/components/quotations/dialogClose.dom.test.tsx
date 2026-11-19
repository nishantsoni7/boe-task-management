// New quotation's Cancel and × did nothing on a page opened straight at ?new=1 (owner, 18 Nov 2026), and no
// quotation dialog answered Escape. Runs the real dialogs in jsdom.
import { mount } from '@/lib/testing/domHarness'
import '@/lib/testing/cssModuleStub'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { LeadStep } from './LeadStep'
import { CropDialog } from './CropDialog'

const LEAD = { id: 'lead-1', lead_no: 12406, name: 'Babylon Resort', phone: '+919876543210', email: null, location: 'Hyderabad', requirement: '56 rooms', assigned_to: 'u1', holder_name: 'Mohit Sharma' }
const supabase = { rpc: async () => ({ data: { periods: {}, everyone: 1, unallotted: 0, holders: [], total: 1, rows: [LEAD] }, error: null }) }

function newQuotation() {
  let closed = 0
  const qc = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false }, mutations: { gcTime: Infinity } } })
  const ui = mount(createElement(QueryClientProvider, { client: qc },
    createElement(LeadStep, { supabase: supabase as never, userId: 'u1', canAssign: false, title: 'New quotation', action: 'Start quotation', onClose: () => { closed++ }, onPick: async () => {} })))
  return { ui, closed: () => closed }
}

describe('New quotation closes', () => {
  test('Cancel and × close it, even with a search typed in', async () => {
    const { ui, closed } = newQuotation()
    ui.type(ui.one<HTMLInputElement>('input'), 'Babylon')
    ui.click(ui.button('Cancel'))
    ui.click(ui.one('button[aria-label="Close"]'))
    assert.equal(closed(), 2)
    ui.unmount()
  })
  test('Escape closes it while no lead is chosen, and keeps it once a lead is chosen (like a tap outside)', async () => {
    const empty = newQuotation()
    empty.ui.press('Escape')
    assert.equal(empty.closed(), 1)
    empty.ui.unmount()
    const chosen = newQuotation()
    await chosen.ui.settle(); await chosen.ui.settle()
    chosen.ui.click(chosen.ui.button(/Babylon Resort/))
    await chosen.ui.settle()
    chosen.ui.press('Escape')
    assert.equal(chosen.closed(), 0)
    chosen.ui.unmount()
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
    for (const f of ['LeadStep', 'ImportDialog', 'StudioDialog', 'CropDialog', 'MyDetails', 'VersionsCard']) {
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
