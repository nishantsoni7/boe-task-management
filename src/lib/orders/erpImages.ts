// ── Getting the products' pictures ready for the ERP sheet ───────────────────
//
// Each product's representative picture is fetched (already signed for this
// reader — nothing new is signed), decoded, and re-drawn at its on-sheet size as
// a JPEG: every Excel can show a JPEG, a WebP it cannot, and a full-size photo
// per row would make the workbook huge. A picture that cannot be fetched or
// decoded is left out and counted; the sheet is never held back for it.

import type { PiViewerItem } from '@/lib/pi/previewView'
import { ERP_IMAGE_BOX_PX, fitInBox, type ErpSheetImage } from './erpWorkbookImages'

/** The URL of each product's picture for the sheet: the representative one, else its first. */
export function erpPictureUrlsByRow(items: readonly PiViewerItem[]): Map<number, string> {
  const byRow = new Map<number, string>()
  for (const item of items) {
    if (item.role === 'representative' && !byRow.has(item.row)) byRow.set(item.row, item.url)
  }
  for (const item of items) {
    if (!byRow.has(item.row)) byRow.set(item.row, item.url)
  }
  return byRow
}

/**
 * Loads one picture per product, in product order. `fetchBytes` and `prepare`
 * are injected (the browser supplies them); at most `concurrency` run at once.
 */
export async function loadErpImages(
  urls: readonly (string | null)[],
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
  prepare: (bytes: Uint8Array) => Promise<ErpSheetImage | null>,
  concurrency = 4,
): Promise<{ images: (ErpSheetImage | null)[]; failed: number }> {
  const images: (ErpSheetImage | null)[] = new Array(urls.length).fill(null)
  let failed = 0
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const i = next++
      const url = urls[i]
      if (!url) continue
      try {
        const bytes = await fetchBytes(url)
        images[i] = bytes ? await prepare(bytes) : null
      } catch {
        images[i] = null
      }
      if (!images[i]) failed++
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, urls.length)) }, worker))
  return { images, failed }
}

/** Browser only: decode, fit to the box (drawn at 2x for sharpness) and re-encode as JPEG. */
export async function prepareErpImage(source: Uint8Array): Promise<ErpSheetImage | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([source as BlobPart]))
    const shown = fitInBox(bitmap.width, bitmap.height, ERP_IMAGE_BOX_PX)
    const canvas = document.createElement('canvas')
    canvas.width = shown.width * 2
    canvas.height = shown.height * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob) return null
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: shown.width, height: shown.height, ext: 'jpeg' }
  } catch {
    return null
  }
}
