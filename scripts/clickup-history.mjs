#!/usr/bin/env node
// ClickUp's full history for Sales → Import from ClickUp.
//
// A ClickUp CSV export carries only each task's latest comment, without its date. This reads, from ClickUp's API, every
// comment of every task in the exports (with its date and author, replies included) and, where ClickUp keeps it, the
// statuses each task went through. It writes one line per task to history.jsonl, which the Import page takes with the CSVs.
//
// Run it on your own computer, with your own ClickUp token (ClickUp: avatar, Settings, Apps, API Token, Generate):
//   $env:CLICKUP_TOKEN = "pk_..."                                    (PowerShell; the token stays in that window)
//   node scripts/clickup-history.mjs "<folder with the CSV exports>"            the whole workspace, about two hours
//   node scripts/clickup-history.mjs "<folder with the CSV exports>" --sample 5 five tasks per folder, to check first
// The sample writes sample-history.jsonl and sample.csv next to the exports. Stopping is safe: a task already in the
// file is skipped when it is run again. ClickUp allows 100 requests a minute. Only counts are printed; the token is
// never written anywhere. Customer data stays in that folder: never copy it into the repository.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const API = 'https://api.clickup.com/api/v2'
const PAGE = 25

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += c
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

/** Every task in the exports, once: its id, folder and comment count, and the row itself for a sample CSV. */
export function readTasks(files) {
  const byId = new Map()
  const headers = []
  for (const text of files) {
    const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''))
    if (!head?.includes('Task ID')) continue
    for (const h of head) if (!headers.includes(h)) headers.push(h)
    for (const r of rows) {
      if (r.length < 2) continue
      const task = Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))
      const id = task['Task ID']
      if (id && !byId.has(id)) byId.set(id, { id, folder: task.Folder ?? '', comments: Number(task['Comment Count']) || 0, task })
    }
  }
  return { tasks: [...byId.values()], headers }
}

/** A few tasks per folder to check before the whole run: the most talked-about half, the rest spread across the list. */
export function pickSample(tasks, perFolder) {
  const folders = new Map()
  for (const t of tasks) folders.set(t.folder, [...(folders.get(t.folder) ?? []), t])
  const out = []
  for (const list of folders.values()) {
    const sorted = [...list].sort((a, b) => b.comments - a.comments || a.id.localeCompare(b.id))
    const top = sorted.slice(0, Math.ceil(perFolder / 2))
    const rest = sorted.slice(top.length)
    const step = rest.length / Math.max(1, perFolder - top.length)
    const spread = Array.from({ length: Math.min(rest.length, perFolder - top.length) }, (_, i) => rest[Math.floor(i * step)])
    out.push(...top, ...spread)
  }
  return out
}

const comment = c => ({
  id: String(c.id),
  at: new Date(Number(c.date)).toISOString(),
  author: c.user?.username || c.user?.email || '',
  text: String(c.comment_text ?? ''),
})

/**
 * One task's history. `get(path)` returns the parsed JSON, or { status } for a refusal it did not throw on.
 * Comments come newest first, 25 a page; the next page starts at the oldest comment of the last one.
 */
export async function taskHistory(id, get, { statuses = true } = {}) {
  const all = []
  let start = null
  for (;;) {
    const page = await get(`/task/${id}/comment${start ? `?start=${start.date}&start_id=${start.id}` : ''}`)
    const list = page?.comments ?? []
    for (const c of list) {
      all.push(comment(c))
      if (Number(c.reply_count) > 0) {
        const replies = await get(`/comment/${c.id}/reply`)
        for (const r of replies?.comments ?? []) all.push(comment(r))
      }
    }
    if (list.length < PAGE) break
    const last = list[list.length - 1]
    if (start && String(last.id) === String(start.id)) break
    start = { date: last.date, id: last.id }
  }
  const seen = new Set()
  const comments = all.filter(c => c.text.trim() && !seen.has(c.id) && seen.add(c.id)).sort((a, b) => a.at.localeCompare(b.at))

  let kept = null
  if (statuses) {
    const s = await get(`/task/${id}/time_in_status`)
    if (s && !s.status && Array.isArray(s.status_history)) {
      const current = s.current_status?.status
      kept = s.status_history
        .filter(h => h.status && h.total_time?.since)
        .map(h => ({ status: h.status, at: new Date(Number(h.total_time.since)).toISOString(), ...(h.status === current ? { current: true } : {}) }))
    } else if (s?.status) {
      kept = undefined // ClickUp keeps no status history for this workspace; stop asking.
    }
  }
  return { task_id: id, comments, ...(kept ? { statuses: kept } : {}), statusesOff: kept === undefined }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function clickupGetter(token) {
  let last = 0
  return async function get(path) {
    for (let attempt = 1; ; attempt++) {
      await sleep(Math.max(0, last + 620 - Date.now()))
      last = Date.now()
      let res
      try {
        res = await fetch(API + path, { headers: { Authorization: token } })
      } catch (e) {
        if (attempt >= 4) throw e
        await sleep(2000 * attempt)
        continue
      }
      if (res.status === 429) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
        await sleep(Math.max(1000, reset ? reset - Date.now() + 1000 : 60_000))
        continue
      }
      if (res.status === 401) throw new Error('ClickUp refused the token. Generate a new one and set CLICKUP_TOKEN again.')
      if (res.status >= 500 && attempt < 4) { await sleep(2000 * attempt); continue }
      if (!res.ok) return { status: res.status }
      return res.json()
    }
  }
}

async function main() {
  const [dir, ...flags] = process.argv.slice(2)
  const token = process.env.CLICKUP_TOKEN?.trim()
  if (!dir || !existsSync(dir)) { console.error('Give the folder that holds the ClickUp CSV exports.'); process.exit(2) }
  if (!token) { console.error('Set CLICKUP_TOKEN first: $env:CLICKUP_TOKEN = "pk_..."'); process.exit(2) }
  const sampleAt = flags.indexOf('--sample')
  const sample = sampleAt >= 0 ? Math.max(1, Number(flags[sampleAt + 1]) || 5) : 0

  const texts = readdirSync(dir).filter(f => /\.csv$/i.test(f) && f !== 'sample.csv').map(f => readFileSync(join(dir, f), 'utf8'))
  const { tasks: everything, headers } = readTasks(texts)
  const tasks = sample ? pickSample(everything, sample) : everything
  const out = join(dir, sample ? 'sample-history.jsonl' : 'history.jsonl')
  if (sample) {
    const cell = v => (/[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
    writeFileSync(join(dir, 'sample.csv'), [headers, ...tasks.map(t => headers.map(h => t.task[h] ?? ''))].map(r => r.map(cell).join(',')).join('\n'))
  }
  const done = new Set(existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).task_id) : [])
  const todo = tasks.filter(t => !done.has(t.id))
  console.log(`${tasks.length} tasks, ${done.size} already read, ${todo.length} to read. Writing ${out}`)

  const get = clickupGetter(token)
  let statuses = true
  let comments = 0
  const t0 = Date.now()
  for (const [i, t] of todo.entries()) {
    let row
    try {
      row = await taskHistory(t.id, get, { statuses })
    } catch (e) {
      if (/refused the token/.test(e.message)) { console.error(e.message); process.exit(1) }
      row = { task_id: t.id, error: 'could not be read' }
    }
    if (row.statusesOff) { statuses = false; console.log('ClickUp keeps no status history here: reading comments only.') }
    delete row.statusesOff
    appendFileSync(out, JSON.stringify(row) + '\n')
    comments += row.comments?.length ?? 0
    if ((i + 1) % 50 === 0 || i + 1 === todo.length) {
      const left = ((Date.now() - t0) / (i + 1)) * (todo.length - i - 1)
      console.log(`${i + 1} of ${todo.length} tasks, ${comments} comments. About ${Math.ceil(left / 60_000)} min left.`)
    }
  }
  console.log(`Done. Add ${out} on Sales, Import from ClickUp, with the CSV files.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
