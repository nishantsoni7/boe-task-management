// Price learning: small helpers the screens share.

import { CLIENT_TYPES, type QuotationAccess } from '@/lib/quotations/api'
import { formatDateIN } from '@/lib/quotations/math'
import { istDateOf } from '@/lib/istDate'

/** The pricing desk: Admin, or Quotations edit AND see-all (the same rule as price approval; the database decides). */
export const isDesk = (a: QuotationAccess) => a.admin || (a.edit && a.view_all)

export const CLIENT_LABEL: Record<string, string> = Object.fromEntries(CLIENT_TYPES)

/** A date as people read it, from an ISO date or a timestamp. */
export const dateIN = (v: string) => formatDateIN(v.length > 10 ? istDateOf(v) : v)

export const inNum = (n: number) => Math.round(n).toLocaleString('en-IN')

export const KIND_LABEL: Record<string, string> = {
  too_high: 'Looks too high', too_low: 'Looks too low', wrong_type: 'Wrong kind of product', misread: 'A detail was misread', other: 'Other', correction: 'Correct the logic',
}
