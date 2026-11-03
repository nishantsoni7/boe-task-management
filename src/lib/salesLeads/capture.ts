// What the "Website Leads" sheet script may send to /api/sales/capture/website. Everything is checked here before the
// database sees it: a bad body is refused whole, a row is cut to the sizes the database takes.

export type CaptureRow = {
  key: string | null
  form_type: string | null
  name: string | null
  email: string | null
  phone: string
  location: string | null
  message: string | null
}

export const MAX_ROWS = 100

const field = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

/** The rows of a request body, or the reason it is refused. */
export function captureRows(body: unknown): { rows: CaptureRow[] } | { error: string } {
  const rows = (body as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows)) return { error: 'Send { rows: [...] }.' }
  if (rows.length > MAX_ROWS) return { error: `Send up to ${MAX_ROWS} rows at a time.` }
  const out: CaptureRow[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const phone = field(r.phone, 40)
    if (!phone) continue
    out.push({
      key: field(r.key, 200), form_type: field(r.form_type, 60), name: field(r.name, 120), email: field(r.email, 120), phone,
      location: field(r.location, 120), message: field(r.message, 4000),
    })
  }
  return { rows: out }
}
