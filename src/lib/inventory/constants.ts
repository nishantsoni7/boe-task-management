// Inventory — the closed vocabularies, shared by the form, the lists, the share message and the tests.
// The slugs are what the database stores (and CHECKs); the labels are what people read.
// Changing a slug is a migration.

export const INVENTORY_MODULE_KEY = 'inventory'
export const INVENTORY_BUCKET = 'inventory-images'
export const MAX_IMAGES = 8

export const CONDITIONS = [
  { value: 'new', label: 'New', hint: 'Brand new, never used' },
  { value: 'refurbished', label: 'Refurbished', hint: 'Restored and ready to sell' },
  { value: 'needs_repair', label: 'Needs repair', hint: 'Sold as is, or repaired before dispatch' },
  { value: 'antique', label: 'Antique / old', hint: 'Old piece, may show age' },
] as const
export type Condition = (typeof CONDITIONS)[number]['value']

// The production pipeline, in the order a piece travels. `days` is only the number offered in the form
// when this stage is picked; the manager overrides it for the actual piece.
export const STAGES = [
  { value: 'raw', label: 'Raw', short: 'Raw', days: 30, hint: 'Frame or timber, not yet worked' },
  { value: 'in_production', label: 'In production', short: 'In production', days: 21, hint: 'Being made' },
  { value: 'finishing', label: 'Finishing', short: 'Finishing', days: 10, hint: 'Polish, paint or lacquer' },
  { value: 'awaiting_upholstery', label: 'Awaiting upholstery', short: 'Upholstery', days: 7, hint: 'Finished, upholstery pending' },
  { value: 'under_repair', label: 'Under repair', short: 'Repair', days: 14, hint: 'Being repaired or restored' },
  { value: 'ready', label: 'Ready to ship', short: 'Ready', days: 0, hint: 'Can be dispatched now' },
] as const
export type Stage = (typeof STAGES)[number]['value']

export const BOOKING_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const
export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export type InventoryImage = { path: string; position: number }

export type InventoryItem = {
  id: string
  product_code: string
  name: string
  category: string | null
  size_text: string
  material: string
  description: string | null
  price: number
  condition: Condition
  stage: Stage
  expected_ready_on: string | null
  qty_total: number
  qty_reserved: number
  qty_sold: number
  qty_available: number
  created_at: string
  updated_at: string
  inventory_images: InventoryImage[]
}

export type Booking = {
  id: string
  item_id: string
  product_code: string
  item_name: string
  price: number
  thumb_path: string | null
  qty: number
  customer_name: string
  customer_phone: string | null
  note: string | null
  status: BookingStatus
  requested_by: string
  requester_name: string
  requested_at: string
  decided_by: string | null
  decider_name: string | null
  decided_at: string | null
  decision_note: string | null
  item_available: number
}

export type InventoryAccess = { create: boolean; edit: boolean; delete: boolean; approve: boolean }

export type HistoryEntry = {
  id: string
  action: 'created' | 'updated' | 'deleted' | 'requested' | 'confirmed' | 'rejected' | 'cancelled' | 'reversed'
  detail: Record<string, unknown>
  at: string
  actor: string | null
}

export const conditionLabel = (v: string) => CONDITIONS.find(c => c.value === v)?.label ?? v
export const stageLabel = (v: string) => STAGES.find(s => s.value === v)?.label ?? v
export const stageIndex = (v: string) => STAGES.findIndex(s => s.value === v)
