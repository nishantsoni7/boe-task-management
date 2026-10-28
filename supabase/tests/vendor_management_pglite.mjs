// Database regression suite for 20270425000000 (Vendor Management). Runs the REAL migration in an in-memory
// Postgres (PGlite) against small stubs of the platform objects it depends on (users, auth.uid(),
// module_entry_open, resolve_permission, storage). Run:
//   node supabase/tests/vendor_management_pglite.mjs <dir with @electric-sql/pglite installed>
// Expected last line: "all N checks passed".
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import assert from 'node:assert/strict'

const PGLITE_DIR = process.argv[2]
if (!PGLITE_DIR) { console.error('usage: node vendor_management_pglite.mjs <dir with @electric-sql/pglite installed>'); process.exit(2) }
const require = createRequire(resolve(PGLITE_DIR) + '/')
const { PGlite } = require('@electric-sql/pglite')
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const mig = f => readFileSync(`${REPO}/supabase/migrations/${f}`, 'utf8').replace(/\r/g, '')

// The real phone normaliser, extracted from the Exhibition Leads migration (the vendor module depends on it).
function extract(text, fnName) {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.toLowerCase().startsWith(`create or replace function public.${fnName.toLowerCase()}(`))
  if (start < 0) throw new Error('cannot extract ' + fnName)
  const out = []
  let tag = null
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    if (!tag) {
      const m = /(\$[a-z_]*\$)/i.exec(line)
      if (m) { tag = m[1]; if (line.slice(m.index + tag.length).includes(tag) && /;\s*$/.test(line)) break }
      continue
    }
    if (line.includes(tag) && /;\s*$/.test(line)) break
  }
  return out.join('\n')
}

const U = {
  admin:  '00000000-0000-0000-0000-0000000000a1',
  dhruv:  '00000000-0000-0000-0000-0000000000b2',
  nobody: '00000000-0000-0000-0000-0000000000c3',
  other:  '00000000-0000-0000-0000-0000000000d4',
}

const db = new PGlite()
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create schema storage;
  grant usage on schema public, auth, storage to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

  create table public.users (id uuid primary key, full_name text, role text not null default 'employee',
    is_active boolean not null default true, is_deleted boolean default false);
  create table public.grants (user_id uuid, module_key text, action_key text);
  create function public.resolve_permission(p_uid uuid, p_module text, p_action text) returns boolean
    language sql stable as $$ select exists (select 1 from public.grants g where g.user_id = p_uid and g.module_key = p_module and g.action_key = p_action) $$;
  create function public.module_entry_open(p text) returns boolean language sql stable as $$ select true $$;
  create function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

  create table public.app_modules (module_key text primary key, module_name text, description text, route_path text,
    visibility_type text, allowed_department text, sort_order int);
  create table public.permission_modules (id uuid primary key default gen_random_uuid(), module_key text unique, display_name text, description text);
  create table public.permission_actions (id uuid primary key default gen_random_uuid(), action_key text unique);
  insert into public.permission_actions (action_key) values ('view');
  create table public.module_permission_actions (module_id uuid, action_id uuid, default_allowed boolean, unique (module_id, action_id));
  create table public.role_permissions (role text, module_id uuid, action_id uuid, allowed boolean, unique (role, module_id, action_id));

  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
  alter table storage.objects enable row level security;

  insert into public.users (id, full_name, role) values
    ('${U.admin}', 'Admin Person', 'admin'), ('${U.dhruv}', 'Dhruv', 'employee'),
    ('${U.nobody}', 'No Access', 'employee'), ('${U.other}', 'Other Person', 'employee');
  insert into public.grants values ('${U.dhruv}', 'vendors', 'view'), ('${U.other}', 'vendors', 'view');
`)
await db.exec(extract(mig('20270305000000_exhibition_leads.sql'), 'normalize_lead_phone'))

// The migration under test, whole.
await db.exec(mig('20270425000000_vendor_management.sql'))
await db.exec(`
  grant select on all tables in schema public to authenticated;
  grant all on all tables in schema storage to authenticated;
  grant execute on all functions in schema public to authenticated;
`)

let checks = 0
const ok = (name) => { checks++; console.log(`  ok - ${name}`) }

async function as(uid, sql, params = []) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role authenticated;`)
  try { return await db.query(sql, params) } finally { await db.exec('reset role;') }
}
async function fails(uid, sql, params, pattern) {
  await assert.rejects(() => as(uid, sql, params), pattern)
}
const rpc = async (uid, fn, ...args) => {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const r = await as(uid, `select public.${fn}(${ph}) as r`, args)
  return r.rows[0].r
}

const sub = () => crypto.randomUUID()
const vendorBody = (over = {}) => ({
  company_name: 'Sharma Wood Works', contact_name: 'Ramesh Sharma', contact_designation: 'Owner',
  phone: '+919876543210', address: 'Plot 14, Basni Industrial Area, Phase 2', city: 'Jodhpur', state: 'Rajasthan',
  pincode: '342005', capabilities: ['raw_pieces', 'finishing_only'], categories: ['chairs', 'tables'],
  materials: 'Sheesham, mango wood', headcount: '35', monthly_capacity: '200 chairs a month', ...over,
})
const photoPath = uid => `${uid}/${crypto.randomUUID()}.jpg`
async function upload(uid, path) {
  await db.query(`insert into storage.objects (bucket_id, name, owner_id) values ('vendor-visit-photos', $1, $2)`, [path, uid])
}
function visitBody(photos, over = {}) {
  return {
    purpose: "first_meeting", person_met: "Ramesh Sharma", discussion: "Saw the workshop; they make solid wood chairs.",
    outcome: "interested", latitude: 26.2389, longitude: 73.0243, accuracy_m: 18, photos, ...over,
  }
}

// ── Registration and structure ─────────────────────────────────────────────
{
  const m = await db.query(`select module_key from public.app_modules where module_key = 'vendors'`)
  assert.equal(m.rows.length, 1)
  const a = await db.query(`select count(*)::int n from public.role_permissions r join public.permission_modules p on p.id = r.module_id where p.module_key = 'vendors' and r.role = 'admin' and r.allowed`)
  assert.equal(a.rows[0].n, 1)
  const b = await db.query(`select public from storage.buckets where id = 'vendor-visit-photos'`)
  assert.equal(b.rows[0].public, false)
  ok('module registered for Admin only; photo bucket is private')
}

// ── Access ─────────────────────────────────────────────────────────────────
await fails(U.nobody, `select public.vendor_list('{}'::jsonb)`, [], /VENDORS_FORBIDDEN/)
await fails(null, `select public.vendor_list('{}'::jsonb)`, [], /VENDORS_FORBIDDEN/)
await fails(U.nobody, `select public.save_vendor($1::uuid, null, $2::jsonb)`, [sub(), vendorBody()], /VENDORS_FORBIDDEN/)
ok('a person without the grant (or signed out) cannot read or write')

await fails(U.dhruv, `insert into public.vendors (submission_id, company_name, contact_name, phone_e164, address, city, capabilities, created_by)
  values (gen_random_uuid(), 'X', 'Y', '+919999999999', 'Somewhere far', 'Z', '{raw_pieces}', $1)`, [U.dhruv], /row-level security|permission denied/)
ok('a granted person cannot write the table directly')

const nobodyRead = await as(U.nobody, 'select count(*)::int n from public.vendors')
assert.equal(nobodyRead.rows[0].n, 0)
ok('the table shows nothing to a person without the grant')

// ── Creating vendors ───────────────────────────────────────────────────────
const s1 = sub()
const created = await rpc(U.dhruv, 'save_vendor', s1, null, vendorBody())
assert.equal(created.status, 'created')
const vendorId = created.id
const replay = await rpc(U.dhruv, 'save_vendor', s1, null, vendorBody())
assert.equal(replay.status, 'created'); assert.equal(replay.id, vendorId)
const count = await db.query('select count(*)::int n from public.vendors')
assert.equal(count.rows[0].n, 1)
ok('create is idempotent on the submission id')

const dup = await rpc(U.other, 'save_vendor', sub(), null, vendorBody({ company_name: 'Sharma Again', phone: '9876543210' }))
assert.equal(dup.status, 'duplicate'); assert.equal(dup.id, vendorId)
ok('the same mobile number (typed differently) reports the existing vendor instead of creating another')

await fails(U.dhruv, `select public.save_vendor($1::uuid, null, $2::jsonb)`, [sub(), vendorBody({ phone: '12345', company_name: 'Bad Phone' })], /VENDOR_INVALID: Mobile/)
await fails(U.dhruv, `select public.save_vendor($1::uuid, null, $2::jsonb)`, [sub(), vendorBody({ phone: '+919811111111', capabilities: [] })], /VENDOR_INVALID: choose at least 1/)
await fails(U.dhruv, `select public.save_vendor($1::uuid, null, $2::jsonb)`, [sub(), vendorBody({ phone: '+919811111111', address: 'abc' })], /VENDOR_INVALID: Address/)
await fails(U.dhruv, `select public.save_vendor($1::uuid, null, $2::jsonb)`, [sub(), vendorBody({ phone: '+919811111111', categories: ['spaceships'] })], /VENDOR_INVALID: Product types/)
ok('invalid phone, empty capability, short address and unknown product type are refused with a readable message')

// ── Visits ─────────────────────────────────────────────────────────────────
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([])], /at least one photograph/)
const pPerson = photoPath(U.dhruv)
await upload(U.dhruv, pPerson)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: pPerson, kind: 'person' }])], /first visit needs at least one photograph of the factory/)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: photoPath(U.dhruv), kind: 'factory' }])], /has not finished uploading/)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: photoPath(U.other), kind: 'factory' }])], /photograph is not valid/)
ok('a visit needs a photograph, a factory photograph the first time, uploaded, from the caller\'s own folder')

const pFactory = photoPath(U.dhruv)
await upload(U.dhruv, pFactory)
const v1s = sub()
const v1 = await rpc(U.dhruv, 'log_vendor_visit', v1s, vendorId, visitBody([{ path: pFactory, kind: 'factory' }, { path: pPerson, kind: 'person' }]))
assert.equal(v1.status, 'logged'); assert.equal(v1.location_source, 'gps')
assert.equal(v1.distance_m, null) // vendor had no pinned point yet
const pinned = await db.query('select latitude, longitude from public.vendors where id = $1', [vendorId])
assert.equal(Number(pinned.rows[0].latitude), 26.2389)
const v1replay = await rpc(U.dhruv, 'log_vendor_visit', v1s, vendorId, visitBody([{ path: pFactory, kind: 'factory' }]))
assert.equal(v1replay.status, 'replayed'); assert.equal(v1replay.id, v1.id)
ok('first visit saved, the vendor\'s address point is pinned from its GPS, and a retry returns the original')

const pF2 = photoPath(U.dhruv)
await upload(U.dhruv, pF2)
const near = await rpc(U.dhruv, 'log_vendor_visit', sub(), vendorId, visitBody([{ path: pF2, kind: 'product' }],
  { purpose: 'follow_up', latitude: 26.2392, longitude: 73.0246, outcome: 'sample_requested' }))
assert.ok(near.distance_m > 0 && near.distance_m < 100, 'about 45 m away, got ' + near.distance_m)
const pF3 = photoPath(U.dhruv)
await upload(U.dhruv, pF3)
const far = await rpc(U.dhruv, 'log_vendor_visit', sub(), vendorId, visitBody([{ path: pF3, kind: 'factory' }],
  { purpose: 'follow_up', latitude: 26.9124, longitude: 75.7873, outcome: 'interested' }))
assert.ok(far.distance_m > 250000, 'Jaipur is ~270 km from Jodhpur, got ' + far.distance_m)
const pF4 = photoPath(U.dhruv)
await upload(U.dhruv, pF4)
const noGps = await rpc(U.dhruv, 'log_vendor_visit', sub(), vendorId, visitBody([{ path: pF4, kind: 'factory' }],
  { latitude: null, longitude: null, accuracy_m: null, outcome: 'interested' }))
assert.equal(noGps.location_source, 'unavailable'); assert.equal(noGps.distance_m, null)
ok('distance from the vendor is computed on the server (near 45 m, far ~270 km); no GPS is recorded as unavailable')

const pF5 = photoPath(U.dhruv)
await upload(U.dhruv, pF5)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: pF5, kind: 'factory' }], { outcome: 'follow_up_needed' })], /date of the next follow-up/)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: pF5, kind: 'factory' }], { outcome: 'follow_up_needed', next_follow_up_on: '2020-01-01' })], /cannot be in the past/)
const fu = await rpc(U.dhruv, 'log_vendor_visit', sub(), vendorId, visitBody([{ path: pF5, kind: 'factory' }], { outcome: 'follow_up_needed', next_follow_up_on: '2099-01-01' }))
assert.equal(fu.status, 'logged')
ok('a follow-up outcome needs a future date')

// A photograph can be attached to only one visit.
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: pFactory, kind: 'factory' }])], /duplicate key|unique/)
ok('one photograph belongs to one visit')

// ── Visits are a record ────────────────────────────────────────────────────
await assert.rejects(() => db.query(`update public.vendor_visits set discussion = 'edited' where id = $1`, [v1.id]), /VENDOR_VISIT_IMMUTABLE/)
await assert.rejects(() => db.query(`delete from public.vendor_visits where id = $1`, [v1.id]), /VENDOR_VISIT_IMMUTABLE/)
await assert.rejects(() => db.query(`delete from public.vendor_visit_photos`), /VENDOR_VISIT_IMMUTABLE/)
ok('a visit and its photographs cannot be edited or deleted, even by a superuser')

// ── Reading ────────────────────────────────────────────────────────────────
await rpc(U.other, 'save_vendor', sub(), null, vendorBody({ company_name: 'Kumar Upholstery', contact_name: 'Anil Kumar', phone: '+919822222222', city: 'Jaipur', state: 'Rajasthan', capabilities: ['finished_pieces'], categories: ['sofa_upholstery'], materials: 'Fabric, foam, teak frames', headcount: '12' }))
await rpc(U.other, 'save_vendor', sub(), null, vendorBody({ company_name: 'Metal Craft', contact_name: 'Sohan', phone: '+919833333333', city: 'Jodhpur', capabilities: ['raw_pieces'], categories: ['metal_fabrication'], materials: 'MS, iron' }))

let list = await rpc(U.dhruv, 'vendor_list', { q: 'jodhpur' })
assert.equal(list.total, 2)
list = await rpc(U.dhruv, 'vendor_list', { q: 'teak jaipur' })
assert.equal(list.total, 1); assert.equal(list.rows[0].company_name, 'Kumar Upholstery')
list = await rpc(U.dhruv, 'vendor_list', { q: 'jaipur teak' })
assert.equal(list.total, 1)
list = await rpc(U.dhruv, 'vendor_list', { q: '98765' })
assert.equal(list.total, 1)
list = await rpc(U.dhruv, 'vendor_list', { q: 'nonexistent' })
assert.equal(list.total, 0)
ok('search finds by city, by several words in any order, by part of the phone number')

list = await rpc(U.dhruv, 'vendor_list', { capabilities: ['finished_pieces'] })
assert.equal(list.total, 1)
list = await rpc(U.dhruv, 'vendor_list', { categories: ['chairs'] })
assert.equal(list.total, 1)
list = await rpc(U.dhruv, 'vendor_list', {})
assert.equal(list.total, 3)
assert.equal(list.rows[0].company_name, 'Sharma Wood Works', 'most recently visited first')
assert.equal(list.rows[0].visit_count, 5)
assert.equal(list.rows[0].last_visited_by, 'Dhruv')
assert.equal(list.rows[0].days_since_visit, 0)
assert.equal(list.rows[2].visit_count, 0)
assert.equal(list.rows[2].days_since_visit, null)
list = await rpc(U.dhruv, 'vendor_list', { sort: 'name', limit: 2, offset: 1 })
assert.equal(list.rows.length, 2); assert.equal(list.total, 3)
ok('filters, ordering (recently visited first), visit counts and paging')

await rpc(U.admin, 'set_vendor_status', vendorId, 'approved')
list = await rpc(U.dhruv, 'vendor_list', { statuses: ['approved'] })
assert.equal(list.total, 1)
assert.equal(list.status_counts.approved, 1)
assert.equal(list.status_counts.prospect, 2, 'tabs show their counts even while one status is selected')
list = await rpc(U.dhruv, 'vendor_list', { q: 'jaipur', statuses: ['approved'] })
assert.equal(list.total, 0)
assert.equal(list.status_counts.prospect, 1, 'counts follow the search')
ok('status tabs: counts under the current search, filter applied after the counts')

await fails(U.dhruv, `select public.set_vendor_status($1::uuid, 'rejected')`, [vendorId], /Admin only/)
await fails(U.dhruv, `select public.archive_vendor($1::uuid, 'no longer needed')`, [vendorId], /Admin only/)
await fails(U.dhruv, `select public.vendor_list('{"archived": true}'::jsonb)`, [], /Admin only/)
await fails(U.dhruv, `select public.vendor_activity(null, null)`, [], /Admin only/)
ok('status change, archive, archived list and the activity report are Admin only')

const detail = await rpc(U.dhruv, 'get_vendor', vendorId)
assert.equal(detail.vendor.company_name, 'Sharma Wood Works')
assert.equal(detail.vendor.status, 'approved')
assert.equal(detail.visits.length, 5)
assert.equal(detail.visits[0].visited_by_name, 'Dhruv')
const firstVisit = detail.visits.find(v => v.id === v1.id)
assert.equal(firstVisit.photos.length, 2)
ok('vendor detail returns the profile and every visit with its photographs, newest first')

// ── Editing and archiving ──────────────────────────────────────────────────
const edited = await rpc(U.other, 'save_vendor', sub(), vendorId, vendorBody({ headcount: '40', notes: 'Added a second shed' }))
assert.equal(edited.status, 'saved')
await fails(U.other, `select public.save_vendor($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, vendorBody({ phone: '+919822222222' })], /VENDOR_DUPLICATE_PHONE/)
const afterEdit = await db.query('select headcount, latitude from public.vendors where id = $1', [vendorId])
assert.equal(afterEdit.rows[0].headcount, 40)
assert.equal(Number(afterEdit.rows[0].latitude), 26.2389, 'an edit without a location leaves the pin')
ok('edit updates the profile, keeps the pin, refuses another vendor\'s number')

const act = await rpc(U.admin, 'vendor_activity', null, null)
assert.equal(act.totals.visits, 5)
assert.equal(act.totals.vendors_visited, 1)
assert.equal(act.totals.no_location, 1)
assert.equal(act.totals.at_site, 2, 'the pin-setting visit has no distance; the 45 m visit is at the site; the 270 km one is not; and the no-GPS one is not')
assert.equal(act.by_person.length, 1)
assert.equal(act.by_person[0].name, 'Dhruv')
assert.equal(act.by_person[0].repeat_visits, 4)
assert.equal(act.by_person[0].vendors_added, 1)
assert.ok(act.quiet_vendors.some(q => q.company_name === 'Metal Craft' && q.days_since_visit === null), 'never-visited live vendors are listed as quiet')
assert.ok(act.follow_ups_due.length === 0, 'the follow-up date is far in the future')
ok('activity: totals, per-person visits/repeat/at-site/no-location, quiet vendors')

await rpc(U.admin, 'archive_vendor', vendorId, 'Closed down')
list = await rpc(U.dhruv, 'vendor_list', {})
assert.equal(list.total, 2)
const archivedList = await rpc(U.admin, 'vendor_list', { archived: true })
assert.equal(archivedList.total, 1)
await fails(U.dhruv, `select public.get_vendor($1::uuid)`, [vendorId], /VENDOR_NOT_FOUND/)
await fails(U.dhruv, `select public.log_vendor_visit($1::uuid, $2::uuid, $3::jsonb)`, [sub(), vendorId, visitBody([{ path: pPerson, kind: 'factory' }])], /VENDOR_ARCHIVED/)
const free = await rpc(U.dhruv, 'save_vendor', sub(), null, vendorBody({ company_name: 'Sharma New Firm' }))
assert.equal(free.status, 'created', 'archiving frees the mobile number')
await fails(U.admin, `select public.restore_vendor($1::uuid)`, [vendorId], /VENDOR_DUPLICATE_PHONE/)
ok('archive hides the vendor from non-admins, blocks visits, frees the number; restore re-checks it')

// ── Photographs (storage policies) ─────────────────────────────────────────
const canUp = await as(U.dhruv, `select public.vendor_photo_can_upload($1) a, public.vendor_photo_can_upload($2) b, public.vendor_photo_can_upload($3) c`,
  [photoPath(U.dhruv), photoPath(U.other), `${U.dhruv}/not-a-uuid.jpg`])
assert.deepEqual(canUp.rows[0], { a: true, b: false, c: false })
const nobodyUp = await as(U.nobody, `select public.vendor_photo_can_upload($1) a`, [photoPath(U.nobody)])
assert.equal(nobodyUp.rows[0].a, false)
const readAttached = await as(U.other, `select public.vendor_photo_readable($1, $2) a`, [pFactory, U.dhruv])
assert.equal(readAttached.rows[0].a, true, 'a module user can see an attached visit photograph')
const orphan = photoPath(U.dhruv)
const readOrphanOther = await as(U.other, `select public.vendor_photo_readable($1, $2) a`, [orphan, U.dhruv])
assert.equal(readOrphanOther.rows[0].a, false, 'an unattached upload is visible only to its uploader')
const readNobody = await as(U.nobody, `select public.vendor_photo_readable($1, $2) a`, [pFactory, U.dhruv])
assert.equal(readNobody.rows[0].a, false)
ok('photograph upload is limited to your own folder and uuid names; reading follows module access')

console.log(`all ${checks} checks passed`)
