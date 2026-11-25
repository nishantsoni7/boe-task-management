// Shared by the top panel's tests: a quotation, the panel with every prop filled in, and a fake database that answers nothing, so the Lead and
// Senior rows draw nothing unless a test hands in its own. (Not a test file: the runner only takes *.test.*.)
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Quotation, QuotationStatus } from '@/lib/quotations/api'
import { TopPanel } from './TopPanel'

// next/link's link observer reads `self`, which the jsdom harness does not define.
if (typeof (globalThis as { self?: unknown }).self === 'undefined') (globalThis as { self?: unknown }).self = globalThis

export const quote = (o: Partial<Quotation> = {}) =>
  ({ id: 'q1', quote_no: 'QT-1', status: 'draft' as QuotationStatus, may_edit: true, pi: null, price: null, share_token: null, events: [], ...o }) as Quotation

export type PanelOver = Partial<Parameters<typeof TopPanel>[0]>

const silent = { rpc: async () => ({ data: null, error: { message: 'not answered in this test' } }) }

export const panel = (base: Quotation, over: PanelOver = {}, supabase: unknown = silent) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) },
    createElement(TopPanel, {
      supabase: supabase as never, id: 'q1', base, dirty: false, busy: false, isAdmin: false, canConfirm: false, piProblems: [], piStage: null,
      lineCount: 3, phone: '98290 12345', waText: 'Hello', copied: false,
      lostNote: null, setLostNote: () => {}, lostReason: '', setLostReason: () => {}, onMove: () => {}, onConfirm: () => {},
      onCopy: () => {}, onExcel: () => {}, onShare: () => {}, onChanged: () => {}, ...over,
    }))
