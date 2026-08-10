#!/usr/bin/env node
/**
 * Lint, held to a ratchet rather than to zero.
 *
 * WHY THIS EXISTS
 * ---------------
 * `npm run lint` reports 4 errors and 1 warning on a clean checkout, all of them
 * pre-existing and none in a file this repository's recent work touched:
 *
 *   src/components/objections/ObjectionQueue.tsx        react-hooks/set-state-in-effect
 *   src/components/objections/useObjections.ts          react-hooks/set-state-in-effect
 *   src/app/admin/control-center/page.tsx               react-hooks/set-state-in-effect
 *   src/app/admin/control-center/test-data-cleanup/…    react-hooks/set-state-in-effect
 *   src/app/payroll/results/[periodId]/[employeeId]/…   no-unused-vars (warning)
 *
 * Two bad options were rejected:
 *
 *   Gate on zero  — `npm run verify` could never pass, so nobody would run it,
 *                   and the command would be theatre.
 *   Drop lint     — a genuinely new error would then reach `main` unnoticed.
 *
 * So this fails only when the count RISES above the recorded baseline. Existing
 * problems stay visible; new ones block. Lower BASELINE as they are fixed — it
 * is a ratchet, and it must only ever go down.
 *
 * Fixing the four `set-state-in-effect` errors is real work with real behaviour
 * risk (they are load-on-mount effects), which is why it is a tracked task
 * rather than something smuggled into an unrelated change.
 *
 *   npm run lint:baseline
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Highest number of eslint problems allowed. Only ever decrease this. */
const BASELINE = { errors: 4, warnings: 1 }

// Run eslint's own CLI entry directly rather than through npx: on Windows,
// spawnSync('npx.cmd', …) raises EINVAL without a shell, and enabling the shell
// to work around it would mean quoting arguments per platform.
//
// Resolved from package.json rather than by importing `eslint/bin/eslint.js`,
// which the package's `exports` map does not expose.
const eslintBin = join(
  dirname(createRequire(import.meta.url).resolve('eslint/package.json')),
  'bin', 'eslint.js',
)

const result = spawnSync(
  process.execPath,
  [eslintBin, '--format', 'json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)

if (result.error) {
  console.error('lint:baseline — could not run eslint:', result.error.message)
  process.exit(1)
}

let report
try {
  // eslint prints the JSON report on stdout; anything else is noise.
  const start = result.stdout.indexOf('[')
  report = JSON.parse(result.stdout.slice(start))
} catch {
  console.error('lint:baseline — could not parse the eslint report')
  console.error(result.stdout.slice(0, 2000))
  console.error(result.stderr.slice(0, 2000))
  process.exit(1)
}

let errors = 0
let warnings = 0
const offenders = []

for (const file of report) {
  if (file.errorCount === 0 && file.warningCount === 0) continue
  errors += file.errorCount
  warnings += file.warningCount
  for (const m of file.messages) {
    offenders.push(
      `  ${m.severity === 2 ? 'error  ' : 'warning'} ${file.filePath.replace(process.cwd(), '.')}:${m.line}  ${m.ruleId ?? ''}`,
    )
  }
}

const over = errors > BASELINE.errors || warnings > BASELINE.warnings

console.log(
  `lint:baseline — ${errors} error(s), ${warnings} warning(s) ` +
  `(baseline ${BASELINE.errors}/${BASELINE.warnings})`,
)

if (over) {
  console.error('\nLint problems increased above the recorded baseline.\n')
  console.error(offenders.join('\n'))
  console.error(
    '\nFix the problem you introduced. Do not raise BASELINE in scripts/lint-baseline.mjs.',
  )
  process.exit(1)
}

if (errors < BASELINE.errors || warnings < BASELINE.warnings) {
  console.log(
    `\nFewer problems than the baseline. Lower BASELINE in scripts/lint-baseline.mjs ` +
    `to ${errors}/${warnings} so the improvement is locked in.`,
  )
}

process.exit(0)
