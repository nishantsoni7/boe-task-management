// DRAWING THE PAYMENT PLAN PDF. Node only (pdfkit), like confirmedPdfRender.
// It decides nothing: the model comes from paymentPlanSheet.ts. Rupee signs are
// left out (amounts are whole rupees, "All amounts in Rs." is said once) because
// the standard PDF font has no ₹ (toPdfText).
//
// THE OWNER'S LAYOUT (2026-10-29, mockup v2): A4 landscape. The product table
// with thin grid lines; "How the amount is worked out" (Sent earlier | This lot
// | Still to come | Whole order), the carried figures shaded; then "To pay
// before this dispatch" read across as one sum, the balance column shaded.

import PDFDocument from 'pdfkit'

import { toPdfText } from './confirmedPdf'
import { CLIENT_PDF_DATE } from './confirmedPdfRender'
import { wholeRupees, type PaymentPlanSheet, type SheetCell, type SheetColumn } from './paymentPlanSheet'

const RED = '#BC4B35'
const DARK = '#1F2937'
const GRAY = '#6B7280'
const GRID = '#DCDCDC'
const HEAD = '#F5F5F5'
const CARRIED = '#FFF1D6'
const BALANCE = '#FDF3EF'
const MARGIN = 36
const PAGE_W = 841.89
const PAGE_H = 595.28
const CONTENT_W = PAGE_W - MARGIN * 2
const BOTTOM = PAGE_H - 30
/** The 15 product columns, in points; they add up to the content width. */
const LINE_WIDTHS = [52, 104, 38, 42, 38, 42, 54, 60, 42, 52, 40, 40, 40, 56, 70]

const number = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 })

function formatCell(cell: SheetCell, kind: SheetColumn['kind']): string {
  if (cell === null || cell === '') return kind === 'text' ? '' : '-'
  if (typeof cell === 'string') return cell
  return kind === 'money' ? number(Math.round(cell)) : number(cell)
}

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
    const newPage = () => {
      doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 } })
      y = MARGIN
    }
    const ensure = (height: number) => { if (y + height > BOTTOM) newPage() }
    const text = (s: string, x: number, width: number, opts: { size?: number; color?: string; bold?: boolean; align?: 'left' | 'right' | 'center'; at?: number } = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 8.5).fillColor(opts.color ?? DARK)
        .text(toPdfText(s), x, opts.at ?? y, { width, align: opts.align ?? 'left', lineBreak: false, ellipsis: true })
    }
    /** One grid row: cells with a fill each, thin borders all round. */
    const gridRow = (xs: number[], ws: number[], h: number, fills: (string | null)[]) => {
      xs.forEach((x, i) => {
        if (fills[i]) doc.rect(x, y, ws[i], h).fillColor(fills[i] as string).fill()
        doc.rect(x, y, ws[i], h).strokeColor(GRID).lineWidth(0.5).stroke()
      })
    }

    try {
      // ── Heading ──
      if (logo) {
        try { doc.image(Buffer.from(logo), PAGE_W - MARGIN - 120, y, { height: 24 }) } catch { /* the document does not need its logo */ }
      }
      text(sheet.title.replace(/^Payment plan — /, 'Payment plan · '), MARGIN, 520, { size: 15, bold: true })
      y += 20
      text(sheet.subtitle, MARGIN, CONTENT_W - 130, { size: 8.5, color: GRAY })
      y += 18

      // ── 1. The product table ──
      const lineXs: number[] = []
      LINE_WIDTHS.reduce((x, w) => { lineXs.push(x); return x + w }, MARGIN)
      const LOT_COL = 4
      const drawLine = (cells: SheetCell[], opts: { head?: boolean; foot?: boolean } = {}) => {
        const h = opts.head ? 22 : 17
        ensure(h)
        gridRow(lineXs, LINE_WIDTHS, h, LINE_WIDTHS.map((_, i) => (opts.head || opts.foot ? HEAD : i === LOT_COL ? '#FFF9EC' : null)))
        cells.forEach((cell, i) => {
          const col = sheet.lineColumns[i]
          text(opts.head ? col.label : formatCell(cell, col.kind), lineXs[i] + 3, LINE_WIDTHS[i] - 6, {
            size: opts.head ? 6.8 : 7.8, bold: opts.head || opts.foot, color: opts.head ? '#444444' : DARK,
            align: col.kind === 'text' ? 'left' : 'right', at: y + (opts.head ? 7 : 5),
          })
        })
        y += h
      }
      drawLine(sheet.lineColumns.map(c => c.label), { head: true })
      for (const r of sheet.lineRows) drawLine(r)
      drawLine(sheet.lineTotals, { foot: true })
      y += 16

      // ── 2. How the amount is worked out ──
      const calcLabelW = CONTENT_W * 0.36
      const calcColW = (CONTENT_W - calcLabelW) / 4
      const calcXs = [MARGIN, ...[0, 1, 2, 3].map(i => MARGIN + calcLabelW + i * calcColW)]
      const calcWs = [calcLabelW, calcColW, calcColW, calcColW, calcColW]
      ensure(40)
      text('How the amount is worked out', MARGIN, 400, { size: 10, bold: true })
      y += 15
      gridRow(calcXs, calcWs, 18, calcWs.map(() => HEAD))
      ;['', ...sheet.calcColumns].forEach((h, i) =>
        text(h, calcXs[i] + 6, calcWs[i] - 12, { size: 8, bold: true, align: i === 0 ? 'left' : 'right', at: y + 5 }))
      y += 18
      for (const r of sheet.calcRows) {
        if (r.kind === 'gap') { y += 6; continue }
        ensure(17)
        const strong = r.kind !== 'line'
        gridRow(calcXs, calcWs, 17, calcWs.map((_, i) =>
          r.carried && i >= 1 && i <= 3 ? CARRIED : strong ? '#FAFAFA' : null))
        text(r.label, calcXs[0] + 6, calcWs[0] - 12, { size: 8.3, bold: strong, at: y + 5 })
        r.cells.forEach((c, i) => {
          const shown = c === null ? '' : typeof c === 'string' ? c : wholeRupees(c)
          text(shown, calcXs[i + 1] + 6, calcWs[i + 1] - 12, { size: 8.3, bold: strong || (r.carried && i < 3), align: 'right', at: y + 5 })
        })
        y += 17
      }
      y += 6
      text('Shaded figures are carried into the box below. All amounts in Rs., rounded to the rupee.', MARGIN, CONTENT_W, { size: 7.5, color: GRAY })
      y += 18

      // ── 3. To pay before this dispatch ──
      const n = sheet.payColumns.length
      const opW = 22
      const payLabelW = 80
      const amountW = (CONTENT_W - 20 - payLabelW - opW * (n - 1)) / n
      const xs: { x: number; w: number; op: boolean; col?: number }[] = []
      let x = MARGIN + 10 + payLabelW
      sheet.payColumns.forEach((c, i) => {
        if (i > 0) { xs.push({ x, w: opW, op: true, col: i }); x += opW }
        xs.push({ x, w: amountW, op: false, col: i })
        x += amountW
      })
      const boxH = 34 + 26 + sheet.payRows.length * 20 + 26
      ensure(boxH)
      const top = y
      doc.roundedRect(MARGIN, top, CONTENT_W, boxH, 8).strokeColor(RED).lineWidth(1.4).stroke()
      y += 12
      text('To pay before this dispatch', MARGIN + 10, 300, { size: 11, bold: true })
      text('Goods sent + Advance - Already received = Balance', MARGIN + CONTENT_W - 330, 320, { size: 8, color: GRAY, align: 'right' })
      y += 22
      const balanceCell = xs.find(c => !c.op && sheet.payColumns[c.col ?? 0]?.balance)
      if (balanceCell) doc.rect(balanceCell.x, y - 4, balanceCell.w, 26 + sheet.payRows.length * 20).fillColor(BALANCE).fill()
      for (const c of xs) {
        if (c.op) continue
        const col = sheet.payColumns[c.col ?? 0]
        text(`${col.mark ? `(${col.mark}) ` : ''}${col.title}`, c.x + 4, c.w - 8, { size: 8.5, bold: true, align: 'right', color: col.balance ? '#8F3524' : DARK })
        text(col.sub, c.x + 4, c.w - 8, { size: 7, color: GRAY, align: 'right', at: y + 11 })
      }
      y += 26
      for (const r of sheet.payRows) {
        doc.moveTo(MARGIN + 10, y - 3).lineTo(MARGIN + CONTENT_W - 10, y - 3).strokeColor(r.total ? '#BFBFBF' : '#ECECEC').lineWidth(0.6).stroke()
        text(r.label, MARGIN + 10, payLabelW - 6, { size: 9, bold: r.total, at: y + 3 })
        for (const c of xs) {
          const col = sheet.payColumns[c.col ?? 0]
          if (c.op) { text(col.op ?? '', c.x, c.w, { size: 10, color: '#9A9A9A', align: 'center', at: y + 2 }); continue }
          const v = r.cells[c.col ?? 0]
          const shown = col.balance && v < 0 ? `${wholeRupees(-v)} paid extra` : wholeRupees(v)
          text(shown, c.x + 4, c.w - 8, { size: r.total ? 10 : 9, bold: r.total || col.balance, align: 'right', color: col.balance ? '#8F3524' : DARK, at: y + 3 })
        }
        y += 20
      }
      y = top + boxH + 12

      for (const note of sheet.notes) {
        ensure(20)
        doc.font('Helvetica').fontSize(7.5).fillColor(GRAY).text(toPdfText(note), MARGIN, y, { width: CONTENT_W })
        y = doc.y + 3
      }
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
