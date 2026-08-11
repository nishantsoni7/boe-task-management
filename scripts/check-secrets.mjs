#!/usr/bin/env node
/**
 * Credential scanner for tracked files, and optionally for Git history.
 *
 * WHY THIS EXISTS
 * ---------------
 * Three UAT scripts carried a Supabase `service_role` JWT for the production
 * project in tracked source for months, and nothing noticed. `.gitignore` could
 * never have caught it: an ignore rule protects against committing a secret
 * FILE, not against typing a secret into a source file.
 *
 * WHAT IT REPORTS, AND WHAT IT NEVER PRINTS
 * -----------------------------------------
 * File, line and the KIND of credential. Never the value, not even truncated —
 * a scanner that echoes secrets into CI logs has moved the problem rather than
 * found it. JWT payloads are decoded only far enough to name the `role` claim,
 * because "service_role" and "anon" are very different findings.
 *
 * SCOPE
 * -----
 *   npm run check:secrets            tracked working-tree files
 *   npm run check:secrets -- --history   every blob in every commit (slow)
 *
 * History mode exists because rotation, not deletion, is the fix for something
 * already committed — you cannot know what to rotate without knowing what is in
 * there. It does not clean anything and must never be read as doing so.
 *
 * This is a heuristic. A clean result means these patterns found nothing; it is
 * not proof that the repository holds no secrets.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const HISTORY = process.argv.includes('--history')

/** Patterns worth failing a build over. Ordered most specific first. */
const PATTERNS = [
  {
    kind: 'Supabase/JWT token',
    // header.payload.signature, base64url — the shape of a Supabase key.
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    detail: describeJwt,
  },
  { kind: 'AWS access key id',        re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'GitHub token',             re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'OpenAI-style API key',     re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'Anthropic API key',        re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Google API key',           re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Slack token',              re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Private key block',        re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  {
    kind: 'Hard-coded password/secret assignment',
    // `password = '...'` with a literal, excluding obvious placeholders.
    re: /\b(?:password|passwd|secret|service_role_key|api_key|apikey)\s*[:=]\s*['"`]([^'"`\n]{8,})['"`]/gi,
    ignoreIf: v => /replace-me|example|placeholder|your-|xxx|\*{3,}|\$\{|process\.env|<[^>]+>/i.test(v),
  },
]

/** Name a JWT's `role` claim without revealing the token. */
function describeJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
    const role = typeof payload.role === 'string' ? payload.role : 'unknown-role'
    return role === 'service_role'
      ? 'role=service_role — BYPASSES ROW-LEVEL SECURITY'
      : `role=${role}`
  } catch {
    return 'unparsable payload'
  }
}

/** Paths that legitimately contain pattern-shaped text. */
const ALLOW = [
  /^scripts\/check-secrets\.mjs$/,      // this file's own patterns
  /^scripts\/uat\.env\.example$/,       // placeholders only
  /^package-lock\.json$/,               // integrity hashes, not credentials
  /^docs\/.*\.md$/,                     // prose about secrets, never values
]

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|xlsx?|woff2?|ttf|eot|mp4|ipynb)$/i

function scan(content, where, findings) {
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    let m
    while ((m = p.re.exec(content)) !== null) {
      const captured = m[1] ?? m[0]
      if (p.ignoreIf && p.ignoreIf(captured)) continue
      const line = content.slice(0, m.index).split('\n').length
      findings.push({
        where,
        line,
        kind: p.kind,
        detail: p.detail ? p.detail(m[0]) : '',
      })
    }
  }
}

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })

const findings = []

// ─── Tracked working-tree files ───────────────────────────────────────────────

const tracked = git(['ls-files']).split('\n').map(s => s.trim()).filter(Boolean)
let scanned = 0

for (const file of tracked) {
  if (BINARY.test(file) || ALLOW.some(re => re.test(file))) continue
  let content
  try {
    if (statSync(file).size > 8 * 1024 * 1024) continue
    content = readFileSync(file, 'utf8')
  } catch { continue }
  scanned++
  scan(content, file, findings)
}

// ─── Git history (opt-in) ─────────────────────────────────────────────────────

let historyBlobs = 0
if (HISTORY) {
  // Every blob ever recorded, with the path it was stored at.
  const objects = git(['rev-list', '--objects', '--all']).split('\n')
  const seen = new Set()
  for (const row of objects) {
    const sp = row.indexOf(' ')
    if (sp === -1) continue
    const sha = row.slice(0, sp)
    const path = row.slice(sp + 1).trim()
    if (!path || BINARY.test(path) || ALLOW.some(re => re.test(path))) continue
    if (seen.has(sha)) continue
    seen.add(sha)
    let content
    try { content = git(['cat-file', '-p', sha]) } catch { continue }
    historyBlobs++
    scan(content, `history:${path}`, findings)
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

const scope = HISTORY
  ? `${scanned} tracked file(s) + ${historyBlobs} historical blob(s)`
  : `${scanned} tracked file(s)`

if (findings.length === 0) {
  console.log(`check:secrets — no credential patterns found in ${scope}`)
  console.log('  (heuristic: a clean result is not proof the repository holds no secrets)')
  process.exit(0)
}

// Collapse duplicates: the same secret in many historical blobs is one problem.
const grouped = new Map()
for (const f of findings) {
  const key = `${f.where}|${f.kind}|${f.detail}`
  if (!grouped.has(key)) grouped.set(key, { ...f, count: 0 })
  grouped.get(key).count++
}

const all = [...grouped.values()].sort((a, b) => a.where.localeCompare(b.where))
const live = all.filter(f => !f.where.startsWith('history:'))
const past = all.filter(f => f.where.startsWith('history:'))

const render = f => {
  const times = f.count > 1 ? ` ×${f.count}` : ''
  return `  ${f.where}:${f.line}${times}\n    ${f.kind}${f.detail ? ` — ${f.detail}` : ''}`
}

// The two result kinds are reported SEPARATELY and labelled differently.
//
// An earlier version printed one combined "N finding(s)" header and exited 0
// when every finding was historical. That reads as a failed check that somehow
// passed, which is the worst possible signal from a security tool: a reviewer
// either ignores a real problem or distrusts the exit code. A finding in a
// tracked file is a FAILURE. A finding in history is an INVESTIGATION RESULT
// about commits that already exist, and no exit code can change the past.

if (live.length > 0) {
  console.error(`\ncheck:secrets — FAILED: ${live.length} credential(s) in tracked files\n`)
  console.error(live.map(render).join('\n'))
  console.error(
    '\n  Remove the literal, read the value from the environment, and ROTATE it at the' +
    '\n  provider — a credential that has been committed is compromised even once deleted.',
  )
}

if (past.length > 0) {
  console.error(
    `\ncheck:secrets — HISTORY REPORT: ${past.length} credential(s) in past commits` +
    '\n  This is investigation output, NOT a check result. It does not pass and does not' +
    '\n  fail: these commits already exist, and no exit code changes that. Use it to decide' +
    '\n  WHAT TO ROTATE.\n',
  )
  console.error(past.map(render).join('\n'))
  console.error(
    '\n  Rotation at the provider is the only thing that revokes these. Deleting the file,' +
    '\n  or even rewriting history, does not — assume every value here is compromised.',
  )
}

console.error('\n  Values are deliberately not printed.')
if (!HISTORY) {
  console.error('  Run with --history to see whether these values also exist in past commits.')
}

// Only a live finding fails. Stated in the output above so the exit code is
// never the only thing a reader has to go on.
if (live.length > 0) {
  process.exit(1)
}

console.log(
  `\ncheck:secrets — tracked files clean (${scanned} scanned).` +
  (past.length > 0
    ? ` ${past.length} historical finding(s) reported above and NOT treated as a pass.`
    : ''),
)
process.exit(0)
