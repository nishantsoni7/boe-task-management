// Owner reminders: what the owner must do regularly, what is due, and what is overdue.
// The owner is not expected to remember any of this — this script (and the Claude sessions that
// run it) remember for them.
//
//   node owner-reminders.mjs                 print every reminder with its status
//   node owner-reminders.mjs --due           print only due / overdue items (exit 1 if any)
//   node owner-reminders.mjs --notify        show a Windows pop-up when something is due (max once a day)
//   node owner-reminders.mjs done <id> [note]   record that the owner did a manual task today
//   node owner-reminders.mjs snooze <id> <days> postpone one reminder
//   node owner-reminders.mjs --json          machine-readable
//
// State lives OUTSIDE git: <backups>/status/owner-reminders.json. Add a task by adding one entry to TASKS.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_ROOT, ensureDir, readStatus } from './lib.mjs'

const DAY = 86_400_000
const stateFile = path.join(BACKUP_ROOT, 'status', 'owner-reminders.json')
const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return { done: {}, snoozed: {}, lastNotified: null } } }
const save = (s) => { ensureDir(path.dirname(stateFile)); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)) }
const ageDays = (iso) => (iso ? (Date.now() - Date.parse(iso)) / DAY : Infinity)

// kind: 'manual' (owner does it, then runs `done`) | 'auto' (measured by this script) | 'date' (fixed deadline)
const TASKS = [
  { id: 'external-drive', kind: 'auto', everyDays: 7, title: 'Plug in the external drive and copy the backup',
    how: 'Plug in the hard disk (D:), then ask Claude "run the backup", or run: BOE_BACKUP_COPY_TO=D:\\BOE-Backups node ~/BOE-Development/backups/tools/backup-all.mjs',
    last: () => readStatus('second-copy')?.at },
  { id: 'daily-backup-health', kind: 'auto', everyDays: 2, title: 'The daily 9:30 pm backup has not run successfully',
    how: 'Leave the laptop on at 9:30 pm, or ask Claude to check the "BOE Backup" Task Scheduler entry and the log at BOE-Development/backups/daily-backup.log.',
    last: () => { const s = readStatus('all'); return s && s.code !== false && s.database !== false ? s.at : null } },
  { id: 'supabase-backups', kind: 'manual', everyDays: 30, title: 'Check that Supabase still takes daily backups',
    how: 'Supabase dashboard > project boe-task-management > Database > Backups > Scheduled backups. Confirm the newest one is from the last 2 days. Then tell Claude "done supabase-backups".' },
  { id: 'password-manager', kind: 'manual', everyDays: 180, title: 'Confirm the password manager still holds every key',
    how: 'Check it holds: the backup passphrase (backups/.keys/backup-passphrase.txt), the Supabase sb_secret key, CRON_SECRET, FAL_KEY, ANTHROPIC_API_KEY, the Minop token, and the GitHub and Vercel recovery codes. Then tell Claude "done password-manager".' },
  { id: 'github-security', kind: 'manual', everyDays: 90, title: 'Review GitHub security and access',
    how: 'GitHub > the repo > Security tab: open alerts? Settings > Rules: both main rules still Active? Settings > Collaborators: only people who should be there? Then tell Claude "done github-security".' },
  { id: 'restore-rehearsal', kind: 'manual', everyDays: 90, title: 'Test that a backup can really be restored',
    how: 'Start Docker Desktop, then ask Claude "do the restore rehearsal" (it runs scripts/backup/restore-rehearsal.mjs: free, local, about 3 minutes, production untouched). Then say "done restore-rehearsal".' },
  { id: 'housekeeping', kind: 'manual', everyDays: 30, title: 'Tidy old branches and worktrees',
    how: 'Ask Claude to remove merged worktrees and fully-merged local branches (everything stays in the backups). Then say "done housekeeping".' },
  { id: 'supabase-key-rotation', kind: 'manual', everyDays: 365, title: 'Rotate the Supabase backup secret key',
    how: 'Supabase > Project Settings > API Keys > create a new secret key named backup, put it in backups/.env.backup, delete the old key. Then say "done supabase-key-rotation".' },
  { id: 'mirror-token', kind: 'date', due: '2027-09-17', title: 'Renew the GitHub mirror token (expires 2027-10-17)',
    how: 'GitHub > Settings > Developer settings > Fine-grained tokens > boe-mirror > Regenerate (or recreate with Contents + Workflows read/write on the mirror repo only), then update the repo secret BACKUP_MIRROR_TOKEN. Then say "done mirror-token" (the next renewal date is set to a year later).' },
]

function evaluate(task, st) {
  const doneAt = st.done[task.id]
  const snoozeUntil = st.snoozed[task.id]
  let status, detail, dueIn
  if (task.kind === 'date') {
    const dueMs = Date.parse(task.due) + (doneAt ? 365 * DAY : 0)
    const days = Math.ceil((dueMs - Date.now()) / DAY)
    dueIn = days
    status = days < 0 ? 'OVERDUE' : days <= 0 ? 'DUE' : days <= 14 ? 'SOON' : 'ok'
    detail = days < 0 ? `${-days} days past the date` : `in ${days} days`
  } else {
    const last = task.kind === 'auto' ? task.last() : doneAt
    const age = ageDays(last)
    dueIn = Math.ceil(task.everyDays - age)
    status = !Number.isFinite(age) ? 'NEVER' : age > task.everyDays * 1.5 ? 'OVERDUE' : age > task.everyDays ? 'DUE' : 'ok'
    detail = Number.isFinite(age) ? `last done ${age.toFixed(0)} days ago (every ${task.everyDays})` : `never recorded (every ${task.everyDays} days)`
  }
  if (snoozeUntil && Date.parse(snoozeUntil) > Date.now() && status !== 'ok') status = 'SNOOZED'
  return { id: task.id, title: task.title, how: task.how, status, detail, dueIn }
}

const args = process.argv.slice(2)
const st = load()

if (args[0] === 'done') {
  const t = TASKS.find((x) => x.id === args[1])
  if (!t) { console.error('unknown id. Known:', TASKS.map((x) => x.id).join(', ')); process.exit(2) }
  st.done[t.id] = new Date().toISOString(); delete st.snoozed[t.id]; save(st)
  console.log(`recorded: ${t.id} done today${args[2] ? ' (' + args.slice(2).join(' ') + ')' : ''}`); process.exit(0)
}
if (args[0] === 'snooze') {
  const t = TASKS.find((x) => x.id === args[1]); const d = Number(args[2] || 3)
  if (!t) { console.error('unknown id'); process.exit(2) }
  st.snoozed[t.id] = new Date(Date.now() + d * DAY).toISOString(); save(st)
  console.log(`snoozed ${t.id} for ${d} days`); process.exit(0)
}

const rows = TASKS.map((t) => evaluate(t, st))
const actionable = rows.filter((r) => ['NEVER', 'DUE', 'OVERDUE'].includes(r.status))

if (args.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(actionable.length ? 1 : 0) }

if (args.includes('--notify')) {
  const toast = [...actionable, ...rows.filter((r) => r.status === 'SOON')]
  const today = new Date().toISOString().slice(0, 10)
  if (toast.length && st.lastNotified !== today && process.platform === 'win32') {
    const msg = 'BOE reminders - please do these:\n\n' + toast.map((r) => '- ' + r.title).join('\n') + '\n\nOpen Claude and say "show my BOE reminders" for the steps.'
    const ps = `(New-Object -ComObject WScript.Shell).Popup(${JSON.stringify(msg)}, 900, 'BOE One - owner reminders', 48)`
    const enc = Buffer.from(ps, 'utf16le').toString('base64')
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { detached: true, stdio: 'ignore' }).unref()
    st.lastNotified = today; save(st)
  }
  process.exit(0)
}

const list = args.includes('--due') ? [...actionable, ...rows.filter((r) => r.status === 'SOON')] : rows
const icon = { ok: 'ok     ', SNOOZED: 'snoozed', SOON: 'SOON   ', DUE: 'DUE    ', OVERDUE: 'OVERDUE', NEVER: 'NEVER  ' }
for (const r of list) {
  console.log(`${icon[r.status]}  ${r.title}\n         ${r.detail}`)
  if (r.status !== 'ok' && r.status !== 'SNOOZED') console.log(`         HOW: ${r.how}`)
}
if (!list.length) console.log('Nothing is due. All owner routines are up to date.')
process.exit(actionable.length ? 1 : 0)
