/**
 * Repository check: the administrator's "delete meeting" door.
 *
 * Deleting a meeting with its data is destructive, so the properties that keep
 * it narrow are pinned in source: admin-only in the database, one marked
 * exception to the two refusals, tasks and issues untouched, files erased only
 * after the database commit, and the buttons hidden from everyone else.
 *
 * Run: npx tsx --test src/lib/meetings/adminDelete.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n')

const SQL = read('supabase', 'migrations', '20270326000000_meetings_admin_delete.sql')
const ROUTE = read('src', 'app', 'api', 'meetings', 'delete', 'route.ts')
const MODAL = read('src', 'components', 'meetings', 'DeleteMeetingModal.tsx')
const DETAIL = read('src', 'app', 'meetings', '[id]', 'MeetingWorkScreen.tsx')
const LIST = read('src', 'app', 'meetings', 'MeetingsListScreen.tsx')

describe('admin_delete_meeting (database)', () => {
  test('is refused unless the caller is an active administrator', () => {
    assert.match(SQL, /u\.role::text = 'admin' AND u\.is_active/)
    assert.match(SQL, /MEETING_FORBIDDEN: Only an administrator/)
  })

  test('is callable by signed-in users only, never anon', () => {
    assert.match(SQL, /REVOKE EXECUTE ON FUNCTION public\.admin_delete_meeting\(uuid\) FROM public, anon;/)
    assert.match(SQL, /GRANT  EXECUTE ON FUNCTION public\.admin_delete_meeting\(uuid\) TO authenticated;/)
  })

  test('both refusals bypass only for the meeting being deleted, via a transaction-local marker', () => {
    const bypass = /current_setting\('app\.admin_deleting_meeting', true\) = OLD\.id::text/g
    assert.equal((SQL.match(bypass) ?? []).length, 2)
    assert.match(SQL, /set_config\('app\.admin_deleting_meeting', p_meeting_id::text, true\)/)
    assert.match(SQL, /set_config\('app\.admin_deleting_meeting', '', true\)/)
  })

  test('removes evidence rows first (no cascade on that table) then the meeting', () => {
    const ev = SQL.indexOf('DELETE FROM public.meeting_order_evidence')
    const mt = SQL.indexOf('DELETE FROM public.meetings WHERE id = p_meeting_id')
    assert.ok(ev > 0 && mt > ev)
  })

  test('never touches tasks or discussion issues themselves', () => {
    assert.doesNotMatch(SQL, /DELETE FROM public\.tasks/)
    assert.doesNotMatch(SQL, /DELETE FROM public\.meeting_discussion_items/)
  })

  test('only erases issue-trail rows that belong to this meeting', () => {
    assert.match(SQL, /event_type IN \('update', 'added_to_agenda', 'carried_forward'\)/)
  })

  test('returns a product photo for erasure only when no other line references it', () => {
    assert.match(SQL, /NOT EXISTS \(SELECT 1 FROM public\.meeting_order_items i WHERE i\.image_path = p\)/)
  })

  test('writes an audit row and clients cannot write it', () => {
    assert.match(SQL, /INSERT INTO public\.meeting_deletion_audit/)
    assert.match(SQL, /REVOKE ALL ON public\.meeting_deletion_audit FROM anon, authenticated;/)
    assert.doesNotMatch(SQL, /USING \(true\)/)
  })
})

describe('delete route', () => {
  test('runs the delete as the caller and erases files only afterwards, with the service role', () => {
    const rpc = ROUTE.indexOf("rpc('admin_delete_meeting'")
    const svc = ROUTE.indexOf('SUPABASE_SERVICE_ROLE_KEY')
    assert.ok(rpc > 0 && svc > rpc)
    assert.match(ROUTE, /Authorization: `Bearer \$\{token\}`/)
  })

  test('maps refusal and missing meeting to 403 / 404', () => {
    assert.match(ROUTE, /42501[\s\S]*status: 403/)
    assert.match(ROUTE, /P0002[\s\S]*status: 404/)
  })

  test('cleans both buckets', () => {
    assert.match(ROUTE, /'meeting-evidence'/)
    assert.match(ROUTE, /'meeting-product-images'/)
  })
})

describe('delete UI', () => {
  test('confirmation needs the word DELETE', () => {
    assert.match(MODAL, /CONFIRM_WORD = 'DELETE'/)
    assert.match(MODAL, /disabled=\{typed\.trim\(\) !== CONFIRM_WORD\}/)
  })

  test('buttons are shown to administrators only', () => {
    assert.match(DETAIL, /profile\?\.role === 'admin' &&\s*\(\s*<button\s+onClick=\{\(\) => setModal\(\{ kind: 'delete-meeting' \}\)\}/)
    assert.match(LIST, /profile\?\.role === 'admin' && \(\s*<td/)
  })
})
