/**
 * THE PARSER, AGAINST A REAL BOE PI.
 *
 * Every other parser test builds a synthetic workbook from the addresses this
 * file believes in, which proves the code agrees with itself and nothing more.
 * This one reads a production workbook — "Revised PI Format.xlsx", supplied
 * 2026-09-21 — and asserts what actually comes out of it.
 *
 * IT IS WHAT CAUGHT THE THREE THINGS THE SYNTHETIC TESTS COULD NOT:
 *
 *   1. The fabric dropdown is on K117, not the J117 that was assumed, and its
 *      list says "Under BOE Scope" rather than "Under BOE".
 *   2. G20 holds "26th Feb 2026" as TEXT, not an Excel date. Reading only the
 *      serial found nothing, and the save path would have stamped the
 *      importer's own day onto a PI drawn up seven months earlier.
 *   3. The template has no city cell at all; B28 "Billing Address" is where a
 *      salesperson writes one.
 *
 * ── WHEN THE FILE IS NOT THERE ─────────────────────────────────────────────
 *
 * The workbook is a real commercial document with a real client's name on it,
 * so it is NOT committed. These tests SKIP when it is absent and run for
 * anybody who drops it at the path below. A skipped test is visible in the
 * output; a deleted one is not, which is why this is a skip and not a
 * conditional import.
 *
 *   npx tsx --test src/lib/pi/realWorkbook.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { creationDateIso, parseBoePiWorkbook, parseWrittenDate } from './masterSheetParser'
import { buildSubmissionPlan, cityFromBillingAddress, savedOnDate } from '@/lib/orders/submissionPayload'
import { piReadiness } from '@/lib/orders/piReadiness'

const WORKBOOK = join(homedir(), 'BOE-Development', 'temporary', 'pi-sample', 'Revised PI Format.xlsx')
const AVAILABLE = existsSync(WORKBOOK)

/**
 * The parse, done once and shared.
 *
 * Memoised rather than computed at module scope: the test runner transforms
 * this file to CommonJS, where a top-level await is a syntax error.
 */
type Parsed = Awaited<ReturnType<typeof parseBoePiWorkbook>>
let cached: Parsed | null = null
async function workbook(): Promise<Extract<Parsed, { ok: true }> | null> {
  if (!AVAILABLE) return null
  cached ??= await parseBoePiWorkbook(new Uint8Array(readFileSync(WORKBOOK)))
  return cached.ok ? cached : null
}

const opts = { skip: AVAILABLE ? false : `sample workbook not present at ${WORKBOOK}` }

describe('a real BOE PI workbook', () => {
  test('parses, and produces a draft rather than a refusal', opts, async () => {
    const parsed = await workbook()
    assert.ok(parsed, 'the production template must still parse')
    if (!parsed) return
    // THE UPLOAD IS NOT A GATE. This PI states no fabric answer and no city,
    // and it must still become an editable draft — that is the whole point of
    // moving the header requirements to finalization.
    assert.deepEqual(parsed.blockingIssues, [],
      'a production PI must not be refused at upload')
  })

  test('the header cells are the ones this parser names', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    const h = parsed.data.header
    assert.equal(h.createdBy, 'Dhruv', 'G21 — Salesperson')
    assert.equal(h.contactNumber, '8302368420', 'G22 — Salesperson contact, stored as a NUMBER in the sheet')
    assert.equal(h.billToName, 'Bombay Club', 'B25 — Client name')
    assert.equal(h.billingAddress, 'Coimbatore', 'B28 — Billing address')
    assert.equal(h.creationDate?.text, '26th Feb 2026', 'G20 — written as words, not a date')
    assert.equal(h.orderConfirmationDate?.iso, '2026-09-20', 'A113 — a real serial')
    assert.equal(h.dispatchCommitment?.iso, '2026-09-30', 'E113 — a real serial')
  })

  test('G20 reaches the record as the date the DOCUMENT states', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    // Not as the day somebody imported it. This is the assertion that would
    // have failed before creationDateIso existed.
    assert.equal(creationDateIso(parsed.data.header), '2026-02-26')
  })

  test('A115 gives the commercial terms, without the sheet’s own heading', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    assert.equal(parsed.data.piTerms.commercialTermsNote,
      'Given prices are ex-factory.\nFabric, Packaging and GST (if not quoted) will be extra as applicable.')
  })

  test('K117 is empty on this PI, so NOBODY HAS ANSWERED the fabric question', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    // The cell carries the dropdown but no value. That is not "not selected
    // yet" — it is nobody having been asked, and it must block finalization.
    assert.equal(parsed.data.piTerms.fabricResponsibility, null)
  })

  test('the city is read out of the billing address, because there is no city cell', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    assert.equal(cityFromBillingAddress(parsed.data.header.billingAddress), 'Coimbatore')
  })

  test('nothing in the surrounding prose is mistaken for a value', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    // This workbook contains "ex-factory" a second time at C137, and "Fabric
    // and Wood Finish Confirmations" at A127. Neither may contribute anything.
    const terms = parsed.data.piTerms.commercialTermsNote ?? ''
    assert.ok(!terms.includes('bubble packaging'),
      'C137 is a different sentence and must not be picked up')
    assert.ok(!/Wood Finish/.test(terms))
  })

  test('the stored record is complete except for what a person must answer', opts, async () => {
    const parsed = await workbook()
    if (!parsed) return
    const plan = buildSubmissionPlan({
      submissionId: '11111111-1111-4111-8111-111111111111',
      workbook: parsed.data,
      warnings: parsed.warnings,
      blockingIssues: parsed.blockingIssues,
      source: {
        workbookPath: 'submissions/x/original/pi.xlsx',
        workbookName: null,
        workbookSizeBytes: 1024,
        workbookSha256: 'a'.repeat(64),
        templateVersion: 'Master',
        savedOn: savedOnDate(new Date('2026-09-21T06:00:00Z')),
      },
    })
    const header = (plan.payload as Record<string, Record<string, unknown>>).header
    assert.equal(header.creation_date, '2026-02-26')
    assert.equal(header.source_created_by, 'Dhruv')
    assert.equal(header.contact_number, '8302368420')
    assert.equal(header.client_name, 'Bombay Club')
    assert.equal(header.due_date, '2026-09-30')

    // AND THE ONE THING IT CANNOT SUPPLY stops the PI being finalized, naming
    // itself rather than leaving somebody to guess.
    const readiness = piReadiness('submission', {
      client_name: String(header.client_name),
      source_workbook_path: 'submissions/x/original/pi.xlsx',
      parse_blocking_issues: [],
      creation_date: String(header.creation_date),
      source_created_by: String(header.source_created_by),
      contact_number: String(header.contact_number),
      client_city: cityFromBillingAddress(parsed.data.header.billingAddress),
      fabric_responsibility: parsed.data.piTerms.fabricResponsibility,
      commercial_terms_note: parsed.data.piTerms.commercialTermsNote,
    }, [{ item_sequence: 1, product_name: 'x', hasRepresentativeImage: true }])

    assert.deepEqual(readiness.missing.map(m => m.key), ['fabric_responsibility'],
      'everything else this workbook states; the fabric answer it does not')
  })
})

// ── The written date, in its own right ────────────────────────────────────────

describe('a date the template wrote as words', () => {
  test('the form the production template uses', () => {
    assert.equal(parseWrittenDate('26th Feb 2026'), '2026-02-26')
  })

  test('the ordinary variants around it', () => {
    for (const [input, expected] of [
      ['26 Feb 2026', '2026-02-26'],
      ['26th February 2026', '2026-02-26'],
      ['1st Jan 2027', '2027-01-01'],
      ['3rd March 2026', '2026-03-03'],
      ['Feb 26, 2026', '2026-02-26'],
      ['February 26th 2026', '2026-02-26'],
      ['2026-02-26', '2026-02-26'],
      ['  26th   feb   2026 ', '2026-02-26'],
    ] as const) {
      assert.equal(parseWrittenDate(input), expected, input)
    }
  })

  test('AN AMBIGUOUS NUMERIC DATE IS REFUSED, not guessed', () => {
    // 02/03/2026 is 2 March to half the world and 3 February to the other
    // half. A PI is read in both, so there is no safe reading and none is
    // taken. The date is asked for on screen instead.
    for (const ambiguous of ['02/03/2026', '02-03-2026', '2/3/26', '26/02/2026']) {
      assert.equal(parseWrittenDate(ambiguous), null, ambiguous)
    }
  })

  test('and so is anything that is not a calendar day', () => {
    for (const bad of [
      null, undefined, '', '   ', '-', 'TBC', 'yesterday', 'today', 'now',
      'Feb 2026', '26th Feb', '26th Smarch 2026', '31st Feb 2026', '2026-02-31',
    ]) {
      assert.equal(parseWrittenDate(bad), null, JSON.stringify(bad))
    }
  })
})

// ── The city, read out of an address that may not be one ──────────────────────

describe('the client city, taken only when the billing address can only be one', () => {
  test('a bare city is taken', () => {
    for (const city of ['Coimbatore', 'New Delhi', 'Jodhpur', '  Mumbai  ']) {
      assert.equal(cityFromBillingAddress(city), city.trim(), city)
    }
  })

  test('A STREET ADDRESS IS NOT A CITY, and none of these is taken', () => {
    // Each fails at least one of the four rules. A wrong city routes a
    // delivery to the wrong place, which is worse than an empty field.
    for (const address of [
      '12 Residency Road\nBengaluru 560025',
      '14 Nariman Point, Mumbai',
      'Plot 8, Sector 21, Gurugram',
      'B-7, Trade World, Basni Phase-II, Jodhpur, Rajasthan 342005',
      'Flat 4 Sunrise Apartments Bandra West Mumbai 400050',
      '221B Baker Street',
    ]) {
      assert.equal(cityFromBillingAddress(address), null, address)
    }
  })

  test('and neither is a blank or a placeholder', () => {
    for (const nothing of [null, undefined, '', '   ', '-', '—', '...']) {
      assert.equal(cityFromBillingAddress(nothing), null, JSON.stringify(nothing))
    }
  })
})
