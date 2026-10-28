import { firstUsablePhone, splitPhone } from '@/lib/exhibitionLeads/scan'
import type { VendorInput } from './api'

// Scanning a vendor's visiting card or name plate.
//
// A photograph is read once, on the server (/api/vendors/scan), into a VendorScanResult. Nothing here trusts that
// result: parseVendorScan keeps only text of the right shape, and applyVendorScan only ever FILLS fields the person
// has not already typed. The person still checks the form before saving, so a misread costs a correction, not a
// wrong record. The photograph itself is never stored.

export const MAX_VENDOR_SCAN_BYTES = 6 * 1024 * 1024

export type VendorScanResult = {
  company: string
  contact: string
  /** Every number found, as printed. The first usable one fills the mobile field. */
  phones: string[]
  address: string
  /** The locality in Jodhpur (Basni, Boranada …), when the address names one. */
  area: string
}

export type VendorScanApiResponse =
  | { ok: true; result: VendorScanResult }
  | { ok: false; code: 'auth' | 'not_configured' | 'rate_limited' | 'too_large' | 'unreadable' | 'failed'; error: string }

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** The model's answer, made safe: wrong types are dropped, lengths capped to what the form accepts. */
export function parseVendorScan(raw: unknown): VendorScanResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    company: text(o.company, 160),
    contact: text(o.contact_person, 120),
    phones: (Array.isArray(o.phones) ? o.phones : []).map(p => text(p, 40)).filter(Boolean).slice(0, 6),
    address: text(o.address, 500),
    area: text(o.area, 80),
  }
}

/** True when the photograph yielded nothing the form can use. */
export const vendorScanIsEmpty = (r: VendorScanResult): boolean =>
  !r.company && !r.contact && r.phones.length === 0 && !r.address

export type VendorScanField = 'company_name' | 'contact_name' | 'phone' | 'address' | 'area'

export const VENDOR_SCAN_FIELD_LABEL: Record<VendorScanField, string> = {
  company_name: 'Company name', contact_name: 'Contact person', phone: 'Mobile', address: 'Address', area: 'Area',
}

/**
 * The patch that pours the scan into the form: only fields still empty are filled, and the list says which.
 * A number the form could not save is left out rather than filled in.
 */
export function applyVendorScan(current: VendorInput, r: VendorScanResult): { patch: Partial<VendorInput>; filled: VendorScanField[] } {
  const patch: Partial<VendorInput> = {}
  const filled: VendorScanField[] = []
  if (r.company && !current.company_name.trim()) { patch.company_name = r.company; filled.push('company_name') }
  if (r.contact && !current.contact_name.trim()) { patch.contact_name = r.contact; filled.push('contact_name') }
  const phone = firstUsablePhone(r.phones)
  if (phone && !current.phone.trim()) { patch.phone = splitPhone(phone).mobile; filled.push('phone') }
  if (r.address && !current.address.trim()) { patch.address = r.address; filled.push('address') }
  if (r.area && !current.area.trim()) { patch.area = r.area; filled.push('area') }
  return { patch, filled }
}
