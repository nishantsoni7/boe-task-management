// Code backup: bare mirror (every local + GitHub ref, never pruned), dated git bundle,
// uncommitted work snapshot, project memory, and encrypted env files.
//   node backup-code.mjs --quick      fast, offline: mirror <- local repo refs only (used by git hooks)
//   node backup-code.mjs              full backup (default)
//   node backup-code.mjs --no-github  full backup without the network fetch
import fs from 'node:fs'
import path from 'node:path'
import { BACKUP_ROOT, DEV_ROOT, MAIN_REPO, MEMORY_DIR, HOME, ensureDir, encryptFile, git, gitTry, log, prune, sha256File, stamp, writeStatus } from './lib.mjs'

const quick = process.argv.includes('--quick')
const noGithub = process.argv.includes('--no-github')
const ts = stamp()
const repoArgIdx = process.argv.indexOf('--repo')
const repo = repoArgIdx > 0 ? process.argv[repoArgIdx + 1] : MAIN_REPO
const common = path.resolve(repo, git(repo, 'rev-parse', '--git-common-dir'))
const result = { mode: quick ? 'quick' : 'full', steps: {} }

// 1 ── bare mirror ────────────────────────────────────────────────────────────
const mirror = path.join(BACKUP_ROOT, 'git', 'boe-task-management.git')
if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
  ensureDir(mirror)
  git(mirror, 'init', '--bare', '--quiet')
}
for (const [k, v] of [['gc.auto', '0'], ['gc.pruneExpire', 'never'], ['gc.reflogExpire', 'never'], ['gc.reflogExpireUnreachable', 'never'], ['core.logAllRefUpdates', 'always']]) git(mirror, 'config', k, v)
// Local view (includes branches that were never pushed, stashes, remote-tracking refs).
let r = gitTry(mirror, 'fetch', '--quiet', '--no-tags', common, '+refs/heads/*:refs/local/heads/*', '+refs/tags/*:refs/local/tags/*', '+refs/remotes/*:refs/local/remotes/*')
if (!r.ok) throw new Error('mirror fetch from local repo failed: ' + r.err)
gitTry(mirror, 'fetch', '--quiet', '--no-tags', common, '+refs/stash:refs/local/stash') // absent when nothing is stashed
result.steps.mirrorLocal = 'ok'
// GitHub view (heads, tags, and the head of every pull request, merged or not).
if (!quick && !noGithub) {
  r = gitTry(mirror, 'fetch', '--quiet', '--no-tags', 'https://github.com/nishantsoni7/boe-task-management.git',
    '+refs/heads/*:refs/github/heads/*', '+refs/tags/*:refs/github/tags/*', '+refs/pull/*/head:refs/github/pull/*')
  result.steps.mirrorGithub = r.ok ? 'ok' : 'FAILED: ' + r.err.split('\n').slice(-1)[0]
  if (!r.ok) log('WARNING: GitHub fetch failed —', r.err)
}
result.mirrorRefs = git(mirror, 'for-each-ref', '--format=%(refname)').split('\n').length

if (!quick) {
  // 2 ── dated bundle (single portable file; restore with `git clone <bundle>`) ──
  const bdir = ensureDir(path.join(BACKUP_ROOT, 'bundles'))
  const bundle = path.join(bdir, `boe-code-${ts}.bundle`)
  git(repo, 'bundle', 'create', bundle, '--all')
  git(repo, 'bundle', 'verify', bundle)
  fs.writeFileSync(bundle + '.sha256', sha256File(bundle) + '  ' + path.basename(bundle) + '\n')
  prune(bdir, /\.bundle$/, 30); prune(bdir, /\.sha256$/, 30)
  result.steps.bundle = { file: path.basename(bundle), bytes: fs.statSync(bundle).size }

  // 3 ── uncommitted work in every worktree (git does not protect this) ─────────
  const wt = git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
  const wip = []
  for (const w of wt) {
    if (!fs.existsSync(w)) continue
    const files = gitTry(w, 'ls-files', '-m', '-o', '--exclude-standard', '-z').out.split('\0').filter(Boolean)
    if (!files.length) continue
    const dest = path.join(BACKUP_ROOT, 'wip', ts, path.basename(w))
    let n = 0
    for (const f of files) {
      const src = path.join(w, f)
      try {
        if (!fs.statSync(src).isFile() || fs.statSync(src).size > 20 * 1024 * 1024) continue
        fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true }); fs.copyFileSync(src, path.join(dest, f)); n++
      } catch { /* deleted file */ }
    }
    if (n) wip.push({ worktree: w, files: n, branch: gitTry(w, 'rev-parse', '--abbrev-ref', 'HEAD').out })
  }
  prune(path.join(BACKUP_ROOT, 'wip'), /^\d/, 10)
  result.steps.uncommittedWork = wip
  if (wip.length) log('NOTE: uncommitted work exists (copied to backup, but COMMIT it):', wip.map((x) => `${x.branch} (${x.files})`).join(', '))

  // 4 ── Claude project memory + global instructions ───────────────────────────
  if (fs.existsSync(MEMORY_DIR)) {
    const mdir = path.join(BACKUP_ROOT, 'memory', ts)
    fs.cpSync(MEMORY_DIR, mdir, { recursive: true })
    const g = path.join(HOME, '.claude', 'CLAUDE.md'); if (fs.existsSync(g)) fs.copyFileSync(g, path.join(mdir, 'GLOBAL_CLAUDE.md'))
    prune(path.join(BACKUP_ROOT, 'memory'), /^\d/, 20)
    result.steps.memory = { files: fs.readdirSync(mdir).length }
  }

  // 4b ── SEO project folder + scheduled-task instructions (neither is in git) ─
  result.steps.projects = {}
  for (const [name, src] of [['bestofexports-website', path.join(DEV_ROOT, 'repositories', 'bestofexports-website')], ['scheduled-tasks', path.join(HOME, '.claude', 'scheduled-tasks')]]) {
    // A file locked by a running session must not cost tonight's code backup, so this reports and carries on.
    try {
      fs.cpSync(src, path.join(BACKUP_ROOT, 'projects', ts, name), { recursive: true })
      result.steps.projects[name] = fs.readdirSync(path.join(BACKUP_ROOT, 'projects', ts, name), { recursive: true }).length
    } catch (e) { result.steps.projects[name] = 'FAILED: ' + e.message; log('WARNING: not backed up:', src, e.message) }
  }
  prune(path.join(BACKUP_ROOT, 'projects'), /^\d/, 14)

  // 5 ── env files (secrets) — encrypted, never plain ──────────────────────────
  const sdir = ensureDir(path.join(BACKUP_ROOT, 'secrets'))
  const envs = fs.readdirSync(MAIN_REPO).filter((f) => /^\.env(\..+)?$/.test(f) && f !== '.env.example')
  result.steps.envFiles = []
  for (const f of envs) {
    encryptFile(path.join(MAIN_REPO, f), path.join(sdir, `${f.replace(/^\./, '')}-${ts}.enc`)); result.steps.envFiles.push(f)
  }
  prune(sdir, /\.enc$/, 20 * Math.max(envs.length, 1))
}

result.head = git(repo, 'rev-parse', 'HEAD')
result.branch = gitTry(repo, 'rev-parse', '--abbrev-ref', 'HEAD').out
writeStatus(quick ? 'code-quick' : 'code-full', result)
log(`code backup ${result.mode} OK — mirror refs: ${result.mirrorRefs}`)
