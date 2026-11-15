// ── Route health: evidence for slow navigations and page errors ─────────────
//
// WHY THIS EXISTS. Users report 8–15 second waits and occasional "This page
// couldn't load" screens, and every investigation so far has had to reconstruct
// the moment after the fact. This records just enough to tell, next time, WHERE
// the time went — without recording who, or what they were looking at.
//
// WHAT IS RECORDED, AND NOTHING ELSE
//   * route TEMPLATES, never paths: every id, number and token becomes `:id`,
//     and no query string or hash is kept;
//   * durations in milliseconds, rounded;
//   * whether the page was VISIBLE when the wait started and ended — a hidden
//     tab's timers are throttled, so its durations are not user-facing waits
//     and are marked, not mixed in;
//   * the connection's effective type and round-trip estimate, when the browser
//     offers them;
//   * the deployment id the page was built with (so a tab left open across a
//     deploy is visible as such);
//   * for an error: its message ONLY when it is a known browser / React / Next /
//     database message (safeErrorMessage) — otherwise just its type — and the
//     script FILE name it came from.
//
// No user id, email, name, record content, cookie or URL parameter is ever sent.
// The server writes one log line per report (src/app/api/client-health) and
// stores nothing; the device keeps its own copy (appendLocalEvidence). All of
// this is pure so the privacy rules are testable.
//
// ONE REPORT, AS LOGGED (≈ 330 bytes):
//   [client-health] {"kind":"navigation","from":"/finance","to":"/orders/:id",
//   "durationMs":9000,"contentMs":9500,"stalled":false,"visibleAtStart":true,
//   "visibleAtEnd":true,"hardLoad":false,"network":{"effectiveType":"4g",
//   "rttMs":150},"deployment":"dpl_…","device":"mobile"}

export const LONG_NAVIGATION_MS = 5000
export const STALLED_NAVIGATION_MS = 8000
/** Content that has not settled by now is reported as never settling. */
export const CONTENT_GIVE_UP_MS = 60000
/** The page must show no loading marker for this long to count as settled. */
export const CONTENT_QUIET_MS = 400
/** Per browser tab, counted across reloads (sessionStorage). */
export const MAX_REPORTS_PER_TAB = 20
export const MAX_REPORT_BYTES = 2048
/**
 * Per server instance. A flood (a loop, or somebody posting by hand) costs at
 * most this many log lines a minute per instance; the rest are counted and
 * summarised in one line.
 */
export const SERVER_MAX_LINES_PER_MINUTE = 60

/**
 * A per-minute allowance of log lines. Returns take(now): true while lines are
 * left this minute. When a new minute starts after some were refused, the
 * count is reported once through `summary`.
 */
export function lineBudget(perMinute: number, summary: (line: string) => void): (now: number) => boolean {
  let windowStart = -Infinity, used = 0, dropped = 0
  return (now: number) => {
    if (now - windowStart >= 60_000) {
      if (dropped > 0) summary(JSON.stringify({ kind: 'dropped', count: dropped }))
      windowStart = now; used = 0; dropped = 0
    }
    if (used >= perMinute) { dropped++; return false }
    used++
    return true
  }
}

// ── Keeping the evidence ────────────────────────────────────────────────────
// This Vercel team is on the Hobby plan, whose runtime logs are kept for ONE
// HOUR (vercel.com/docs/logs/runtime → Limits). An incident reported the next
// morning would have no log line left. So the same whitelisted reports are also
// kept on the device that saw them — the last LOCAL_EVIDENCE_MAX, for
// LOCAL_EVIDENCE_DAYS — and /diagnostics shows them with a Copy button.
export const LOCAL_EVIDENCE_KEY = 'boe_route_health_v1'
export const LOCAL_EVIDENCE_MAX = 30
export const LOCAL_EVIDENCE_DAYS = 7

export type StoredReport = { at: string; report: RouteHealthReport }

/** The kept list after adding one report: newest last, capped, old ones dropped. */
export function appendLocalEvidence(previous: unknown, report: RouteHealthReport, now: Date): StoredReport[] {
  const cutoff = now.getTime() - LOCAL_EVIDENCE_DAYS * 86_400_000
  const kept = readLocalEvidence(previous).filter(e => Date.parse(e.at) >= cutoff)
  kept.push({ at: now.toISOString(), report })
  return kept.slice(-LOCAL_EVIDENCE_MAX)
}

/** Whatever was stored, re-validated through the same whitelist. */
export function readLocalEvidence(stored: unknown): StoredReport[] {
  if (!Array.isArray(stored)) return []
  const out: StoredReport[] = []
  for (const e of stored) {
    if (!e || typeof e !== 'object') continue
    const at = (e as { at?: unknown }).at
    const report = parseRouteHealthReport((e as { report?: unknown }).report)
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at)) && report) out.push({ at, report })
  }
  return out.slice(-LOCAL_EVIDENCE_MAX)
}

/**
 * What "still loading" looks like in this app: the shared LoadingScreen, any
 * aria-busy region, the order-document loader, and the first-open daily quote
 * (it covers the page, so nothing behind it is usable yet).
 */
export const LOADING_SELECTOR = [
  '.boe-loading', '.boe-loading-spinner', '[aria-busy="true"]', '.order-doc-loading', '[aria-label="Daily quote"]',
].join(', ')
/** A bare loading label, e.g. "Loading…", with nothing else in the element. */
export const LOADING_TEXT = /^Loading(\.{3}|…)?$/

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** `/orders/5ca4…?returnTo=x` → `/orders/:id`. Never keeps a query or hash. */
export function routeTemplate(pathname: string): string {
  const path = (pathname || '/').split(/[?#]/)[0]
  const segments = path.split('/').map(seg => {
    if (seg === '') return seg
    if (UUID.test(seg)) { UUID.lastIndex = 0; return ':id' }
    UUID.lastIndex = 0
    if (/^\d+$/.test(seg)) return ':id'                       // order numbers, years
    if (/^[A-Za-z0-9_-]{20,}$/.test(seg)) return ':id'         // tokens, share codes
    if (/[0-9]/.test(seg) && /^[A-Z0-9-]{4,}$/i.test(seg) && /[A-Z]/i.test(seg) && /\d{2,}/.test(seg)) return ':id' // codes like PID-00001, 526-BE001
    if (seg.includes('@')) return ':id'
    return seg.length > 40 ? ':id' : seg
  })
  const t = segments.join('/') || '/'
  return t.length > 120 ? t.slice(0, 120) : t
}

/**
 * `/orders/5ca4…` with params `{ id: '5ca4…' }` → `/orders/:id`, using the
 * route's OWN parameters (Next's useParams), so a product code, share token or
 * any other dynamic segment is replaced exactly — not guessed. The heuristics
 * in routeTemplate still run afterwards as a second net.
 */
export function templateFromParams(pathname: string, params: Record<string, string | string[] | undefined> | null | undefined): string {
  const path = (pathname || '/').split(/[?#]/)[0]
  const byValue = new Map<string, string>()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (!/^[A-Za-z_][\w]{0,40}$/.test(key)) continue
    for (const v of Array.isArray(value) ? value : value == null ? [] : [value]) if (v) byValue.set(v, `:${key}`)
  }
  const segments = path.split('/').map(seg => {
    if (seg === '') return seg
    let decoded = seg
    try { decoded = decodeURIComponent(seg) } catch { /* keep the raw segment */ }
    return byValue.get(decoded) ?? byValue.get(seg) ?? seg
  })
  return routeTemplate(segments.join('/') || '/')
}

/**
 * Error messages that are KNOWN to be written by the browser, React, Next or
 * the database — their variable parts are code identifiers, not people's data.
 * Anything else (an app-thrown message could hold a customer name or amount)
 * is replaced by its error type alone.
 */
const SAFE_MESSAGES: RegExp[] = [
  /^[\w$.[\]'"()? ]{1,120} is not (a function|defined|iterable|a constructor|an object)$/,
  /^Cannot (read|set) properties of (undefined|null) \((reading|setting) '[\w$]{1,60}'\)$/,
  /^Cannot access '[\w$]{1,60}' before initialization$/,
  /^Assignment to constant variable\.?$/,
  /^Maximum call stack size exceeded$/,
  /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?|Network request failed)$/,
  /^(The operation was aborted\.?|signal is aborted without reason|The user aborted a request\.?|This operation was aborted)$/,
  /^(Loading (CSS )?chunk [\w:-]{1,40} failed\.?|ChunkLoadError|Failed to load chunk)( \([^)]{0,80}\))?.{0,40}$/,
  /^Minified React error #\d{1,4}; visit :url for the full message.{0,120}$/,
  /^(Hydration failed|Text content does not match server-rendered HTML|There was an error while hydrating)\b.{0,160}$/,
  /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)\.?$/,
  /^new row violates row-level security policy for table "\w{1,63}"$/,
  /^permission denied for (table|relation|function|schema|sequence) [\w.]{1,63}$/,
  /^JWT expired$/,
  /^[A-Z]\w{0,40}: \(message withheld\)$/,
]

/** Fixed wording for engine messages that quote the text they failed on. */
const NORMALISED: Array<[RegExp, string]> = [
  [/^Unexpected token\b/, 'Unexpected token (response was not JSON)'],
  [/is not valid JSON$/, 'Unexpected token (response was not JSON)'],
  [/^Unexpected end of JSON input$/, 'Unexpected end of JSON input'],
]

/** The message if it is one of the known kinds above; otherwise only its type. */
export function safeErrorMessage(message: unknown, name?: unknown): string {
  const s = scrubMessage(message)
  for (const [re, fixed] of NORMALISED) if (re.test(s)) return fixed
  if (SAFE_MESSAGES.some(re => re.test(s))) return s
  const type = typeof name === 'string' && /^[A-Z]\w{0,40}$/.test(name) ? name : 'Error'
  return `${type}: (message withheld)`
}

/** An error message with anything identifying removed, and a hard length cap. */
export function scrubMessage(message: unknown): string {
  let s = typeof message === 'string' ? message : String(message ?? '')
  s = s.replace(UUID, ':id')
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ':email')
  s = s.replace(/https?:\/\/\S+/g, ':url')
  s = s.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, ':token')
  s = s.replace(/\b[A-Za-z0-9_-]{24,}\b/g, ':token')
  s = s.replace(/\d{4,}/g, ':n')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > 200 ? s.slice(0, 200) : s
}

/** `https://…/_next/static/chunks/0cgnk1q34yg_u.js?dpl=…:1:2635` → `0cgnk1q34yg_u.js`. */
export function scriptFile(source: unknown): string | null {
  if (typeof source !== 'string' || source === '') return null
  const file = source.split(/[?#]/)[0].split('/').pop() ?? ''
  const name = file.replace(/:\d+(:\d+)?$/, '')
  return /^[\w.~-]{1,80}$/.test(name) ? name : null
}

export type NetworkHint = { effectiveType: string | null; rttMs: number | null }

export type NavigationReport = {
  kind: 'navigation'
  from: string
  to: string
  /** Intent (click / back) → the new route painted. null when it never arrived. */
  durationMs: number | null
  /** Intent → the route showing no loading marker. null when it never settled. */
  contentMs: number | null
  /** No route change by STALLED_NAVIGATION_MS, or content never settled. */
  stalled: boolean
  visibleAtStart: boolean
  visibleAtEnd: boolean
  hardLoad: boolean
  network: NetworkHint
  deployment: string | null
}

export type DocumentReport = {
  kind: 'document'
  route: string
  /** Navigation start → the app's first route paint. */
  firstRouteMs: number
  /** Navigation start → no loading marker (incl. the daily quote). null = never. */
  contentMs: number | null
  responseEndMs: number | null
  visible: boolean
  network: NetworkHint
  deployment: string | null
}

export type ErrorReport = {
  kind: 'error'
  route: string
  message: string
  file: string | null
  visible: boolean
  deployment: string | null
}

export type RouteHealthReport = NavigationReport | DocumentReport | ErrorReport

const round = (n: number) => Math.max(0, Math.round(n))

export function navigationReport(input: {
  fromPath: string; toPath: string; startedAt: number; endedAt: number | null
  /** When the page stopped showing loading markers; null = never (or not yet). */
  contentAt?: number | null
  visibleAtStart: boolean; visibleAtEnd: boolean; hardLoad: boolean
  network: NetworkHint; deployment: string | null
}): NavigationReport | null {
  const duration = input.endedAt == null ? null : round(input.endedAt - input.startedAt)
  const content = input.contentAt == null ? null : round(input.contentAt - input.startedAt)
  const stalled = duration == null || content == null
  // Only waits long enough to matter are worth a report.
  const longest = Math.max(duration ?? 0, content ?? 0)
  if (!stalled && longest < LONG_NAVIGATION_MS) return null
  return {
    kind: 'navigation',
    from: routeTemplate(input.fromPath),
    to: routeTemplate(input.toPath),
    durationMs: duration,
    contentMs: content,
    stalled,
    visibleAtStart: input.visibleAtStart,
    visibleAtEnd: input.visibleAtEnd,
    hardLoad: input.hardLoad,
    network: cleanNetwork(input.network),
    deployment: cleanDeployment(input.deployment),
  }
}

export function documentReport(input: {
  path: string; firstRouteMs: number; contentMs?: number | null; responseEndMs: number | null; visible: boolean
  network: NetworkHint; deployment: string | null
}): DocumentReport | null {
  const content = input.contentMs == null ? null : round(input.contentMs)
  if (content != null && Math.max(input.firstRouteMs, content) < LONG_NAVIGATION_MS) return null
  return {
    kind: 'document',
    route: routeTemplate(input.path),
    firstRouteMs: round(input.firstRouteMs),
    contentMs: content,
    responseEndMs: input.responseEndMs == null ? null : round(input.responseEndMs),
    visible: input.visible,
    network: cleanNetwork(input.network),
    deployment: cleanDeployment(input.deployment),
  }
}

export function errorReport(input: {
  path: string; message: unknown; name?: unknown; source: unknown; visible: boolean; deployment: string | null
}): ErrorReport {
  return {
    kind: 'error',
    route: routeTemplate(input.path),
    message: safeErrorMessage(input.message, input.name),
    file: scriptFile(input.source),
    visible: input.visible,
    deployment: cleanDeployment(input.deployment),
  }
}

function cleanNetwork(n: NetworkHint | null | undefined): NetworkHint {
  const t = n?.effectiveType
  return {
    effectiveType: typeof t === 'string' && /^(slow-2g|2g|3g|4g)$/.test(t) ? t : null,
    rttMs: typeof n?.rttMs === 'number' && Number.isFinite(n.rttMs) ? round(Math.min(n.rttMs, 60000)) : null,
  }
}

function cleanDeployment(d: unknown): string | null {
  return typeof d === 'string' && /^dpl_[A-Za-z0-9]{8,40}$/.test(d) ? d : null
}

/**
 * The server's whitelist. Anything not exactly one of the three shapes above —
 * extra keys, wrong types, unscrubbed ids — is dropped rather than logged.
 * Values are re-cleaned here, so a hand-made request cannot smuggle data in.
 */
export function parseRouteHealthReport(body: unknown): RouteHealthReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  const bool = (v: unknown) => v === true
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 3_600_000 ? Math.round(v) : null
  const net = (v: unknown): NetworkHint => {
    const o = (v && typeof v === 'object') ? v as Record<string, unknown> : {}
    return cleanNetwork({ effectiveType: typeof o.effectiveType === 'string' ? o.effectiveType : null, rttMs: typeof o.rttMs === 'number' ? o.rttMs : null })
  }
  const route = (v: unknown) => routeTemplate(typeof v === 'string' ? v : '/')
  if (b.kind === 'navigation') {
    const duration = b.durationMs === null ? null : num(b.durationMs)
    if (duration === null && b.durationMs !== null) return null
    const content = b.contentMs == null ? null : num(b.contentMs)
    return { kind: 'navigation', from: route(b.from), to: route(b.to), durationMs: duration, contentMs: content, stalled: bool(b.stalled),
      visibleAtStart: bool(b.visibleAtStart), visibleAtEnd: bool(b.visibleAtEnd), hardLoad: bool(b.hardLoad),
      network: net(b.network), deployment: cleanDeployment(b.deployment) }
  }
  if (b.kind === 'document') {
    const first = num(b.firstRouteMs)
    if (first === null) return null
    return { kind: 'document', route: route(b.route), firstRouteMs: first, contentMs: b.contentMs == null ? null : num(b.contentMs), responseEndMs: num(b.responseEndMs),
      visible: bool(b.visible), network: net(b.network), deployment: cleanDeployment(b.deployment) }
  }
  if (b.kind === 'error') {
    return { kind: 'error', route: route(b.route), message: safeErrorMessage(b.message), file: scriptFile(b.file),
      visible: bool(b.visible), deployment: cleanDeployment(b.deployment) }
  }
  return null
}
