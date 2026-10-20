// ── The ERP line-items sheet ──────────────────────────────────────────────────
//
// The production team uploads this exact workbook into their ERP, so the header
// row is the ERP's own (C:\BOE New\Process\line_items_template.xlsx, 23 columns,
// in that order) and must never be reworded or reordered. We fill what the Order
// knows and leave the rest empty. Size, material and customization all travel in
// the ONE Description column (owner, 2026-10-20); the three dimension columns
// stay empty on purpose.

import { safeFileName } from '@/lib/tasks/taskGallery'
import { styleErpWorkbook } from './erpWorkbookStyles'

export const ERP_LINE_ITEMS_HEADERS = [
  'Item Type', 'Inventory Code', 'Item Name', 'Description', 'Quantity', 'Unit Price',
  'Dimension Type', 'Length inches', 'Width inches', 'Height inches',
  'Remark Metal', 'Remark Wood',
  'Requires Wood Approval', 'Requires Metal Approval', 'Requires Stone Approval',
  'Requires Cord Approval', 'Requires Fabric Approval', 'Requires Natural Cane',
  'PO Allowed - Wood', 'PO Allowed - Metal', 'PO Allowed - Stone', 'PO Allowed - Fabric', 'PO Allowed - Cord',
] as const

export const ERP_LINE_ITEMS_SHEET_NAME = 'Sheet 1 - line_items_template'

export type ErpProduct = {
  orderProductCode?: string | null
  productName: string | null
  dimensions: string | null
  material: string | null
  customization: string | null
  quantity: number | null
  costPerPiece: number | null
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

/** Size, material and customization as one sentence-like cell; empty parts are left out. */
export function erpDescription(p: Pick<ErpProduct, 'dimensions' | 'material' | 'customization'>): string {
  return [
    ['Dimensions', p.dimensions],
    ['Material', p.material],
    ['Customization', p.customization],
  ]
    .map(([label, value]) => (clean(value) ? `${label}: ${clean(value)}` : ''))
    .filter(Boolean)
    .join('\n')
}

/** Header row, then one row per product. Unknown cells are '' (empty), never guessed. */
export function erpLineItemRows(products: readonly ErpProduct[]): (string | number)[][] {
  const width = ERP_LINE_ITEMS_HEADERS.length
  const rows = products.map(p => {
    const row: (string | number)[] = new Array(width).fill('')
    // Inventory Code stays blank (owner, 2026-10-20)
    row[2] = clean(p.productName)
    row[3] = erpDescription(p)
    row[4] = p.quantity ?? ''
    row[5] = p.costPerPiece ?? ''
    return row
  })
  return [[...ERP_LINE_ITEMS_HEADERS], ...rows]
}

/** "524 ERP line items.xlsx" */
export function erpLineItemsFileName(orderNumber: string | null | undefined, client: string | null | undefined): string {
  const lead = (orderNumber ?? '').trim() || (client ?? '').trim() || 'Order'
  return `${safeFileName(lead.slice(0, 60), 'Order')} ERP line items.xlsx`
}

/** The .xlsx bytes. `xlsx` is loaded on demand so the Order page does not carry it. */
export async function buildErpLineItemsWorkbook(products: readonly ErpProduct[]): Promise<Uint8Array> {
  const XLSX = await import('xlsx')
  const sheet = XLSX.utils.aoa_to_sheet(erpLineItemRows(products))
  sheet['!cols'] = ERP_LINE_ITEMS_HEADERS.map((h, i) => ({ wch: i === 3 ? 60 : Math.max(12, h.length + 2) }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, ERP_LINE_ITEMS_SHEET_NAME)
  return styleErpWorkbook(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer))
}
