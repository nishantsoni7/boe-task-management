import type { LeadFormValues } from './validation'

// Keeping an entry safe across a session expiry.
//
// When a save fails because the session is gone, what the person typed is
// parked in sessionStorage (this tab only, gone when it closes) so signing in
// and coming back to the form does not mean re-asking the visitor. It is read
// once, then removed. Storage can be unavailable (private mode, blocked site
// data), so every access is guarded and the form works without it.

const KEY = 'exhibition-leads:draft:v1'

export type SavedDraft = {
  values: LeadFormValues
  exhibitionId: string | null
  submissionId: string
}

export function saveDraft(draft: SavedDraft): boolean {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

export function takeDraft(): SavedDraft | null {
  try {
    const raw = window.sessionStorage.getItem(KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(KEY)
    const parsed = JSON.parse(raw) as SavedDraft
    if (!parsed || typeof parsed !== 'object' || !parsed.values || typeof parsed.submissionId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try { window.sessionStorage.removeItem(KEY) } catch { /* nothing to clear */ }
}

/** A v4 id for the submission. crypto.randomUUID needs a secure context, so fall back. */
export function newSubmissionId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (c?.getRandomValues) c.getRandomValues(bytes)
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
