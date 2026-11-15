/**
 * Phone layout pins from the 390px sweep of every page (2026-11-15).
 *
 * The shell's main column has overflow: clip, so a child that is too wide is
 * silently cut off and no scrollbar betrays it. These two were found that way.
 *
 * Run: npm run test:file -- src/app/phoneSweepLayout.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

test('Team Today: the roster scroll box is positioned, so its screen-reader labels cannot widen the page', () => {
  const css = read('src/components/dayClose/teamToday.module.css')
  assert.match(css, /\.srOnly \{ position: absolute;/)
  assert.match(css, /\n\.scroll \{ overflow-x: auto; position: relative; \}/)
})

test('Lead Master: on a phone the "Allotted to" row wraps, so the admin Auto-allot switch is not cut off', () => {
  const css = read('src/components/salesLeads/salesLeads.module.css')
  const phone = css.slice(css.indexOf('/* ── PHONES, CONTENT FIRST (owner, 2026-11-05, Phase 3)'))
  const rule = /\n {2}\.whoBar \{[^}]*\}/.exec(phone)?.[0] ?? ''
  assert.match(rule, /flex-wrap: wrap/)
  assert.doesNotMatch(rule, /overflow/, 'a scrolling row would clip the person panel')
})

test('Access page: the stacked layout column can shrink to a phone width', () => {
  const css = read('src/app/admin/control-center/permissions/permissions.module.css')
  const tablet = css.slice(css.indexOf('@media (max-width: 1023px) {'))
  assert.match(tablet.slice(0, tablet.indexOf('\n}')), /\.layout \{ grid-template-columns: minmax\(0, 1fr\); \}/)
})
