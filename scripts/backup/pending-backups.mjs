// What has been merged to main since the last complete backup. Nobody notes this down: the 9:30 pm task backs up
// everything merged that day, and this list is read live from GitHub against the record that backup leaves.
//   node scripts/backup/pending-backups.mjs
import { spawnSync } from 'node:child_process'
import { GITHUB_REPO, mergedSince, readStatus } from './lib.mjs'

const when = (iso) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
const covered = readStatus('covered')
if (!covered) {
  console.log('No complete backup is on record yet.')
  process.exit(1)
}
const since = covered.through.replace(/\.\d+Z$/, 'Z')
const r = spawnSync('gh', ['pr', 'list', '--repo', GITHUB_REPO, '--state', 'merged', '--base', 'main', '--search', `merged:>=${since}`, '--json', 'number,title,mergedAt', '--limit', '200'], { encoding: 'utf8' })
if (r.status !== 0) {
  console.log(`Last complete backup: ${when(covered.at)}. Could not ask GitHub what was merged since: ${(r.stderr || r.error?.message || '').trim()}`)
  process.exit(1)
}
const waiting = mergedSince(JSON.parse(r.stdout), covered.through)
console.log(`Last complete backup: ${when(covered.at)}. ${waiting.length ? `${waiting.length} merge(s) waiting for the next one:` : 'Nothing is waiting.'}`)
for (const p of waiting) console.log(`  #${p.number}  ${when(p.mergedAt)}  ${p.title}`)
