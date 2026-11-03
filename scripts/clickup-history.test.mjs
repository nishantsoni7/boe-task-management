// scripts/clickup-history.mjs: reading ClickUp's full history. Every name, number and comment here is made up.
// Run: npm run test:file -- scripts/clickup-history.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, pickSample, readTasks, taskHistory } from './clickup-history.mjs'

const CSV = [
  'Task ID,Task Name,Folder,Comment Count,Latest Comment',
  't1,Hotel One,Ashok,3,"Said ""call Monday"", then left"',
  't2,Cafe Two,Ashok,0,',
  't3,Resort,Prerna,9,"Line one',
  'line two"',
].join('\n')

test('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
  const rows = parseCsv(CSV)
  assert.equal(rows.length, 4)
  assert.equal(rows[1][4], 'Said "call Monday", then left')
  assert.equal(rows[3][4], 'Line one\nline two')
})

test('every task once, across files, with its folder and comment count', () => {
  const { tasks, headers } = readTasks([CSV, CSV.replace('t2,Cafe Two', 't4,Cafe Four')])
  assert.deepEqual(tasks.map(t => t.id), ['t1', 't2', 't3', 't4'])
  assert.equal(tasks.find(t => t.id === 't3').comments, 9)
  assert.ok(headers.includes('Latest Comment'))
})

test('a sample takes the most talked-about half of each folder and spreads the rest', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, folder: 'A', comments: i }))
    .concat([{ id: 'b0', folder: 'B', comments: 1 }])
  const s = pickSample(tasks, 4)
  assert.deepEqual(s.filter(t => t.folder === 'A').slice(0, 2).map(t => t.id), ['a9', 'a8'])
  assert.equal(s.filter(t => t.folder === 'A').length, 4)
  assert.deepEqual(s.filter(t => t.folder === 'B').map(t => t.id), ['b0'])
})

const c = (id, day, text, extra = {}) => ({ id, date: String(Date.parse(`2025-01-${String(day).padStart(2, '0')}T10:00:00Z`)), comment_text: text, user: { username: 'Ashok' }, reply_count: '0', ...extra })

test('pages through 25 at a time, oldest first, replies included, statuses dated', async () => {
  const newestFirst = Array.from({ length: 27 }, (_, i) => c(`c${27 - i}`, 28 - i, `note ${27 - i}`))
  newestFirst[0].reply_count = '1'
  const asked = []
  const get = async path => {
    asked.push(path)
    if (path === '/task/t1/comment') return { comments: newestFirst.slice(0, 25) }
    if (path.startsWith('/task/t1/comment?start=')) {
      assert.match(path, /start_id=c3$/)
      return { comments: newestFirst.slice(25) }
    }
    if (path === '/comment/c27/reply') return { comments: [c('r1', 29, 'reply from Prerna', { user: { username: 'Prerna' } })] }
    if (path === '/task/t1/time_in_status') {
      return {
        current_status: { status: 'under process' },
        status_history: [
          { status: 'new leads', total_time: { since: String(Date.parse('2025-01-01T09:00:00Z')) } },
          { status: 'under process', total_time: { since: String(Date.parse('2025-01-02T09:00:00Z')) } },
        ],
      }
    }
    throw new Error('unexpected ' + path)
  }
  const h = await taskHistory('t1', get)
  assert.equal(h.comments.length, 28)
  assert.deepEqual([h.comments[0].text, h.comments.at(-1).text], ['note 1', 'reply from Prerna'])
  assert.equal(h.comments.at(-1).author, 'Prerna')
  assert.equal(h.comments[0].at, '2025-01-02T10:00:00.000Z')
  assert.deepEqual(h.statuses, [
    { status: 'new leads', at: '2025-01-01T09:00:00.000Z' },
    { status: 'under process', at: '2025-01-02T09:00:00.000Z', current: true },
  ])
  assert.equal(h.statusesOff, false)
})

test('a workspace without status history says so once, and comments still come', async () => {
  const get = async path => (path.endsWith('time_in_status') ? { status: 400 } : { comments: [c('c1', 5, 'only one')] })
  const h = await taskHistory('t9', get)
  assert.equal(h.comments.length, 1)
  assert.equal(h.statuses, undefined)
  assert.equal(h.statusesOff, true)
  const quiet = await taskHistory('t9', get, { statuses: false })
  assert.equal(quiet.statusesOff, false)
})
