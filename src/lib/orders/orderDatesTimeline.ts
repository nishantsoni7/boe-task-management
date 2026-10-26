// ── THE ORDER'S DATES, AS A TIMELINE ─────────────────────────────────────────
//
// Confirmed -> PI uploaded -> PI approved -> Due. Two things are worked out
// here so the screen only draws them: how many days passed between the date
// Sales confirmed the order and the day the PI was uploaded (a long gap usually
// means a mistyped confirm date, so it is flagged), and where "today" sits
// between the upload and the due date.
//
// Pure and display-only: it states what the record holds and decides nothing.

/** A confirm-to-upload gap longer than this many days is flagged to the reader. */
export const CONFIRM_TO_UPLOAD_FLAG_DAYS = 7

const DAY_MS = 86_400_000

/** A calendar day in India (the business's day) as a UTC-midnight number, or null. */
function istDay(value: string | null | undefined): number | null {
  if (!value) return null
  const text = value.trim()
  if (text === '') return null
  // A bare date ('2026-09-26') is already a day; a timestamp is read in IST.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return Date.parse(`${text}T00:00:00Z`)
  const ms = Date.parse(text)
  if (Number.isNaN(ms)) return null
  const day = new Date(ms + 330 * 60_000).toISOString().slice(0, 10)
  return Date.parse(`${day}T00:00:00Z`)
}

export type OrderDatesTimeline = {
  /** Days from the confirm date to the upload day; negative = uploaded before it. Null when either is unknown. */
  uploadGapDays: number | null
  /** True when the PI went up more than CONFIRM_TO_UPLOAD_FLAG_DAYS after the confirm date. */
  gapFlagged: boolean
  /** Whole days since the PI was uploaded (never below 0), or null. */
  daysSinceUpload: number | null
  /** Days until the due date; negative = overdue; null when there is no due date. */
  daysToDue: number | null
  /** 0–100: how far today is between the upload day and the due date, or null when it cannot be told. */
  progressPercent: number | null
}

export function orderDatesTimeline(input: {
  confirmDate: string | null | undefined
  uploadedAt: string | null | undefined
  dueDate: string | null | undefined
  now?: Date
}): OrderDatesTimeline {
  const confirm = istDay(input.confirmDate)
  const upload = istDay(input.uploadedAt)
  const due = istDay(input.dueDate)
  const today = istDay((input.now ?? new Date()).toISOString())

  const uploadGapDays = confirm !== null && upload !== null ? Math.round((upload - confirm) / DAY_MS) : null
  const daysSinceUpload = upload !== null && today !== null ? Math.max(0, Math.round((today - upload) / DAY_MS)) : null
  const daysToDue = due !== null && today !== null ? Math.round((due - today) / DAY_MS) : null

  let progressPercent: number | null = null
  if (upload !== null && due !== null && today !== null) {
    const span = due - upload
    progressPercent = span <= 0 ? 100 : Math.min(100, Math.max(0, Math.round(((today - upload) / span) * 100)))
  }
  return {
    uploadGapDays,
    gapFlagged: uploadGapDays !== null && uploadGapDays > CONFIRM_TO_UPLOAD_FLAG_DAYS,
    daysSinceUpload,
    daysToDue,
    progressPercent,
  }
}

/** "30 days after the confirm date", for the flag beside the upload date. */
export function uploadGapLabel(days: number): string {
  return `${days} day${days === 1 ? '' : 's'} after the confirm date`
}

/** "17 days left", "due today", "3 days overdue". */
export function dueCountdownLabel(daysToDue: number): string {
  if (daysToDue === 0) return 'Due today'
  if (daysToDue > 0) return `${daysToDue} day${daysToDue === 1 ? '' : 's'} left`
  const late = -daysToDue
  return `${late} day${late === 1 ? '' : 's'} overdue`
}
