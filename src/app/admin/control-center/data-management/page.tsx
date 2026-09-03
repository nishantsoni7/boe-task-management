'use client'

// Admin Control Center → Data Management → Order & Finance Test Data Cleanup.
//
// WHY THIS IS A SEPARATE PAGE FROM TEST DATA CLEANUP
// ---------------------------------------------------
// They answer different questions. Test Data Cleanup removes ONE finalized test
// transaction, found by searching for it. This clears a MODULE, and there is
// nothing to search for — the scope is "all of it", and the only meaningful
// question is which half.
//
// NOTHING HERE IS A SECURITY BOUNDARY. control-center/layout.tsx already
// admin-guards this subtree, /api/orders/test-data-reset re-derives the admin
// check with the service role before it uses it for anything else, and every
// RPC checks admin, the enabled flag, the scope, the reason, the exact phrase
// and the plan hash again inside the database. This page's job is to make the
// consequences legible before an administrator commits.
//
// AND IT IS NOT ALARMING UNTIL IT NEEDS TO BE. The page opens on two ordinary
// cards. Red appears once — on the final confirmation — because a screen that
// shouts from the first pixel teaches people to click through shouting.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { cc, CcSection, CcDialog, CcField } from '@/components/controlCenter/CcPrimitives'
import {
  NUMBER_RESET_ACKNOWLEDGEMENT,
  RESET_ACKNOWLEDGEMENT,
  RESET_CONFIRMATION,
  RESET_NUMBERING_NOTE,
  RESET_REMOVES,
  RESET_RETAINS,
  RESET_SCOPES,
  RESET_STAGE_LABEL,
  RESET_TITLE,
  canOfferNumberReset,
  describeResetFailure,
  formatStorageSize,
  orderedCounts,
  previewIsEmpty,
  readyToRun,
  stageFromClaim,
  stagesFor,
  type ResetCounts,
  type ResetFailure,
  type ResetScope,
  type ResetStage,
} from '@/lib/orders/testDataReset'

/** The only red on the page, and only on the act itself. */
const btnDanger = 'boe-btn boe-btn-danger'

type Preview = {
  scope: ResetScope
  counts: ResetCounts
  blocking: { kind: string; label?: string; reason?: string }[]
  retained: Record<string, number>
  planHash: string | null
}

type ActiveReset = {
  active: boolean
  scope?: ResetScope
  started_at?: string
  started_by?: string
  mine?: boolean
  stage?: string
  failure?: string | null
  reason?: string
  census?: ResetCounts
}

type RunResult = {
  scope: ResetScope
  deleted: Record<string, number>
  confirmedRemovedFiles: number
  numbering: { previous_next?: number; new_next?: number } | null
  numberingRefused: string | null
}

export default function DataManagementPage() {
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')

  /** The project this page is pointed at. Null means it could not be identified. */
  const [projectRef, setProjectRef] = useState<string | null>(null)
  const [existing, setExisting] = useState<ActiveReset | null>(null)

  const [scope, setScope] = useState<ResetScope | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [reason, setReason] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [typed, setTyped] = useState('')
  const [resetNumbers, setResetNumbers] = useState(false)
  const [numbersAcknowledged, setNumbersAcknowledged] = useState(false)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<ResetStage | null>(null)
  const [failure, setFailure] = useState<ResetFailure | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)

  /**
   * The in-flight guard, in a ref as well as in state.
   *
   * State is what disables the button; the ref is what stops a second call that
   * a double click starts before React has re-rendered.
   */
  const runningRef = useRef(false)

  const post = useCallback(async (payload: Record<string, unknown>) => {
    const response = await fetch('/api/orders/test-data-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    return { ok: response.ok && body?.ok === true, body }
  }, [])

  const loadStatus = useCallback(async () => {
    const { ok, body } = await post({ action: 'status' })
    if (!ok) {
      setLoadErr(describeResetFailure(body?.code).message)
      setLoading(false)
      return
    }
    setProjectRef(typeof body?.projectRef === 'string' ? body.projectRef : null)
    const status = body?.status as ActiveReset | null
    setExisting(status?.active ? status : null)
    setLoading(false)
  }, [post])

  // Identity and the admin check are owned by control-center/layout.tsx; this
  // page mounts only for an admitted administrator. The status call re-derives
  // admin on the server from the cookie session, exactly as it always did.
  //
  // A FETCH IS STARTED HERE; NO STATE IS SET HERE. Every setState inside
  // loadStatus runs after its first await, so this effect performs no
  // synchronous state update. react-hooks/set-state-in-effect is static and
  // cannot see through the await, so the call goes through a named local —
  // the same shape the customer-reviews screens use for a fetch-on-mount.
  useEffect(() => {
    const startFetch = () => { void loadStatus() }
    startFetch()
  }, [loadStatus])

  /** Choosing a card, or changing the choice, invalidates everything below it. */
  const chooseScope = async (next: ResetScope) => {
    setScope(next)
    setPreview(null)
    setTyped('')
    setAcknowledged(false)
    setResetNumbers(false)
    setNumbersAcknowledged(false)
    setFailure(null)
    setResult(null)
    setPreviewing(true)
    const { ok, body } = await post({ action: 'preview', scope: next })
    setPreviewing(false)
    if (!ok) { setFailure(describeResetFailure(body?.code, undefined)); return }
    setPreview({
      scope: next,
      counts: (body?.counts ?? {}) as ResetCounts,
      blocking: (body?.blocking ?? []) as Preview['blocking'],
      retained: (body?.retained ?? {}) as Record<string, number>,
      planHash: typeof body?.planHash === 'string' ? body.planHash : null,
    })
  }

  const intent = {
    scope,
    acknowledged,
    typed,
    reason,
    planHash: preview?.planHash ?? null,
  }
  const blocked = (preview?.blocking.length ?? 0) > 0
  const canConfirm = readyToRun(intent) && !blocked && projectRef !== null
    && (!resetNumbers || numbersAcknowledged)

  const run = useCallback(async () => {
    if (!scope || !preview?.planHash || runningRef.current) return
    runningRef.current = true
    setRunning(true)
    setFailure(null)
    setConfirmOpen(false)
    setStage('preparing')

    try {
      setStage('freezing')
      const { ok, body } = await post({
        action: 'run',
        scope,
        reason,
        confirmation: typed,
        planHash: preview.planHash,
        resetOrderNumbers: resetNumbers,
      })

      if (!ok) {
        const detail = (body?.detail as { blockers?: unknown } | undefined)
        setFailure(describeResetFailure(body?.code, detail))
        setStage(null)
        // A refusal may mean the numbers on screen are out of date. Re-read them
        // so what is shown is what is true, and re-read the cleanup state so an
        // interrupted reset becomes resumable without a page reload.
        await loadStatus()
        if (scope) {
          const again = await post({ action: 'preview', scope })
          if (again.ok) {
            setPreview({
              scope,
              counts: (again.body?.counts ?? {}) as ResetCounts,
              blocking: (again.body?.blocking ?? []) as Preview['blocking'],
              retained: (again.body?.retained ?? {}) as Record<string, number>,
              planHash: typeof again.body?.planHash === 'string' ? again.body.planHash : null,
            })
            setTyped('')
          }
        }
        return
      }

      setStage('verifying')
      setResult({
        scope,
        deleted: (body?.deleted ?? {}) as Record<string, number>,
        confirmedRemovedFiles: Number(body?.confirmedRemovedFiles ?? 0),
        numbering: (body?.numbering ?? null) as RunResult['numbering'],
        numberingRefused: typeof body?.numberingRefused === 'string' ? body.numberingRefused : null,
      })
      setStage('completed')
      setPreview(null)
      setScope(null)
      setTyped('')
      setReason('')
      setAcknowledged(false)
      setResetNumbers(false)
      setNumbersAcknowledged(false)
      await loadStatus()
    } catch {
      setFailure(describeResetFailure('RESET_FAILED'))
      setStage(null)
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }, [scope, preview, reason, typed, resetNumbers, post, loadStatus, runningRef])

  const counts = preview ? orderedCounts(preview.counts) : []
  const storageBytes = typeof preview?.counts.storage_bytes === 'number'
    ? preview.counts.storage_bytes : null

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <ControlCenterSkeleton />

  if (loadErr) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{loadErr}</div>
        <button className="boe-btn boe-btn-ghost" onClick={() => { setLoading(true); void loadStatus() }}>
          Retry
        </button>
      </CcSection>
    )
  }

  return (
    <>
      <div style={{ maxWidth: 900 }}>
        <ProjectBanner projectRef={projectRef} />

        {existing && (
          <InterruptedNotice
            existing={existing}
            onResume={() => { if (existing.scope) void chooseScope(existing.scope) }}
          />
        )}

        {result && <ResultSummary result={result} />}

        <CcSection
          title="Choose what to clear"
          description="Each option lists exactly what it removes and what it leaves alone. Reviewing shows live counts; nothing is deleted until the final confirmation."
        >
          <div className={cc.quick} style={{ marginBottom: 0 }}>
            {RESET_SCOPES.map(option => (
              <ScopeCard
                key={option}
                scope={option}
                chosen={scope === option}
                busy={previewing || running}
                onChoose={() => void chooseScope(option)}
              />
            ))}
          </div>
        </CcSection>

        {scope && previewing && !preview && <ControlCenterSkeleton />}

        {scope && preview && (
          <CcSection title={`${RESET_TITLE[scope]} — what is in scope right now`}>
            {blocked ? (
              <BlockingNotice blocking={preview.blocking} />
            ) : previewIsEmpty(preview.counts) ? (
              <div className={cc.muted} style={{ fontSize: 12.5 }}>
                There is nothing in this scope. Nothing would be deleted.
              </div>
            ) : (
              <>
                <CountTable counts={counts} />
                <div className={cc.muted} style={{ fontSize: 12, marginTop: 10 }}>
                  Storage impact: {formatStorageSize(storageBytes)}
                  {typeof preview.counts.storage_objects === 'number'
                    && ` across ${preview.counts.storage_objects} file(s)`}.
                </div>
                <div className={cc.muted} style={{ fontSize: 12, marginTop: 4 }}>{RESET_NUMBERING_NOTE[scope]}</div>

                <div className={cc.divider} />

                <CcField label="Why is this being cleared?">
                  <input
                    id="reset-reason"
                    className={cc.fieldControl}
                    value={reason}
                    disabled={running}
                    onChange={event => setReason(event.target.value)}
                    placeholder="e.g. resetting the modules after the Order approval test run"
                  />
                </CcField>

                <label className={cc.check} style={{ alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.55, marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    disabled={running}
                    onChange={event => setAcknowledged(event.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <span>{RESET_ACKNOWLEDGEMENT}</span>
                </label>

                {canOfferNumberReset(scope) && (
                  <NumberResetOption
                    enabled={resetNumbers}
                    acknowledged={numbersAcknowledged}
                    disabled={running}
                    onToggle={next => {
                      setResetNumbers(next)
                      if (!next) setNumbersAcknowledged(false)
                    }}
                    onAcknowledge={setNumbersAcknowledged}
                  />
                )}

                <CcField label={`Type ${RESET_CONFIRMATION[scope]} to confirm`}>
                  <input
                    id="reset-phrase"
                    className={cc.fieldControl}
                    style={{ maxWidth: 420 }}
                    value={typed}
                    disabled={running}
                    onChange={event => setTyped(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </CcField>

                {failure && <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }} role="alert">{failure.message}</div>}

                {running && stage
                  ? <StageList scope={scope} current={stage} />
                  : (
                    <button
                      type="button"
                      className={btnDanger}
                      disabled={!canConfirm}
                      onClick={() => setConfirmOpen(true)}
                    >
                      {RESET_TITLE[scope]}
                    </button>
                  )}
              </>
            )}
          </CcSection>
        )}

        {failure && !preview && (
          <div className={cc.error} style={{ marginTop: 0 }} role="alert">{failure.message}</div>
        )}
      </div>

      {confirmOpen && scope && preview && (
        <FinalConfirmation
          scope={scope}
          counts={counts}
          resetNumbers={resetNumbers}
          projectRef={projectRef}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void run()}
        />
      )}
    </>
  )
}

// ── The project this is pointed at ───────────────────────────────────────────

/**
 * WHICH DATABASE THIS EMPTIES, said before anything else on the page.
 *
 * An administrator with three environments open needs this without reading a
 * URL bar. Only the project ref, which names the project and authorizes nothing.
 * A null ref FAILS CLOSED: the buttons stay dead, because an environment that
 * cannot be identified is not one to run this against.
 */
function ProjectBanner({ projectRef }: { projectRef: string | null }) {
  if (!projectRef) {
    return (
      <div className={`${cc.note} ${cc.noteRed}`} style={{ marginBottom: 16 }} role="alert">
        <span className={cc.noteTitle}>The connected project could not be identified, so nothing can be cleared here.</span>
        Check the deployment’s Supabase configuration before using this page.
      </div>
    )
  }
  return (
    <div className={cc.note} style={{ marginBottom: 16 }}>
      This clears data in the connected Supabase project{' '}
      <strong style={{ color: '#111318' }}>{projectRef}</strong>. Every operational record in the
      chosen scope is deleted — nothing is spared for want of a tag.
    </div>
  )
}

// ── An interrupted reset ─────────────────────────────────────────────────────

function InterruptedNotice({ existing, onResume }: {
  existing: ActiveReset
  onResume: () => void
}) {
  const stage = stageFromClaim(existing.stage)
  return (
    <div className={`${cc.note} ${cc.noteAmber}`} style={{ marginBottom: 16 }}>
      <span className={cc.noteTitle}>
        A cleanup is in progress: {existing.scope ? RESET_TITLE[existing.scope] : 'a module reset'}.
      </span>
      <div>
        Started by {existing.started_by}
        {existing.started_at && ` on ${new Date(existing.started_at).toLocaleString()}`}.
        {' '}Last completed stage: <strong>{RESET_STAGE_LABEL[stage]}</strong>.
      </div>
      {existing.reason && <div style={{ marginTop: 4 }}>Reason given: {existing.reason}</div>}
      {existing.failure && <div style={{ marginTop: 6 }}>It stopped because: {existing.failure}</div>}
      <div style={{ marginTop: 10 }}>
        {existing.mine
          ? <button type="button" className="boe-btn boe-btn-primary" onClick={onResume}>Resume this cleanup</button>
          : <span>Only the administrator who started it can finish it. Writes to the affected
              module are refused until it completes.</span>}
      </div>
    </div>
  )
}

// ── The two cards ────────────────────────────────────────────────────────────

function ScopeCard({ scope, chosen, busy, onChoose }: {
  scope: ResetScope
  chosen: boolean
  busy: boolean
  onChoose: () => void
}) {
  return (
    <div className={`${cc.quickCard}${chosen ? ` ${cc.chosen}` : ''}`}>
      <div className={cc.quickHead}>{RESET_TITLE[scope]}</div>
      <Bullets title="Removes" items={RESET_REMOVES[scope]} muted={false} />
      <Bullets title="Leaves alone" items={RESET_RETAINS[scope]} muted />
      <div className={cc.muted} style={{ fontSize: 12 }}>
        Requires typing <strong>{RESET_CONFIRMATION[scope]}</strong>. {RESET_NUMBERING_NOTE[scope]}
      </div>
      <div>
        <button
          type="button"
          className="boe-btn boe-btn-ghost"
          disabled={busy}
          onClick={onChoose}
        >
          {chosen ? 'Refresh counts' : 'Review what this would delete'}
        </button>
      </div>
    </div>
  )
}

function Bullets({ title, items, muted }: {
  title: string
  items: readonly string[]
  muted: boolean
}) {
  return (
    <div>
      <span className={cc.fieldLabel} style={{ marginBottom: 4 }}>{title}</span>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: muted ? '#6B7384' : '#3A4358', lineHeight: 1.65 }}>
        {items.map(item => <li key={item}>{item}</li>)}
      </ul>
    </div>
  )
}

function CountTable({ counts }: { counts: { key: string; label: string; value: number }[] }) {
  return (
    <div className={cc.kv}>
      {counts.map(row => (
        <Fragment key={row.key}>
          <div className={cc.kvKey}>{row.label}</div>
          <div className={cc.kvVal}>{row.value}</div>
        </Fragment>
      ))}
    </div>
  )
}

function BlockingNotice({ blocking }: { blocking: { kind: string; label?: string; reason?: string }[] }) {
  return (
    <div className={`${cc.note} ${cc.noteRed}`} role="alert">
      <span className={cc.noteTitle}>This cleanup is refused: records that are not test data would have to be deleted.</span>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {blocking.map((entry, index) => (
          <li key={`${entry.kind}-${index}`}>
            {entry.label ? <strong>{entry.label}</strong> : entry.kind}
            {entry.reason ? ` — ${entry.reason}` : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── The Order number series ──────────────────────────────────────────────────

/**
 * OFF BY DEFAULT, AND WITH ITS OWN ACKNOWLEDGEMENT. Restarting the series is a
 * different decision from clearing records, and folding it into the same tick
 * would make it something people do by accident. It is refused by the database
 * unless every Order and every reserved number is already gone, so this control
 * asks for it rather than promising it.
 */
function NumberResetOption({ enabled, acknowledged, disabled, onToggle, onAcknowledge }: {
  enabled: boolean
  acknowledged: boolean
  disabled: boolean
  onToggle: (next: boolean) => void
  onAcknowledge: (next: boolean) => void
}) {
  return (
    <div className={cc.note} style={{ marginBottom: 14, background: '#fff' }}>
      <label className={cc.check} style={{ alignItems: 'flex-start', fontSize: 12.5 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={event => onToggle(event.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <strong>Reset the Confirmed Order number series after cleanup</strong>
          <br />
          <span className={cc.muted} style={{ fontSize: 12 }}>
            Off by default. Runs only after the records are gone, and is refused if any Order,
            any submitted or approved PI, or any payment allocation still exists.
          </span>
        </span>
      </label>
      {enabled && (
        <label className={cc.check} style={{ alignItems: 'flex-start', fontSize: 12.5, lineHeight: 1.55, marginTop: 10 }}>
          <input
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={event => onAcknowledge(event.target.checked)}
            style={{ marginTop: 2 }}
          />
          <span>{NUMBER_RESET_ACKNOWLEDGEMENT}</span>
        </label>
      )}
    </div>
  )
}

// ── Progress ─────────────────────────────────────────────────────────────────

function StageList({ scope, current }: { scope: ResetScope; current: ResetStage }) {
  const stages = stagesFor(scope)
  const index = stages.indexOf(current)
  return (
    <div role="status" aria-live="polite" style={{ display: 'grid', gap: 6 }}>
      {stages.map((entry, position) => (
        <div key={entry} style={{
          fontSize: 12.5,
          fontWeight: position === index ? 700 : 500,
          color: position < index ? '#166534' : position === index ? '#111318' : '#B4BAC6',
        }}>
          {position < index ? '✓ ' : position === index ? '• ' : '  '}
          {RESET_STAGE_LABEL[entry]}
        </div>
      ))}
    </div>
  )
}

// ── The final dialog ─────────────────────────────────────────────────────────

function FinalConfirmation({ scope, counts, resetNumbers, projectRef, onCancel, onConfirm }: {
  scope: ResetScope
  counts: { key: string; label: string; value: number }[]
  resetNumbers: boolean
  projectRef: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <CcDialog
      title={`${RESET_TITLE[scope]}?`}
      subtitle={`This permanently deletes the following from project ${projectRef ?? 'unknown'}. It cannot be undone.`}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="boe-btn boe-btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className={btnDanger} onClick={onConfirm}>
            {RESET_CONFIRMATION[scope]}
          </button>
        </>
      }
    >
      <CountTable counts={counts} />
      {resetNumbers && (
        <div className={cc.muted} style={{ fontSize: 12, marginTop: 12 }}>
          The Confirmed Order number series will also restart at 0001, if nothing that uses a
          number survives.
        </div>
      )}
    </CcDialog>
  )
}

// ── Afterwards ───────────────────────────────────────────────────────────────

function ResultSummary({ result }: { result: RunResult }) {
  const rows = Object.entries(result.deleted)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .filter(([key]) => key !== 'storage_removed')
  return (
    <div className={`${cc.note} ${cc.noteGreen}`} style={{ marginBottom: 16 }} role="status">
      <span className={cc.noteTitle}>{RESET_TITLE[result.scope]} completed.</span>
      <div>{result.confirmedRemovedFiles} file(s) removed from storage.</div>
      {rows.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {rows.map(([key, value]) => <li key={key}>{key.replace(/_/g, ' ')}: {value}</li>)}
        </ul>
      )}
      {result.numbering && (
        <div style={{ marginTop: 8 }}>
          Order numbering restarted: next number is now {result.numbering.new_next}.
        </div>
      )}
      {result.numberingRefused && (
        <div style={{ marginTop: 8, color: '#92400E' }}>
          {describeResetFailure(result.numberingRefused).message}
        </div>
      )}
    </div>
  )
}
