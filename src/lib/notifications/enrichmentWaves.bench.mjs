// Before/after wall-clock comparison for the notification page's enrichment,
// under comparable conditions: the SAME fake client, the same page of rows, and
// a fixed simulated per-query latency standing in for one database round trip.
//
// It is a benchmark, not a test: run it by hand.
//
//   node --import tsx src/lib/notifications/enrichmentWaves.bench.mjs [rttMs] [runs]
//
// "Before" is the implementation at the given git ref (default origin/main),
// written to a temporary sibling module; "after" is the working tree's. Both are
// imported and driven identically, so the only difference is the code.
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const RTT = Number(process.argv[2] ?? 200)
const RUNS = Number(process.argv[3] ?? 15)
const REF = process.env.BENCH_REF ?? 'origin/main'
const DIR = join(process.cwd(), 'src/lib/notifications')
const BEFORE = join(DIR, '__bench_before_pageEnrichment.ts')

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** One page: 12 tasks, 12 linked activity rows, 8 distinct people. */
function page() {
  const rows = []
  for (let i = 0; i < 12; i++) rows.push({ task_id: `task-${i}`, activity_log_id: `act-${i}` })
  return rows
}

function fakeClient() {
  let queries = 0
  const person = i => ({ full_name: `Person ${i % 8}` })
  const client = {
    from(table) {
      const builder = {
        select(columns) { builder.columns = columns; return builder },
        async in(_col, ids) {
          queries++
          await sleep(RTT)
          if (table === 'tasks') {
            return { data: ids.map((id, i) => ({
              id, title: `Task ${i}`, assigned_to: `user-${i % 8}`, created_by: `user-${(i + 1) % 8}`,
              assignee: person(i), creator: person(i + 1),
            })), error: null }
          }
          if (table === 'task_activity_log') {
            return { data: ids.map((id, i) => ({
              id, actor_id: `user-${i % 8}`, action: 'note_added', note: 'x',
              from_status: null, to_status: null, attachment_url: null, actor: person(i),
            })), error: null }
          }
          if (table === 'task_attachments') return { data: [], error: null }
          if (table === 'users') {
            return { data: ids.map((id, i) => ({ id, full_name: `Person ${i % 8}` })), error: null }
          }
          return { data: [], error: null }
        },
      }
      return builder
    },
  }
  return { client, queries: () => queries }
}

async function measure(enrich) {
  const samples = []
  let queries = 0
  for (let i = 0; i < RUNS; i++) {
    const { client, queries: q } = fakeClient()
    const started = performance.now()
    await enrich(client, page())
    samples.push(performance.now() - started)
    queries = q()
  }
  samples.sort((a, b) => a - b)
  return {
    runs: RUNS,
    queries,
    min: Math.round(samples[0]),
    median: Math.round(samples[Math.floor(samples.length / 2)]),
    max: Math.round(samples[samples.length - 1]),
  }
}

const source = execFileSync('git', ['show', `${REF}:src/lib/notifications/pageEnrichment.ts`], { encoding: 'utf8' })
writeFileSync(BEFORE, source, 'utf8')
try {
  const before = await import(pathToFileURL(BEFORE).href)
  const after = await import(pathToFileURL(join(DIR, 'pageEnrichment.ts')).href)
  const b = await measure(before.enrichNotificationPage)
  const a = await measure(after.enrichNotificationPage)
  console.log(`simulated round trip: ${RTT} ms, runs: ${RUNS}, page: 12 tasks / 12 activity rows / 8 people`)
  console.log(`before (${REF}):`, JSON.stringify(b))
  console.log('after  (working tree):', JSON.stringify(a))
  console.log(`median delta: ${b.median - a.median} ms (${b.queries} queries -> ${a.queries})`)
} finally {
  unlinkSync(BEFORE)
}
