// Month names for payroll period labels.
//
// A payroll period is stored as (payroll_month, payroll_year) and displayed as
// "August 2026" everywhere it appears. Shared so the dashboard, its dialogs and
// the confirmation copy inside them cannot disagree about the spelling.

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** "August 2026" for a 1-based month. */
export function periodLabel(month: number, year: number): string {
  return `${MONTHS[month - 1] ?? month} ${year}`
}

/**
 * A stored instant as "08 Aug 2026, 12:16 PM".
 *
 * `payroll_results.generated_at` is a timestamptz — it has always carried the
 * time; the header simply threw it away and showed the date alone, which made
 * two runs on the same day indistinguishable.
 *
 * PINNED TO ASIA/KOLKATA, deliberately
 * ------------------------------------
 * Without an explicit timeZone, toLocaleString formats in whatever zone the
 * runtime is in: IST in the office, UTC on the server. That is wrong twice over
 * — an admin in Ahmedabad would read a payroll timestamp in UTC if the string
 * were ever produced during a server render, and the same instant would render
 * as two different times depending on where it was formatted. Every other
 * "when" in this application is an Indian business time (see src/lib/istDate),
 * so this one is too, and it does not depend on the host's clock settings.
 *
 * That pinning is also what makes the value hydration-safe: server and client
 * produce the same characters for the same instant. (Payroll Result Detail
 * loads its data client-side, so this string is not part of the server HTML
 * today — the pin means it stays safe if that ever changes.)
 *
 * The meridiem is uppercased because ICU emits "pm" for en-IN, and the rest of
 * the header is not lowercase.
 */
export function formatGeneratedAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null

  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
    timeZone: 'Asia/Kolkata',
  })
    // Some ICU builds separate the meridiem with a narrow no-break space, which
    // is invisible in the source and breaks a naive comparison. Normalised to a
    // plain space so the output is one predictable string.
    .replace(/ /g, ' ')
    .replace(/\b(am|pm)\b/gi, m => m.toUpperCase())
}
