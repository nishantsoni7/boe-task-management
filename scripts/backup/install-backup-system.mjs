// Installs the backup tooling OUTSIDE the repository so it works on every branch and worktree:
//   BOE-Development/backups/tools  <- copy of scripts/backup/*.mjs
//   BOE-Development/backups/hooks  <- copy of .githooks/*
// and points the repository's core.hooksPath at the hooks folder (shared by all worktrees).
// Re-run whenever scripts/backup or .githooks changes. Safe to run repeatedly.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_ROOT, MAIN_REPO, ensureDir, git, log } from './lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const tools = ensureDir(path.join(DEV_ROOT, 'backups', 'tools'))
const hooks = ensureDir(path.join(DEV_ROOT, 'backups', 'hooks'))
for (const f of fs.readdirSync(path.join(repoRoot, 'scripts', 'backup')).filter((f) => f.endsWith('.mjs'))) {
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'backup', f), path.join(tools, f))
}
for (const f of fs.readdirSync(path.join(repoRoot, '.githooks'))) {
  fs.copyFileSync(path.join(repoRoot, '.githooks', f), path.join(hooks, f))
  try { fs.chmodSync(path.join(hooks, f), 0o755) } catch { /* windows */ }
}
const existing = fs.readdirSync(path.join(MAIN_REPO, '.git', 'hooks')).filter((f) => !f.endsWith('.sample'))
if (existing.length) log('WARNING: the repo had its own hooks which core.hooksPath will bypass:', existing.join(', '))
git(MAIN_REPO, 'config', 'core.hooksPath', hooks.split(path.sep).join('/'))
log(`installed tools -> ${tools}`)
log(`core.hooksPath -> ${hooks}`)
