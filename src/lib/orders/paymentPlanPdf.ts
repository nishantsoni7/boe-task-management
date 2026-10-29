// DRAWING THE PAYMENT PLAN PDF. Node only (pdfkit), like confirmedPdfRender.
// It decides nothing: the model comes from paymentPlanSheet.ts. Rupee signs are
// written "Rs." because the standard PDF font has no ₹ (toPdfText).
//
// THE OWNER'S LAYOUT (2026-10-29, after their "Req-0169"): A4 landscape so the
// whole product table fits — code, item, quantities, item / packing / fabric
// amounts per product — then four small panels side by side (this lot, sent
// earlier, still to come, received), then the one box that matters: what to
// pay before this dispatch, bank and cash.

import PDFDocument from 'pdfkit'

import { toPdfText } from './confirmedPdf'
import { CLIENT_PDF_DATE } from './confirmedPdfRender'
import type { PaymentPlanSheet, SheetCell, SheetColumn } from './paymentPlanSheet'

const RED = '#BC4B35'
const DARK = '#1F2937'
const GRAY = '#6B7280'
const BORDER = '#E5E7EB'
const PANEL = '#F5F2EE'
const MARGIN = 36
const PAGE_W = 841.89
const PAGE_H = 595.28
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = PAGE_H - 36
/** The 14 product columns, in points; they add up to the content width. */
const LINE_WIDTHS = [62, 118, 40, 44, 40, 58, 62, 44, 52, 40, 44, 40, 56, 70]

const whole = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

function formatCell(cell: SheetCell, kind: SheetColumn['kind']): string {
  if (cell === null || cell === '') return kind === 'text' ? '' : '-'
  if (typeof cell === 'string') return cell
  return whole(cell)
}

const money = (paise: number | null) => (paise === null ? '-' : `Rs. ${whole(paise / 100)}`)

export async function renderPaymentPlanPdf(sheet: PaymentPlanSheet, logo?: Uint8Array | null): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
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
        doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 } })
        y = MARGIN
      }
    }
    const text = (s: string, x: number, width: number, opts: { size?: number; color?: string; bold?: boolean; align?: 'left' | 'right'; at?: number } = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 8.5).fillColor(opts.color ?? DARK)
        .text(toPdfText(s), x, opts.at ?? y, { width, align: opts.align ?? 'left', lineBreak: false, ellipsis: true })
    }

    try {
      // ── Heading ──
      if (logo) {
        try { doc.image(Buffer.from(logo), PAGE_W - MARGIN - 120, y, { height: 24 }) } catch { /* the document does not need its logo */ }
      }
      text('DISPATCH PAYMENT SHEET', MARGIN, 300, { size: 8, bold: true, color: RED })
      y += 12
      text(sheet.title.replace(/^Payment plan — /, ''), MARGIN, 500, { size: 16, bold: true })
      y += 22
      text(sheet.facts.filter(f => ['Client', 'Date', 'Billing (paid in bank)'].includes(f.label))
        .map(f => `${f.label}: ${f.value}`).join('   ·   '), MARGIN, CONTENT_W, { size: 9, color: GRAY })
      y += 20

      // ── The product table ──
      const drawRow = (cells: SheetCell[], opts: { head?: boolean; bold?: boolean } = {}) => {
        ensure(17)
        if (opts.head) doc.rect(MARGIN, y - 3, CONTENT_W, 16).fillColor('#FAF8F5').fill()
        let x = MARGIN
        cells.forEach((cell, i) => {
          const col = sheet.lineColumns[i]
          const align = col.kind === 'text' ? 'left' : 'right'
          if (!opts.head && i === 4) doc.rect(x, y - 3, LINE_WIDTHS[i], 16).fillColor('#FFF8E6').fill()
          text(opts.head ? col.label : formatCell(cell, col.kind), x + 2, LINE_WIDTHS[i] - 4, {
            size: opts.head ? 7 : 8, bold: opts.head || opts.bold, color: opts.head ? GRAY : DARK, align,
          })
          x += LINE_WIDTHS[i]
        })
        y += 15
        doc.moveTo(MARGIN, y - 2).lineTo(MARGIN + CONTENT_W, y - 2).strokeColor(BORDER).lineWidth(0.5).stroke()
      }
      drawRow(sheet.lineColumns.map(c => c.label), { head: true })
      for (const r of sheet.lineRows) drawRow(r)
      drawRow(sheet.lineTotals, { bold: true })
      y += 12

      // ── Four panels, side by side ──
      const gap = 12
      const panelW = (CONTENT_W - gap * 3) / 4
      const tallest = Math.max(...sheet.panels.map(p => p.rows.length)) + (sheet.panels.length > 0 ? 1 : 0)
      const panelH = 16 + tallest * 13 + 10
      ensure(panelH + 6)
      doc.rect(MARGIN, y, CONTENT_W, panelH).fillColor(PANEL).fill()
      sheet.panels.forEach((panel, i) => {
        const x = MARGIN + 8 + i * (panelW + gap)
        let py = y + 8
        text(panel.title.toUpperCase(), x, panelW - 16, { size: 8, bold: true, at: py })
        py += 15
        for (const row of panel.rows) {
          const strong = /^(Lot value|Advance for them|Total received)$/.test(row.label)
          text(row.label, x, panelW - 90, { size: 8, bold: strong, color: strong ? DARK : '#3D3D3D', at: py })
          text(row.text ?? money(row.paise), x + panelW - 96, 80, { size: 8, bold: strong, align: 'right', at: py })
          py += 13
        }
      })
      y += panelH + 12

      // ── What to pay before this dispatch ──
      const rows = sheet.summary.length + 1
      ensure(rows * 18 + 30)
      const boxTop = y
      text('TO PAY BEFORE THIS DISPATCH', MARGIN + 10, 300, { size: 9, bold: true, at: y + 8 })
      y += 24
      const labelW = CONTENT_W - 3 * 110 - 20
      const col = (i: number) => MARGIN + 10 + labelW + i * 110
      ;['Bank', 'Cash', 'Total'].forEach((h, i) => text(h, col(i), 104, { size: 8, bold: true, color: GRAY, align: 'right' }))
      y += 14
      for (const s of sheet.summary) {
        const strong = s.kind !== 'line'
        if (s.kind === 'balance') doc.rect(MARGIN + 4, y - 4, CONTENT_W - 8, 18).fillColor('#FDF1EC').fill()
        text(s.label, MARGIN + 10, labelW - 10, { size: 9, bold: strong })
        ;[s.account, s.cash, s.total].forEach((v, i) => {
          const shown = s.kind === 'balance' && v !== null && v < 0 ? `${money(-v)} paid extra` : money(v)
          text(shown, col(i), 104, { size: 9, bold: strong, align: 'right', color: s.kind === 'balance' ? RED : DARK })
        })
        y += 18
      }
      doc.roundedRect(MARGIN, boxTop, CONTENT_W, y - boxTop + 4, 6).strokeColor(RED).lineWidth(1.2).stroke()
      y += 14

      for (const n of sheet.notes) {
        ensure(22)
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(GRAY).text(toPdfText(n), MARGIN, y, { width: CONTENT_W })
        y = doc.y + 3
      }
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
