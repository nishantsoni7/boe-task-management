// The browser half of "Download Excel" (owner, 18 Nov 2026): fetch the pictures the client sees, build the workbook, save the file.
// Kept apart from clientWorkbook.ts, which is pure and runs in tests. Everything here needs a browser (fetch, createImageBitmap, a link).

import { clientSheetFileName, type SheetPicture, type WorkbookHead, type WorkbookInput } from './clientWorkbook'
import { choiceKeys, type QuoteArea, type QuoteLine, type QuoteMoney } from './math'

const PARALLEL = 6

/** Each picture's bytes and size, six at a time. A picture that cannot be loaded is left out (and counted), never a reason to fail. */
export async function loadSheetPictures(paths: readonly string[], srcOf: (path: string) => string): Promise<{ pictures: Map<string, SheetPicture>; missing: number }> {
  const pictures = new Map<string, SheetPicture>()
  const queue = [...new Set(paths)]
  let missing = 0
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      try {
        const res = await fetch(srcOf(path))
        if (!res.ok) throw new Error('not ok')
        const blob = await res.blob()
        const bmp = await createImageBitmap(blob)
        pictures.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), width: bmp.width, height: bmp.height })
        bmp.close()
      } catch { missing++ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
  return { pictures, missing }
}

/** The Best of Exports logo for the sheet's title band, or null when it cannot be loaded. */
async function loadLogo(): Promise<SheetPicture | null> {
  try {
    const res = await fetch('/quotation/boe-logo.png')
    if (!res.ok) return null
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob)
    const out = { bytes: new Uint8Array(await blob.arrayBuffer()), width: bmp.width, height: bmp.height }
    bmp.close()
    return out
  } catch { return null }
}

/** A picture kept as a data URL (the UPI QR), as bytes, or null when there is none or it cannot be decoded. */
async function loadDataUrl(url: string | null | undefined): Promise<SheetPicture | null> {
  if (!url) return null
  try {
    const blob = await (await fetch(url)).blob()
    const bmp = await createImageBitmap(blob)
    const out = { bytes: new Uint8Array(await blob.arrayBuffer()), width: bmp.width, height: bmp.height }
    bmp.close()
    return out
  } catch { return null }
}

function saveBytes(fileName: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Builds and downloads the quotation's Excel. Returns how many pictures could not be loaded and were left out. */
export async function downloadClientWorkbook(input: {
  head: WorkbookHead; money: QuoteMoney; areas: readonly QuoteArea[]; lines: readonly QuoteLine[]
  /** Where each picture is shown from: the same address the builder uses, so the logo mark follows the quotation's switch. */
  srcOf: (path: string) => string
  /** The bank account and UPI QR to print, as read from quotation_payment_details; null prints nothing. */
  payment?: (WorkbookInput['payment'] & { qr_image?: string | null }) | null
}): Promise<{ missing: number }> {
  const { buildClientWorkbook } = await import('./clientWorkbook')
  // the products' pictures and the swatches of their client choices (the second sheet); a swatch that cannot be loaded is counted like a picture
  const paths = input.lines.flatMap(l => [l.image_path, ...choiceKeys(l.choices).map(k => l.choices?.[k]?.photo)]).filter((p): p is string => !!p)
  const [{ pictures, missing }, logo] = await Promise.all([loadSheetPictures(paths, input.srcOf), loadLogo()])
  const qr = await loadDataUrl(input.payment?.qr_image)
  const bytes = await buildClientWorkbook({ head: input.head, money: input.money, areas: input.areas, lines: input.lines, pictures, logo, payment: input.payment, qr })
  saveBytes(clientSheetFileName(input.head.quoteNo), bytes)
  return { missing }
}
