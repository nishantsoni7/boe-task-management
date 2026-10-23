import type { createClient } from '@/lib/supabase/client'
import { classifyInventoryError, InventoryRequestError } from './errors'
import type {
  Booking, BookingStatus, Condition, HistoryEntry, InventoryAccess, InventoryItem, Stage,
} from './constants'

// Thin typed wrappers over the database. There is no API route in between on purpose: every function reads
// auth.uid() itself, so the browser's own session IS the identity and nothing here holds a service credential.

type Supabase = ReturnType<typeof createClient>
type RpcResult<T> = { data: T | null; error: { message?: string; code?: string; status?: number } | null }

export const INVENTORY_KEY = ['inventory'] as const
export const itemsKey = [...INVENTORY_KEY, 'items'] as const
export const itemKey = (id: string) => [...INVENTORY_KEY, 'item', id] as const
export const accessKey = [...INVENTORY_KEY, 'access'] as const
export const pendingKey = [...INVENTORY_KEY, 'pending'] as const
export const bookingsKey = (scope: string, item?: string | null) => [...INVENTORY_KEY, 'bookings', scope, item ?? 'all'] as const

async function call<T>(run: () => PromiseLike<RpcResult<T>>): Promise<T> {
  let res: RpcResult<T>
  try {
    res = await run()
  } catch (e) {
    throw new InventoryRequestError(classifyInventoryError({ message: e instanceof Error ? e.message : 'Failed to fetch', status: 0 }))
  }
  if (res.error) throw new InventoryRequestError(classifyInventoryError(res.error))
  return res.data as T
}

const ITEM_COLUMNS = '*, inventory_images(path, position)'

export const fetchAccess = (s: Supabase) => call<InventoryAccess>(() => s.rpc('inventory_my_access'))

export const fetchItems = (s: Supabase) =>
  call<InventoryItem[]>(async () => {
    const { data, error } = await s.from('inventory_items').select(ITEM_COLUMNS)
      .order('updated_at', { ascending: false }).range(0, 4999)
    return { data: data as InventoryItem[] | null, error }
  })

export const fetchItem = (s: Supabase, id: string) =>
  call<InventoryItem | null>(async () => {
    const { data, error } = await s.from('inventory_items').select(ITEM_COLUMNS).eq('id', id).maybeSingle()
    return { data: data as InventoryItem | null, error }
  })

/** Requests waiting for a decision (for an approver: everyone's; for anyone else: their own). */
export const fetchPendingCount = (s: Supabase) =>
  call<number>(async () => {
    const { count, error } = await s.from('inventory_bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending')
    return { data: count ?? 0, error }
  })

export const fetchBookings = (s: Supabase, scope: 'mine' | 'all', opts: { statuses?: BookingStatus[]; itemId?: string | null } = {}) =>
  call<Booking[]>(() => s.rpc('inventory_bookings_list', {
    p_scope: scope, p_statuses: opts.statuses ?? null, p_item_id: opts.itemId ?? null, p_limit: 300,
  }))

export const fetchHistory = (s: Supabase, itemId: string) =>
  call<HistoryEntry[]>(() => s.rpc('inventory_item_history', { p_item_id: itemId, p_limit: 50 }))

export type ItemInput = {
  product_code: string
  name: string
  category: string
  size_text: string
  material: string
  description: string
  /** Standard price (basic packaging). */
  price: number
  /** Retail price (taxes, transportation and packaging included). */
  retail_price: number
  condition: Condition
  stage: Stage
  qty_total: number
  /** Whole days from today. Omit on an edit to leave the date alone. */
  ready_in_days?: number | null
}

export const saveItem = (s: Supabase, itemId: string | null, data: ItemInput, images: string[]) =>
  call<{ id: string; product_code: string }>(() => s.rpc('inventory_save_item', {
    p_item_id: itemId, p_data: data, p_images: images,
  }))

export const deleteItem = (s: Supabase, itemId: string) =>
  call<{ id: string }>(() => s.rpc('inventory_delete_item', { p_item_id: itemId }))

export type BookingInput = {
  requestId: string
  itemId: string
  qty: number
  customerName: string
  customerPhone: string
  note: string
  confirmNow?: boolean
}

export const requestBooking = (s: Supabase, b: BookingInput) =>
  call<{ id: string; status: BookingStatus; replayed: boolean }>(() => s.rpc('inventory_request_booking', {
    p_request_id: b.requestId, p_item_id: b.itemId, p_qty: b.qty, p_customer_name: b.customerName,
    p_customer_phone: b.customerPhone || null, p_note: b.note || null, p_confirm_now: b.confirmNow ?? false,
  }))

export const decideBooking = (s: Supabase, bookingId: string, decision: 'confirm' | 'reject', opts: { qty?: number | null; note?: string } = {}) =>
  call<{ id: string; status: BookingStatus }>(() => s.rpc('inventory_decide_booking', {
    p_booking_id: bookingId, p_decision: decision, p_qty: opts.qty ?? null, p_note: opts.note?.trim() || null,
  }))

export const cancelBooking = (s: Supabase, bookingId: string, note?: string) =>
  call<{ id: string; status: BookingStatus }>(() => s.rpc('inventory_cancel_booking', {
    p_booking_id: bookingId, p_note: note?.trim() || null,
  }))
