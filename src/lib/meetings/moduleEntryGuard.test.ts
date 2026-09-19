/**
 * Repository check: every Meetings write RPC requires Meetings module entry.
 *
 * The RESTRICTIVE module_entry_open('meetings') gate on the meeting tables does
 * not reach a SECURITY DEFINER function. 20261214000000 put module entry into
 * the two shared guards, can_edit_meeting() and assert_meeting_editor(), which
 * every write RPC calls. The defect returns SILENTLY if a later migration
 * re-emits either guard from its 20260814000000 text, or re-emits an RPC without
 * the guard — so this reads the LATEST definition of each across all migrations.
 *
 * Behaviour is proved by supabase/tests/run_meetings_rpc_module_entry_local.sh;
 * this keeps the text from drifting before it gets there.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/moduleEntryGuard.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const FIX = '20261214000000_meetings_rpcs_require_module_entry.sql'

const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
/** Comments removed: headers describe the very things these check. */
const code = new Map(files.map(f => [f, readFileSync(join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, '')]))

/** The last definition of public.<name> in migration order, and the file it is in. */
function latest(name: string): { file: string; body: string } {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`, 'g')
  let found: { file: string; body: string } | null = null
  for (const f of files) {
    for (const match of code.get(f)!.matchAll(re)) found = { file: f, body: match[0] }
  }
  assert.ok(found, `public.${name} is never defined`)
  return found
}

const ENTRY = "public.module_entry_open('meetings')"

describe('the shared guards require Meetings module entry', () => {
  test('the fix is on disk', () => {
    assert.ok(files.includes(FIX))
  })

  test('can_edit_meeting answers false without module entry', () => {
    const { file, body } = latest('can_edit_meeting')
    assert.ok(file >= FIX, `latest can_edit_meeting is in ${file}, before the fix`)
    assert.ok(body.includes(`SELECT p_user_id IS NOT NULL AND ${ENTRY} AND EXISTS`))
  })

  test('assert_meeting_editor refuses without module entry, before the meeting is looked up', () => {
    const { file, body } = latest('assert_meeting_editor')
    assert.ok(file >= FIX, `latest assert_meeting_editor is in ${file}, before the fix`)
    const entry = body.indexOf(`IF NOT ${ENTRY} THEN`)
    assert.ok(entry > 0, 'no module entry refusal')
    assert.ok(body.includes("'MEETING_FORBIDDEN: You do not have access to Meetings'"))
    assert.ok(entry < body.indexOf('MEETING_MISSING:'), 'the meeting is looked up before module entry is checked')
    assert.ok(entry < body.indexOf('MEETING_COMPLETED:'), 'completion is revealed before module entry is checked')
  })

  test('signatures are unchanged, so no second overload appears (PGRST203)', () => {
    assert.match(latest('can_edit_meeting').body,
      /can_edit_meeting\(\s*p_meeting_id\s+uuid,\s*p_user_id\s+uuid\s+DEFAULT auth\.uid\(\),\s*p_allow_completed boolean DEFAULT false\s*\)/)
    assert.match(latest('assert_meeting_editor').body,
      /assert_meeting_editor\(\s*p_meeting_id\s+uuid,\s*p_allow_completed boolean DEFAULT false\s*\)/)
  })
})

describe('every Meetings write RPC still authorizes through the guard', () => {
  for (const name of [
    'add_meeting_order', 'save_meeting_order_update', 'remove_meeting_order',
    'add_meeting_order_item', 'save_meeting_item_update', 'link_meeting_item_task',
    'set_meeting_status', 'import_meeting_rows', 'set_meeting_item_image_path',
    'add_meeting_order_evidence',
  ]) {
    test(name, () => {
      assert.ok(latest(name).body.includes('public.assert_meeting_editor('), `${name} does not call assert_meeting_editor`)
    })
  }
})
