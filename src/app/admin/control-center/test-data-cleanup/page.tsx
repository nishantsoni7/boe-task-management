'use client'

// Admin Control Center → Test Data Cleanup.
//
// The single place where a finalized test record can be removed. It is a page of
// its own, reached from its own sidebar entry, deliberately nowhere near the
// everyday Finance and Orders lists — those pages now offer no destructive
// action on a Confirmed Order or a Received Payment at all.
//
// Nothing here is a security boundary. The enclosing control-center/layout.tsx
// already admin-guards this subtree, and every RPC below re-checks admin, the
// enabled setting, the reason, the typed confirmation and per-record test-data
// eligibility in the database (20260706000000). This page's job is to make the
// consequences legible before the admin commits: what will be deleted, what will
// survive, and what — if anything — is blocking.
//
// The dependency graph is never reconstructed here. preview_test_data_cleanup()
// resolves it server-side and execute_test_data_cleanup() re-resolves it under
// row locks, so what was shown and what is acted on cannot drift.
//
// The page reads top to bottom as the decision does: what this tool is, find
// the record, see what goes and what stays, confirm, act. Red appears only on
// the act itself.

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ControlCenterSkeleton } from '@/components/layout/ControlCenterSkeleton'
import { cc, CcSection, CcToolbar, CcBadge, CcField } from '@/components/controlCenter/CcPrimitives'
import { PROOF_BUCKET } from '@/lib/paymentProof'

// ── Types mirroring the RPC payloads ─────────────────────────────────────────

type RootType = 'order' | 'order_request' | 'payment'

/**
 * What a chain row can be.
 *
 * 'order_submission' joined in 20260916000000: an Order created by approving a
 * PI carries that PI as part of the same indivisible transaction, and deleting
 * one without the other is what the mutual foreign key refuses.
 */
type ChainType = RootType | 'order_submission'

type Settings = {
  enabled: boolean
  permanently_disabled: boolean
  disabled_at: string | null
  disabled_by_email: string | null
  test_record_counts: { orders: number; order_requests: number; payment_requests: number }
}

type ChainRecord = {
  type: ChainType
  id: string
  number: string | null
  status: string
  label?: string
  amount?: number
  is_test_data: boolean
  /** PI rows only: submissions/{id}/, resolved server-side. Never built here. */
  storage_prefix?: string
  /** Blocking rows only: why this one stops the operation. */
  reason?: string
}

/**
 * A row the SEARCH returns, which is always one of the three ROOT types.
 *
 * A PI submission is never a search root: it is never the thing an admin names,
 * only something the chain pulls in behind the Order it produced. Keeping the
 * two types apart is what stops the search list being handed an id
 * preview_test_data_cleanup() would refuse.
 */
type RootRecord = ChainRecord & { type: RootType }

type Preview = {
  root_type: RootType
  root_id: string
  root_number: string
  to_delete: ChainRecord[]
  to_retain: ChainRecord[]
  blocking: ChainRecord[]
  storage_paths: string[]
  counts: Record<string, number>
  eligible: boolean
  /** The approved PI this Order came from, or null. */
  order_submission_id: string | null
  /** submissions/{id}/ — shown so the admin can see the files are in scope. */
  submission_storage_prefix: string | null
}

type CleanupResult = {
  audit_id: string
  root_number: string
  deleted: Record<string, number>
  deleted_records: ChainRecord[]
  storage_paths: string[]
}

const TYPE_LABEL: Record<ChainType, string> = {
  order:            'Confirmed Order',
  order_request:    'Order Request',
  payment:          'Payment',
  order_submission: 'PI submission',
}

const COUNT_LABEL: Record<string, string> = {
  orders:                 'Confirmed Orders',
  order_requests:         'Order Requests',
  payment_requests:       'Payment Requests',
  order_activity_log:     'Order activity rows',
  order_request_activity: 'Order Request activity rows',
  payment_activity:       'Payment activity rows',
  proof_attachments:      'Proof attachments',
  notifications:          'Notifications',
  // The PI and everything that belongs solely to it. Three of the four go by
  // CASCADE, and all four are shown: an admin deciding whether to press the
  // button should see the size of what goes, not only the row they named.
  order_submissions:            'PI submissions',
  order_submission_items:       'PI product lines',
  order_submission_item_images: 'PI images',
  order_submission_activity:    'PI activity rows',
}

const CLEANUP_PHRASE = 'DELETE TEST DATA'
const DISABLE_PHRASE = 'DISABLE TEST CLEANUP'

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className={cc.step}>
      <span className={cc.stepNum}>{n}</span>
      <span className={cc.stepTitle}>{title}</span>
    </div>
  )
}

export default function TestDataCleanupPage() {
  return (
    <Suspense fallback={<ControlCenterSkeleton />}>
      <TestDataCleanupInner />
    </Suspense>
  )
}

function TestDataCleanupInner() {
  const supabase = useMemo(() => createClient(), [])
  const params   = useSearchParams()

  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [loadErr,  setLoadErr]  = useState('')

  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<RootRecord[] | null>(null)
  const [searching,setSearching]= useState(false)

  const [preview,  setPreview]  = useState<Preview | null>(null)
  const [previewErr,setPreviewErr] = useState('')

  const [reason,   setReason]   = useState('')
  const [typed,    setTyped]    = useState('')
  const [running,  setRunning]  = useState(false)
  const [runErr,   setRunErr]   = useState('')
  const [result,   setResult]   = useState<CleanupResult | null>(null)
  const [storageWarning, setStorageWarning] = useState('')

  const [disableOpen,  setDisableOpen]  = useState(false)
  const [disableTyped, setDisableTyped] = useState('')
  const [disableErr,   setDisableErr]   = useState('')
  const [disabling,    setDisabling]    = useState(false)

  const loadSettings = useCallback(async () => {
    setLoadErr('')
    const { data, error } = await supabase.rpc('get_test_data_cleanup_settings')
    if (error) { setLoadErr(error.message); setSettings(null); setLoading(false); return }
    setSettings(data as Settings)
    setLoading(false)
  }, [supabase])

  // Identity and the admin check are owned by control-center/layout.tsx; this
  // page mounts only for an admitted administrator, so it goes straight to its
  // own data. The RPC still runs under the browser session's own authorization.
  //
  // A FETCH IS STARTED HERE. loadSettings clears the error message before its
  // await; on mount that message is already empty, so React bails out of the
  // update and nothing re-renders. react-hooks/set-state-in-effect is static and
  // cannot see that, so the call goes through a named local — the same shape
  // the customer-reviews screens use for a fetch-on-mount.
  useEffect(() => {
    const startFetch = () => { void loadSettings() }
    startFetch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = !!settings?.enabled && !settings?.permanently_disabled

  const runPreview = useCallback(async (type: RootType, id: string) => {
    setPreviewErr('')
    setResult(null)
    setStorageWarning('')
    setRunErr('')
    const { data, error } = await supabase.rpc('preview_test_data_cleanup', {
      p_root_type: type, p_root_id: id,
    })
    if (error) { setPreview(null); setPreviewErr(error.message); return }
    setPreview(data as Preview)
  }, [supabase])

  // Deep link from a record's "Clean Up Test Transaction" action. Runs once the
  // settings are known, so a disabled cleanup shows its banner rather than an
  // unexplained preview error.
  useEffect(() => {
    const t = params.get('type')
    const id = params.get('id')
    if (!loading && active && !preview && id && (t === 'order' || t === 'order_request' || t === 'payment')) {
      // A FETCH IS STARTED HERE; every setState inside runPreview follows its
      // first await, so the call goes through a named local (see loadSettings).
      const startPreview = () => { void runPreview(t, id) }
      startPreview()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, active])

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    setResults(null)
    const { data, error } = await supabase.rpc('search_test_data_cleanup_roots', { p_query: query })
    setSearching(false)
    if (error) { setPreviewErr(error.message); return }
    setResults(data as RootRecord[])
  }

  const execute = async () => {
    if (!preview) return
    setRunning(true)
    setRunErr('')
    setStorageWarning('')

    // ONE REQUEST. The browser does not coordinate destructive steps.
    //
    // WHY IT USED TO, AND WHY IT MUST NOT. This page previously purged Order
    // Request attachments, then purged the PI's files, then called the delete
    // RPC — three calls with nothing durable joining them. A sweep that removes
    // some objects and then fails, or a sweep that succeeds followed by an RPC
    // that refuses, both end the same way: an approved PI surviving with its
    // workbook and images destroyed. A tab closed between two of the calls does
    // it too.
    //
    // The route now owns the whole sequence behind a DURABLE CLAIM taken in the
    // database — every gate first, records frozen, files removed, then the rows.
    // A failure anywhere leaves the rows whole and the claim standing, and
    // pressing the button again resumes exactly where it stopped.
    //
    // This page sends what the ADMIN typed and nothing else: no path, no
    // submission id, no claim token. Every destructive target is derived from
    // the database inside the claim.
    let body: Record<string, unknown> | null = null
    let ok = false
    try {
      const res = await fetch('/api/orders/test-data-cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rootType:     preview.root_type,
          rootId:       preview.root_id,
          reason,
          confirmation: typed,
        }),
      })
      ok = res.ok
      body = await res.json().catch(() => null)
    } catch {
      setRunning(false)
      setRunErr('The cleanup could not be reached. Nothing was deleted — please retry.')
      return
    }

    if (!ok) {
      // The reason and the typed confirmation are deliberately preserved: the
      // failure is usually something the admin can fix and retry, and making
      // them retype the confirmation adds friction without adding safety.
      setRunning(false)
      setRunErr(typeof body?.error === 'string'
        ? body.error
        : 'The cleanup did not complete. Nothing was deleted — please retry.')
      return
    }

    const res = body as unknown as CleanupResult

    // Payment proofs live in a different bucket with a row-independent admin
    // storage policy, and are removed AFTER the commit from the RPC's own path
    // list — the safe side for them: a failure here strands files that the
    // permanent audit still names, rather than destroying a proof whose payment
    // record survives. A failure is surfaced, never reported as a clean success.
    const warnings: string[] = []
    if (res.storage_paths?.length) {
      const { data: removed, error: rmErr } =
        await supabase.storage.from(PROOF_BUCKET).remove(res.storage_paths)
      if (rmErr || (removed?.length ?? 0) < res.storage_paths.length) {
        warnings.push('one or more proof files could not be removed')
      }
    }
    if (warnings.length > 0) {
      setStorageWarning(`Database cleanup succeeded, but ${warnings.join(' and ')}.`)
    }

    setRunning(false)
    setResult(res)
    setPreview(null)
    setResults(null)
    setReason('')
    setTyped('')
    setQuery('')
    await loadSettings()
  }

  const disable = async () => {
    setDisabling(true)
    setDisableErr('')
    const { error } = await supabase.rpc('permanently_disable_test_data_cleanup', {
      p_confirmation: disableTyped,
    })
    setDisabling(false)
    if (error) { setDisableErr(error.message); return }
    setDisableOpen(false)
    setDisableTyped('')
    setPreview(null)
    setResults(null)
    await loadSettings()
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) return <ControlCenterSkeleton />

  if (loadErr) {
    return (
      <CcSection>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{loadErr}</div>
        <button className="boe-btn boe-btn-ghost" onClick={() => { setLoading(true); void loadSettings() }}>Retry</button>
      </CcSection>
    )
  }

  const canExecute = !running && reason.trim().length > 0 && typed === CLEANUP_PHRASE
  const canDisable = !disabling && disableTyped === DISABLE_PHRASE
  const counts = settings?.test_record_counts

  return (
    <div style={{ maxWidth: 900 }}>

      {/* ── What this tool is, and whether it is on ────────────────────────── */}
      {active ? (
        <div className={`${cc.note} ${cc.noteAmber}`} style={{ marginBottom: 16 }}>
          <span className={cc.noteTitle}>Test Data Cleanup is enabled. Use this only for records created during system testing.</span>
          Deletions here are permanent and are recorded in a cleanup audit that survives them.
          {counts && (
            <>
              {' '}Currently marked as test data: {counts.orders} Confirmed{' '}
              {counts.orders === 1 ? 'Order' : 'Orders'},{' '}
              {counts.order_requests} Order{' '}
              {counts.order_requests === 1 ? 'Request' : 'Requests'},{' '}
              {counts.payment_requests} Payment{' '}
              {counts.payment_requests === 1 ? 'Request' : 'Requests'}.
            </>
          )}
        </div>
      ) : (
        <div className={`${cc.note} ${cc.noteGreen}`} style={{ marginBottom: 16 }}>
          <span className={cc.noteTitle}>Test Data Cleanup has been permanently disabled. Final Orders and bank payment history cannot be deleted.</span>
          {settings?.disabled_at && (
            <>
              Disabled on {new Date(settings.disabled_at).toLocaleString('en-IN')}
              {settings.disabled_by_email ? ` by ${settings.disabled_by_email}` : ''}.
              Re-enabling requires a database migration.
            </>
          )}
        </div>
      )}

      {/* ── Result of the last cleanup ─────────────────────────────────────── */}
      {result && (
        <div className={`${cc.note} ${cc.noteGreen}`} style={{ marginBottom: 16 }} role="status">
          <span className={cc.noteTitle}>
            Cleaned up {TYPE_LABEL[result.deleted_records[0]?.type ?? 'order']} {result.root_number}
          </span>
          {Object.entries(result.deleted)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${n} ${COUNT_LABEL[k] ?? k}`)
            .join(' · ') || 'Nothing was removed.'}
          {storageWarning && (
            <div className={`${cc.note} ${cc.noteAmber}`} style={{ marginTop: 10, padding: '8px 12px' }}>
              {storageWarning}
            </div>
          )}
          <div className={cc.mono} style={{ marginTop: 8 }}>Audit entry {result.audit_id}</div>
        </div>
      )}

      {active && (
        <>
          {/* ── 1. Find the record ─────────────────────────────────────────── */}
          <CcSection>
            <Step n={1} title="Find the record" />
            <CcToolbar>
              <div className={cc.search} style={{ flex: '1 1 320px' }}>
                <Search size={13} strokeWidth={2} />
                <input
                  className={cc.control}
                  style={{ width: '100%' }}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void search() }}
                  placeholder="Order number, request number, payment number or client"
                  aria-label="Find a record"
                />
              </div>
              <button className="boe-btn boe-btn-ghost" onClick={search} disabled={searching || !query.trim()}>
                {searching ? 'Searching…' : 'Search'}
              </button>
            </CcToolbar>

            {results && results.length === 0 && (
              <div className={cc.muted} style={{ fontSize: 12.5 }}>No records matched.</div>
            )}

            {results && results.length > 0 && (
              <div className={cc.records}>
                {results.map(r => (
                  <button
                    key={`${r.type}:${r.id}`}
                    type="button"
                    className={`${cc.record} ${cc.recordBtn}`}
                    onClick={() => void runPreview(r.type, r.id)}
                  >
                    <span className={cc.recordId}>{r.number}</span>
                    <span className={cc.recordMeta}>
                      {TYPE_LABEL[r.type]} · {r.status}{r.label ? ` · ${r.label}` : ''}
                    </span>
                    <TestBadge isTest={r.is_test_data} />
                  </button>
                ))}
              </div>
            )}

            {previewErr && <div className={cc.error}>{previewErr}</div>}
          </CcSection>

          {/* ── 2. Review, 3. Confirm ──────────────────────────────────────── */}
          {preview && (
            <CcSection>
              <Step n={2} title={`Review ${TYPE_LABEL[preview.root_type]} ${preview.root_number}`} />
              <div className={cc.muted} style={{ fontSize: 12, marginBottom: 12 }}>
                Everything below is resolved by the database, not by this page.
              </div>

              <RecordList title="Will be deleted" records={preview.to_delete} tone="delete" />
              {preview.to_retain.length > 0 && (
                <RecordList title="Will be kept" records={preview.to_retain} tone="retain" />
              )}

              <div style={{ marginBottom: 14 }}>
                <span className={cc.fieldLabel}>Also removed</span>
                <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.7 }}>
                  {Object.entries(preview.counts)
                    // The four ROW types already listed above by name are
                    // excluded here; what is left is the dependent rows
                    // that go with them.
                    .filter(([k, n]) => n > 0 && ![
                      'orders', 'order_requests', 'payment_requests', 'order_submissions',
                    ].includes(k))
                    .map(([k, n]) => `${n} ${COUNT_LABEL[k] ?? k}`)
                    .join(' · ') || 'No dependent rows.'}
                  {preview.storage_paths.length > 0 &&
                    ` · ${preview.storage_paths.length} proof file(s) in storage`}
                </div>
                {/* The PI's own files. Named by their PREFIX rather than
                    listed: the count is what matters here, the keys are
                    resolved server-side, and a wall of storage paths is
                    not what an admin is deciding on. */}
                {preview.submission_storage_prefix && (
                  <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.7, marginTop: 4 }}>
                    Every PI file under{' '}
                    <code className={cc.mono} style={{ color: '#111318' }}>
                      {preview.submission_storage_prefix}
                    </code>
                  </div>
                )}
              </div>

              {!preview.eligible ? (
                <div className={`${cc.note} ${cc.noteRed}`} role="alert">
                  <span className={cc.noteTitle}>This chain cannot be cleaned up.</span>
                  It contains records that are not test data, so removing it would destroy real
                  business history:{' '}
                  {preview.blocking
                    .map(b => b.reason
                      ? `${TYPE_LABEL[b.type]} — ${b.reason}`
                      : `${TYPE_LABEL[b.type]} ${b.number ?? b.id}`)
                    .join(', ')}.
                </div>
              ) : (
                <>
                  <div className={cc.divider} />
                  <Step n={3} title="Confirm and clean up" />

                  <CcField label="Why is this being removed?">
                    <textarea
                      className={cc.fieldControl}
                      style={{ height: 'auto', padding: '8px 11px', resize: 'vertical' }}
                      value={reason}
                      onChange={e => { setReason(e.target.value); setRunErr('') }}
                      rows={2}
                      placeholder="e.g. Re-running the order-to-payment workflow from a clean state"
                    />
                  </CcField>

                  <CcField label={`Type ${CLEANUP_PHRASE} to confirm`}>
                    <input
                      className={cc.fieldControl}
                      style={{ maxWidth: 280 }}
                      value={typed}
                      onChange={e => { setTyped(e.target.value); setRunErr('') }}
                      placeholder={CLEANUP_PHRASE}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </CcField>

                  {runErr && <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{runErr}</div>}

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="boe-btn boe-btn-ghost" onClick={() => { setPreview(null); setReason(''); setTyped('') }}>
                      Cancel
                    </button>
                    <button className="boe-btn boe-btn-danger" disabled={!canExecute} onClick={execute}>
                      {running ? 'Cleaning up…' : 'Clean Up Test Transaction'}
                    </button>
                  </div>
                </>
              )}
            </CcSection>
          )}

          {/* ── Finish testing ─────────────────────────────────────────────── */}
          <CcSection
            title="Finish testing"
            description="When BOE starts entering real Orders and real bank payments, disable this permanently. Every record created afterwards counts as real data, and no Order or bank payment can be removed again. Re-enabling would require a database migration."
          >
            {!disableOpen ? (
              <button className="boe-btn boe-btn-ghost" onClick={() => setDisableOpen(true)}>
                Permanently Disable Test Data Cleanup
              </button>
            ) : (
              <>
                <CcField label={`Type ${DISABLE_PHRASE} to confirm`}>
                  <input
                    className={cc.fieldControl}
                    style={{ maxWidth: 300 }}
                    value={disableTyped}
                    onChange={e => { setDisableTyped(e.target.value); setDisableErr('') }}
                    placeholder={DISABLE_PHRASE}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </CcField>
                {disableErr && <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }}>{disableErr}</div>}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="boe-btn boe-btn-ghost" onClick={() => { setDisableOpen(false); setDisableTyped(''); setDisableErr('') }}>
                    Cancel
                  </button>
                  <button className="boe-btn boe-btn-danger" disabled={!canDisable} onClick={disable}>
                    {disabling ? 'Disabling…' : 'Permanently Disable'}
                  </button>
                </div>
              </>
            )}
          </CcSection>
        </>
      )}
    </div>
  )
}

function TestBadge({ isTest }: { isTest: boolean }) {
  return <CcBadge tone={isTest ? 'amber' : 'green'}>{isTest ? 'Test data' : 'Real data'}</CcBadge>
}

function RecordList({
  title, records, tone,
}: {
  title: string
  records: ChainRecord[]
  tone: 'delete' | 'retain'
}) {
  if (records.length === 0) return null
  return (
    <div style={{ marginBottom: 14 }}>
      <span className={cc.fieldLabel}>{title}</span>
      <div className={cc.records}>
        {records.map(r => (
          <div
            key={`${r.type}:${r.id}`}
            className={`${cc.record} ${tone === 'delete' ? cc.recordDanger : cc.recordKeep}`}
          >
            {/* A PI submission has no business number — numbering happens at
                approval and belongs to the Order. An empty identifier column
                would read as a missing value, so it says what the row IS. */}
            <span className={cc.recordId}>
              {r.number ?? TYPE_LABEL[r.type]}
            </span>
            <span className={cc.recordMeta}>
              {TYPE_LABEL[r.type]} · {r.status}{r.label ? ` · ${r.label}` : ''}
            </span>
            <TestBadge isTest={r.is_test_data} />
          </div>
        ))}
      </div>
    </div>
  )
}
