/**
 * Exhibition Leads on a phone — the rules that keep it usable, pinned in source.
 *
 * Layout cannot be proven without a browser (the responsive audit that drove
 * these changes ran headless Chrome at 320 / 360 / 390 / 414 / 768 / 1440px);
 * what CI can do is fail when someone removes the rules that audit depends on.
 *
 * Run: npx tsx --test src/components/exhibitionLeads/mobile.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r/g, '')
const DIR = 'src/components/exhibitionLeads/'
const css = read(DIR + 'leads.module.css')
const choice = read(DIR + 'ChoiceGroup.tsx')
const list = read(DIR + 'LeadsListScreen.tsx')
const add = read(DIR + 'AddLeadScreen.tsx')
const ranking = read(DIR + 'RankingScreen.tsx')

describe('options and the "i" popup', () => {
  test('option text is regular weight; the group label is not touched', () => {
    assert.match(choice, /className=\{`boe-choice \$\{s\.choiceRegular\}/)
    assert.match(css, /label\.choiceRegular\s*\{[^}]*font-weight:\s*400/)
    assert.match(css, /\.chip\s*\{[^}]*font-weight:\s*400/, 'filter chips are options too')
    assert.match(css, /\.label\s*\{[^}]*font-weight:\s*700/, 'field labels stay bold')
  })
  test('the hint opens as a popup anchored to its tile, never inline in the layout', () => {
    assert.match(choice, /role="note"[^>]*className=\{s\.hintPopup\}|className=\{s\.hintPopup\}[^>]*role="note"/)
    assert.match(css, /\.hintPopup\s*\{[^}]*position:\s*absolute/)
    assert.match(css, /\.choiceTile\s*\{[^}]*position:\s*relative/)
    assert.doesNotMatch(css, /\.optionHint/, 'the old inline hint block is gone')
  })
  test('it closes on an outside tap, on Escape and on a second tap; one at a time', () => {
    assert.match(choice, /addEventListener\('pointerdown'/)
    assert.match(choice, /e\.key === 'Escape'/)
    assert.match(choice, /setOpenHint\(open \? null : o\.value\)/)
    assert.match(choice, /aria-expanded=\{open\}/)
    assert.match(choice, /aria-controls=\{hintId\}/)
  })
  test('the "i" is a 44px touch target and sits above the tile\'s hit area', () => {
    const rule = /\.infoBtn\s*\{([^}]*)\}/.exec(css)![1]
    assert.match(rule, /width:\s*44px/)
    assert.match(rule, /height:\s*44px/)
    assert.match(rule, /z-index:\s*\d+/)
  })
  test('the hint text never appears in a label (lists, filters, CSV)', () => {
    const constants = read('src/lib/exhibitionLeads/constants.ts')
    assert.match(constants, /label: 'Hot', hint:/)
    assert.doesNotMatch(constants, /label: '[^']*\(/, 'no bracketed text in any label')
  })
})

describe('phone-first behaviour', () => {
  test('inputs are 16px so iOS does not zoom on focus', () => {
    assert.match(css, /\.input,\s*\.select,\s*\.textarea\s*\{[^}]*font-size:\s*16px/)
  })
  test('taps register at once and show no grey flash', () => {
    assert.match(css, /touch-action:\s*manipulation/)
    assert.match(css, /-webkit-tap-highlight-color:\s*transparent/)
  })
  test('the save bar clears the home indicator', () => {
    assert.match(css, /safe-area-inset-bottom/)
  })
  test('filters are a sheet with Clear all and a live "Show N" button', () => {
    assert.match(list, /<ReviewSheet\s+title="Filters"/)
    assert.match(list, /Clear all/)
    assert.match(list, /Show \$\{total\} lead/)
    assert.doesNotMatch(list, /className=\{s\.filterPanel\}/, 'the long inline panel is gone')
  })
  test('the heavy update sheet is loaded only when a lead is opened', () => {
    for (const src of [list, add]) {
      assert.match(src, /dynamic\(\(\) => import\('\.\/LeadDetailSheet'\), \{ ssr: false \}\)/)
      assert.doesNotMatch(src, /^import LeadDetailSheet from/m)
    }
  })
  test('card actions share one row, and the date window wraps instead of scrolling', () => {
    assert.match(css, /\.cardActions\s*\{\s*flex-wrap:\s*nowrap/)
    assert.match(css, /\.segmented\s*\{\s*flex-wrap:\s*wrap/)
  })
  test('narrow phones drop the card button icons rather than crowd the labels', () => {
    assert.match(css, /@media \(max-width: 359px\)[^{]*\{[^}]*\.cardActions \.btn svg\s*\{\s*display:\s*none/)
  })
  test('the table lets columns keep whole words (no break-anywhere squeezing)', () => {
    assert.doesNotMatch(css, /\.table td[^}]*overflow-wrap:\s*anywhere/)
    assert.match(css, /\.table td[^}]*overflow-wrap:\s*break-word/)
  })
  test('ranking fits a phone without sideways scrolling, and folds its long explanation away', () => {
    assert.match(css, /\.rankTable\s*\{\s*min-width:\s*0/)
    assert.match(ranking, /<details className=\{s\.scopeMore\}>/)
  })
  test('the update sheet keeps Save in reach while the form scrolls', () => {
    assert.match(css, /\.sheetFooter\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0/)
  })
})
