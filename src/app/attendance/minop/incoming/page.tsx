'use client'

// Incoming Minop data — a read-only register of everything the fingerprint
// system has sent, one row per punch. Collection and inspection only: nothing
// here links an employee, approves, processes or retries, and nothing received
// from Minop is used for attendance (see src/lib/minop/collectionMode.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { UserProfile } from '@/lib/types'
import { AttendancePayrollLayout } from '@/components/layout/AttendancePayrollLayout'
import { LoadingScreen } from '@/components/ui/atoms'
import { USER_PROFILE_COLUMNS } from '@/lib/users/safeColumns'
import { Badge, Notice, StateBlock, ui } from '@/components/attendancePayroll/ui'
import { Download, RefreshCw } from 'lucide-react'
import { DUPLICATE_FLAG_LABEL, type IncomingRegisterRow } from '@/lib/minop/incomingRegister'
import styles from './incoming.module.css'

type ListResponse = {
  rows: IncomingRegisterRow[]
  total: number
  page: number
  pageSize: number
  messagesRetained: number
  latestReceivedAt: string | null
  truncated: boolean
}

type PayloadResponse = {
  id: string
  received_at: string
  service_tag_id: string | null
  content_type: string | null
  user_agent: string | null
  auth_method: string
  processing_status: string
  error_text: string | null
  body_sha256: string
  raw_body: string
}

const IST_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
})

/** Asia/Kolkata with seconds. */
function ist(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? IST_FORMAT.format(new Date(ms)) : iso
}

function punchTime(row: IncomingRegisterRow): { main: string; note: string | null } {
  if (row.punchTimeRaw === null) return { main: '—', note: null }
  if (row.punchTimeHasZone) return { main: ist(row.punchTimeInstant), note: null }
  return { main: row.punchTimeRaw, note: 'as sent, no time zone' }
}

const READ_TONE = { readable: 'good', partial: 'warn', unreadable: 'bad' } as const
const READ_LABEL = { readable: 'Read', partial: 'Partly read', unreadable: 'Cannot read' } as const

function PayloadDetails({ row, token }: { row: IncomingRegisterRow; token: string }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PayloadResponse | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || data || error) return
    let cancelled = false
    fetch(`/api/attendance/minop-incoming/${row.deliveryId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async res => {
        const json = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok) setData(json as PayloadResponse)
        else setError(json.error ?? 'Could not load the payload')
      })
      .catch(() => { if (!cancelled) setError('Could not reach the server') })
    return () => { cancelled = true }
  }, [open, data, error, row.deliveryId, token])

  return (
    <details className={styles.payload} onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>View payload</summary>
      {open && !data && !error && <p className={ui.sub}>Loading…</p>}
      {error && <p className={ui.sub} role="alert">{error}</p>}
      {data && (
        <>
          <dl className={styles.meta}>
            <dt>Message reference</dt><dd>{data.id}</dd>
            <dt>Received (UTC)</dt><dd>{data.received_at}</dd>
            <dt>Auth method</dt><dd>{data.auth_method}</dd>
            <dt>Stored status</dt><dd>{data.processing_status}{data.error_text ? ` — ${data.error_text}` : ''}</dd>
            <dt>Content type</dt><dd>{data.content_type ?? '—'}</dd>
            <dt>Service tag</dt><dd>{data.service_tag_id ?? '—'}</dd>
            <dt>User agent</dt><dd>{data.user_agent ?? '—'}</dd>
            <dt>SHA-256</dt><dd>{data.body_sha256}</dd>
          </dl>
          <p className={ui.sub}>Full message as received. Credential values are removed.</p>
          <pre className={styles.pre}>{data.raw_body}</pre>
        </>
      )}
    </details>
  )
}

export default function IncomingMinopDataPage() {
  const [profile, setProfile] = useState<UserProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [fetching, setFetching] = useState(false)
  const [result, setResult] = useState<ListResponse | null>(null)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState<'csv' | 'raw' | null>(null)

  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const requestSeq = useRef(0)

  const query = useCallback((extra: Record<string, string> = {}) => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    for (const [k, v] of Object.entries(extra)) params.set(k, v)
    return params.toString()
  }, [q, from, to])

  const load = useCallback(async () => {
    if (!token) return
    const seq = ++requestSeq.current
    setFetching(true)
    setError('')
    try {
      const res = await fetch(`/api/attendance/minop-incoming?${query({ page: String(page) })}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const json = await res.json().catch(() => ({}))
      if (seq !== requestSeq.current) return
      if (res.ok) setResult(json as ListResponse)
      else setError(json.error ?? 'Could not load the incoming data')
    } catch {
      if (seq === requestSeq.current) setError('Could not reach the server. Check your connection and try again.')
    }
    if (seq === requestSeq.current) setFetching(false)
  }, [token, query, page])

  useEffect(() => {
    const init = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) { router.push('/login'); return }
      const { data: prof } = await supabase
        .from('users').select(USER_PROFILE_COLUMNS).eq('id', session.user.id).single()
      if (!prof) { router.push('/coming-soon'); return }
      setProfile(prof as UserProfile)
      setToken(session.access_token)
      setLoading(false)
    }
    void init()
  }, [router, supabase])

  // Typing in the search box waits a moment; everything else loads at once.
  useEffect(() => {
    if (!token) return
    const timer = setTimeout(() => { void load() }, 300)
    return () => clearTimeout(timer)
  }, [load, token])

  const download = async (format: 'csv' | 'raw') => {
    setExporting(format)
    setError('')
    try {
      const res = await fetch(`/api/attendance/minop-incoming/export?${query({ format })}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json.error ?? 'The download failed')
      } else {
        const blob = await res.blob()
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1]
          ?? (format === 'csv' ? 'minop-incoming-data.csv' : 'minop-raw-payloads.json')
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = name
        document.body.appendChild(link)
        link.click()
        link.remove()
        URL.revokeObjectURL(url)
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    }
    setExporting(null)
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  if (loading) return <LoadingScreen />

  const total = result?.total ?? 0
  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1
  const filtered = Boolean(q.trim() || from || to)
  const rows = result?.rows ?? []

  const flags = (row: IncomingRegisterRow) => row.duplicateFlags.map(f => (
    <Badge key={f} tone="warn">{DUPLICATE_FLAG_LABEL[f]}</Badge>
  ))

  const reading = (row: IncomingRegisterRow) => (
    <div className={styles.reading}>
      <Badge tone={READ_TONE[row.readStatus]}>{READ_LABEL[row.readStatus]}</Badge>
      {row.readReason && <p className={styles.reason}>{row.readReason}</p>}
      {flags(row)}
    </div>
  )

  const ref = (row: IncomingRegisterRow) => (
    <span className={styles.ref} title={row.deliveryId}>
      {row.deliveryId.slice(0, 8)}{row.entryNumber !== null && row.entryCount > 1 ? ` · ${row.entryNumber}/${row.entryCount}` : ''}
    </span>
  )

  return (
    <AttendancePayrollLayout
      profile={profile}
      title="Incoming Minop data"
      subtitle="Data received from Minop for verification. New incoming data is stored only and is not used for attendance."
      onSignOut={handleSignOut}
      actions={
        <button
          type="button"
          onClick={() => void load()}
          disabled={fetching}
          className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
        >
          <RefreshCw size={13} className={fetching ? 'boe-spin' : undefined} /> Refresh
        </button>
      }
    >
      <div className={ui.stack}>
        {error && <Notice kind="error">{error}</Notice>}
        {result?.truncated && (
          <Notice kind="warning">
            More messages are retained than this view can read at once. Only the newest are shown and exported.
          </Notice>
        )}

        <div className={styles.controls}>
          <label className={styles.search}>
            <span className={ui.srOnly}>Search by Minop user ID, punch ID, or device</span>
            <input
              type="search"
              className={ui.input}
              placeholder="Search user ID, punch ID or device"
              value={q}
              onChange={e => { setQ(e.target.value); setPage(1) }}
            />
          </label>
          <label className={styles.date}>
            <span>Received from</span>
            <input type="date" className={ui.input} value={from} max={to || undefined}
              onChange={e => { setFrom(e.target.value); setPage(1) }} />
          </label>
          <label className={styles.date}>
            <span>to</span>
            <input type="date" className={ui.input} value={to} min={from || undefined}
              onChange={e => { setTo(e.target.value); setPage(1) }} />
          </label>
          {filtered && (
            <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
              onClick={() => { setQ(''); setFrom(''); setTo(''); setPage(1) }}>
              Clear filters
            </button>
          )}
          <div className={ui.toolbarEnd}>
            <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
              disabled={exporting !== null} onClick={() => void download('csv')}>
              <Download size={13} /> {exporting === 'csv' ? 'Preparing…' : 'Download CSV'}
            </button>
            <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
              disabled={exporting !== null} onClick={() => void download('raw')}>
              <Download size={13} /> {exporting === 'raw' ? 'Preparing…' : 'Download raw payloads'}
            </button>
          </div>
        </div>

        <p className={styles.summary} aria-live="polite">
          {result
            ? <>
                <strong>{total}</strong> {total === 1 ? 'record' : 'records'}{filtered ? ' match' : ''}
                {' · '}{result.messagesRetained} {result.messagesRetained === 1 ? 'message' : 'messages'} retained
                {' · '}Latest received: <strong>{ist(result.latestReceivedAt)}</strong> IST
              </>
            : 'Loading…'}
          {' '}Downloads include every matching record, not only this page. Times are Asia/Kolkata.
        </p>

        {!result && fetching ? (
          <StateBlock kind="loading">Loading incoming data…</StateBlock>
        ) : !result ? (
          <StateBlock kind="error" title="Could not load the incoming data">Use Refresh to try again.</StateBlock>
        ) : rows.length === 0 ? (
          <StateBlock kind="empty" title={filtered ? 'Nothing matches these filters' : 'Nothing received from Minop yet'}>
            {filtered ? 'Clear the filters to see everything that was received.' : 'Data will appear here as soon as Minop sends it.'}
          </StateBlock>
        ) : (
          <>
            <div className={`${ui.surface} ${ui.desktopOnly}`} style={{ overflow: 'hidden' }} aria-busy={fetching}>
              <div className={ui.tableWrap}>
                <table className={`${ui.table} ${styles.table}`}>
                  <thead>
                    <tr>
                      <th scope="col">Received (IST)</th>
                      <th scope="col">Minop user ID</th>
                      <th scope="col">Punch ID</th>
                      <th scope="col">Punch time</th>
                      <th scope="col">Punch type</th>
                      <th scope="col">Device</th>
                      <th scope="col">Name from Minop</th>
                      <th scope="col">Data reading</th>
                      <th scope="col">Payload</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => {
                      const pt = punchTime(row)
                      return (
                        <tr key={row.rowId}>
                          <td className={ui.nowrap}>{ist(row.receivedAt)}<div className={ui.sub}>{ref(row)}</div></td>
                          <td className={styles.mono}>{row.minopUserId ?? '—'}</td>
                          <td className={styles.mono}>{row.eventId ?? '—'}</td>
                          <td className={ui.nowrap}>{pt.main}{pt.note && <div className={ui.sub}>{pt.note}</div>}</td>
                          <td>
                            {row.punchTypeRaw ?? '—'}
                            {row.punchTypeSource && <div className={ui.sub}>{row.punchTypeSource}</div>}
                          </td>
                          <td className={styles.mono}>
                            {row.deviceName ?? row.deviceId ?? '—'}
                            {row.deviceName && row.deviceId && <div className={ui.sub}>{row.deviceId}</div>}
                            {row.deviceIp && <div className={ui.sub}>{row.deviceIp}</div>}
                          </td>
                          <td>{row.nameSupplied ?? <span className={ui.muted}>—</span>}</td>
                          <td>{reading(row)}</td>
                          <td><PayloadDetails row={row} token={token} /></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <ul className={ui.cards} aria-label="Incoming Minop records">
              {rows.map(row => {
                const pt = punchTime(row)
                return (
                  <li key={row.rowId} className={`${ui.surface} ${ui.card}`}>
                    <div className={ui.cardHead}>
                      <div className={ui.strong}>User <span className={styles.mono}>{row.minopUserId ?? '—'}</span></div>
                      <div className={`${ui.sub} ${ui.nowrap}`} style={{ marginTop: 0 }}>{ref(row)}</div>
                    </div>
                    <dl className={styles.cardFacts}>
                      <dt>Received (IST)</dt><dd>{ist(row.receivedAt)}</dd>
                      <dt>Punch ID</dt><dd className={styles.mono}>{row.eventId ?? '—'}</dd>
                      <dt>Punch time</dt><dd>{pt.main}{pt.note ? ` (${pt.note})` : ''}</dd>
                      <dt>Punch type</dt><dd>{row.punchTypeRaw ?? '—'}{row.punchTypeSource ? ` (${row.punchTypeSource})` : ''}</dd>
                      <dt>Device</dt>
                      <dd className={styles.mono}>{[row.deviceName, row.deviceId, row.deviceIp].filter(Boolean).join(' · ') || '—'}</dd>
                      <dt>Name from Minop</dt><dd>{row.nameSupplied ?? '—'}</dd>
                    </dl>
                    {reading(row)}
                    <PayloadDetails row={row} token={token} />
                  </li>
                )
              })}
            </ul>

            <nav className={styles.pager} aria-label="Pages">
              <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                disabled={page <= 1 || fetching} onClick={() => setPage(p => Math.max(1, p - 1))}>
                Previous
              </button>
              <span>Page {result.page} of {pageCount}</span>
              <button type="button" className={`boe-btn boe-btn-ghost ${ui.btnSm}`}
                disabled={page >= pageCount || fetching} onClick={() => setPage(p => p + 1)}>
                Next
              </button>
            </nav>
          </>
        )}
      </div>
    </AttendancePayrollLayout>
  )
}
