#!/usr/bin/env node
/**
 * Documentation validator for the BOE repository.
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------
 * It checks STRUCTURE: that required records exist, that every local link
 * resolves, that module documents carry their required sections, and that the
 * ADR numbering and indexes are consistent.
 *
 * It cannot check whether a sentence is TRUE. A file passes with a false
 * statement in it. Accuracy stays a human responsibility — see AGENTS.md §4.
 *
 * It also deliberately does NOT compare timestamps to force freshness. That
 * produces meaningless edits made to satisfy a checker rather than to inform a
 * reader. See ADR-0007.
 *
 * No dependencies: Node's standard library only.
 *
 *   npm run docs:check
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = process.cwd()
const MASTER = 'docs/BOE Master Context'
const MODULES = 'docs/Module Docs'
const ADR = 'docs/adr'

const problems = []
const fail = (where, message) => problems.push({ where, message })

const read = p => readFileSync(join(ROOT, p), 'utf8')
const has = p => existsSync(join(ROOT, p))

// ─── 1. Required records exist ────────────────────────────────────────────────

const REQUIRED = [
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  `${MASTER}/00_README_FIRST.md`,
  `${MASTER}/01_Project_Master_Context.md`,
  `${MASTER}/02_Current_System_State.md`,
  `${MASTER}/03_Development_History.md`,
  `${MASTER}/04_Current_Roadmap.md`,
  `${MASTER}/05_Business_Rules.md`,
  `${MASTER}/06_Module_Architecture.md`,
  `${MASTER}/07_Business_Rule_Index.md`,
  `${MASTER}/08_Authorization_Matrix.md`,
  `${MASTER}/09_Risk_Register.md`,
  `${MASTER}/10_Documentation_Update_Matrix.md`,
  `${MASTER}/11_File_Structure_Plan.md`,
  `${MASTER}/12_Large_File_Plan.md`,
  `${MASTER}/BOE_GLOBAL_NAVIGATION_STANDARD.md`,
  `${MASTER}/BOE_MODULE_LAYOUT_STANDARD.md`,
  `${MODULES}/README.md`,
  `${MODULES}/_MODULE_TEMPLATE.md`,
  `${ADR}/README.md`,
  `${ADR}/_TEMPLATE.md`,
]

for (const p of REQUIRED) {
  if (!has(p)) fail(p, 'required document is missing')
}

// ─── 2. Every local link resolves ─────────────────────────────────────────────

/** Markdown files whose links are checked. */
function markdownFiles() {
  const out = ['README.md', 'AGENTS.md', 'CLAUDE.md']
  const walk = dir => {
    if (!existsSync(join(ROOT, dir))) return
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${entry}`
      const st = statSync(join(ROOT, rel))
      if (st.isDirectory()) walk(rel)
      else if (entry.endsWith('.md')) out.push(rel)
    }
  }
  walk('docs')
  return out
}

// [text](target) — skipping images, external URLs, mailto and pure anchors.
const LINK = /\[[^\]]*\]\(([^)]+)\)/g

for (const file of markdownFiles()) {
  if (!has(file)) continue
  const src = read(file)
  for (const match of src.matchAll(LINK)) {
    const raw = match[1].trim()
    if (/^(https?:|mailto:|#)/.test(raw)) continue

    // Strip any anchor, then percent-decode (paths here contain spaces).
    const target = decodeURIComponent(raw.split('#')[0])
    if (!target) continue

    const resolved = resolve(ROOT, dirname(file), target)
    if (!existsSync(resolved)) {
      fail(file, `broken local link → ${raw}`)
    }
  }
}

// ─── 3. Module index and module documents ─────────────────────────────────────

const REQUIRED_MODULE_SECTIONS = [
  'Purpose', 'Status', 'Users', 'Routes', 'APIs', 'Tables', 'Permissions',
  'Main workflows', 'Business rules', 'Main files', 'Tests', 'Known limitations',
]

if (has(`${MODULES}/README.md`)) {
  const index = read(`${MODULES}/README.md`)

  // Rows marked "Full" must carry the required sections and a verified date.
  for (const line of index.split('\n')) {
    if (!line.startsWith('|')) continue
    if (!/\|\s*Full\s*\|/.test(line)) continue

    const link = /\[[^\]]*\]\(([^)]+)\)/.exec(line)
    if (!link) continue
    const doc = `${MODULES}/${decodeURIComponent(link[1].split('#')[0])}`
    if (!has(doc)) { fail(doc, 'module index lists a document that does not exist'); continue }

    const src = read(doc)
    for (const section of REQUIRED_MODULE_SECTIONS) {
      // Match a heading whose text starts with the section name.
      const heading = new RegExp(`^#{1,4}\\s+${section}\\b`, 'im')
      if (!heading.test(src)) {
        fail(doc, `full module document is missing a required section: "${section}"`)
      }
    }
    if (!/Last verified:/i.test(src)) {
      fail(doc, 'module document has no "Last verified:" line')
    }
  }
}

// ─── 4. ADRs ──────────────────────────────────────────────────────────────────

if (has(`${ADR}/README.md`)) {
  const indexSrc = read(`${ADR}/README.md`)
  const files = readdirSync(join(ROOT, ADR))
    .filter(f => /^\d{4}-.*\.md$/.test(f))
    .sort()

  // 4a. Duplicate numbers.
  const byNumber = new Map()
  for (const f of files) {
    const n = f.slice(0, 4)
    if (byNumber.has(n)) {
      fail(`${ADR}/${f}`, `duplicate ADR number ${n} (also ${byNumber.get(n)})`)
    } else {
      byNumber.set(n, f)
    }
  }

  // 4b. Every ADR is in the index, and every indexed ADR exists.
  for (const f of files) {
    if (!indexSrc.includes(f)) fail(`${ADR}/README.md`, `ADR ${f} is not listed in the index`)
  }
  for (const match of indexSrc.matchAll(LINK)) {
    const t = decodeURIComponent(match[1].split('#')[0])
    if (/^\d{4}-.*\.md$/.test(t) && !has(`${ADR}/${t}`)) {
      fail(`${ADR}/README.md`, `index lists a missing ADR: ${t}`)
    }
  }

  // 4c. Required front matter, and a real status.
  const STATUSES = ['proposed', 'accepted', 'superseded', 'rejected']
  for (const f of files) {
    const src = read(`${ADR}/${f}`)
    const status = /^-\s*\*\*Status:\*\*\s*(\w+)/im.exec(src)
    if (!status) {
      fail(`${ADR}/${f}`, 'no "- **Status:**" line')
    } else if (!STATUSES.includes(status[1].toLowerCase())) {
      fail(`${ADR}/${f}`, `unknown status "${status[1]}" (expected ${STATUSES.join(' | ')})`)
    }
    if (!/^-\s*\*\*Date:\*\*/im.test(src)) fail(`${ADR}/${f}`, 'no "- **Date:**" line')
    for (const section of ['Context', 'Decision', 'Consequences']) {
      if (!new RegExp(`^#{1,3}\\s+${section}\\b`, 'im').test(src)) {
        fail(`${ADR}/${f}`, `missing required section: "${section}"`)
      }
    }
  }
}

// ─── 5. No competing entry point ──────────────────────────────────────────────

// The repository had three "start here" files, one of which pointed at seven
// paths that did not exist. One canonical entry point, and no strays at root.
for (const stray of ['CLAUDE_START_HERE.md.txt', 'CLAUDE_START_HERE.md']) {
  if (has(stray)) {
    fail(stray, 'competing entry point at repository root — the canonical one is ' +
                `${MASTER}/00_README_FIRST.md (see ADR-0007)`)
  }
}

// ─── Report ───────────────────────────────────────────────────────────────────

if (problems.length === 0) {
  const n = markdownFiles().filter(has).length
  console.log(`docs:check — OK (${REQUIRED.length} required records, ${n} markdown files linked correctly)`)
  process.exit(0)
}

console.error(`docs:check — ${problems.length} problem(s):\n`)
for (const p of problems) console.error(`  ${p.where}\n    ${p.message}`)
console.error('\nSee AGENTS.md and docs/adr/0007-documentation-contract.md.')
process.exit(1)
