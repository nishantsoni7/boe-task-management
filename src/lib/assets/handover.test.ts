/**
 * Asset handover acknowledgement (20261029000000).
 *
 * Three things are proved here:
 *
 *   1. THE TERMS DO NOT DRIFT. The text this app renders and the text the
 *      database snapshots at acceptance are compared character for character
 *      against the migration itself. If they ever differ, an employee is shown
 *      one document and recorded as having accepted another.
 *
 *   2. THE ACCEPTANCE IS SERVER-SIDE. Only the allocated employee may accept,
 *      the acknowledgement is checked by the RPC and not just by a checkbox,
 *      and the employee, timestamp, version and terms body are all written by
 *      the database rather than supplied by the caller. Asserted against the
 *      migration source, because a Node test cannot run Postgres — the live
 *      counterpart is supabase/tests/asset_handover_assertions.sql.
 *
 *   3. THE PRINTED SHEET CARRIES THE ALLOCATION AND THE TERMS, including the
 *      case where nothing was recorded, where it must say so rather than print
 *      a blank line onto a document somebody is about to sign.
 *
 * Run:
 *   npx tsx --test src/lib/assets/handover.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSET_HANDOVER_ACKNOWLEDGEMENT,
  ASSET_HANDOVER_TERMS_BODY,
  ASSET_HANDOVER_TERMS_CLAUSES,
  ASSET_HANDOVER_TERMS_HEADING,
  ASSET_HANDOVER_TERMS_VERSION,
  HANDOVER_NOT_RECORDED,
  buildHandoverSheet,
  handoverTermsLines,
} from './handover'
import { EMPLOYEE_ASSET_COLUMNS } from './detail'
import { assetErrorMessage } from './errors'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

const MIGRATION = 'supabase/migrations/20261029000000_asset_handover_acknowledgement.sql'
const sql = read(MIGRATION)

/**
 * The migration with every `--` comment line removed.
 *
 * For the handful of assertions about what the file DOES NOT contain. This file
 * explains itself at length, including by quoting SQL it deliberately does not
 * run, so a "must not appear" test that read the prose would fail on the very
 * sentence written to prevent the mistake.
 */
const statements = sql
  .split('\n')
  .filter(line => !line.trimStart().startsWith('--'))
  .join('\n')

/** Everything between the dollar-quoted markers in the v1 seed. */
function seededTermsBody(): string {
  const match = sql.match(/\$terms\$([\s\S]*?)\$terms\$/)
  assert.ok(match, 'the migration must seed the terms in a $terms$ … $terms$ block')
  return match![1]
}

// ── 1. The terms ────────────────────────────────────────────────────────────

describe('the Asset Handover Terms', () => {
  test('the heading is exactly what the owner specified', () => {
    assert.equal(ASSET_HANDOVER_TERMS_HEADING, 'Asset Handover Terms')
    assert.equal(ASSET_HANDOVER_ACKNOWLEDGEMENT, 'I have read and accept the Asset Handover Terms')
  })

  test('there are seven clauses, numbered 1–7', () => {
    assert.equal(ASSET_HANDOVER_TERMS_CLAUSES.length, 7)
    const lines = ASSET_HANDOVER_TERMS_BODY.split('\n')
    assert.equal(lines.length, 7)
    lines.forEach((line, i) => assert.ok(line.startsWith(`${i + 1}. `), line))
  })

  test('the app text and the seeded database text are identical', () => {
    // The single assertion this file exists for.
    assert.equal(seededTermsBody(), ASSET_HANDOVER_TERMS_BODY)
  })

  test('the version the app names is the version the migration makes current', () => {
    assert.equal(ASSET_HANDOVER_TERMS_VERSION, 'v1')
    assert.match(sql, /VALUES \('v1', \$terms\$/)
    assert.match(sql, /\$terms\$, true\)/)   // is_current
  })

  test('the clauses say what was asked, and nothing stronger', () => {
    const body = ASSET_HANDOVER_TERMS_BODY.toLowerCase()
    // The specific things the owner ruled out: no automatic salary deduction,
    // and no claim that every damage is automatically payable.
    for (const forbidden of ['salary', 'deduct', 'automatically payable', 'will be deducted']) {
      assert.ok(!body.includes(forbidden), `the terms must not say "${forbidden}"`)
    }
    // …and the softening that must survive any future edit.
    assert.match(ASSET_HANDOVER_TERMS_BODY, /normal wear from proper use/)
    assert.match(ASSET_HANDOVER_TERMS_BODY, /will be reviewed with me/)
    assert.match(ASSET_HANDOVER_TERMS_BODY, /follow company process and applicable law/)
  })
})

describe('which terms a record shows', () => {
  test('an accepted record shows the SNAPSHOT, never today’s text', () => {
    // If the terms are amended, a sheet printed for an old acceptance must
    // still say what that person actually agreed to.
    const old = '1. An older clause.\n2. Another older clause.'
    assert.deepEqual(handoverTermsLines(old), ['1. An older clause.', '2. Another older clause.'])
  })

  test('a record with no snapshot shows the current terms', () => {
    assert.deepEqual(handoverTermsLines(null), ASSET_HANDOVER_TERMS_BODY.split('\n'))
    assert.deepEqual(handoverTermsLines(undefined), ASSET_HANDOVER_TERMS_BODY.split('\n'))
    assert.deepEqual(handoverTermsLines('   '), ASSET_HANDOVER_TERMS_BODY.split('\n'))
  })
})

// ── 2. Acceptance is decided by the database ────────────────────────────────
//
// The migration has ONE implementation and TWO entry points, so the tests below
// read the implementation for the guards and the wrappers for the routing.
// `impl` is where every rule lives; a wrapper that duplicated one of them would
// be the drift this shape exists to prevent.

const impl = sql.slice(
  sql.indexOf('CREATE OR REPLACE FUNCTION public.accept_employee_asset_impl('),
  sql.indexOf('REVOKE ALL ON FUNCTION public.accept_employee_asset_impl(uuid, boolean)'),
)

describe('only the allocated employee can accept', () => {
  test('the guard is on employee_id = auth.uid(), taken from the session', () => {
    assert.ok(impl.length > 0, 'accept_employee_asset_impl must be defined by this migration')
    assert.match(impl, /v_uid\s+uuid := auth\.uid\(\)/)
    assert.match(impl, /IF NOT FOUND OR v_row\.employee_id <> v_uid THEN/)
    assert.match(impl, /ASSET_ACCEPT_DENIED/)
  })

  test('the same guard is repeated in the UPDATE, so a race cannot slip through', () => {
    assert.match(impl, /WHERE id\s+= p_assignment_id\n\s+AND employee_id = v_uid\n\s+AND status\s+= 'pending_acceptance'/)
    assert.match(impl, /ASSET_ACCEPT_CONFLICT/)
  })

  test('an already-accepted assignment is refused rather than re-stamped', () => {
    assert.match(impl, /IF v_row\.status <> 'pending_acceptance' THEN/)
    assert.match(impl, /ASSET_ACCEPT_INVALID/)
  })

  test('BOTH entry points reach that one guard — the wrapper is not a second path', () => {
    // A legacy wrapper that re-implemented the acceptance could drift from it.
    // Each is a handful of lines whose only job is to call the implementation.
    for (const signature of [
      'CREATE OR REPLACE FUNCTION public.accept_employee_asset(\n  p_assignment_id uuid,\n  p_accept_terms  boolean\n)',
      'CREATE OR REPLACE FUNCTION public.accept_employee_asset(p_assignment_id uuid)',
    ]) {
      assert.ok(sql.includes(signature), signature.split('\n')[0])
    }
    assert.match(sql, /RETURN public\.accept_employee_asset_impl\(p_assignment_id, true\);/)
    assert.match(sql, /RETURN public\.accept_employee_asset_impl\(p_assignment_id, false\);/)
    // Neither wrapper writes to employee_assets itself.
    const wrappers = sql.slice(sql.indexOf('-- 5b. THE NEW ENTRY POINT'))
    assert.ok(
      !/UPDATE public\.employee_assets/.test(wrappers),
      'a wrapper must not write the acceptance itself',
    )
  })

  test('there is no parameter through which an employee id or a timestamp could arrive', () => {
    const signature = impl.slice(0, impl.indexOf('RETURNS public.employee_assets'))
    assert.match(signature, /p_assignment_id\s+uuid/)
    assert.ok(!/p_employee_id/.test(signature), 'no employee id parameter')
    assert.ok(!/p_accepted_at|timestamptz/.test(signature), 'no timestamp parameter')
    assert.ok(!/p_terms|p_version/.test(signature), 'the terms are never supplied by the caller')
  })

  test('the implementation is NOT callable by a client', () => {
    // Only the two SECURITY DEFINER wrappers may reach it. Otherwise a caller
    // could choose p_explicit_acknowledgement for itself and record a legacy
    // acceptance from a client that has the checkbox.
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.accept_employee_asset_impl\(uuid, boolean\)\n\s*FROM public, anon, authenticated;/,
    )
    assert.ok(
      !/GRANT EXECUTE ON FUNCTION public\.accept_employee_asset_impl/.test(sql),
      'the implementation must never be granted to anybody',
    )
    assert.match(sql, /accept_employee_asset_impl must not be executable by authenticated/)
  })

  test('both entry points are executable by authenticated, and by nobody else', () => {
    for (const args of ['uuid, boolean', 'uuid']) {
      assert.ok(
        sql.includes(`REVOKE ALL   ON FUNCTION public.accept_employee_asset(${args}) FROM public, anon;`),
        `revoke for (${args})`,
      )
      assert.ok(
        sql.includes(`GRANT EXECUTE ON FUNCTION public.accept_employee_asset(${args}) TO authenticated;`),
        `grant for (${args})`,
      )
    }
  })
})

// ── 2b. The database-first rollout ──────────────────────────────────────────
//
// The migration is applied BEFORE the new frontend ships. In that window the
// deployed frontend calls accept_employee_asset(uuid) and assign_asset with
// five arguments, and both must keep working — otherwise applying the migration
// takes the Accept button away from every employee until the deploy lands.

describe('the deployed frontend keeps working during a database-first rollout', () => {
  test('the legacy one-argument RPC is KEPT, not dropped', () => {
    // Against the statements, not the prose: the header quotes exactly this
    // DROP as the thing a LATER migration should do.
    assert.ok(
      !/DROP FUNCTION IF EXISTS public\.accept_employee_asset\(uuid\);/.test(statements),
      'the one-argument accept_employee_asset must not be dropped by this migration',
    )
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.accept_employee_asset\(p_assignment_id uuid\)/)
  })

  test('it records the SAME five facts as the new path', () => {
    // It routes into the same implementation, which is the only place the
    // acceptance is written — asserted above. So this checks the migration says
    // so, and the live runner proves it (§B6 of the assertions).
    assert.match(sql, /It is NOT a weaker acceptance/)
    assert.match(sql, /RETURN public\.accept_employee_asset_impl\(p_assignment_id, false\);/)
  })

  test('and it does not claim an acknowledgement it cannot evidence', () => {
    assert.match(impl, /'acknowledged_explicitly', p_explicit_acknowledgement/)
  })

  test('NEITHER overload declares a DEFAULT — that is what keeps them resolvable', () => {
    // With a default on p_accept_terms, a {p_assignment_id} request would match
    // both candidates and PostgREST answers PGRST203 for every acceptance.
    //
    // Comments are stripped first: the follow-up cleanup note in the header
    // spells out the default that MAY be added once the wrapper is gone, and a
    // test that read prose would fail on the very sentence explaining itself.
    assert.ok(
      !/p_accept_terms\s+boolean\s+DEFAULT/.test(statements),
      'p_accept_terms must have no DEFAULT while the legacy wrapper exists',
    )
    assert.match(sql, /p\.pronargdefaults > 0/)
    assert.match(sql, /makes the PostgREST call ambiguous \(PGRST203\)/)
  })

  test('the migration asserts BOTH entry points exist at apply time', () => {
    assert.match(sql, /expected 2 accept_employee_asset entry points/)
    assert.match(sql, /the legacy one-argument accept_employee_asset is missing/)
  })

  test('assign_asset stays ONE function whose new parameters default', () => {
    // The opposite case: here a second overload would be the ambiguity, and the
    // five trailing defaults are what let the old five-argument call resolve.
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.assign_asset\(uuid, uuid, date, text, text\);/)
    assert.match(sql, /p_accessories\s+text DEFAULT NULL,/)
    assert.match(sql, /p_existing_issues text DEFAULT NULL/)
    assert.match(sql, /expected 1 assign_asset, found/)
    assert.match(sql, /AND p\.pronargdefaults = 5/)
  })

  test('the follow-up cleanup is written down, with how to know it is safe', () => {
    assert.match(sql, /FOLLOW-UP CLEANUP, TO BE DONE IN A LATER MIGRATION/)
    assert.match(sql, /DROP FUNCTION IF EXISTS public\.accept_employee_asset\(uuid\);/)
    assert.match(sql, /Do NOT do it here, and do not do it in the same release as the frontend/)
    assert.match(sql, /details ->> 'acknowledged_explicitly' = 'false'/)
    assert.match(sql, /DEPRECATED compatibility wrapper/)
  })

  test('the print overlay is PORTALLED to document.body', () => {
    // THE DEFECT THIS LOCKS DOWN, found in local browser QA on 2026-08-31.
    //
    // PRINT_STYLES hides everything beside the sheet with
    //   body > *:not(.boe-handover-print-root) { display: none }
    // Rendered in place, the overlay is a descendant of div.boe-app-shell —
    // which IS the direct body child — so that rule hid the shell AND the sheet
    // inside it. The screen looked perfect and the printout was a blank page.
    //
    // The selector and the portal are two halves of one mechanism. Whoever
    // changes either must change both, and this fails if only one moves.
    const ui = read('src/components/assets/AssetHandover.tsx')
    assert.match(ui, /import \{ createPortal \} from 'react-dom'/)
    assert.match(ui, /return createPortal\(/)
    assert.match(ui, /^\s*document\.body,$/m)
    assert.match(ui, /body > \*:not\(\.boe-handover-print-root\)/)
    // The overlay element the selector names is the one being portalled.
    const portalled = ui.slice(ui.indexOf('return createPortal('))
    assert.match(portalled, /className="boe-handover-print-root"/)
  })

  test('the NEW UI uses the explicit checkbox path, never the wrapper', () => {
    const ui = read('src/components/assets/AssetHandover.tsx')
    assert.match(ui, /supabase\.rpc\('accept_employee_asset', \{\n\s*p_assignment_id: assignment\.id,\n\s*p_accept_terms: true,\n\s*\}\)/)
    // …and the button cannot be pressed until the box is ticked.
    assert.match(ui, /disabled=\{!acknowledged\}/)
    assert.match(ui, /if \(!acknowledged\) \{/)
  })
})

describe('what an acceptance records', () => {
  test('the acknowledgement itself is checked on the server', () => {
    // The checkbox is the honest interaction; this is what makes the record
    // true even if a future screen forgets it. It lives on the NEW entry point:
    // the legacy wrapper predates the checkbox and cannot ask for it.
    const newEntry = sql.slice(
      sql.indexOf('-- 5b. THE NEW ENTRY POINT'),
      sql.indexOf('-- 5c. THE LEGACY ENTRY POINT'),
    )
    assert.match(newEntry, /IF p_accept_terms IS NOT TRUE THEN/)
    assert.match(newEntry, /ASSET_ACCEPT_TERMS_REQUIRED/)
  })

  test('employee, timestamp, version and terms body are all written', () => {
    assert.match(impl, /SET status\s+= 'accepted',/)
    assert.match(impl, /accepted_at\s+= now\(\),/)          // the database's clock
    assert.match(impl, /accepted_by\s+= v_uid,/)            // the session, not a parameter
    assert.match(impl, /acceptance_version = v_terms\.version,/)
    assert.match(impl, /accepted_terms\s+= v_terms\.body/)
  })

  test('the terms are read from the table inside the function', () => {
    assert.match(impl, /SELECT \* INTO v_terms FROM public\.current_asset_handover_terms\(\)/)
    assert.match(impl, /ASSET_ACCEPT_TERMS_MISSING/)
  })

  test('the six columns exist and are asserted by the migration', () => {
    for (const column of [
      'handover_condition', 'handover_accessories', 'handover_existing_issues',
      'accepted_by', 'acceptance_version', 'accepted_terms',
    ]) {
      assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`), column)
      assert.ok(EMPLOYEE_ASSET_COLUMNS.split(', ').includes(column), `${column} is not read by the app`)
    }
    assert.match(sql, /expected 6 handover columns on employee_assets, found/)
  })

  test('nothing is backfilled — an old acceptance never gains a version it never had', () => {
    assert.ok(
      !/UPDATE public\.employee_assets\s+SET (acceptance_version|accepted_by|accepted_terms)/i.test(sql),
      'the migration must not backfill acceptances',
    )
    assert.match(sql, /pre-existing acceptance\(s\) were given a terms version/)
  })
})

describe('the handover facts are recorded before the employee is asked', () => {
  test('assign_asset takes the accessories and the existing issues', () => {
    assert.match(sql, /p_accessories\s+text DEFAULT NULL,/)
    assert.match(sql, /p_existing_issues text DEFAULT NULL/)
    assert.match(sql, /handover_condition, handover_accessories, handover_existing_issues/)
  })

  test('assigning still requires the assign permission, unchanged', () => {
    assert.match(sql, /public\.assert_asset_custody_permission\(\n\s*'assign', 'You do not have permission to assign assets'\)/)
  })

  test('the refusals reach the reader as sentences, not driver strings', () => {
    for (const code of ['ASSET_ACCEPT_TERMS_REQUIRED', 'ASSET_ACCEPT_TERMS_MISSING']) {
      const message = assetErrorMessage('accept', {
        code: '42501',
        message: `${code}: Confirm you have read and accept the Asset Handover Terms`,
      })
      assert.equal(message, 'Confirm you have read and accept the Asset Handover Terms.')
    }
  })
})

// ── 3. The printed sheet ────────────────────────────────────────────────────

const fmt = (iso: string) => `formatted(${iso})`

const FULL = {
  assetName: 'ThinkPad T14',
  assetCode: 'BOE-ASSET-000042',
  serialNo: 'PF3ABCDE',
  assetType: 'laptop',
  employeeName: 'Priya Sharma',
  issuedByName: 'Aditya Verma',
  assignedAt: '2026-08-20T09:30:00.000Z',
  condition: 'good',
  accessories: '65W charger, sleeve, wireless mouse',
  existingIssues: 'Small scratch on the lid',
  acceptedAt: '2026-08-21T04:15:00.000Z',
  acceptedByName: 'Priya Sharma',
  acceptanceVersion: 'v1',
  acceptedTerms: ASSET_HANDOVER_TERMS_BODY,
  formatDateTime: fmt,
}

/** Everything the sheet prints, flattened, so a test can ask "does it say X". */
function sheetText(sheet: ReturnType<typeof buildHandoverSheet>): string {
  return [
    sheet.company, sheet.title, sheet.termsHeading, sheet.acceptanceStatement,
    ...sheet.assetLines.flatMap(l => [l.label, l.value]),
    ...sheet.handoverLines.flatMap(l => [l.label, l.value]),
    ...sheet.acceptanceLines.flatMap(l => [l.label, l.value]),
    ...sheet.terms,
    ...sheet.signatures.flatMap(s => [s.label, s.caption]),
  ].join('\n')
}

describe('the printed Handover Sheet', () => {
  test('it carries BOE, the employee, and every allocation detail', () => {
    const text = sheetText(buildHandoverSheet(FULL))
    for (const expected of [
      'Best of Exports',
      'Asset Handover Sheet',
      'ThinkPad T14',              // asset / device name
      'BOE-ASSET-000042',          // asset id
      'PF3ABCDE',                  // serial number
      'Priya Sharma',              // employee
      'Aditya Verma',              // who issued it
      'formatted(2026-08-20T09:30:00.000Z)', // handover date
      'Good',                      // issued condition, labelled for a reader
      '65W charger, sleeve, wireless mouse',
      'Small scratch on the lid',
    ]) {
      assert.ok(text.includes(expected), `the sheet must print "${expected}"`)
    }
  })

  test('it carries the terms, all seven clauses, verbatim', () => {
    const sheet = buildHandoverSheet(FULL)
    assert.equal(sheet.termsHeading, ASSET_HANDOVER_TERMS_HEADING)
    assert.deepEqual(sheet.terms, ASSET_HANDOVER_TERMS_BODY.split('\n'))
    for (const clause of ASSET_HANDOVER_TERMS_CLAUSES) {
      assert.ok(sheet.terms.some(line => line.endsWith(clause)), clause.slice(0, 40))
    }
  })

  test('it states the online acceptance — who, when, which version', () => {
    const sheet = buildHandoverSheet(FULL)
    assert.equal(sheet.accepted, true)
    assert.match(sheet.acceptanceStatement, /Priya Sharma accepted the Asset Handover Terms online on formatted\(2026-08-21T04:15:00\.000Z\)\./)
    assert.deepEqual(
      sheet.acceptanceLines,
      [
        { label: 'Accepted By',   value: 'Priya Sharma' },
        { label: 'Accepted On',   value: 'formatted(2026-08-21T04:15:00.000Z)' },
        { label: 'Terms Version', value: 'v1' },
      ],
    )
  })

  test('it always has both physical signature lines', () => {
    for (const input of [FULL, { ...FULL, acceptedAt: null }]) {
      const sheet = buildHandoverSheet(input)
      assert.deepEqual(
        sheet.signatures.map(s => s.label),
        ['Employee Signature', 'Issued By (Signature)'],
      )
    }
  })

  test('an unaccepted handover says so, rather than implying one', () => {
    const sheet = buildHandoverSheet({ ...FULL, acceptedAt: null, acceptanceVersion: null, acceptedTerms: null })
    assert.equal(sheet.accepted, false)
    assert.equal(sheet.acceptanceLines.length, 0)
    assert.match(sheet.acceptanceStatement, /has not yet been accepted online/)
    // It still prints the terms — this is the copy the two people sign.
    assert.deepEqual(sheet.terms, ASSET_HANDOVER_TERMS_BODY.split('\n'))
  })

  test('it reproduces the SNAPSHOT for an old acceptance, not the current text', () => {
    const sheet = buildHandoverSheet({ ...FULL, acceptedTerms: '1. The clause as it stood then.' })
    assert.deepEqual(sheet.terms, ['1. The clause as it stood then.'])
  })

  test('an unrecorded field prints words, never a blank line', () => {
    const sheet = buildHandoverSheet({
      assetName: null, assetCode: null, serialNo: null,
      employeeName: null, issuedByName: null, assignedAt: null,
      condition: null, accessories: null, existingIssues: null,
      formatDateTime: fmt,
    })
    for (const line of [...sheet.assetLines, ...sheet.handoverLines]) {
      assert.notEqual(line.value.trim(), '', `${line.label} printed a blank`)
    }
    assert.equal(sheet.assetLines.find(l => l.label === 'Serial Number')?.value, HANDOVER_NOT_RECORDED)
    // Clause 2 makes an unrecorded issue a statement in itself, so the sheet
    // says that rather than "Not recorded".
    assert.equal(
      sheet.handoverLines.find(l => l.label === 'Existing Issues')?.value,
      'None recorded at handover',
    )
  })
})
