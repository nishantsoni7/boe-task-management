/**
 * SAMPLE TRACKING — "Mark Received & Close" is ONE action behind ONE permission.
 *
 * THE DEFECT (production, reported 2026-08-31). Aditya — a non-admin 'member'
 * holding an employee_override grant of Sample Tracking 'receive' — could see the
 * "Mark Received & Close" button on a dispatched request he had raised himself,
 * but pressing it opened nothing. The button was gated on canReceive; the
 * confirmation panel underneath was gated on
 *
 *     isAdmin || (canReceive && !isRequester)
 *
 * so for a requester who also holds 'receive' the button rendered and the panel
 * did not. The remarks textbox and Confirm Received were unreachable, and the
 * request could never be closed by the one person the grant was for.
 *
 * THE RULE. The permission that reveals the button governs the entire action:
 * open the panel, type the optional received-condition remarks, press Confirm
 * Received, close the request. There is no second permission for the textbox,
 * and owning the request does not cancel an explicit 'receive' grant. A user
 * without 'receive' gets none of it. Admin is unchanged (admin implies
 * canReceive). This is also exactly what the database enforces:
 * sd_update_perm_receive checks 'receive' and never looks at requested_by.
 *
 * HOW THIS TESTS IT. The gate expressions are lifted verbatim out of the real
 * page source and evaluated as JavaScript, so these are assertions about the
 * shipped condition rather than about a copy of it that could drift away from
 * it. If either gate is reworded, extraction fails loudly instead of passing on
 * a stale duplicate.
 *
 * Reads repository files only. No DB, no network, no writes.
 *
 * Run:
 *   npx tsx --test src/lib/permissions/sampleReceiveAction.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const SAMPLES_PAGE = 'src/app/samples/page.tsx'
const RECEIVE_RLS = 'supabase/migrations/20260904000000_sample_tracking_view_parent_gate.sql'

const pageSource = read(SAMPLES_PAGE)

// ── Lifting the real gates out of the page ──────────────────────────────────

/**
 * The confirmation panel's JSX gate, verbatim. Anchored on the opening of the
 * "Verify received panel" block: everything between the leading `{` and the
 * trailing ` && (` is the condition that decides whether the remarks textbox
 * and Confirm Received exist in the tree at all.
 */
function extractPanelGate(): string {
  const m = pageSource.match(/^[ \t]*\{(verifyOpen &&[^\r\n]*?) && \($/m)
  assert.ok(m, `${SAMPLES_PAGE}: could not find the verify-received panel gate — has it been reworded?`)
  return m[1]
}

/** The `const canReceive = ...` derivation, verbatim. */
function extractCanReceiveRule(): string {
  const m = pageSource.match(/^[ \t]*const canReceive[ \t]*=[ \t]*([^\r\n]+?)[ \t]*$/m)
  assert.ok(m, `${SAMPLES_PAGE}: could not find the canReceive derivation`)
  return m[1]
}

type Ctx = {
  verifyOpen: boolean
  status: string
  canReceive: boolean
  isAdmin: boolean
  isRequester: boolean
}

/** Evaluate the lifted panel gate under a given context. */
function panelOpens(gate: string, ctx: Ctx): boolean {
  const fn = new Function(
    'verifyOpen', 'r', 'canReceive', 'isAdmin', 'isRequester',
    `return Boolean(${gate})`,
  ) as (v: boolean, r: { status: string }, c: boolean, a: boolean, req: boolean) => boolean
  return fn(ctx.verifyOpen, { status: ctx.status }, ctx.canReceive, ctx.isAdmin, ctx.isRequester)
}

/** Evaluate the lifted canReceive rule for a user. */
function canReceiveFor(rule: string, isAdmin: boolean, actions: string[]): boolean {
  const fn = new Function(
    'effectiveIsAdmin', 'effectivePerms',
    `return Boolean(${rule})`,
  ) as (a: boolean, p: Set<string>) => boolean
  return fn(isAdmin, new Set(actions))
}

// Aditya in production: role 'member', Sample Tracking view + receive granted
// through employee_override. Not an admin, and the requester of his own row.
const ADITYA_ACTIONS = [
  'view', 'create', 'edit', 'approve', 'dispatch',
  'receive', 'mark_lost', 'close', 'export', 'manage',
]

describe('canReceive is the whole gate for Mark Received & Close', () => {
  test('a non-admin requester holding receive can reach the button', () => {
    const canReceive = canReceiveFor(extractCanReceiveRule(), false, ADITYA_ACTIONS)
    assert.equal(canReceive, true, 'a non-admin with the receive grant must resolve canReceive = true')

    // The button branch in the dispatched block renders whenever canReceive is
    // true; the "ask someone else" hint is the isRequester && !canReceive branch.
    assert.match(
      pageSource,
      /\{isRequester && !canReceive \? \(/,
      'the ask-someone-else hint must remain the !canReceive branch',
    )
    assert.match(
      pageSource,
      /\) : canReceive \? \(\s*[\r\n]\s*<ActionBtn[^\r\n]*'Mark Received & Close'/,
      'Mark Received & Close must render on canReceive alone',
    )
  })

  test('clicking it opens the confirmation panel for that same user', () => {
    const gate = extractPanelGate()
    assert.equal(
      panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive: true, isAdmin: false, isRequester: true }),
      true,
      'THE REGRESSION: a non-admin requester with receive must get the confirmation panel',
    )
  })

  test('owning the request does not override an explicit receive grant', () => {
    const gate = extractPanelGate()
    const owned = panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive: true, isAdmin: false, isRequester: true })
    const notOwned = panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive: true, isAdmin: false, isRequester: false })
    assert.equal(owned, notOwned, 'requester and non-requester with receive must be treated identically')
    assert.equal(owned, true)

    // And the gate must not mention ownership at all any more.
    assert.doesNotMatch(gate, /isRequester/, 'the panel gate must not consult isRequester')
  })

  test('the button and the panel agree for every user, so no dead button exists', () => {
    const gate = extractPanelGate()
    for (const canReceive of [true, false]) {
      for (const isAdmin of [true, false]) {
        for (const isRequester of [true, false]) {
          const buttonVisible = canReceive
          const panel = panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive, isAdmin, isRequester })
          assert.equal(
            panel, buttonVisible,
            `button/panel disagree for canReceive=${canReceive} isAdmin=${isAdmin} isRequester=${isRequester}`,
          )
        }
      }
    }
  })

  test('a user without receive gets neither the button nor the panel', () => {
    const canReceive = canReceiveFor(extractCanReceiveRule(), false, ['view', 'create'])
    assert.equal(canReceive, false, 'no receive grant and not admin must resolve canReceive = false')

    const gate = extractPanelGate()
    for (const isRequester of [true, false]) {
      assert.equal(
        panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive: false, isAdmin: false, isRequester }),
        false,
        'a user without receive must never reach the confirmation panel',
      )
    }
  })

  test('admin behaviour is unchanged', () => {
    assert.equal(
      canReceiveFor(extractCanReceiveRule(), true, []),
      true,
      'admin must resolve canReceive = true with no explicit grants',
    )

    const gate = extractPanelGate()
    for (const isRequester of [true, false]) {
      assert.equal(
        panelOpens(gate, { verifyOpen: true, status: 'dispatched', canReceive: true, isAdmin: true, isRequester }),
        true,
        'admin must still get the confirmation panel, including on their own request',
      )
    }
  })

  test('the panel stays shut until the button is pressed, and only for dispatched rows', () => {
    const gate = extractPanelGate()
    assert.equal(
      panelOpens(gate, { verifyOpen: false, status: 'dispatched', canReceive: true, isAdmin: true, isRequester: false }),
      false,
      'the panel must not render before Mark Received & Close is pressed',
    )
    for (const status of ['pending_approval', 'qr_submitted', 'returned', 'lost', 'rejected']) {
      assert.equal(
        panelOpens(gate, { verifyOpen: true, status, canReceive: true, isAdmin: true, isRequester: false }),
        false,
        `the panel must not render for status ${status}`,
      )
    }
  })
})

describe('the panel still contains the whole action', () => {
  // The gate is worth nothing if what it guards has lost its controls, so pin
  // the three things the report said were missing.
  const panelBlock = (() => {
    const start = pageSource.indexOf('{verifyOpen && r.status === ')
    assert.ok(start > 0, 'verify panel block not found')
    const end = pageSource.indexOf('{/* Mark Lost confirmation panel */}', start)
    assert.ok(end > start, 'could not bound the verify panel block')
    return pageSource.slice(start, end)
  })()

  test('the optional received-condition remarks textbox is inside the panel', () => {
    assert.match(panelBlock, /<textarea value=\{receivedNote\}/, 'the remarks textbox must live inside the gated panel')
    assert.match(panelBlock, /placeholder="Optional/, 'the remarks must stay optional')
  })

  test('Confirm Received and Cancel are inside the panel', () => {
    assert.match(panelBlock, /Confirm Received/, 'Confirm Received must live inside the gated panel')
    assert.match(panelBlock, /onClick=\{handleVerifyReceived\}/, 'Confirm Received must call the verify handler')
    assert.match(panelBlock, /setVerifyOpen\(false\)/, 'Cancel must close the panel')
  })

  test('confirming still writes the closed status and the received note', () => {
    const m = pageSource.match(/const handleVerifyReceived = async \(\) => \{[\s\S]*?\r?\n {2}\}/)
    assert.ok(m, 'handleVerifyReceived not found')
    const handler = m[0]
    assert.match(handler, /\.from\('sample_dispatches'\)/)
    assert.match(handler, /status: 'returned'/, 'the transition must still close the request')
    assert.match(handler, /received_note: receivedNote\.trim\(\) \|\| null/, 'the remarks must still be saved')
    assert.match(handler, /received_by: currentUserId/)
  })
})

describe('the UI gate agrees with what the database enforces', () => {
  const sql = read(RECEIVE_RLS)
  const policy = (() => {
    const start = sql.indexOf('CREATE POLICY "sd_update_perm_receive"')
    assert.ok(start > 0, 'sd_update_perm_receive policy not found')
    return sql.slice(start, sql.indexOf(';', start))
  })()

  test('the receive policy authorises dispatched → returned on the receive action', () => {
    assert.match(policy, /status = 'dispatched'/)
    assert.match(policy, /status = 'returned'/)
    assert.match(policy, /resolve_permission\(auth\.uid\(\), 'sample_tracking', 'receive'\)/)
  })

  test('the database never treats the requester as disqualified', () => {
    assert.doesNotMatch(
      policy, /requested_by/,
      'sd_update_perm_receive must not exclude the requester — the UI must not either',
    )
  })

  test('the module parent gate is still on the policy', () => {
    assert.match(policy, /sample_tracking_module_open\(\)/, 'RLS must not be weakened to fix a frontend bug')
  })
})
