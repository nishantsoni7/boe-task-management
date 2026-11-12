'use client'

// Versions (20270622000000): what was sent to the client and when, "Send as new version", and a compare of any two
// (or of the last version with the unsent saved copy). The client's link always shows the latest version.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GitCompare, Send } from 'lucide-react'
import type { createClient } from '@/lib/supabase/client'
import { formatINR } from '@/lib/currency'
import { istDateOf } from '@/lib/istDate'
import { errorText, type Quotation } from '@/lib/quotations/api'
import { formatDateIN } from '@/lib/quotations/math'
import { compareDocs, fetchVersionDoc, fetchVersions, sendNewVersion, type Comparison } from '@/lib/quotations/versions'
import s from './quotations.module.css'

type Supabase = ReturnType<typeof createClient>

export function VersionsCard({ supabase, base, dirty, busy, onSent }: {
  supabase: Supabase; base: Quotation; dirty: boolean; busy: boolean; onSent: (msg: string) => void
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['quotations', 'versions', base.id, base.updated_at], queryFn: () => fetchVersions(supabase, base.id), retry: false })
  const [note, setNote] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [err, setErr] = useState('')
  const [cmp, setCmp] = useState<{ a: number; b: number } | null>(null)
  const rows = q.data ?? []
  if (q.isError || (rows.length === 0 && !base.share_token)) return null
  const latest = rows[0]?.version_no ?? 0
  const maySend = base.may_edit && !!base.share_token && ['draft', 'sent', 'negotiating'].includes(base.status)

  const send = async () => {
    setSending(true); setErr('')
    try {
      const no = await sendNewVersion(supabase, base.id, note?.trim() || null)
      setNote(null)
      await qc.invalidateQueries({ queryKey: ['quotations'] })
      onSent(`v${no} sent: the client's link now shows it. Send them the link again on WhatsApp.`)
    } catch (e) { setErr(errorText(e)) } finally { setSending(false) }
  }

  return (
    <section className={s.card}>
      <div className={s.cardHead}><h2>Versions</h2><span className={s.spacer} />{latest > 0 && <span className={s.muted}>client sees v{latest}</span>}</div>
      <div className={s.cardBody} style={{ display: 'grid', gap: 8 }}>
        {rows.map(v => (
          <div key={v.version_no} className={s.event}>
            <b style={{ minWidth: 26 }}>v{v.version_no}</b>
            <span>{formatDateIN(istDateOf(v.created_at))} · {formatINR(Number(v.value_before_gst))}{v.note ? ` · ${v.note}` : ''}{v.by ? ` · ${v.by}` : ''}</span>
          </div>
        ))}
        {latest > 0 && (
          <div className={s.row}>
            <button className={`${s.btn} ${s.btnSm}`} onClick={() => setCmp({ a: latest, b: 0 })}><GitCompare size={14} aria-hidden /> Unsent changes since v{latest}</button>
            {latest > 1 && <button className={`${s.btn} ${s.btnSm}`} onClick={() => setCmp({ a: latest - 1, b: latest })}>v{latest - 1} → v{latest}</button>}
          </div>
        )}
        {maySend && (dirty ? <div className={`${s.small} ${s.dirty}`}>Save first, then send it as a new version.</div>
          : note === null
            ? <button className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => setNote('')}><Send size={15} aria-hidden /> Send as new version (v{latest + 1})</button>
            : (
              <div style={{ display: 'grid', gap: 6 }}>
                <label className={s.field}><span>What changed for the client? (optional)</span><input id="version-note" className={s.input} maxLength={300} value={note} onChange={e => setNote(e.target.value)} placeholder="Walnut instead of mango, 5% off" autoFocus /></label>
                <div className={s.row}><button className={`${s.btn} ${s.btnPrimary} ${s.btnSm}`} disabled={sending} onClick={send}>{sending ? 'Sending…' : `Send v${latest + 1}`}</button><button className={`${s.btn} ${s.btnSm}`} onClick={() => setNote(null)}>Cancel</button></div>
              </div>
            ))}
        {err && <div className={`${s.notice} ${s.noticeBad}`}>{err}</div>}
      </div>
      {cmp && <CompareDialog supabase={supabase} id={base.id} a={cmp.a} b={cmp.b} versions={rows.map(v => v.version_no)} onClose={() => setCmp(null)} />}
    </section>
  )
}

function CompareDialog({ supabase, id, a: a0, b: b0, versions, onClose }: { supabase: Supabase; id: string; a: number; b: number; versions: number[]; onClose: () => void }) {
  const [a, setA] = useState(a0)
  const [b, setB] = useState(b0)
  const q = useQuery({
    queryKey: ['quotations', 'compare', id, a, b],
    queryFn: async () => compareDocs(await fetchVersionDoc(supabase, id, a), await fetchVersionDoc(supabase, id, b)),
    retry: false,
  })
  const label = (n: number) => (n === 0 ? 'Now (saved, not sent)' : `v${n}`)
  const pick = (value: number, set: (n: number) => void, id2: string) => (
    <select id={id2} className={s.input} style={{ width: 'auto' }} value={value} onChange={e => set(Number(e.target.value))}>
      {[...versions, 0].map(n => <option key={n} value={n}>{label(n)}</option>)}
    </select>
  )
  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.modal} style={{ maxWidth: 820 }} onClick={e => e.stopPropagation()} role="dialog" aria-labelledby="cmp-title">
        <div className={s.cardHead}><h2 id="cmp-title">Compare</h2><span className={s.spacer} />{pick(a, setA, 'cmp-a')}<span>→</span>{pick(b, setB, 'cmp-b')}<button type="button" className={s.iconBtn} onClick={onClose} aria-label="Close">×</button></div>
        <div className={s.cardBody} style={{ display: 'grid', gap: 12, maxHeight: '70vh', overflow: 'auto' }}>
          {q.isLoading && <div className={s.empty}>Comparing…</div>}
          {q.isError && <div className={`${s.notice} ${s.noticeBad}`}>{errorText(q.error)}</div>}
          {q.data && <CompareBody c={q.data} />}
        </div>
      </div>
    </div>
  )
}

function CompareBody({ c }: { c: Comparison }) {
  const diff = c.before.to - c.before.from
  const pct = c.before.from ? Math.round((diff / c.before.from) * 1000) / 10 : null
  const nothing = !c.header.length && !c.added.length && !c.removed.length && !c.changed.length
  return (
    <>
      <div className={s.kpis}>
        <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Before GST</div><div className={s.kpiValue}>{formatINR(c.before.to)}</div><div className={`${s.small} ${s.muted}`}>was {formatINR(c.before.from)}</div></div>
        <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Change</div><div className={s.kpiValue}>{diff >= 0 ? '+' : '−'}{formatINR(Math.abs(diff))}</div><div className={`${s.small} ${s.muted}`}>{pct === null ? '' : `${pct > 0 ? '+' : ''}${pct}%`}</div></div>
        <div className={s.kpi}><div className={`${s.small} ${s.muted}`}>Grand total</div><div className={s.kpiValue}>{formatINR(c.grand.to)}</div><div className={`${s.small} ${s.muted}`}>was {formatINR(c.grand.from)}</div></div>
      </div>
      {nothing && <div className={s.empty}>No difference.</div>}
      {c.header.length > 0 && <Table title="Terms" rows={c.header.map(h => [h.label, h.from, h.to])} />}
      {c.changed.length > 0 && <Table title="Changed products" rows={c.changed.flatMap(x => x.changes.map((ch, i) => [i === 0 ? `${x.room ? `${x.room} · ` : ''}${x.name}` : '', `${ch.label}: ${ch.from}`, ch.to]))} />}
      {c.added.length > 0 && <Table title="Added" rows={c.added.map(x => [`${x.room ? `${x.room} · ` : ''}${x.name}`, '', `${x.qty.toLocaleString('en-IN')} × ${x.price === null ? 'no price' : formatINR(x.price)}`])} />}
      {c.removed.length > 0 && <Table title="Removed" rows={c.removed.map(x => [`${x.room ? `${x.room} · ` : ''}${x.name}`, `${x.qty.toLocaleString('en-IN')} × ${x.price === null ? 'no price' : formatINR(x.price)}`, ''])} />}
    </>
  )
}

function Table({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <div>
      <div className={s.name} style={{ marginBottom: 4 }}>{title}</div>
      <div className={s.tableWrap}><table className={s.table}><thead><tr><th>Item</th><th>Before</th><th>After</th></tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} style={{ cursor: 'default' }}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
    </div>
  )
}
