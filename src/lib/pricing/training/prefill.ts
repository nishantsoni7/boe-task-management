// Pricing > Training: starting a case from somewhere else, "Teach this price" (Price Brain v2, phase 1 part 2; owner,
// 23 Nov 2026). From a feedback card in Price learning, or from the "Why?" popup of a suggested price on a quotation line,
// the product's details wait in this browser's localStorage (at most 10 minutes; a quotation opens Training in a new tab) and the new-case screen reads them once. Nothing is
// sent anywhere. The photo is the quotation line's own picture; the new case copies it into Training when it opens.

import { dimensionsInches } from '@/lib/pricing/features'
import type { CaseForm } from './doc'

export type Prefill = {
  name: string
  /** The size as the line writes it, e.g. "36×36×24 inches". */
  size: string | null
  material: string | null
  qty: number | null
  /** The price the person would quote, or the line's price. */
  price: number | null
  /** The note to draft the elements from ("In your words"). */
  note: string | null
  /** A public URL of the line's photo, to copy into the case. */
  photoUrl: string | null
  /** The feedback it came from: marked done once the case is saved. */
  feedbackId: string | null
  quoteNo: string | null
}

const KEY = 'boe.pricing.training.prefill'
const MAX_AGE_MS = 10 * 60_000

/** Keeps the details for the new-case screen. False when the browser will not store them (a private window). */
export function stashPrefill(p: Prefill, store: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  try { if (!store) return false; store.setItem(KEY, JSON.stringify({ ...p, at: Date.now() })); return true } catch { return false }
}

/** Forgets the details once the new-case screen has them (a second visit to New case starts empty). */
export function clearPrefill(store: Pick<Storage, 'removeItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): void {
  try { store?.removeItem(KEY) } catch { /* nothing stored, nothing to forget */ }
}

/** The details, or null when there are none, they are old, or they are not ours. Reading does not remove them: clearPrefill does. */
export function takePrefill(store: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage, now = Date.now()): Prefill | null {
  try {
    if (!store) return null
    const raw = store.getItem(KEY)
    if (!raw) return null
    const o = JSON.parse(raw) as Record<string, unknown>
    if (typeof o.at !== 'number' || now - o.at > MAX_AGE_MS || typeof o.name !== 'string') return null
    const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
    const url = s(o.photoUrl, 600)
    return {
      name: o.name.trim().slice(0, 160), size: s(o.size, 160), material: s(o.material, 160), qty: n(o.qty), price: n(o.price),
      note: s(o.note, 4000), photoUrl: url && /^https:\/\//.test(url) ? url : null, feedbackId: s(o.feedbackId, 60), quoteNo: s(o.quoteNo, 40),
    }
  } catch { return null }
}

const two = (x: number) => String(Math.round(x * 100) / 100)

/** Width, depth and height in inches from the size a line writes; blank when it cannot be read as at least two numbers. */
export function sizeFields(text: string | null): Pick<CaseForm, 'width_in' | 'depth_in' | 'height_in'> {
  const d = dimensionsInches(text)
  if (!d || d.length < 2 || d.some(x => !(x > 0 && x < 1000))) return { width_in: '', depth_in: '', height_in: '' }
  return { width_in: two(d[0]), depth_in: two(d[1]), height_in: d[2] ? two(d[2]) : '' }
}

/** "Set of 2 Coffee Table" is priced for a set of two. */
export function setSize(name: string): string {
  const m = /\bset\s+of\s+(\d{1,2})\b/i.exec(name)
  const k = m ? Number(m[1]) : 0
  return k >= 2 && k <= 50 ? String(k) : ''
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === (b ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

/** The quotation line a feedback card speaks of: the same name, and the same size when two lines share a name. */
export function findLine<T extends { name: string; size_text: string | null }>(lines: readonly T[], name: string, size: string | null): T | null {
  const named = lines.filter(l => same(l.name, name))
  return named.find(l => same(l.size_text, size)) ?? named[0] ?? null
}

/** The case form a prefill starts with. */
export function prefillForm(p: Prefill): Partial<CaseForm> {
  return {
    name: p.name, ...sizeFields(p.size), per_set: setSize(p.name),
    sold_price: p.price ? String(p.price) : '',
    notes: [p.quoteNo ? `From ${p.quoteNo}${p.qty ? `, ${p.qty} pieces` : ''}.` : p.qty ? `${p.qty} pieces.` : '', p.material ? `Material: ${p.material}.` : '', p.size ? `Size as written: ${p.size}.` : '']
      .filter(Boolean).join(' ').slice(0, 2000),
  }
}
