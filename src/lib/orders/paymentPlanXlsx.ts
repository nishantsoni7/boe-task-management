// The Payment plan as an Excel workbook, built in the browser from the same
// model the PDF uses (paymentPlanSheet.ts). Numbers stay numbers so the
// finance team can add to them; money cells carry the Indian rupee format.

import type { PaymentPlanSheet, SheetCell, SheetColumn } from './paymentPlanSheet'

const MONEY_FORMAT = '[$₹-4009]#,##,##0.00;[Red]-[$₹-4009]#,##,##0.00'
const QTY_FORMAT = '#,##0.00'

export async function buildPaymentPlanWorkbook(sheet: PaymentPlanSheet): Promise<Uint8Array> {
  const XLSX = await import('xlsx')
  const rows: SheetCell[][] = []
  const formats = new Map<string, string>() // "r,c" -> number format

  const mark = (r: number, c: number, kind: SheetColumn['kind']) => {
    if (kind === 'money') formats.set(`${r},${c}`, MONEY_FORMAT)
    else if (kind === 'qty') formats.set(`${r},${c}`, QTY_FORMAT)
  }

  rows.push([sheet.title])
  rows.push([])
  for (const f of sheet.facts) rows.push([f.label, f.value])
  rows.push([])

  rows.push(sheet.lineColumns.map(c => c.label))
  for (const row of sheet.lineRows) {
    row.forEach((_, c) => mark(rows.length, c, sheet.lineColumns[c].kind))
    rows.push(row)
  }
  sheet.lineTotals.forEach((_, c) => mark(rows.length, c, sheet.lineColumns[c].kind))
  rows.push(sheet.lineTotals)
  rows.push([])

  if (sheet.lotRows.length > 0) {
    rows.push(sheet.lotColumns.map(c => c.label))
    for (const row of sheet.lotRows) {
      row.forEach((_, c) => mark(rows.length, c, sheet.lotColumns[c].kind))
      rows.push(row)
    }
    rows.push([])
  }

  for (const s of sheet.summary) {
    formats.set(`${rows.length},1`, MONEY_FORMAT)
    rows.push([s.label, s.value])
  }
  if (sheet.notes.length > 0) {
    rows.push([])
    for (const n of sheet.notes) rows.push([n])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  for (const [key, z] of formats) {
    const [r, c] = key.split(',').map(Number)
    const cell = ws[XLSX.utils.encode_cell({ r, c })]
    if (cell && typeof cell.v === 'number') cell.z = z
  }
  ws['!cols'] = [{ wch: 52 }, { wch: 30 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 16 }]
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
