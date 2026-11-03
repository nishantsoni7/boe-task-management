'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Download, FileUp, X } from 'lucide-react'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { useSalesAccess } from '@/hooks/useSalesAccess'
import { istToday } from '@/lib/istDate'
import { fetchPeople, importHistory, importLeads, SALES_KEY, type HistoryOutcome, type ImportOutcome } from '@/lib/salesLeads/api'
import { stageLabel } from '@/lib/salesLeads/board'
import {
  buildPlan, guessHolder, historyBatches, readExport, readHistory, toSave, type ClickupTask, type HistoryRow, type Refused,
} from '@/lib/salesLeads/clickup'
import { dayLabel, plural } from '@/lib/salesLeads/format'
import { createClient } from '@/lib/supabase/client'
import { SalesFrame } from './SalesFrame'
import b from './leadBoard.module.css'
import s from './salesPages.module.css'

// Bringing ClickUp over. The files are read here, in the browser, and go nowhere until the button is pressed. The whole
// result is on the screen first: who gets what, what each old status becomes, and what cannot come across. Saving goes in
// small batches, and a task already saved is skipped, so an interrupted import is simply started again.
// A CSV export carries only each task's latest comment, undated. The history file (scripts/clickup-history.mjs, read from
// ClickUp's API) carries every comment with its date and author; added here, it goes in after the leads.

const BATCH = 200
const PER_DAY = [10, 15, 20, 30]

type LoadedFile = { name: string; tasks: ClickupTask[] }
type Progress = { done: number; total: number; result: ImportOutcome; history?: { done: number; total: number; result: HistoryOutcome } }

const NOBODY = 'nobody'
const shortName = (file: string) => file.replace(/^.*Best Of Exports - /i, '').replace(/\.csv$/i, '')

function downloadRefused(rows: { task: string; name: string; folder: string; status: string; why: string }[]) {
  const cell = (v: string) => `"${v.replaceAll('"', '""')}"`
  const lines = [['Task', 'Name', 'Folder', 'Status', 'Why'], ...rows.map(r => [r.task, r.name, r.folder, r.status, r.why])]
  const url = URL.createObjectURL(new Blob([lines.map(l => l.map(cell).join(',')).join('\n')], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'clickup-not-imported.csv'
  a.click()
  URL.revokeObjectURL(url)
}

export function ImportScreen() {
  const { ready } = usePermissionContext()
  const { canAssign } = useSalesAccess()
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [history, setHistory] = useState<{ name: string; rows: HistoryRow[] } | null>(null)
  const [badFiles, setBadFiles] = useState<string[]>([])
  const [perDay, setPerDay] = useState(20)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [over, setOver] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [failure, setFailure] = useState('')
  const today = istToday()

  const people = useQuery({ queryKey: [SALES_KEY, 'people'], queryFn: () => fetchPeople(supabase), staleTime: 300_000, enabled: ready && canAssign })
  const plan = useMemo(() => (files.length ? buildPlan(files.map(f => f.tasks), perDay, today) : null), [files, perDay, today])

  // Leaving mid-way would stop the import where it stands.
  useEffect(() => {
    if (!running) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])

  async function addFiles(list: FileList | null) {
    if (!list) return
    const all = Array.from(list)
    const histories = await Promise.all(all.filter(f => /\.jsonl$/i.test(f.name)).map(async f => ({ name: f.name, rows: readHistory(await f.text()) })))
    const good = histories.find(h => h.rows)
    if (good?.rows) setHistory({ name: good.name, rows: good.rows })
    const read = await Promise.all(all.filter(f => !/\.jsonl$/i.test(f.name)).map(async f => ({ name: f.name, tasks: readExport(await f.text()) })))
    setBadFiles([...read.filter(f => !f.tasks).map(f => f.name), ...histories.filter(h => !h.rows).map(h => h.name)])
    setFiles(now => [...now, ...read.flatMap(f => (f.tasks && !now.some(n => n.name === f.name) ? [{ name: f.name, tasks: f.tasks }] : []))])
    setProgress(null)
  }

  const holderOf = (folder: string) => {
    const pick = chosen[folder]
    if (pick) return pick === NOBODY ? null : pick
    return guessHolder(folder, people.data ?? [])
  }

  async function run() {
    if (!plan) return
    const rows = toSave(plan, Object.fromEntries(plan.folders.map(f => [f.folder, holderOf(f.folder)])))
    const result: ImportOutcome = { created: 0, merged: 0, already: 0, failed: [] }
    setRunning(true)
    setFailure('')
    setProgress({ done: 0, total: rows.length, result })
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        const r = await importLeads(supabase, rows.slice(i, i + BATCH))
        result.created += r.created
        result.merged += r.merged
        result.already += r.already
        result.failed.push(...r.failed)
        setProgress({ done: Math.min(i + BATCH, rows.length), total: rows.length, result: { ...result } })
      }
      if (history) {
        const batches = historyBatches(history.rows)
        const total = history.rows.reduce((n, r) => n + r.comments.length, 0)
        const h: HistoryOutcome = { comments: 0, statuses: 0, already: 0, not_imported: 0, failed: [] }
        let done = 0
        for (const batch of batches) {
          const r = await importHistory(supabase, batch)
          h.comments += r.comments
          h.statuses += r.statuses
          h.already += r.already
          h.not_imported += r.not_imported
          h.failed.push(...r.failed)
          done += batch.reduce((n, x) => n + x.comments.length, 0)
          setProgress({ done: rows.length, total: rows.length, result: { ...result }, history: { done, total, result: { ...h } } })
        }
      }
      await queryClient.invalidateQueries({ queryKey: [SALES_KEY] })
    } catch (e) {
      setFailure(`${(e as Error).message} Nothing saved so far is lost. Press Import again and it carries on from here.`)
    } finally {
      setRunning(false)
    }
  }

  const refusedRows = (refused: Refused[], result?: ImportOutcome) => [
    ...refused.map(r => ({ task: r.taskId, name: r.name, folder: r.folder, status: r.status, why: r.why })),
    ...(result?.failed ?? []).map(f => ({ task: f.task_id ?? '', name: '', folder: '', status: '', why: f.why })),
  ]

  if (ready && !canAssign) {
    return (
      <SalesFrame title="Import from ClickUp" subtitle="Lead Master">
        <div className="boe-empty"><p className="boe-empty-title">This page is for whoever allots leads</p><p>Ask an Admin for the right to allot leads.</p></div>
      </SalesFrame>
    )
  }

  const finished = progress && !running && progress.done === progress.total
  const noHolder = plan?.folders.filter(f => !holderOf(f.folder)) ?? []

  return (
    <SalesFrame title="Import from ClickUp" subtitle="Lead Master">
      <div className={s.import}>
        <section className={s.card} aria-labelledby="import-files">
          <h2 id="import-files">Add your ClickUp exports</h2>
          <p>Add every list from every salesperson at once. Nothing is saved until you press Import.</p>
          <label
            className={`${s.drop}${over ? ` ${s.dropOver}` : ''}`}
            onDragOver={e => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={e => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files) }}
          >
            <FileUp aria-hidden="true" />
            <b>Drop CSV files here, or press to choose</b>
            <span>ClickUp: open a list, then Export, then CSV. Add the history file (history.jsonl) with them.</span>
            <input ref={input} className="boe-sr-only" type="file" accept=".csv,text/csv,.jsonl" multiple disabled={running} onChange={e => { void addFiles(e.target.files); e.target.value = '' }} />
          </label>
          {badFiles.map(f => <p key={f} className={s.bad}>{shortName(f)} is not a ClickUp task export or history file.</p>)}
          {history && (
            <ul className={s.files}>
              <li>
                <span>{history.name}: every comment with its date</span><span className={b.count}>{plural(history.rows.length, 'task')}</span>
                <button type="button" aria-label="Remove the history file" disabled={running} onClick={() => setHistory(null)}><X aria-hidden="true" /></button>
              </li>
            </ul>
          )}
          {files.length > 0 && (
            <ul className={s.files}>
              {files.map(f => (
                <li key={f.name}>
                  <span>{shortName(f.name)}</span><span className={b.count}>{plural(f.tasks.length, 'task')}</span>
                  <button type="button" aria-label={`Remove ${shortName(f.name)}`} disabled={running} onClick={() => setFiles(now => now.filter(n => n.name !== f.name))}><X aria-hidden="true" /></button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {plan && (
          <>
            <div className="fin-stats" role="group" aria-label="What is in these files">
              <Tile label="Open leads" value={plan.open} sub="go to a salesperson" />
              <Tile label="Dead leads" value={plan.dead} sub="kept, so a repeat number is known" />
              <Tile label="Same number twice" value={plan.samePhone} sub="become a note on the lead" />
              <Tile label="Cannot come across" value={plan.refused.length} sub="the download says why" />
            </div>

            {!history && (
              <section className={s.card} aria-labelledby="import-history">
                <h2 id="import-history">Only the latest comment is in these files</h2>
                <p>
                  A ClickUp export carries each task&apos;s latest comment, without its date. To bring every comment with its date and
                  who wrote it, run the history download on this computer (Sales dossier, &quot;ClickUp history&quot;) and add the
                  history.jsonl file it makes. You can also import now and add the history file later: nothing is saved twice.
                </p>
              </section>
            )}

            <section className={s.card} aria-labelledby="import-people">
              <h2 id="import-people">Who gets what</h2>
              <p>Each ClickUp folder goes to one person. Overdue follow-ups are spread over the coming working days, so nobody starts with a wall of red.</p>
              <div className={s.perDay} role="group" aria-label="Follow-ups a day">
                <span>Follow-ups a day, per person</span>
                {PER_DAY.map(n => <button key={n} type="button" className={b.view} aria-pressed={perDay === n} disabled={running} onClick={() => setPerDay(n)}>{n}</button>)}
              </div>
              <table className={s.table}>
                <thead><tr><th scope="col">ClickUp folder</th><th scope="col">Goes to</th><th scope="col">Open</th><th scope="col">Dead</th><th scope="col">Re-planned</th><th scope="col">Caught up by</th></tr></thead>
                <tbody>
                  {plan.folders.map(f => (
                    <tr key={f.folder}>
                      <td>{f.folder}</td>
                      <td data-l="Goes to">
                        <select className={`${b.filter} ${s.pick}`} aria-label={`Who takes ${f.folder}`} value={chosen[f.folder] ?? holderOf(f.folder) ?? NOBODY} disabled={running}
                          onChange={e => setChosen(c => ({ ...c, [f.folder]: e.target.value }))}>
                          <option value={NOBODY}>Not allotted</option>
                          {(people.data ?? []).map(p => <option key={p.id} value={p.id}>{p.full_name}</option>)}
                        </select>
                      </td>
                      <td data-l="Open">{f.open.toLocaleString('en-IN')}</td>
                      <td data-l="Dead">{f.dead.toLocaleString('en-IN')}</td>
                      <td data-l="Re-planned">{f.replanned.toLocaleString('en-IN')}</td>
                      <td data-l="Caught up by">{f.lastDay ? dayLabel(f.lastDay) : 'Up to date'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {noHolder.length > 0 && <p className={s.bad}>{noHolder.map(f => f.folder).join(', ')}: these leads will wait in the Lead Master until somebody allots them.</p>}
            </section>

            <details className={s.card}>
              <summary>What each ClickUp status becomes</summary>
              <table className={s.table}>
                <thead><tr><th scope="col">ClickUp status</th><th scope="col">Stage</th><th scope="col">Temperature</th><th scope="col">Leads</th></tr></thead>
                <tbody>
                  {plan.statuses.map(p => (
                    <tr key={`${p.family}|${p.stage}|${p.temperature}`}>
                      <td>{p.family}</td><td data-l="Stage">{stageLabel(p.stage)}</td>
                      <td data-l="Temperature">{p.stage === 'dead' ? '–' : p.temperature}</td><td data-l="Leads">{p.n.toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            <div className={s.go}>
              {progress && (
                <div className={s.progress} role="status">
                  <div className={b.progressText}><b>{progress.done.toLocaleString('en-IN')}</b> of {progress.total.toLocaleString('en-IN')} saved</div>
                  <span className={b.progressTrack} aria-hidden="true"><span className={b.progressFill} style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }} /></span>
                </div>
              )}
              {progress?.history && (
                <div className={s.progress} role="status">
                  <div className={b.progressText}><b>{progress.history.done.toLocaleString('en-IN')}</b> of {progress.history.total.toLocaleString('en-IN')} comments saved</div>
                  <span className={b.progressTrack} aria-hidden="true"><span className={b.progressFill} style={{ width: `${Math.round((progress.history.done / Math.max(progress.history.total, 1)) * 100)}%` }} /></span>
                </div>
              )}
              {failure && <p className={s.bad} role="alert">{failure}</p>}
              {finished && (
                <div className={s.done} role="status">
                  <CheckCircle2 aria-hidden="true" />
                  <div>
                    <b>{plural(progress.result.created, 'lead')} imported.</b>{' '}
                    {plural(progress.result.merged, 'task')} added as notes{progress.result.already ? `, ${progress.result.already.toLocaleString('en-IN')} already here` : ''}.
                    {progress.history && <> {plural(progress.history.result.comments, 'comment')} and {plural(progress.history.result.statuses, 'status change')} added with their dates.</>}
                    {' '}<Link href="/sales/team">Open the Team page</Link>, or give people access in <Link href="/admin/control-center?tab=sales-team">Control Center</Link>.
                  </div>
                </div>
              )}
              <div className={s.goRow}>
                {refusedRows(plan.refused, progress?.result).length > 0 && (
                  <button type="button" className="boe-btn boe-btn-secondary" onClick={() => downloadRefused(refusedRows(plan.refused, progress?.result))}><Download aria-hidden="true" />Download what did not come across</button>
                )}
                {people.isError && <p className={s.bad} role="alert">The list of salespeople could not be loaded. Reload the page.</p>}
                <button type="button" className="boe-btn boe-btn-primary" disabled={running || !people.data} onClick={() => void run()}>
                  {running ? 'Importing...' : `Import ${(plan.open + plan.dead).toLocaleString('en-IN')} leads`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </SalesFrame>
  )
}

function Tile({ label, value, sub }: { label: string; value: number; sub: string }) {
  return <div className="fin-stat"><span className="fin-stat-label">{label}</span><span className="fin-stat-value" style={{ display: 'block' }}>{value.toLocaleString('en-IN')}</span><span className="fin-stat-sub" style={{ display: 'block' }}>{sub}</span></div>
}
