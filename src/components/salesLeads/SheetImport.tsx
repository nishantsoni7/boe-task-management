'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, FileUp, X } from 'lucide-react'
import { importSheet, SALES_KEY, SalesRequestError, type SheetOutcome } from '@/lib/salesLeads/api'
import { plural } from '@/lib/salesLeads/format'
import { firstDates, readLeadsMaster, readWebsiteLeads, workbookKind, type Grid } from '@/lib/salesLeads/sheets'
import type { createClient } from '@/lib/supabase/client'
import b from './leadBoard.module.css'
import s from './salesPages.module.css'

// The two old Google Sheets, after the ClickUp import (the database refuses them before it). Downloaded from Drive as
// Excel, read here, and nothing is saved until the button is pressed. A number already in BOE One keeps its ClickUp
// stage and salesperson and gains what the sheets know; a number only in the sheets becomes an old lead, kept for the
// record. Safe to run again: a row already saved is skipped.

const BATCH = 500
type Book = { name: string; tabs: Record<string, Grid> }

async function readBook(file: File): Promise<{ kind: 'leads_master' | 'website' | null; book: Book }> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
  const tabs = Object.fromEntries(wb.SheetNames.map(n => [n, XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: '', raw: true })]))
  return { kind: workbookKind(wb.SheetNames), book: { name: file.name, tabs } }
}

export function SheetImport({ supabase }: { supabase: ReturnType<typeof createClient> }) {
  const queryClient = useQueryClient()
  const [master, setMaster] = useState<Book | null>(null)
  const [website, setWebsite] = useState<Book | null>(null)
  const [bad, setBad] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [result, setResult] = useState<SheetOutcome | null>(null)
  const [failure, setFailure] = useState('')

  const plan = useMemo(() => {
    const m = master ? readLeadsMaster(master.tabs) : null
    const w = website ? readWebsiteLeads(website.tabs, firstDates(m?.rows ?? [])) : null
    return { rows: [...(m?.rows ?? []), ...(w?.rows ?? [])], tabs: [...(m?.tabs ?? []), ...(w?.tabs ?? [])], estimated: (m?.estimated ?? 0) + (w?.estimated ?? 0) }
  }, [master, website])

  async function add(list: FileList | null) {
    if (!list) return
    const read = await Promise.all(Array.from(list).map(async f => ({ file: f.name, ...(await readBook(f).catch(() => ({ kind: null, book: null }))) })))
    for (const r of read) {
      if (r.kind === 'leads_master' && r.book) setMaster(r.book)
      if (r.kind === 'website' && r.book) setWebsite(r.book)
    }
    setBad(read.filter(r => !r.kind).map(r => r.file))
    setResult(null)
    setDone(0)
  }

  async function run() {
    const total: SheetOutcome = { history: 0, filled: 0, already: 0, failed: [] }
    setRunning(true)
    setFailure('')
    setResult(total)
    try {
      for (let i = 0; i < plan.rows.length; i += BATCH) {
        const r = await importSheet(supabase, plan.rows.slice(i, i + BATCH))
        total.history += r.history
        total.filled += r.filled
        total.already += r.already
        total.failed.push(...r.failed)
        setDone(Math.min(i + BATCH, plan.rows.length))
        setResult({ ...total })
      }
      await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
    } catch (e) {
      setFailure(e instanceof SalesRequestError ? e.message : `${(e as Error).message} Nothing saved so far is lost: press Import again and it carries on.`)
    } finally {
      setRunning(false)
    }
  }

  const finished = result && !running && done === plan.rows.length && plan.rows.length > 0
  const why = (result?.failed ?? []).reduce<Record<string, number>>((m, f) => ({ ...m, [f.why]: (m[f.why] ?? 0) + 1 }), {})

  return (
    <section className={s.card} aria-labelledby="import-sheets">
      <h2 id="import-sheets">The old Google Sheets: Leads Master and Website Leads</h2>
      <p>
        After the ClickUp import. Download each sheet from Drive as Excel (File, Download, Microsoft Excel) and add both here.
        A number already in BOE One keeps its ClickUp stage and salesperson and gains what the sheets know. A number only in
        the sheets is kept as an old lead: searchable, known if it calls again, on nobody&apos;s board.
      </p>
      <label className={s.drop}>
        <FileUp aria-hidden="true" />
        <b>Add the two Excel files</b>
        <span>Leads Master - 2026.xlsx and Website Leads.xlsx</span>
        <input className="boe-sr-only" type="file" accept=".xlsx" multiple disabled={running} onChange={e => { void add(e.target.files); e.target.value = '' }} />
      </label>
      {bad.map(f => <p key={f} className={s.bad}>{f} is neither the Leads Master nor the Website Leads sheet.</p>)}
      {(master || website) && (
        <ul className={s.files}>
          {[master && { book: master, clear: () => setMaster(null) }, website && { book: website, clear: () => setWebsite(null) }].filter(Boolean).map(x => x && (
            <li key={x.book.name}>
              <span>{x.book.name}</span>
              <button type="button" aria-label={`Remove ${x.book.name}`} disabled={running} onClick={x.clear}><X aria-hidden="true" /></button>
            </li>
          ))}
        </ul>
      )}

      {plan.rows.length > 0 && (
        <>
          <table className={s.table}>
            <thead><tr><th scope="col">Tab</th><th scope="col">Rows read</th><th scope="col">Left out</th><th scope="col">Why</th></tr></thead>
            <tbody>
              {plan.tabs.map(t => (
                <tr key={t.tab}><td>{t.tab}</td><td data-l="Rows read">{t.used.toLocaleString('en-IN')}</td><td data-l="Left out">{t.skipped.toLocaleString('en-IN')}</td><td data-l="Why">{t.note}</td></tr>
              ))}
            </tbody>
          </table>
          {plan.estimated > 0 && <p>{plural(plan.estimated, 'row has', 'rows have')} no exact day; the date is taken from the month, or from the rows around it, and the lead&apos;s history says so.</p>}
          {!website && <p className={s.bad}>Add Website Leads too: it brings each customer&apos;s message.</p>}
          {!master && <p className={s.bad}>Add Leads Master too: without it most website rows have no date.</p>}

          <div className={s.go}>
            {result && (
              <div className={s.progress} role="status">
                <div className={b.progressText}><b>{done.toLocaleString('en-IN')}</b> of {plan.rows.length.toLocaleString('en-IN')} rows saved</div>
                <span className={b.progressTrack} aria-hidden="true"><span className={b.progressFill} style={{ width: `${Math.round((done / Math.max(plan.rows.length, 1)) * 100)}%` }} /></span>
              </div>
            )}
            {failure && <p className={s.bad} role="alert">{failure}</p>}
            {finished && result && (
              <div className={s.done} role="status">
                <CheckCircle2 aria-hidden="true" />
                <div>
                  <b>{plural(result.history, 'old lead')} kept for the record, {plural(result.filled, 'lead')} filled in from the sheets.</b>
                  {result.already ? ` ${result.already.toLocaleString('en-IN')} rows were already here.` : ''}
                  {Object.keys(why).length > 0 && ` Not saved: ${Object.entries(why).map(([w, n]) => `${n.toLocaleString('en-IN')} (${w})`).join(', ')}.`}
                </div>
              </div>
            )}
            <div className={s.goRow}>
              <button type="button" className="boe-btn boe-btn-primary" disabled={running} onClick={() => void run()}>
                {running ? 'Importing...' : `Import ${plan.rows.length.toLocaleString('en-IN')} rows`}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
