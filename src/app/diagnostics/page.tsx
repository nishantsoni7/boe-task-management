'use client'

// /diagnostics — this device's own record of slow pages and page errors.
//
// The server log that receives the same reports is kept for one hour on this
// Vercel plan, so when somebody says "it hung for 15 seconds this morning", this
// page is where the evidence still is. It shows only the whitelisted reports
// (route templates, durations, scrubbed error types — nothing about records or
// people), read from this browser. Copy puts them on the clipboard to paste
// into a message; nothing is sent from here.

import { useEffect, useState } from 'react'
import { colors, font } from '@/lib/tokens'
import { clearLocally, readLocally } from '@/components/layout/routeHealthLocal'
import type { StoredReport } from '@/lib/telemetry/routeHealth'

function describe(e: StoredReport): { what: string; detail: string } {
  const r = e.report
  const s = (ms: number | null) => (ms == null ? 'never' : `${(ms / 1000).toFixed(1)} s`)
  if (r.kind === 'navigation') {
    return { what: `${r.from} → ${r.to}`, detail: `${r.stalled ? 'Stalled · ' : ''}page ${s(r.durationMs)} · content ${s(r.contentMs)}${r.visibleAtStart && r.visibleAtEnd ? '' : ' · tab was hidden'}` }
  }
  if (r.kind === 'document') {
    return { what: `Opened ${r.route}`, detail: `first page ${s(r.firstRouteMs)} · content ${s(r.contentMs)}${r.visible ? '' : ' · tab was hidden'}` }
  }
  return { what: `Error on ${r.route}`, detail: r.message }
}

export default function DiagnosticsPage() {
  const [entries, setEntries] = useState<StoredReport[] | null>(null)
  const [copied, setCopied] = useState(false)

  // localStorage exists only in the browser, so the list is read after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setEntries(readLocally().reverse()) }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ userAgent: navigator.userAgent, reports: [...(entries ?? [])].reverse() }, null, 1))
      setCopied(true)
    } catch { setCopied(false) }
  }

  return (
    <main style={{ minHeight: '100vh', background: colors.void, padding: '24px 16px', fontFamily: font.body }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, margin: '0 0 6px', color: colors.primary }}>Diagnostics</h1>
        <p style={{ fontSize: 13, color: colors.secondary, margin: '0 0 16px', lineHeight: 1.5 }}>
          Slow pages (5 seconds or more) and page errors seen on this device in the last 7 days. It holds no names,
          numbers or record details. Copy it into a message when you report a problem.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button type="button" className="boe-btn boe-btn-primary" onClick={copy} disabled={!entries?.length}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" className="boe-btn" onClick={() => { clearLocally(); setEntries([]); setCopied(false) }} disabled={!entries?.length}>
            Clear
          </button>
        </div>
        {entries == null ? null : entries.length === 0 ? (
          <p style={{ fontSize: 14, color: colors.secondary }}>Nothing recorded on this device.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {entries.map((e, i) => {
              const d = describe(e)
              return (
                <li key={`${e.at}-${i}`} style={{ background: colors.base, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, color: colors.secondary }}>{new Date(e.at).toLocaleString()}</div>
                  <div style={{ fontSize: 14, color: colors.primary, overflowWrap: 'anywhere' }}>{d.what}</div>
                  <div style={{ fontSize: 13, color: colors.secondary, overflowWrap: 'anywhere' }}>{d.detail}</div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </main>
  )
}
