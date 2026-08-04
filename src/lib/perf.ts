// Development-only timing instrumentation.
//
// Off by default everywhere. Turn it on with:
//   NEXT_PUBLIC_BOE_PERF_DEBUG=true   (browser — client components, hooks)
//   BOE_PERF_DEBUG=true               (server — route handlers)
//
// Both flags are read once at module load. In a production build with neither
// set, `perfStart` returns a shared no-op closure and nothing is measured,
// allocated, or logged — so leaving instrumentation calls in place costs
// nothing in normal use.
//
// PRIVACY: this utility records an action name, a phase name, and elapsed
// milliseconds. It never accepts or logs a payload, so task descriptions,
// comment bodies, attachment file names, notification content and user
// identifiers cannot leak through it. Callers must keep phase names static —
// `mark('upload')`, never `mark(file.name)`.

/**
 * Stable action names. Keeping this a closed union means a log line always
 * refers to the same user-visible operation across releases, so timings stay
 * comparable — a free-form string would drift and fragment the logs.
 */
export type PerfAction =
  | 'task.list.load'
  | 'task.detail.load'
  | 'task.create'
  | 'task.edit'
  | 'task.comment.add'
  | 'task.comment.delete'
  | 'task.attachment.upload'
  | 'task.status.update'
  | 'task.complete'
  | 'task.restore'
  | 'task.delete'
  | 'notification.list.load'
  | 'notification.delete.single'
  | 'notification.delete.selected'
  | 'notification.delete.all'
  | 'notification.mark.read'
  | 'navigation.task-detail'

/** A total above this is flagged — the threshold the audit treats as "slow". */
export const PERF_TOTAL_WARN_MS = 1000
/** An individual phase above this is flagged. */
export const PERF_PHASE_WARN_MS = 500

export type PerfPhase = {
  name: string
  ms: number
  /** True when this phase alone exceeded PERF_PHASE_WARN_MS. */
  slow: boolean
}

export type PerfReport = {
  action: PerfAction
  totalMs: number
  /** True when the total exceeded PERF_TOTAL_WARN_MS. */
  slow: boolean
  /** True when the total OR any single phase crossed its threshold. */
  flagged: boolean
  phases: PerfPhase[]
}

/** Rounded to 0.1 ms — sub-tenth-of-a-millisecond precision is noise here. */
const round = (ms: number) => Math.round(ms * 10) / 10

/**
 * Assemble a report from raw measurements. Pure — no clock, no environment, no
 * I/O — which is what makes the thresholds and formatting directly testable.
 */
export function buildPerfReport(
  action: PerfAction,
  totalMs: number,
  phases: { name: string; ms: number }[],
): PerfReport {
  const builtPhases: PerfPhase[] = phases.map(p => ({
    name: p.name,
    ms: round(p.ms),
    slow: p.ms > PERF_PHASE_WARN_MS,
  }))
  const slow = totalMs > PERF_TOTAL_WARN_MS
  return {
    action,
    totalMs: round(totalMs),
    slow,
    flagged: slow || builtPhases.some(p => p.slow),
    phases: builtPhases,
  }
}

/**
 * One-line rendering of a report. `!` marks the total or a phase that crossed
 * its threshold, so a slow action is greppable in a console full of logs.
 */
export function formatPerfReport(report: PerfReport): string {
  const head = `[perf] ${report.action} ${report.totalMs}ms${report.slow ? ' !SLOW' : ''}`
  if (report.phases.length === 0) return head
  const body = report.phases.map(p => `${p.name}=${p.ms}ms${p.slow ? '!' : ''}`).join(' ')
  return `${head} — ${body}`
}

/** Injectable seams so tests can drive the tracker without a real clock or console. */
export type PerfOptions = {
  enabled?: boolean
  now?: () => number
  sink?: (report: PerfReport, line: string) => void
}

export type PerfTracker = {
  /** Close the current phase and open one named `name`. */
  mark: (name: string) => void
  /** Close the final phase, emit the report, and return it (null when disabled). */
  end: () => PerfReport | null
}

const isBrowser = typeof window !== 'undefined'

const clientEnabled = process.env.NEXT_PUBLIC_BOE_PERF_DEBUG === 'true'
const serverEnabled = process.env.BOE_PERF_DEBUG === 'true'

/** True when instrumentation is on for whichever side this module loaded in. */
export const perfEnabled = isBrowser ? clientEnabled : serverEnabled

/**
 * High-resolution clock. `performance.now()` on the client; on the server
 * Node's `perf_hooks`-backed global `performance` (Node 16+) with a
 * `Date.now()` fallback so a non-standard runtime degrades instead of throwing.
 */
export function perfNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

const defaultSink = (report: PerfReport, line: string) => {
  if (report.flagged) console.warn(line)
  else console.info(line)
}

/** Shared no-op so the disabled path allocates nothing per call. */
const NOOP_TRACKER: PerfTracker = { mark: () => {}, end: () => null }

/**
 * Start timing an action.
 *
 *   const perf = perfTrack('task.detail.load')
 *   ...
 *   perf.mark('queries')     // closes the implicit first phase
 *   ...
 *   perf.end()
 *
 * Returns a no-op tracker when instrumentation is disabled, so call sites need
 * no environment checks of their own.
 */
export function perfTrack(action: PerfAction, opts: PerfOptions = {}): PerfTracker {
  const enabled = opts.enabled ?? perfEnabled
  if (!enabled) return NOOP_TRACKER

  const now  = opts.now ?? perfNow
  const sink = opts.sink ?? defaultSink

  const start = now()
  let phaseStart = start
  let pendingName: string | null = null
  const phases: { name: string; ms: number }[] = []
  let ended = false

  return {
    mark(name: string) {
      if (ended) return
      const at = now()
      if (pendingName !== null) phases.push({ name: pendingName, ms: at - phaseStart })
      pendingName = name
      phaseStart = at
    },
    end() {
      if (ended) return null
      ended = true
      const at = now()
      if (pendingName !== null) phases.push({ name: pendingName, ms: at - phaseStart })
      const report = buildPerfReport(action, at - start, phases)
      sink(report, formatPerfReport(report))
      return report
    },
  }
}

/**
 * Shorthand for an action with no internal phases: `const done = perfStart(x)`
 * … `done()`. Safe to call unconditionally — disabled builds get a no-op.
 */
export function perfStart(action: PerfAction, opts: PerfOptions = {}): () => PerfReport | null {
  const tracker = perfTrack(action, opts)
  return () => tracker.end()
}
