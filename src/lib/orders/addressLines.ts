// ── A POSTAL ADDRESS, READ AS LABELLED LINES ─────────────────────────────────
//
// The PI stores an address as one run of text in the order the client's portal
// printed it: "Building No./Flat No.: 160 Name Of Premises/Building: Tiverton
// Bungalow Road/Street: Coonoor Road Nearby Landmark: … PIN Code: 643001".
// Read in one breath that is hard to scan, so the dialog breaks it at each
// known label. DISPLAY ONLY: the stored text is never changed, and anything
// that does not look like this shape is returned as null so the caller shows
// it exactly as stored.

/** The labels the portal prints, in its own order, with the words the dialog uses. */
const KEYS: readonly { key: string; label: string }[] = [
  { key: 'Building No./Flat No.', label: 'Flat / building' },
  { key: 'Name Of Premises/Building', label: 'Premises' },
  { key: 'Road/Street', label: 'Road' },
  { key: 'Nearby Landmark', label: 'Landmark' },
  { key: 'Locality/Sub Locality', label: 'Locality' },
  { key: 'City/Town/Village', label: 'City' },
  { key: 'District', label: 'District' },
  { key: 'State', label: 'State' },
  { key: 'PIN Code', label: 'PIN' },
]

export type AddressLine = { label: string; value: string }

/**
 * The address as labelled lines, or null when it cannot be split SAFELY: fewer
 * than two known labels found, or text before the first one (which would be
 * lost). A label with nothing after it is dropped, not shown empty.
 */
export function splitAddress(raw: string | null | undefined): AddressLine[] | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return null

  const found: { at: number; len: number; label: string }[] = []
  const lower = text.toLowerCase()
  for (const { key, label } of KEYS) {
    const needle = `${key.toLowerCase()}:`
    const at = lower.indexOf(needle)
    if (at >= 0) found.push({ at, len: needle.length, label })
  }
  if (found.length < 2) return null
  found.sort((a, b) => a.at - b.at)
  if (found[0].at !== 0) return null

  const lines: AddressLine[] = []
  found.forEach((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].at : text.length
    const value = text.slice(f.at + f.len, end).trim()
    if (value !== '') lines.push({ label: f.label, value })
  })
  return lines.length > 0 ? lines : null
}

/** The address as plain text for the clipboard: labelled lines when it splits, the stored text otherwise. */
export function addressForCopy(name: string | null | undefined, raw: string | null | undefined): string {
  const lines = splitAddress(raw)
  const body = lines ? lines.map(l => `${l.label}: ${l.value}`).join('\n') : (raw ?? '').trim()
  return [(name ?? '').trim(), body].filter(part => part !== '').join('\n')
}

/** Two addresses are the same when they read the same ignoring case and spacing. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return norm(a) !== '' && norm(a) === norm(b)
}
