// Announcements — the rules the screens share, kept free of React and Supabase
// so they can be tested directly.
//
// The database decides who may see what and when (see
// supabase/migrations/20270110000000_announcements.sql). What lives here is
// presentation and form logic: the India date the form defaults to, how an
// admin row is labelled, which unread announcements the banner shows, and the
// PDF checks that mirror the bucket so an upload is refused before it starts.

export const ANNOUNCEMENT_BUCKET = 'announcement-files'

/** Mirrors the bucket's file_size_limit. */
export const ANNOUNCEMENT_PDF_MAX_BYTES = 10 * 1024 * 1024

/** Mirrors the table's CHECK constraints. */
export const ANNOUNCEMENT_LIMITS = { title: 120, summary: 280, body: 20000 } as const

/** A new announcement runs for this many days, counting the start day. */
export const ANNOUNCEMENT_DEFAULT_DAYS = 15

/** Signed URLs for the PDF are short-lived; the button asks for a fresh one. */
export const ANNOUNCEMENT_PDF_URL_TTL_SECONDS = 300

/** How many unread announcements the Modules banner lists before "View all". */
export const ANNOUNCEMENT_BANNER_MAX_ROWS = 3

/** One row of public.my_announcements(). */
export type MyAnnouncement = {
  id: string
  title: string
  summary: string
  body: string
  starts_on: string
  ends_on: string
  attachment_path: string | null
  attachment_name: string | null
  attachment_size: number | null
  created_at: string
  read_at: string | null
}

/** An announcement as the admin screen reads it. */
export type AdminAnnouncement = {
  id: string
  title: string
  summary: string
  body: string
  starts_on: string
  ends_on: string
  attachment_path: string | null
  attachment_name: string | null
  attachment_size: number | null
  ended_at: string | null
  created_at: string
  announcement_recipients: { user_id: string }[]
  announcement_reads: { user_id: string; read_at: string }[]
}

// ── India dates ──────────────────────────────────────────────────────────────

/** YYYY-MM-DD in Asia/Kolkata at the given instant. */
export function indiaDate(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at)
}

/** Adds whole days to a YYYY-MM-DD date. Pure calendar arithmetic, no time zone. */
export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + days))
  return t.toISOString().slice(0, 10)
}

/** The form's default window: today in India through day 15, inclusive. */
export function defaultAnnouncementWindow(at: Date = new Date()): { startsOn: string; endsOn: string } {
  const startsOn = indiaDate(at)
  return { startsOn, endsOn: addDays(startsOn, ANNOUNCEMENT_DEFAULT_DAYS - 1) }
}

/** "5 Oct 2026" for a YYYY-MM-DD date. */
export function formatAnnouncementDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

export type AnnouncementStatus = 'scheduled' | 'active' | 'expired' | 'ended'

/**
 * The same rule as public.announcement_is_live, for labelling admin rows.
 * Visibility itself is always the database's decision.
 */
export function announcementStatus(
  a: { starts_on: string; ends_on: string; ended_at: string | null },
  today: string = indiaDate(),
): AnnouncementStatus {
  if (a.ended_at) return 'ended'
  if (today < a.starts_on) return 'scheduled'
  if (today > a.ends_on) return 'expired'
  return 'active'
}

// ── The banner ───────────────────────────────────────────────────────────────

/** What the Modules banner shows: nothing, one announcement, or a count and a short list. */
export function bannerContent(list: MyAnnouncement[]): {
  unread: MyAnnouncement[]
  shown: MyAnnouncement[]
  more: number
} {
  const unread = list.filter(a => !a.read_at)
  const shown = unread.slice(0, ANNOUNCEMENT_BANNER_MAX_ROWS)
  return { unread, shown, more: unread.length - shown.length }
}

// ── The PDF ──────────────────────────────────────────────────────────────────

/** Returns an error to show, or null when the file may be uploaded. */
export function validateAnnouncementPdf(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return 'The selected file is empty.'
  if (file.size > ANNOUNCEMENT_PDF_MAX_BYTES) return 'The PDF must be under 10 MB.'
  const isPdfType = file.type === 'application/pdf'
  const isPdfName = /\.pdf$/i.test(file.name)
  // A reported type must be PDF; a blank type falls back to the extension.
  if (file.type ? !isPdfType : !isPdfName) return 'Only PDF files can be attached.'
  return null
}

/**
 * The object key for a PDF: {announcementId}/{generated}.pdf. The first segment
 * is what the storage policies and create/update_announcement check; the name
 * is generated, never user-controlled.
 */
export function buildAnnouncementPdfPath(announcementId: string, now: number = Date.now()): string {
  return `${announcementId}/${now}_${Math.random().toString(36).slice(2, 10)}.pdf`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The database raises `ANNOUNCEMENT_<CODE>: message`. Show the message part;
 * anything else becomes a generic line rather than a raw Postgres error.
 */
export function announcementErrorMessage(err: unknown, fallback = 'Something went wrong. Please try again.'): string {
  const msg = typeof err === 'object' && err && 'message' in err ? String((err as { message: unknown }).message) : ''
  const m = /ANNOUNCEMENT_[A-Z_]+:\s*(.+)$/.exec(msg)
  return m ? m[1] : fallback
}

// ── Form validation, mirroring the table's constraints ───────────────────────

export type AnnouncementDraft = {
  title: string
  summary: string
  body: string
  startsOn: string
  endsOn: string
  recipientIds: string[]
}

/**
 * `allowPastEnd` is for editing: an expired announcement may be corrected
 * without moving its dates. A new one must end today or later, as
 * create_announcement also insists.
 */
export function validateAnnouncementDraft(
  d: AnnouncementDraft,
  today: string = indiaDate(),
  { allowPastEnd = false }: { allowPastEnd?: boolean } = {},
): string | null {
  if (!d.title.trim()) return 'Add a title.'
  if (d.title.trim().length > ANNOUNCEMENT_LIMITS.title) return `The title must be ${ANNOUNCEMENT_LIMITS.title} characters or fewer.`
  if (!d.summary.trim()) return 'Add a short summary.'
  if (d.summary.trim().length > ANNOUNCEMENT_LIMITS.summary) return `The summary must be ${ANNOUNCEMENT_LIMITS.summary} characters or fewer.`
  if (!d.body.trim()) return 'Add the full text.'
  if (d.body.trim().length > ANNOUNCEMENT_LIMITS.body) return 'The full text is too long.'
  if (!d.startsOn || !d.endsOn) return 'Choose a start and an end date.'
  if (d.endsOn < d.startsOn) return 'The end date must be on or after the start date.'
  if (!allowPastEnd && d.endsOn < today) return 'The end date has already passed.'
  if (d.recipientIds.length === 0) return 'Choose at least one person to show this announcement to.'
  return null
}
