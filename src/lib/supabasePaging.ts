/**
 * Reading more than 1000 rows out of PostgREST.
 *
 * THE DEFECT THIS EXISTS TO FIX
 *
 * Supabase's PostgREST enforces a server-side `max-rows` ceiling — 1000 on this
 * project. It is a *cap*, not an error: `.limit(50000)` is silently reduced to
 * 1000 and the response looks completely normal. There is no error field, no
 * warning, and `data.length` is a plausible number.
 *
 * Measured on live data, 2026-07-30, for the Team Performance monthly window:
 *
 *     task_activity_log   requested 100000   received 1000   actual 4100
 *     tasks (completed)   requested  50000   received 1000   actual 1027
 *     tasks (created)     requested  50000   received 1000   actual 1174
 *
 * 75% of the activity log was being discarded. Because PostgREST applies no
 * ORDER BY unless asked, the surviving 1000 rows were the oldest in the window —
 * so the *entire current month* was missing. Every employee therefore showed 0
 * completions and a blank on-time rate, the output pillar (the heaviest, at 50 of
 * 100 points) scored zero for everybody, the whole team averaged 8/100, and all
 * ten employees appeared to be declining. The page was internally consistent and
 * comprehensively wrong.
 *
 * Automated tests did not catch it because they exercise the pure scoring logic
 * with fixtures, and the fixtures were never 1000 rows long. Only reconciling the
 * rendered page against raw database counts exposed it.
 *
 * WHAT STABLE ORDERING DOES AND DOES NOT GUARANTEE
 *
 * `range()` maps to LIMIT/OFFSET, so every caller MUST supply a deterministic
 * `ORDER BY` on a unique column — the primary key is always safe. Without one,
 * Postgres makes no promise about row order between two requests and pages can
 * overlap or leave gaps for no reason at all.
 *
 * **A unique ORDER BY is necessary but NOT sufficient.** OFFSET pagination reads
 * each page in a separate transaction, so it is not a database snapshot:
 *
 *   - A row INSERTED between two pages shifts every later row one position
 *     forward. If it lands before the current offset, one row is skipped.
 *   - A row DELETED between two pages shifts every later row one position back,
 *     which can return the same row twice.
 *   - `id` here is `gen_random_uuid()`, so a new row lands at a *random* ordinal
 *     position rather than at the end. Concurrent writes can therefore disturb
 *     any page boundary, not just the last one.
 *
 * The practical effect is bounded: at worst a handful of rows across a page
 * boundary, against the 3,100 rows the un-paged version was silently discarding.
 * This reduces truncation risk by orders of magnitude; it does not make the read
 * transactionally consistent.
 *
 * Keyset pagination (`.gt('id', lastSeenId)`) would be immune to both cases. It
 * is deliberately not used yet: it would change every call site's query shape,
 * and the reporting windows here are historical, so concurrent writes inside them
 * are rare. Revisit if these reads ever move onto live, actively-mutating ranges.
 *
 * Ordering by `id` rather than by a natural column is fine for the Performance
 * routes specifically: they group rows into maps, and both order-sensitive
 * consumers (`dueDateAsOf` and `buildDailyRiskSeries`) sort by `created_at`
 * themselves.
 */

/** PostgREST's server-side ceiling on rows per response for this project. */
export const POSTGREST_MAX_ROWS = 1000

/**
 * Hard stop on total rows read by one paged fetch.
 *
 * A guard against a runaway loop, not a real expectation: the largest table in
 * play holds ~5,600 rows. If this is ever hit the result is reported as
 * `truncated`, so the caller can say so rather than quietly under-reporting —
 * which is precisely the failure mode this whole file addresses.
 */
export const PAGED_FETCH_ROW_CAP = 100_000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * One retry per page, for transient connection failures.
 *
 * Paging trades one large request for several small ones, which multiplies the
 * chance of hitting a transient abort. Observed live: `TypeError: terminated`
 * (undici's "the connection closed mid-response") on roughly one page load in six
 * once the team route went from 8 requests to ~14. The error panel and its Retry
 * button handled it correctly, but making the owner click Retry every few loads is
 * not an acceptable resting state.
 *
 * Deliberately one retry, not a general backoff policy: a genuine outage should
 * still fail fast and visibly rather than being hidden behind a long retry loop.
 */
const TRANSIENT_RETRIES = 1
const RETRY_DELAY_MS = 250

/**
 * Errors worth one more attempt. Matched on message because supabase-js surfaces
 * fetch-layer failures as plain messages with no code. A schema or permission
 * error must NOT be retried — it will fail identically and only slow the response.
 */
function isTransient(message: string): boolean {
  return /terminated|fetch failed|network|ECONNRESET|ETIMEDOUT|socket hang up|timeout/i.test(message)
}

/**
 * The result of a paged read, as a discriminated union.
 *
 * The failure branch carries **no `rows` property at all**, so
 * `result.rows` is a compile error until `result.ok` has been narrowed. That is
 * the point: the previous shape returned `{ rows, error }` together, and a caller
 * who forgot to check `error` would have silently computed from a partial read —
 * reintroducing, in a new place, exactly the class of defect this file exists to
 * prevent. Partial rows are now discarded rather than handed back.
 *
 * `truncated` lives on the success branch because it is a *complete* read of a
 * capped window, not a failure — but callers must still reject it before using the
 * rows. `unwrapPagedRows` does both checks in one call.
 */
export type PagedFetchResult<T> =
  | {
      ok: true
      rows: T[]
      /** True when PAGED_FETCH_ROW_CAP stopped the read before the data ran out. */
      truncated: boolean
      pages: number
      attempts: number
    }
  | {
      ok: false
      /** The failing page's error message. Rows are deliberately not returned. */
      error: string
      pages: number
      attempts: number
    }

/**
 * Read every row a query matches, one page at a time.
 *
 * `makePage(from, to)` must return a fresh query for each page — a supabase-js
 * builder can only be awaited once — and must carry a deterministic `.order()`
 * on a unique column.
 *
 * Stops on the first short page, so a query matching fewer than `pageSize` rows
 * costs exactly one request and this is a no-op for small reads.
 *
 * Errors are returned, never thrown, matching how the Performance routes already
 * handle a failed read.
 */
export async function fetchAllRows<T>(
  makePage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize: number = POSTGREST_MAX_ROWS,
  rowCap: number = PAGED_FETCH_ROW_CAP,
): Promise<PagedFetchResult<T>> {
  const rows: T[] = []
  let from = 0
  /** Distinct [from, to] windows requested. Retries of the same window do not count. */
  let pages = 0
  /** Every call to makePage, retries included. Always >= pages. */
  let attempts = 0

  for (;;) {
    let data: T[] | null = null
    let error: { message: string } | null = null
    pages++

    for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt++) {
      // A thrown fetch failure is caught too: supabase-js surfaces most as `error`,
      // but a connection abort can escape as an exception.
      try {
        const page = await makePage(from, from + pageSize - 1)
        data = page.data
        error = page.error
      } catch (thrown) {
        data = null
        error = { message: thrown instanceof Error ? thrown.message : String(thrown) }
      }
      attempts++

      if (!error || !isTransient(error.message) || attempt === TRANSIENT_RETRIES) break
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    }

    // Rows read so far are dropped on purpose — see PagedFetchResult.
    if (error) return { ok: false, error: error.message, pages, attempts }

    const page = data ?? []
    rows.push(...page)

    // A short page means the data ran out. This is the normal exit.
    if (page.length < pageSize) return { ok: true, rows, truncated: false, pages, attempts }

    if (rows.length >= rowCap) return { ok: true, rows, truncated: true, pages, attempts }

    from += pageSize
  }
}

/**
 * Error thrown by `unwrapPagedRows`, carrying enough to build a route's message
 * without leaking a database string into a user-facing response by accident: the
 * caller decides what to surface, and `detail` is intended for the server log.
 */
export class PagedReadError extends Error {
  constructor(
    /** Which read failed, in the owner's language — e.g. 'activity log'. */
    readonly label: string,
    readonly reason: 'read_failed' | 'row_cap_exceeded',
    /** Underlying message. Server-side only. */
    readonly detail: string,
  ) {
    super(`${label}: ${reason} — ${detail}`)
    this.name = 'PagedReadError'
  }
}

/**
 * The single supported way to get rows out of a paged read.
 *
 * Rejects both failure modes — a failed page and a capped read — so no route can
 * compute from an incomplete set. Throws rather than returning, because every
 * caller's correct response is the same (refuse) and a returned sentinel is one
 * more thing to forget to check.
 *
 * Both Performance routes go through this, which is what makes their truncation
 * behaviour identical by construction rather than by two similar-looking blocks.
 */
export function unwrapPagedRows<T>(label: string, result: PagedFetchResult<T>): T[] {
  if (!result.ok) {
    throw new PagedReadError(label, 'read_failed', result.error)
  }
  if (result.truncated) {
    throw new PagedReadError(
      label, 'row_cap_exceeded',
      `exceeded the ${PAGED_FETCH_ROW_CAP}-row read cap after ${result.pages} pages`,
    )
  }
  return result.rows
}
