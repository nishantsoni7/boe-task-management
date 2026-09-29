// ── The approved PI's product pictures, as the Documents card states them ────
//
// They belong to the Main PI (the workbook's own representative and
// customization images), never to Design Files, which hold the Order's
// production references (drawings, plans, site files). This module says what
// the reader can do with them and builds the one-file download.
//
// TRUTHFUL, NOT OPTIMISTIC. A picture counts as available only when its file
// was signed for this reader. A recorded picture whose file storage no longer
// holds (a test-data cleanup that removed the files, say) is counted as
// unavailable and is never put in a ZIP — a download that produces an empty or
// broken archive is worse than a plain sentence.

import { buildZip, safeFileName, uniqueZipNames } from '@/lib/tasks/taskGallery'
import type { PiViewerItem } from '@/lib/pi/previewView'

export const PRODUCT_PICTURES_TITLE = 'Product pictures'

export type ProductPicturesState =
  | { kind: 'loading' }
  | { kind: 'unreadable' }
  | { kind: 'none' }
  /** available > 0: some or all pictures can be viewed and downloaded. */
  | { kind: 'ready'; available: number; unavailable: number }
  /** Pictures are recorded, but not one file could be retrieved. */
  | { kind: 'missing'; recorded: number }

export function productPicturesState(input: {
  /** The picture rows the PI records, or null while loading / when the read failed. */
  recorded: number | null
  loading: boolean
  /** Pictures whose file was signed for this reader. */
  available: number
  /** Recorded pictures with no signed file. */
  unavailable: number
}): ProductPicturesState {
  if (input.loading) return { kind: 'loading' }
  if (input.recorded === null) return { kind: 'unreadable' }
  if (input.recorded === 0 && input.available === 0) return { kind: 'none' }
  if (input.available === 0) return { kind: 'missing', recorded: Math.max(input.recorded, input.unavailable) }
  return { kind: 'ready', available: input.available, unavailable: input.unavailable }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The one line the Documents card prints for the pictures. */
export function productPicturesLine(state: ProductPicturesState): string {
  switch (state.kind) {
    case 'loading':    return 'Loading pictures…'
    case 'unreadable': return 'The pictures could not be read.'
    case 'none':       return 'No product pictures on this PI.'
    case 'missing':    return `${plural(state.recorded, 'picture')} recorded, but the files are no longer in storage.`
    case 'ready':
      return state.unavailable > 0
        ? `${state.available} of ${state.available + state.unavailable} pictures available · ${state.unavailable} no longer in storage`
        : plural(state.available, 'picture')
  }
}

/** "0526 product pictures.zip" — the Order number, or the client, made safe. */
export function productPicturesZipName(orderNumber: string | null | undefined, client: string | null | undefined): string {
  const lead = (orderNumber ?? '').trim() || (client ?? '').trim() || 'Order'
  return `${safeFileName(lead.slice(0, 60), 'Order')} product pictures.zip`
}

/** The file extension of a signed URL's object key, or `.jpg`. */
function extensionOf(url: string): string {
  const path = url.split('?')[0] ?? ''
  const m = /\.(png|jpe?g|webp)$/i.exec(path)
  return m ? `.${m[1].toLowerCase()}` : '.jpg'
}

/**
 * One archive entry per available picture, named so it sorts with its product:
 * "B001 Lounge chair - representative.png", "B001 Lounge chair - customization 2.jpg".
 */
export function productPictureZipEntries(items: readonly PiViewerItem[]): { name: string; url: string }[] {
  const counters = new Map<string, number>()
  const raw = items.map(item => {
    const product = [item.sequence, item.name].map(s => (s ?? '').trim()).filter(Boolean).join(' ') || `Row ${item.row}`
    const roleKey = `${item.row}:${item.role}`
    const n = (counters.get(roleKey) ?? 0) + 1
    counters.set(roleKey, n)
    const role = item.role === 'representative' ? 'representative' : `customization ${n}`
    return { name: `${product} - ${role}${extensionOf(item.url)}`, url: item.url }
  })
  const names = uniqueZipNames(raw.map(r => r.name))
  return raw.map((r, i) => ({ name: names[i], url: r.url }))
}

export type PictureZipResult = { bytes: Uint8Array | null; included: number; failed: number }

/**
 * Fetch each signed picture and store it in one archive. A picture that fails
 * to download is left out and counted; if none downloads, there is no archive.
 */
export async function buildProductPicturesZip(
  entries: readonly { name: string; url: string }[],
  fetchBytes: (url: string) => Promise<Uint8Array | null>,
  concurrency = 4,
): Promise<PictureZipResult> {
  const files: ({ name: string; bytes: Uint8Array } | null)[] = new Array(entries.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < entries.length) {
      const i = next++
      try {
        const bytes = await fetchBytes(entries[i].url)
        files[i] = bytes && bytes.byteLength > 0 ? { name: entries[i].name, bytes } : null
      } catch {
        files[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker))
  const got = files.filter((f): f is { name: string; bytes: Uint8Array } => f !== null)
  return {
    bytes: got.length > 0 ? await buildZip(got) : null,
    included: got.length,
    failed: entries.length - got.length,
  }
}
