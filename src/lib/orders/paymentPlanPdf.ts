// DRAWING THE PAYMENT PLAN PDF. Node only (pdfkit), like confirmedPdfRender.
// It decides nothing: the model comes from paymentPlanSheet.ts. Rupee signs are
// written "Rs." because the standard PDF font has no ₹ (toPdfText).

import PDFDocument from 'pdfkit'

import { toPdfText } from './confirmedPdf'
import { CLIENT_PDF_DATE } from './confirmedPdfRender'
import type { PaymentPlanSheet, SheetCell, SheetColumn } from './paymentPlanSheet'

const RED = '#BC4B35'
const DARK = '#1F2937'
const GRAY = '#6B7280'
const BORDER = '#E5E7EB'
const MARGIN = 36
const PAGE_W = 595.28
const PAGE_H = 841.89
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = PAGE_H - 48

function formatCell(cell: SheetCell, kind: SheetColumn['kind']): string {
  if (cell === null || cell === '') return ''
  if (typeof cell === 'string') return cell
  if (kind === 'money') return `Rs. ${cell.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return cell.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

const money = (v: number) => formatCell(v, 'money')

export async function renderPaymentPlanPdf(sheet: PaymentPlanSheet, logo?: Uint8Array | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 },
      info: {
        Title: toPdfText(sheet.title),
        Author: 'Best of Exports',
        Creator: 'BOE Task Management',
        Producer: 'BOE Task Management',
        CreationDate: CLIENT_PDF_DATE,
        ModDate: CLIENT_PDF_DATE,
      },
    })
    const chunks: Buffer[] = []
    doc.on('data', (c: Buffer) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    let y = MARGIN
    const ensure = (height: number) => {
      if (y + height > BOTTOM) {
        doc.addPage({ size: 'A4', margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 } })
        y = MARGIN
      }
    }
    const text = (s: string, x: number, width: number, opts: { size?: number; color?: string; bold?: boolean; align?: 'left' | 'right' } = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 9).fillColor(opts.color ?? DARK)
        .text(toPdfText(s), x, y, { width, align: opts.align ?? 'left', lineBreak: false, ellipsis: true })
    }

    try {
      if (logo) {
        try { doc.image(Buffer.from(logo), MARGIN, y, { height: 28 }) } catch { /* the document does not need its logo */ }
      }
      y += 38
      text(sheet.title, MARGIN, CONTENT_W, { size: 16, bold: true, color: RED })
      y += 26
      for (const f of sheet.facts) {
        text(f.label, MARGIN, 190, { color: GRAY })
        text(f.value, MARGIN + 195, CONTENT_W - 195)
        y += 14
      }
      y += 10

      // ── Lines ──
      const widths = [28, 130, 52, 44, 52, 44, 52, 62, 59]
      const drawRow = (cells: SheetCell[], cols: SheetColumn[], w: number[], opts: { head?: boolean; bold?: boolean } = {}) => {
        ensure(18)
        if (opts.head) doc.rect(MARGIN, y - 3, CONTENT_W, 16).fillColor('#F9FAFB').fill()
        let x = MARGIN
        cells.forEach((cell, i) => {
          const col = cols[i]
          const align = col.kind === 'text' ? 'left' : 'right'
          text(opts.head ? col.label : formatCell(cell, col.kind), x + 2, w[i] - 4, {
            size: 8, bold: opts.head || opts.bold, color: opts.head ? GRAY : DARK, align,
          })
          x += w[i]
        })
        y += 15
        doc.moveTo(MARGIN, y - 2).lineTo(MARGIN + CONTENT_W, y - 2).strokeColor(BORDER).lineWidth(0.5).stroke()
      }
      drawRow(sheet.lineColumns.map(c => c.label), sheet.lineColumns, widths, { head: true })
      for (const r of sheet.lineRows) drawRow(r, sheet.lineColumns, widths)
      drawRow(sheet.lineTotals, sheet.lineColumns, widths, { bold: true })
      y += 10

      // ── Earlier and planned lots ──
      if (sheet.lotRows.length > 0) {
        const lw = [120, 100, 80, 120]
        drawRow(sheet.lotColumns.map(c => c.label), sheet.lotColumns, lw, { head: true })
        for (const r of sheet.lotRows) drawRow(r, sheet.lotColumns, lw)
        y += 10
      }

      // ── Summary ──
      for (const s of sheet.summary) {
        ensure(22)
        if (s.strong) doc.rect(MARGIN, y - 4, CONTENT_W, 19).fillColor('#FDF3F0').fill()
        text(s.label, MARGIN + 6, CONTENT_W - 130, { size: 9.5, bold: s.strong })
        text(money(s.value), MARGIN + CONTENT_W - 124, 118, { size: 9.5, bold: s.strong, align: 'right', color: s.strong ? RED : DARK })
        y += 19
      }
      y += 8
      for (const n of sheet.notes) {
        ensure(24)
        doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRAY)
          .text(toPdfText(n), MARGIN, y, { width: CONTENT_W })
        y = doc.y + 4
      }
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
