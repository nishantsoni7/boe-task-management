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
 * PAGINATION REQUIRES A TOTAL ORDER
 *
 * `range()` maps to LIMIT/OFFSET. Without a deterministic ORDER BY, Postgres does
 * not promise a stable row order between the two requests, so rows can be
 * silently skipped or duplicated across page boundaries. Every caller must order
 * by something unique — the primary key is always safe.
 *
 * Ordering by `id` is fine for the Performance routes specifically: they group
 * rows into maps and both order-sensitive consumers (`dueDateAsOf` and
 * `buildDailyRiskSeries`) sort by `created_at` themselves.
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

export type PagedFetchResult<T> = {
  rows: T[]
  /** First error encountered, or null. */
  error: string | null
  /** True when PAGED_FETCH_ROW_CAP stopped the read before the data ran out. */
  truncated: boolean
  /** How many round trips it took — asserted by the query-shape guard. */
  requests: number
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
  let requests = 0

  for (;;) {
    let data: T[] | null = null
    let error: { message: string } | null = null

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
      requests++

      if (!error || !isTransient(error.message) || attempt === TRANSIENT_RETRIES) break
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
    }

    if (error) return { rows, error: error.message, truncated: false, requests }

    const page = data ?? []
    rows.push(...page)

    // A short page means the data ran out. This is the normal exit.
    if (page.length < pageSize) return { rows, error: null, truncated: false, requests }

    if (rows.length >= rowCap) return { rows, error: null, truncated: true, requests }

    from += pageSize
  }
}
