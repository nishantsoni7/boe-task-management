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

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ControlCenterLayout } from '@/components/layout/ControlCenterLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { PROOF_BUCKET } from '@/lib/paymentProof'
import type { UserProfile } from '@/lib/types'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'

// ── Types mirroring the RPC payloads ─────────────────────────────────────────

type RootType = 'order' | 'order_request' | 'payment'

type Settings = {
  enabled: boolean
  permanently_disabled: boolean
  disabled_at: string | null
  disabled_by_email: string | null
  test_record_counts: { orders: number; order_requests: number; payment_requests: number }
}

type ChainRecord = {
  type: RootType
  id: string
  number: string | null
  status: string
  label?: string
  amount?: number
  is_test_data: boolean
}

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
}

type CleanupResult = {
  audit_id: string
  root_number: string
  deleted: Record<string, number>
  deleted_records: ChainRecord[]
  storage_paths: string[]
}

const TYPE_LABEL: Record<RootType, string> = {
  order:         'Confirmed Order',
  order_request: 'Order Request',
  payment:       'Payment',
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
}

// ── Styles (Control Center conventions) ──────────────────────────────────────

const CARD: React.CSSProperties = {
  border: '1px solid #E8EBF0', borderRadius: 10,
  padding: '16px 18px', background: '#fff', marginBottom: 16,
}
const INPUT: React.CSSProperties = {
  width: '100%', padding: '9px 11px', fontSize: 13,
  border: '1.5px solid #D1D5DB', borderRadius: 8,
  background: '#fff', color: '#111318', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#6B7384',
  textTransform: 'uppercase', letterSpacing: '0.05em',
  display: 'block', marginBottom: 6,
}
const BTN_DARK: React.CSSProperties = {
  padding: '8px 18px', fontSize: 13, fontWeight: 600, color: '#fff',
  background: '#1A2035', border: 'none', borderRadius: 8, cursor: 'pointer',
}
const BTN_DANGER: React.CSSProperties = {
  padding: '9px 20px', fontSize: 13, fontWeight: 600, color: '#fff',
  background: '#B91C1C', border: 'none', borderRadius: 8, cursor: 'pointer',
}
const BTN_GHOST: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#6B7384',
  background: '#F3F4F6', border: 'none', borderRadius: 8, cursor: 'pointer',
}
const ERR: React.CSSProperties = { fontSize: 12.5, color: '#D94F4F', lineHeight: 1.5 }

export default function TestDataCleanupPage() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <TestDataCleanupInner />
    </Suspense>
  )
}

function TestDataCleanupInner() {
  const supabase = useMemo(() => createClient(), [])
  const router   = useRouter()
  const params   = useSearchParams()

  const [profile,  setProfile]  = useState<UserProfile | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [loadErr,  setLoadErr]  = useState('')

  const [query,    setQuery]    = useState('')
  const [results,  setResults]  = useState<ChainRecord[] | null>(null)
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

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.replace('/login'); return }
      const { data: me } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      setProfile(me as UserProfile)
      await loadSettings()
    }
    void init()
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
      void runPreview(t, id)
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
    setResults(data as ChainRecord[])
  }

  const execute = async () => {
    if (!preview) return
    setRunning(true)
    setRunErr('')
    setStorageWarning('')

    // Order Request attachments live in a private, DRAFT-ONLY-deletable bucket, so
    // their objects are removed by the admin-only, DB-authoritative purge route
    // (which loads each request's paths from the database itself — the browser
    // never supplies them). This is done BEFORE the bulk DB delete: if any purge
    // fails we ABORT and never delete the rows, so the metadata (and its
    // discoverable paths) survive for a retry. Nothing is left as an
    // undiscoverable orphaned file.
    const requestIds = preview.to_delete.filter(r => r.type === 'order_request').map(r => r.id)
    for (const requestId of requestIds) {
      let purgeFailed = true
      try {
        const purgeRes = await fetch('/api/orders/requests/attachments/cleanup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId }),
        })
        const purgeBody = await purgeRes.json().catch(() => null)
        purgeFailed = !purgeRes.ok || (purgeBody?.failed?.length ?? 0) > 0
      } catch {
        purgeFailed = true
      }
      if (purgeFailed) {
        // Row + metadata left intact and discoverable. Nothing was DB-deleted.
        setRunning(false)
        setRunErr('One or more Order Request attachment files could not be removed from storage. Nothing was deleted — please retry.')
        return
      }
    }

    const { data, error } = await supabase.rpc('execute_test_data_cleanup', {
      p_root_type:    preview.root_type,
      p_root_id:      preview.root_id,
      p_reason:       reason,
      p_confirmation: typed,
    })

    if (error) {
      // The reason and the typed confirmation are deliberately preserved: the
      // failure is usually something the admin can fix and retry, and making
      // them retype the confirmation adds friction without adding safety.
      setRunning(false)
      setRunErr(error.message)
      return
    }

    const res = data as CleanupResult

    // Payment proofs live in a different bucket with a row-independent admin
    // storage policy; they are removed after the commit from the RPC's own path
    // list, as before. A failure is surfaced, never reported as a clean success.
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

  const signOut = async () => { await supabase.auth.signOut(); router.replace('/login') }

  return (
    <ControlCenterLayout
      profile={profile}
      title="Test Data Cleanup"
      subtitle="Remove a complete verified test transaction while the system is in testing."
      onSignOut={signOut}
    >
      <div style={{ maxWidth: 900 }}>

        {loading ? (
          <div style={{ fontSize: 12.5, color: '#8C94A6' }}>Loading…</div>
        ) : loadErr ? (
          <div style={CARD}>
            <div style={{ ...ERR, marginBottom: 12 }}>{loadErr}</div>
            <button style={BTN_DARK} onClick={() => { setLoading(true); void loadSettings() }}>Retry</button>
          </div>
        ) : (
          <>
            {/* ── Status banner ──────────────────────────────────────────── */}
            {active ? (
              <div style={{
                background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 10,
                padding: '14px 16px', marginBottom: 16, fontSize: 12.5, color: '#92400E', lineHeight: 1.6,
              }}>
                <strong>Test Data Cleanup is enabled. Use this only for records created during system testing.</strong>
                <br />
                Deletions here are permanent and are recorded in a cleanup audit that survives them.
                Currently marked as test data: {settings?.test_record_counts.orders} Confirmed{' '}
                {settings?.test_record_counts.orders === 1 ? 'Order' : 'Orders'},{' '}
                {settings?.test_record_counts.order_requests} Order{' '}
                {settings?.test_record_counts.order_requests === 1 ? 'Request' : 'Requests'},{' '}
                {settings?.test_record_counts.payment_requests} Payment{' '}
                {settings?.test_record_counts.payment_requests === 1 ? 'Request' : 'Requests'}.
              </div>
            ) : (
              <div style={{
                background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 10,
                padding: '14px 16px', marginBottom: 16, fontSize: 12.5, color: '#166534', lineHeight: 1.6,
              }}>
                <strong>Test Data Cleanup has been permanently disabled. Final Orders and bank payment history cannot be deleted.</strong>
                {settings?.disabled_at && (
                  <>
                    <br />
                    Disabled on {new Date(settings.disabled_at).toLocaleString('en-IN')}
                    {settings.disabled_by_email ? ` by ${settings.disabled_by_email}` : ''}.
                    Re-enabling requires a database migration.
                  </>
                )}
              </div>
            )}

            {/* ── Result summary ─────────────────────────────────────────── */}
            {result && (
              <div style={{ ...CARD, borderColor: '#BBF7D0', background: '#F7FEF9' }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: '#166534', marginBottom: 8 }}>
                  Cleaned up {TYPE_LABEL[result.deleted_records[0]?.type ?? 'order']} {result.root_number}
                </div>
                <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.7 }}>
                  {Object.entries(result.deleted)
                    .filter(([, n]) => n > 0)
                    .map(([k, n]) => `${n} ${COUNT_LABEL[k] ?? k}`)
                    .join(' · ') || 'Nothing was removed.'}
                </div>
                {storageWarning && (
                  <div style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 8,
                    background: '#FFF7ED', border: '1px solid #FED7AA', color: '#9A3412', fontSize: 12.5,
                  }}>
                    {storageWarning}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: '#8C94A6', marginTop: 10 }}>
                  Audit entry {result.audit_id}
                </div>
              </div>
            )}

            {active && (
              <>
                {/* ── Search ───────────────────────────────────────────── */}
                <div style={CARD}>
                  <label style={LABEL}>Find a record</label>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') void search() }}
                      placeholder="Order number, request number, payment number or client"
                      style={INPUT}
                    />
                    <button style={BTN_DARK} onClick={search} disabled={searching || !query.trim()}>
                      {searching ? 'Searching…' : 'Search'}
                    </button>
                  </div>

                  {results && results.length === 0 && (
                    <div style={{ fontSize: 12.5, color: '#8C94A6', marginTop: 12 }}>
                      No records matched.
                    </div>
                  )}

                  {results && results.length > 0 && (
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {results.map(r => (
                        <button
                          key={`${r.type}:${r.id}`}
                          onClick={() => void runPreview(r.type, r.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
                            border: '1px solid #E8EBF0', borderRadius: 8, padding: '10px 12px',
                            background: '#fff', cursor: 'pointer',
                          }}
                        >
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#111318', minWidth: 150 }}>
                            {r.number}
                          </span>
                          <span style={{ fontSize: 12, color: '#6B7384', flex: 1 }}>
                            {TYPE_LABEL[r.type]} · {r.status}{r.label ? ` · ${r.label}` : ''}
                          </span>
                          <TestBadge isTest={r.is_test_data} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {previewErr && <div style={{ ...CARD, ...ERR }}>{previewErr}</div>}

                {/* ── Preview ──────────────────────────────────────────── */}
                {preview && (
                  <div style={CARD}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318', marginBottom: 4 }}>
                      {TYPE_LABEL[preview.root_type]} {preview.root_number}
                    </div>
                    <div style={{ fontSize: 12, color: '#6B7384', marginBottom: 16 }}>
                      Everything below is resolved by the database, not by this page.
                    </div>

                    <RecordList title="Will be deleted" records={preview.to_delete} tone="delete" />
                    {preview.to_retain.length > 0 && (
                      <RecordList title="Will be kept" records={preview.to_retain} tone="retain" />
                    )}

                    <div style={{ marginTop: 14, marginBottom: 16 }}>
                      <label style={LABEL}>Also removed</label>
                      <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.7 }}>
                        {Object.entries(preview.counts)
                          .filter(([k, n]) => n > 0 && !['orders', 'order_requests', 'payment_requests'].includes(k))
                          .map(([k, n]) => `${n} ${COUNT_LABEL[k] ?? k}`)
                          .join(' · ') || 'No dependent rows.'}
                        {preview.storage_paths.length > 0 &&
                          ` · ${preview.storage_paths.length} proof file(s) in storage`}
                      </div>
                    </div>

                    {!preview.eligible ? (
                      <div style={{
                        background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8,
                        padding: '12px 14px', fontSize: 12.5, color: '#991B1B', lineHeight: 1.6,
                      }}>
                        <strong>This chain cannot be cleaned up.</strong> It contains records that are
                        not test data, so removing it would destroy real business history:{' '}
                        {preview.blocking.map(b => `${TYPE_LABEL[b.type]} ${b.number}`).join(', ')}.
                      </div>
                    ) : (
                      <>
                        <div style={{ marginBottom: 14 }}>
                          <label style={LABEL}>Why is this being removed?</label>
                          <textarea
                            value={reason}
                            onChange={e => { setReason(e.target.value); setRunErr('') }}
                            rows={2}
                            placeholder="e.g. Re-running the order-to-payment workflow from a clean state"
                            style={{ ...INPUT, resize: 'vertical' }}
                          />
                        </div>

                        <div style={{ marginBottom: 16 }}>
                          <label style={LABEL}>Type DELETE TEST DATA to confirm</label>
                          <input
                            value={typed}
                            onChange={e => { setTyped(e.target.value); setRunErr('') }}
                            placeholder="DELETE TEST DATA"
                            style={{ ...INPUT, width: 240 }}
                          />
                        </div>

                        {runErr && <div style={{ ...ERR, marginBottom: 12 }}>{runErr}</div>}

                        <div style={{ display: 'flex', gap: 10 }}>
                          <button style={BTN_GHOST} onClick={() => { setPreview(null); setReason(''); setTyped('') }}>
                            Cancel
                          </button>
                          <button
                            style={{
                              ...BTN_DANGER,
                              opacity: running || !reason.trim() || typed !== 'DELETE TEST DATA' ? 0.5 : 1,
                              cursor:  running || !reason.trim() || typed !== 'DELETE TEST DATA' ? 'default' : 'pointer',
                            }}
                            disabled={running || !reason.trim() || typed !== 'DELETE TEST DATA'}
                            onClick={execute}
                          >
                            {running ? 'Cleaning up…' : 'Clean Up Test Transaction'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ── Permanent disable ────────────────────────────────── */}
                <div style={{ ...CARD, borderColor: '#FECACA' }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: '#111318', marginBottom: 4 }}>
                    Finish testing
                  </div>
                  <div style={{ fontSize: 12.5, color: '#4B5563', lineHeight: 1.6, marginBottom: 14 }}>
                    When BOE starts entering real Orders and real bank payments, disable this
                    permanently. Every record created afterwards counts as real data, and no Order
                    or bank payment can be removed again. This cannot be undone from the
                    application — re-enabling would require a database migration.
                  </div>

                  {!disableOpen ? (
                    <button style={BTN_GHOST} onClick={() => setDisableOpen(true)}>
                      Permanently Disable Test Data Cleanup
                    </button>
                  ) : (
                    <>
                      <label style={LABEL}>Type DISABLE TEST CLEANUP to confirm</label>
                      <input
                        value={disableTyped}
                        onChange={e => { setDisableTyped(e.target.value); setDisableErr('') }}
                        placeholder="DISABLE TEST CLEANUP"
                        style={{ ...INPUT, width: 280, marginBottom: 12 }}
                      />
                      {disableErr && <div style={{ ...ERR, marginBottom: 12 }}>{disableErr}</div>}
                      <div style={{ display: 'flex', gap: 10 }}>
                        <button style={BTN_GHOST} onClick={() => { setDisableOpen(false); setDisableTyped(''); setDisableErr('') }}>
                          Cancel
                        </button>
                        <button
                          style={{
                            ...BTN_DANGER,
                            opacity: disabling || disableTyped !== 'DISABLE TEST CLEANUP' ? 0.5 : 1,
                            cursor:  disabling || disableTyped !== 'DISABLE TEST CLEANUP' ? 'default' : 'pointer',
                          }}
                          disabled={disabling || disableTyped !== 'DISABLE TEST CLEANUP'}
                          onClick={disable}
                        >
                          {disabling ? 'Disabling…' : 'Permanently Disable'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ControlCenterLayout>
  )
}

function TestBadge({ isTest }: { isTest: boolean }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, borderRadius: 5, padding: '2px 8px',
      color:      isTest ? '#92400E' : '#166534',
      background: isTest ? '#FFFBEB' : '#F0FDF4',
      border:     `1px solid ${isTest ? '#FDE68A' : '#BBF7D0'}`,
    }}>
      {isTest ? 'Test data' : 'Real data'}
    </span>
  )
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
      <label style={LABEL}>{title}</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {records.map(r => (
          <div
            key={`${r.type}:${r.id}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              border: `1px solid ${tone === 'delete' ? '#FECACA' : '#E8EBF0'}`,
              background: tone === 'delete' ? '#FEF7F7' : '#FAFBFC',
              borderRadius: 8, padding: '9px 12px',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 700, color: '#111318', minWidth: 150 }}>
              {r.number}
            </span>
            <span style={{ fontSize: 12, color: '#6B7384', flex: 1 }}>
              {TYPE_LABEL[r.type]} · {r.status}{r.label ? ` · ${r.label}` : ''}
            </span>
            <TestBadge isTest={r.is_test_data} />
          </div>
        ))}
      </div>
    </div>
  )
}
