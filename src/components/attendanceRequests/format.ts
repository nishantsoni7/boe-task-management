import { istDateOf, istClockOf } from '@/lib/istDate'
import type { RequestStatus } from '@/lib/attendance/requests'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "12 Oct" from a YYYY-MM-DD business date. */
export function formatShortDate(date: string): string {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]}`
}

/** "12 Oct, 09:41" — an instant as IST wall-clock, whatever the device's zone. */
export function formatIstDateTime(instant: string): string {
  return `${formatShortDate(istDateOf(instant))}, ${istClockOf(instant)}`
}

export function statusTone(status: RequestStatus): { bg: string; fg: string } {
  switch (status) {
    case 'approved':  return { bg: 'rgba(16,185,129,0.12)', fg: '#059669' }
    case 'rejected':  return { bg: 'rgba(239,68,68,0.10)',  fg: '#DC2626' }
    case 'cancelled': return { bg: 'rgba(107,114,128,0.12)', fg: '#4B5563' }
    default:          return { bg: 'rgba(232,160,48,0.15)', fg: '#B45309' }
  }
}
