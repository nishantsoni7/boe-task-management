// The Payment plan as an Excel workbook, built in the browser from the same
// model the screen and the PDF use (paymentPlanSheet.ts): the product table,
// "How the amount is worked out", and "To pay before this dispatch". Numbers
// stay numbers so the finance team can add to them; amounts are whole rupees.

import type { PaymentPlanSheet, SheetCell, SheetColumn } from './paymentPlanSheet'

const MONEY_FORMAT = '#,##,##0;[Red]-#,##,##0'
const QTY_FORMAT = '#,##0.###'

export async function buildPaymentPlanWorkbook(sheet: PaymentPlanSheet): Promise<Uint8Array> {
  const XLSX = await import('xlsx')
  const rows: SheetCell[][] = []
  const formats = new Map<string, string>() // "r,c" -> number format
  const mark = (r: number, c: number, kind: SheetColumn['kind']) => {
    if (kind === 'money') formats.set(`${r},${c}`, MONEY_FORMAT)
    else if (kind === 'qty') formats.set(`${r},${c}`, QTY_FORMAT)
  }
  const rupees = (paise: number) => Math.round(paise / 100)

  rows.push([sheet.title.replace(/^Payment plan — /, 'Payment plan · ')])
  rows.push([sheet.subtitle])
  rows.push([])

  // 1. Products
  rows.push(sheet.lineColumns.map(c => c.label))
  for (const row of [...sheet.lineRows, sheet.lineTotals]) {
    row.forEach((_, c) => mark(rows.length, c, sheet.lineColumns[c].kind))
    rows.push(row)
  }
  rows.push([])

  // 2. How the amount is worked out
  rows.push(['How the amount is worked out'])
  rows.push(['', ...sheet.calcColumns])
  for (const r of sheet.calcRows) {
    if (r.kind === 'gap') { rows.push([]); continue }
    r.cells.forEach((c, i) => { if (typeof c === 'number') formats.set(`${rows.length},${i + 1}`, MONEY_FORMAT) })
    rows.push([r.label, ...r.cells.map(c => (typeof c === 'number' ? rupees(c) : c))])
  }
  rows.push([])

  // 3. To pay before this dispatch, read across
  rows.push(['To pay before this dispatch', 'Goods sent + Advance − Already received = Balance'])
  rows.push(['', ...sheet.payColumns.map(c => `${c.op ? `${c.op} ` : ''}${c.mark ? `(${c.mark}) ` : ''}${c.title} — ${c.sub}`)])
  for (const r of sheet.payRows) {
    r.cells.forEach((_, i) => formats.set(`${rows.length},${i + 1}`, MONEY_FORMAT))
    rows.push([r.label, ...r.cells.map(rupees)])
  }
  rows.push([])
  for (const n of sheet.notes) rows.push([n])

  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (const [key, z] of formats) {
    const [r, c] = key.split(',').map(Number)
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    if (cell && typeof cell.v === 'number') cell.z = z
  }
  ws['!cols'] = [{ wch: 48 }, { wch: 26 }, ...Array.from({ length: 13 }, () => ({ wch: 14 }))]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Payment plan')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)
}

export async function downloadPaymentPlanXlsx(sheet: PaymentPlanSheet, fileName: string): Promise<void> {
  const bytes = await buildPaymentPlanWorkbook(sheet)
  const blob = new Blob([bytes as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
