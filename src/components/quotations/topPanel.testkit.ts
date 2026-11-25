// Shared by the properties panel's and the floating bar's tests: a quotation, the panel and the bar with every prop filled in, and a fake database that
// answers nothing, so the Status, Lead and Senior rows draw nothing unless a test hands in its own. (Not a test file: the runner only takes *.test.*.)
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'
import { PropsPanel } from './PropsPanel'
import { ActionDock } from './ActionDock'

// next/link's link observer reads `self`, which the jsdom harness does not define.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') (globalThis as { self?: unknown }).self = globalThis

export const quote = (o: Partial<Quotation> = {}) =>
  ({ id: 'q1', quote_no: 'QT-1', status: 'draft' as QuotationStatus, may_edit: true, pi: null, price: null, share_token: null, events: [], ...o }) as Quotation

export type PanelOver = Partial<Parameters<typeof PropsPanel>[0]>
export type DockOver = Partial<Parameters<typeof ActionDock>[0]>

const silent = { rpc: async () => ({ data: null, error: { message: 'not answered in this test' } }) }
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })

export const panel = (base: Quotation, over: PanelOver = {}, supabase: unknown = silent) =>
  createElement(QueryClientProvider, { client: client() },
    createElement(PropsPanel, { supabase: supabase as never, base, dirty: false, canConfirm: false, piProblems: [], onChanged: () => {}, ...over }))

export const dock = (base: Quotation, over: DockOver = {}) =>
  createElement(ActionDock, {
    id: 'q1', base, dirty: false, busy: false, grand: 2_596_714, taxable: 2_200_605, pieces: 230, lineCount: 3, canConfirm: false, piProblems: [], piStage: null,
    onConfirm: () => {}, phone: '98290 12345', waText: 'Hello', copied: false, onCopy: () => {}, onExcel: () => {}, onShare: () => {}, ...over,
  })
