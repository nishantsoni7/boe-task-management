/**
 * Repository check: the Meetings evidence migration keeps the guarantees the
 * feature exists for.
 *
 *   * Evidence is append-only. No client can insert, change or remove a row,
 *     and no storage policy can replace or delete a recorded image.
 *   * A failed or abandoned upload can never appear as evidence: the RPC proves
 *     the object exists, under this Order's folder, uploaded by the caller.
 *   * Only people entitled to the meeting can read or write its evidence, and
 *     that is decided by the meeting's own predicates — not by the UI.
 *
 * Each of these fails SILENTLY if someone later adds "the obvious missing
 * policy". Structure only — the migration's own DO-block assertions are what an
 * apply executes; these keep the text from drifting before it gets there.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/evidenceSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const sql = readFileSync(join(ROOT, 'supabase', 'migrations', '20261203000000_meeting_order_evidence.sql'), 'utf8')
/** Comments removed: the header describes the very things these check. */
const code = sql.replace(/--[^\n]*/g, '')

type Policy = { name: string; schema: string; table: string; restrictive: boolean; command: string; body: string }

function policies(): Policy[] {
  const out: Policy[] = []
  const re = /CREATE POLICY\s+"([^"]+)"\s+ON\s+(public|storage)\.(\w+)\s+(AS\s+RESTRICTIVE\s+)?FOR\s+(\w+)([\s\S]*?);/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    out.push({
      name: match[1], schema: match[2], table: match[3],
      restrictive: !!match[4], command: match[5].toUpperCase(), body: match[6],
    })
  }
  return out
}

function fnBody(name: string): string {
  const match = code.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`))
  assert.ok(match, `${name} not found`)
  return match[0]
}

const tableBlock = (() => {
  const match = code.match(/CREATE TABLE IF NOT EXISTS public\.meeting_order_evidence \([\s\S]*?\n\);/)
  assert.ok(match, 'meeting_order_evidence table not found')
  return match[0]
})()

describe('the evidence table is append-only', () => {
  test('RLS is enabled', () => {
    assert.match(code, /ALTER TABLE public\.meeting_order_evidence ENABLE ROW LEVEL SECURITY/)
  })

  test('the only permissive policy is SELECT, through can_view_meeting', () => {
    const mine = policies().filter(p => p.table === 'meeting_order_evidence')
    const permissive = mine.filter(p => !p.restrictive)
    assert.deepEqual(permissive.map(p => p.command), ['SELECT'])
    assert.match(permissive[0].body, /public\.can_view_meeting\(meeting_id, auth\.uid\(\)\)/)
  })

  test('it carries the RESTRICTIVE Meetings module gate, like every meeting table', () => {
    const gate = policies().find(p => p.name === 'meeting_order_evidence_module_entry_gate')
    assert.ok(gate)
    assert.equal(gate.restrictive, true)
    assert.equal(gate.command, 'ALL')
    assert.equal((gate.body.match(/public\.module_entry_open\('meetings'\)/g) ?? []).length, 2, 'USING and WITH CHECK')
  })

  test('no client role holds a write privilege, TRUNCATE included', () => {
    assert.match(code, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.meeting_order_evidence FROM authenticated, anon;/)
  })

  test('nothing can remove evidence as a side effect of deleting something else', () => {
    assert.ok(!/ON DELETE/i.test(tableBlock), 'no CASCADE or SET NULL on any evidence foreign key')
    assert.match(tableBlock, /meeting_order_id uuid\s+NOT NULL REFERENCES public\.meeting_orders\(id\)/)
    assert.match(tableBlock, /meeting_id\s+uuid\s+NOT NULL REFERENCES public\.meetings\(id\)/)
  })

  test('each row names its uploader, its time, its Order and its meeting', () => {
    for (const column of ['uploaded_by', 'created_at', 'meeting_order_id', 'meeting_id', 'order_number', 'storage_path']) {
      assert.match(tableBlock, new RegExp(`\\b${column}\\b[^\\n]*NOT NULL`), `${column} must be NOT NULL`)
    }
    assert.match(tableBlock, /storage_path\s+text\s+NOT NULL UNIQUE/)
    assert.match(tableBlock, /split_part\(storage_path, '\/', 1\) = meeting_order_id::text/)
  })

  test('the lookup the screens run is indexed', () => {
    assert.match(code, /CREATE INDEX IF NOT EXISTS meeting_order_evidence_order_idx\s+ON public\.meeting_order_evidence \(meeting_order_id, created_at DESC\)/)
  })
})

describe('storage', () => {
  const storage = () => policies().filter(p => p.schema === 'storage' && p.body.includes("'meeting-evidence'"))

  test('the bucket is private', () => {
    assert.match(code, /'meeting-evidence',\s*'meeting-evidence',\s*false,/)
  })

  test('exactly SELECT, INSERT and DELETE — no policy can replace an image', () => {
    assert.deepEqual(storage().map(p => p.command).sort(), ['DELETE', 'INSERT', 'SELECT'])
  })

  test('reading needs the meeting, not merely the module', () => {
    const select = storage().find(p => p.command === 'SELECT')!
    assert.match(select.body, /public\.can_view_meeting\(o\.meeting_id, auth\.uid\(\)\)/)
    assert.match(select.body, /o\.id::text = split_part\(storage\.objects\.name, '\/', 1\)/)
    assert.match(select.body, /public\.module_entry_open\('meetings'\)/)
  })

  test('writing needs an editor of a LIVE meeting, and the generated key shape', () => {
    const insert = storage().find(p => p.command === 'INSERT')!
    assert.match(insert.body, /public\.can_edit_meeting\(o\.meeting_id, auth\.uid\(\), false\)/)
    assert.match(insert.body, /storage\.objects\.name ~ '\^/)
  })

  test('deleting is only the uploader cleaning up an object no evidence row references', () => {
    const del = storage().find(p => p.command === 'DELETE')!
    assert.match(del.body, /storage\.objects\.owner_id = auth\.uid\(\)::text OR storage\.objects\.owner = auth\.uid\(\)/)
    assert.match(del.body, /NOT public\.meeting_evidence_path_recorded\(storage\.objects\.name\)/)
    // Answered with RLS bypassed, so losing sight of the meeting cannot make a
    // recorded image look unrecorded.
    assert.match(fnBody('meeting_evidence_path_recorded'), /SECURITY DEFINER/)
  })
})

describe('recording an uploaded image', () => {
  const body = () => fnBody('add_meeting_order_evidence')

  test('authorizes first — before any read of storage and before the insert', () => {
    const b = body()
    const guard = b.indexOf('assert_meeting_editor')
    const objects = b.indexOf('FROM storage.objects')
    const insert = b.indexOf('INSERT INTO public.meeting_order_evidence')
    assert.ok(guard > -1 && objects > guard && insert > objects)
  })

  test('records nothing unless the object exists, in this bucket, uploaded by the caller', () => {
    const b = body()
    assert.match(b, /o\.bucket_id = 'meeting-evidence'/)
    assert.match(b, /o\.name = v_path/)
    assert.match(b, /o\.owner_id = v_uid::text OR o\.owner = v_uid/)
    assert.match(b, /MEETING_EVIDENCE_NOT_STORED/)
  })

  test('the path must sit under THIS Order’s folder', () => {
    assert.match(body(), /'\^' \|\| v_order\.id::text \|\| '\//)
  })

  test('type and size come from Storage’s record, never from the caller', () => {
    const b = body()
    assert.match(b, /metadata ->> 'mimetype'/)
    assert.match(b, /metadata ->> 'size'/)
    const signature = b.slice(0, b.indexOf('RETURNS'))
    assert.ok(!/p_mime|p_size|p_type|p_uploaded_by|p_meeting_id/.test(signature), 'no client-supplied type, size, uploader or meeting')
  })

  test('serialises with order removal', () => {
    assert.match(body(), /FROM public\.meeting_orders WHERE id = p_order_id FOR SHARE/)
  })

  test('is executable by signed-in users only', () => {
    assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.add_meeting_order_evidence\(uuid, text, text\) FROM public, anon;/)
    assert.match(code, /GRANT\s+EXECUTE ON FUNCTION public\.add_meeting_order_evidence\(uuid, text, text\) TO authenticated;/)
  })
})

describe('removing an order', () => {
  test('keeps every original refusal and adds evidence, all before the delete', () => {
    const b = fnBody('remove_meeting_order')
    const del = b.indexOf('DELETE FROM public.meeting_orders')
    for (const needle of [
      'assert_meeting_editor',
      "entry_type IN ('order_update', 'item_update', 'task_linked')",
      "btrim(COALESCE(new_update, '')) <> ''",
      'MEETING_ORDER_HAS_HISTORY',
      'MEETING_ORDER_HAS_TASKS',
      'MEETING_ORDER_HAS_EVIDENCE',
    ]) {
      const at = b.indexOf(needle)
      assert.ok(at > -1 && at < del, `${needle} must precede the delete`)
    }
  })
})

describe('house rules', () => {
  test('every function pins search_path with pg_temp last', () => {
    const fns = (code.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length
    const pins = (code.match(/SET search_path = public, pg_temp/g) ?? []).length
    assert.equal(pins, fns)
  })

  test('no policy is USING (true)', () => {
    assert.deepEqual(code.match(/USING\s*\(\s*true\s*\)/gi) ?? [], [])
  })

  test('the self-assertions look for needles inside the functions they name', () => {
    // An assertion whose needle only appears elsewhere in the FILE passes a
    // text test and aborts a real apply (see 20261113000000).
    assert.ok(fnBody('add_meeting_order_evidence').includes('assert_meeting_editor'))
    assert.ok(fnBody('remove_meeting_order').includes('MEETING_ORDER_HAS_EVIDENCE'))
    assert.match(code, /pg_get_functiondef\('public\.remove_meeting_order\(uuid\)'::regprocedure\)\s*NOT LIKE '%MEETING_ORDER_HAS_EVIDENCE%'/)
  })

  test('every guard the migration raises has a reader-facing sentence', () => {
    const errors = readFileSync(join(ROOT, 'src', 'lib', 'meetings', 'errors.ts'), 'utf8')
    const raised = new Set([...code.matchAll(/RAISE EXCEPTION '(MEETING_[A-Z_]+):/g)].map(m => m[1]))
    assert.ok(raised.size >= 6)
    for (const guard of raised) assert.ok(errors.includes(`'${guard}:'`), `${guard} is not in GUARD_PREFIXES`)
  })
})
