import type { PriceHint } from './api'

/** A price hint with its suggestion points removed: the history only (last ordered / quoted), for someone who does not see
 *  suggested prices (Control Center › Sales › Quotation price approval, 18 Nov 2026). */
export const historyOnly = (h: PriceHint | undefined): PriceHint | undefined => (h ? { name: h.name, ordered: h.ordered, quoted: h.quoted } : h)
