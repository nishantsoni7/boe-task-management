// Price learning, piece 1: a batch while a person checks it. These are the pure steps between "files were read" and
// "the batch is saved": which PIs will be learned and which left out (and why), the order facts of each PI, the lines
// the blind test prices, and the document the database function saves. The page holds the state; this file never does.

import type { TestLine } from './blindTest'
import type { PiFile } from './piFile'
import { orderFacts, sameProject, type OrderFacts, type PiLine } from './readPi'

export type ReviewLine = { line: PiLine; keep: boolean }
export type SeenBefore = { file_hash: string; content_print: string; batch_no: number; left_out: boolean; reason: string | null }
export type DateSource = 'file' | 'saved' | 'typed'
export type ReviewPi = {
  id: string
  file: PiFile
  /** Learn this PI. False means left out, with the reason in `leftOutReason`. */
  learn: boolean
  leftOutReason: string | null
  /** Already seen in an earlier batch: nothing to save for it. */
  seen: SeenBefore | null
  /** ISO date of the PI. */
  date: string
  dateSource: DateSource
  clientType: string | null
  lines: ReviewLine[]
}

export const BATCH_FILE_MAX = 25
const DATE_OK = /^\d{4}-\d{2}-\d{2}$/
export const validDate = (d: string) => DATE_OK.test(d) && d >= '2015-01-01' && d <= new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)

export function initialReview(files: readonly PiFile[], seen: readonly SeenBefore[], clientType: string | null): ReviewPi[] {
  const pis: ReviewPi[] = files.map((file, i) => {
    const before = file.fileHash ? seen.find(s => s.file_hash === file.fileHash || (file.reading.lines.length > 0 && s.content_print === file.contentPrint)) ?? null : null
    const verdict = file.verdict
    const twice = files.slice(0, i).some(x => x.fileHash && (x.fileHash === file.fileHash || (x.reading.lines.length > 0 && x.contentPrint === file.contentPrint)))
    const reason = before
      ? `Already ${before.left_out ? 'seen and left out' : 'learned'} in batch ${before.batch_no}${before.left_out && before.reason ? `: ${before.reason}` : ''}`
      : twice ? 'The same PI is in this batch twice'
      : verdict.status === 'left_out' ? verdict.reasons[0] : null
    return {
      id: `pi${i}`, file, learn: reason === null, leftOutReason: reason, seen: before,
      date: file.reading.piDate ?? file.savedDate, dateSource: file.reading.piDate ? 'file' : 'saved', clientType,
      lines: file.reading.lines.map(line => ({ line, keep: !line.sample })),
    }
  })
  // Two PIs of one project: the older one is a revision, so only the later one is learned.
  const live = pis.filter(p => p.learn)
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j]
    if (!a.learn || !b.learn || !sameProject(kept(a).map(l => l.line), kept(b).map(l => l.line))) continue
    const older = a.date < b.date || (a.date === b.date && a.id < b.id) ? a : b
    older.learn = false
    older.leftOutReason = 'An older version of the same project: the later PI is learned'
  }
  return pis
}

export const kept = (p: ReviewPi) => p.lines.filter(l => l.keep)
/** A PI is learned only when it is chosen and at least one line is ticked. */
export const learned = (p: ReviewPi) => p.learn && kept(p).length > 0
export const factsOf = (p: ReviewPi): OrderFacts => orderFacts(kept(p).map(l => l.line), p.file.reading.footer.discount)

export type BatchCounts = { files: number; learn: number; check: number; leftOut: number; seen: number }
export function countsOf(pis: readonly ReviewPi[]): BatchCounts {
  const learn = pis.filter(learned)
  return {
    files: pis.length, learn: learn.length, seen: pis.filter(p => p.seen).length,
    leftOut: pis.length - learn.length,
    check: learn.filter(p => p.file.verdict.status === 'check').length,
  }
}

/** What stops "Test blind, then learn": nothing to learn, or a PI with no usable date. */
export function blockers(pis: readonly ReviewPi[]): string[] {
  const out: string[] = []
  if (pis.length > BATCH_FILE_MAX) out.push(`A batch holds ${BATCH_FILE_MAX} files at most.`)
  const live = pis.filter(learned)
  if (live.length === 0) out.push('No PI is ready to learn.')
  const noDate = live.filter(p => !validDate(p.date)).length
  if (noDate) out.push(`${noDate} PI${noDate === 1 ? ' needs' : 's need'} a date.`)
  return out
}

/** The lines the blind test prices: the ticked lines of the PIs that will be learned. */
export function testLinesOf(pis: readonly ReviewPi[]): TestLine[] {
  return pis.flatMap((p, pi) => (learned(p) ? kept(p).map(({ line }) => ({
    pi, name: line.name, size: line.size, material: line.material, customization: line.customization, qty: line.qty, price: line.price, date: p.date, clientType: p.clientType,
  })) : []))
}

export type Score = { avg_miss: number | null; hit_rate: number | null; priced: number; unpriced: number }

/** The document pricing_learning_save takes. Files that could not be read at all, and files already seen, are not saved. */
export function buildSaveDoc(pis: readonly ReviewPi[], score: Score, clientType: string | null, note: string | null) {
  // The database keeps each file and each set of lines once, so a copy inside this batch is dropped here.
  const taken = new Set<string>()
  const once = (p: ReviewPi) => {
    if (taken.has(p.file.fileHash) || taken.has(p.file.contentPrint)) return false
    taken.add(p.file.fileHash); taken.add(p.file.contentPrint)
    return true
  }
  return {
    client_type: clientType, note, score,
    pis: pis.filter(p => !p.seen && p.file.fileHash && p.file.reading.lines.length > 0 && validDate(p.date)).filter(once).map(p => {
      const live = learned(p)
      const f = factsOf(p)
      return {
        label: p.file.label, file_hash: p.file.fileHash, content_print: p.file.contentPrint, pi_date: p.date, date_source: p.dateSource, client_type: p.clientType,
        pieces: f.pieces, designs: f.designs, subtotal: f.subtotal, discount: f.discount, value_before_gst: f.valueBeforeGst,
        left_out: !live, left_out_reason: live ? null : p.leftOutReason ?? 'No line is ticked',
        lines: p.lines.map(({ line, keep }) => ({
          name: line.name.slice(0, 240), size: line.size.slice(0, 160), material: line.material.slice(0, 200), customization: line.customization.slice(0, 600),
          qty: line.qty, price: line.price, derived: line.flags.includes('price_derived') || line.flags.includes('qty_derived'),
          left_out: !keep, left_out_reason: keep ? null : line.sample ? 'A sample price' : 'Left out while checking',
        })),
      }
    }),
  }
}
