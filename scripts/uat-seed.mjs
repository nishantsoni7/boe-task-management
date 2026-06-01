/**
 * UAT SEED SCRIPT — BOE Task Management
 * Creates 12 dummy users, 100 tasks, and 150+ activity logs.
 * All records tagged [TEST-UAT].
 *
 * Run: node scripts/uat-seed.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://albnsrohngkljfsrrrhf.supabase.co'
const SERVICE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsYm5zcm9obmdrbGpmc3JycmhmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTI4MDk2MywiZXhwIjoyMDk0ODU2OTYzfQ.pNOzEyuqTAYaCRd1Fa1TMdJFW8YVgfNrq07PHq3GGMA'

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const UAT_PASSWORD = 'UATTest@2026'

// ─── Test Users ───────────────────────────────────────────────────────────────
const TEST_USERS = [
  { full_name: '[TEST-UAT] Nishant Owner',          email: 'uat.nishant@boe-test.com',     role: 'admin',   team: 'management',  position: 'Owner' },
  { full_name: '[TEST-UAT] Dhruv BDM',              email: 'uat.dhruv@boe-test.com',       role: 'manager', team: 'bdm',         position: 'Business Development Manager' },
  { full_name: '[TEST-UAT] Ashok Sales Manager',    email: 'uat.ashok@boe-test.com',       role: 'manager', team: 'sales',       position: 'Sales Manager' },
  { full_name: '[TEST-UAT] Mohit Sales Manager',    email: 'uat.mohit@boe-test.com',       role: 'manager', team: 'sales',       position: 'Sales Manager' },
  { full_name: '[TEST-UAT] Prerna Sales Executive', email: 'uat.prerna@boe-test.com',      role: 'member',  team: 'sales',       position: 'Sales Executive' },
  { full_name: '[TEST-UAT] Rohit Sales Executive',  email: 'uat.rohit@boe-test.com',       role: 'member',  team: 'sales',       position: 'Sales Executive' },
  { full_name: '[TEST-UAT] Karan Sales Executive',  email: 'uat.karan@boe-test.com',       role: 'member',  team: 'sales',       position: 'Sales Executive' },
  { full_name: '[TEST-UAT] Aditya After Sales',     email: 'uat.aditya@boe-test.com',      role: 'member',  team: 'sales',       position: 'After Sales Executive' },
  { full_name: '[TEST-UAT] Production Coord',       email: 'uat.production@boe-test.com',  role: 'member',  team: 'operations',  position: 'Production Coordinator' },
  { full_name: '[TEST-UAT] Procurement Coord',      email: 'uat.procurement@boe-test.com', role: 'member',  team: 'purchase',    position: 'Procurement Coordinator' },
  { full_name: '[TEST-UAT] Accounts Executive',     email: 'uat.accounts@boe-test.com',    role: 'member',  team: 'management',  position: 'Accounts Executive' },
  { full_name: '[TEST-UAT] Dispatch Coord',         email: 'uat.dispatch@boe-test.com',    role: 'member',  team: 'operations',  position: 'Dispatch Coordinator' },
]

// ─── Date helpers ─────────────────────────────────────────────────────────────
const d = (offset) => {
  const dt = new Date()
  dt.setDate(dt.getDate() + offset)
  return dt.toISOString().split('T')[0]
}
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString()

// ─── Activity update notes pool ───────────────────────────────────────────────
const UPDATES = [
  'Customer called, asked for revised quote by tomorrow',
  'Waiting for architect approval — expected in 2 days',
  'Sample approved by client, proceeding with full order',
  'Material ordered from vendor, delivery expected Thursday',
  'Production started, estimated completion in 3 days',
  'Dispatch delayed by one day due to transporter issue',
  'Payment reminder sent via WhatsApp and email',
  'Client confirmed payment by this evening',
  'Site carpenter assigned, visit scheduled for tomorrow morning',
  'Vendor promised delivery by evening today',
  'Spoke with GM, they are reviewing the quotation internally',
  'Fabric colour confirmation pending from architect',
  'QC done, batch approved for dispatch',
  'Contacted client 3 times, no response — escalating',
  'Client requested to extend due date by 2 days',
  'Order confirmed, preparing PI now',
  'Follow-up done, client said decision expected by Friday',
  'Material received, quality check in progress',
  'Production 60% complete, on track for deadline',
  'Delivery challan prepared, loading starts tomorrow',
  'Client happy with sample, placing order for 20 units',
  'Minor rework needed on 3 chairs before dispatch',
  'Transporter confirmed vehicle for Thursday',
  'Invoice sent, awaiting payment confirmation',
  'Reminder sent for overdue balance payment',
  'Client asked for discount, escalating to manager',
  'Design finalised after 2 rounds of revision',
  'Packing done, ready for dispatch',
  'Partial payment received, balance follow-up ongoing',
  'Complaint documented, repair team dispatched',
]

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

// ─── Build task definitions ───────────────────────────────────────────────────
// u: update count, urgent, ack, status, due
function buildTasks(ids) {
  const { nishant, dhruv, ashok, mohit, prerna, rohit, karan, aditya,
          production, procurement, accounts, dispatch } = ids

  // team mapping: normalize custom teams to valid enum values
  const TEAM_MAP = {
    after_sales: 'sales', production: 'operations', procurement: 'purchase',
    accounts: 'management', dispatch: 'operations',
  }
  const normTeam = (tm) => TEAM_MAP[tm] || tm

  const t = (title, assignee, creator, { p='medium', type='completion', team='sales',
             due=1, urgent=false, ack=false, updates=0, status='pending' } = {}) => ({
    title:          `[TEST-UAT] ${title}`,
    note:           null,
    status,
    priority:       p,
    type,
    is_urgent:      urgent,
    due_date:       d(due),
    assigned_to:    assignee,
    created_by:     creator,
    team:           normTeam(team),
    delegated_by:   null,
    blocker_reason: null,
    acknowledged_at: ack ? hoursAgo(8) : null,
    last_update_at:  updates > 0 ? hoursAgo(updates * 4) : new Date().toISOString(),
    _updates: updates, // stripped before insert
  })

  return [
    // ── SALES (30) ──────────────────────────────────────────────────────────
    t('Follow up with Treebo Hotel for chair approval',            prerna, dhruv,    { p:'high',   due:0,  urgent:true,  ack:true,  updates:2 }),
    t('Send revised quotation to brewery client in Pune',          rohit,  ashok,    { p:'high',   due:1,  ack:true,     updates:5 }),
    t('Confirm fabric approval from interior architect',           karan,  ashok,    { p:'medium', due:2,  ack:true,     updates:10 }),
    t('Send product catalogue to Noida resort client',             prerna, dhruv,    { p:'low',    due:3  }),
    t('Follow up on quotation sent to Bangalore cafe chain',       rohit,  mohit,    { p:'high',   due:-1, urgent:true,  ack:true  }),
    t('Prepare PI for Mumbai restaurant furniture order',          karan,  ashok,    { p:'high',   due:0,  ack:true,     updates:1 }),
    t('Confirm chair model selection from resort GM',              prerna, dhruv,    { p:'medium', due:2  }),
    t('Send upholstery sample to Delhi hotel client',              rohit,  mohit,    { p:'medium', due:1,  ack:true,     updates:4 }),
    t('Follow up with Jaipur hotel for repeat order',              karan,  ashok,    { p:'low',    due:4  }),
    t('Get approval on revised sofa design from architect',        prerna, dhruv,    { p:'high',   due:0,  urgent:true,  ack:true,  updates:3 }),
    t('Share product video with Hyderabad restaurant client',      rohit,  mohit,    { p:'low',    due:5  }),
    t('Confirm order size with Gujarat resort before PI',          karan,  ashok,    { p:'medium', due:2,  ack:true }),
    t('Get site dimensions from Chandigarh hotel',                 prerna, dhruv,    { p:'medium', due:1  }),
    t('Send revised payment terms to Lucknow client',              rohit,  ashok,    { p:'high',   due:0,  ack:true,     updates:2 }),
    t('Follow up for PO confirmation from Pune brewery',           karan,  mohit,    { p:'high',   due:-2, urgent:true,  ack:true  }),
    t('Share cane furniture collection to eco-resort client',      prerna, dhruv,    { p:'low',    due:6  }),
    t('Confirm outdoor chair count for Goa resort order',          rohit,  ashok,    { p:'medium', due:2,  ack:true,     updates:8 }),
    t('Send technical spec sheet to project architect',            karan,  dhruv,    { p:'medium', due:3  }),
    t('Get written approval on sofa fabric from hotel GM',         prerna, mohit,    { p:'high',   due:1,  urgent:true,  ack:true,  updates:1 }),
    t('Update CRM notes for Rajasthan resort meeting',             rohit,  ashok,    { p:'low',    due:5  }),
    t('Share product brochure to new Kolkata lead',                karan,  dhruv,    { p:'low',    due:7  }),
    t('Send quotation for 50 dining chairs to Indore hotel',       prerna, ashok,    { p:'medium', due:1,  ack:true }),
    t('Follow up with Mumbai coworking space for lounge chairs',   rohit,  mohit,    { p:'medium', due:2,  ack:true,     updates:6 }),
    t('Confirm delivery address for Hyderabad order',              karan,  ashok,    { p:'medium', due:0,  ack:true,     updates:3 }),
    t('Send revised quotation after fabric price revision',        prerna, dhruv,    { p:'high',   due:-1, urgent:true,  ack:true  }),
    t('Follow up on trial order feedback from Agra resort',        rohit,  ashok,    { p:'medium', due:3  }),
    t('Get confirmation on pool chairs from Goa client',           karan,  mohit,    { p:'medium', due:2,  ack:true }),
    t('Share updated price list with all active clients',          prerna, nishant,  { p:'high',   due:0,  urgent:true,  ack:true,  updates:1 }),
    t('Send order status update to Bhopal hotel client',           rohit,  ashok,    { p:'low',    due:4  }),
    t('Follow up for balance payment from Surat restaurant',       karan,  mohit,    { p:'high',   due:-3, urgent:true,  ack:true  }),

    // ── PRODUCTION (20) ─────────────────────────────────────────────────────
    t('Check production status for 40 outdoor chairs — Goa order',   production, nishant,    { p:'high',   team:'production', due:1,  urgent:true, ack:true,  updates:3 }),
    t('Confirm frame welding complete for Treebo order',              production, dhruv,      { p:'high',   team:'production', due:0,  ack:true,    updates:2 }),
    t('Start production for 20 dining chairs — Mumbai restaurant',    production, ashok,      { p:'medium', team:'production', due:3,  ack:true }),
    t('QC check on sofa batch before dispatch',                       production, nishant,    { p:'high',   team:'production', due:0,  urgent:true, ack:true,  updates:5 }),
    t('Coordinate with carpenter for site repair — Jaipur hotel',     production, aditya,     { p:'medium', team:'production', due:2,  ack:true }),
    t('Prepare production schedule for August hotel orders',          production, nishant,    { p:'medium', team:'production', due:5  }),
    t('Complete upholstery for 15 chairs — Pune brewery',             production, ashok,      { p:'high',   team:'production', due:1,  ack:true,    updates:4 }),
    t('Finish lacquer coating on outdoor bench set',                  production, mohit,      { p:'medium', team:'production', due:2,  ack:true }),
    t('Resolve warping issue in teak wood batch',                     production, nishant,    { p:'high',   team:'production', due:0,  urgent:true, ack:true,  updates:6 }),
    t('Cut and prepare cane frames for resort order',                 production, procurement,{ p:'medium', team:'production', due:3  }),
    t('Assemble 30 bar stools for Bangalore cafe chain',              production, ashok,      { p:'high',   team:'production', due:1,  ack:true,    updates:2 }),
    t('Inspect incoming fabric roll quality before use',              production, procurement,{ p:'medium', team:'production', due:0,  ack:true }),
    t('Repair damaged sample chair sent back from client',            production, aditya,     { p:'low',    team:'production', due:4  }),
    t('Pack and wrap Mumbai restaurant order — 20 chairs',            production, dispatch,   { p:'high',   team:'production', due:0,  urgent:true, ack:true,  updates:3 }),
    t('Complete prototype for new lounge chair design',               production, nishant,    { p:'medium', team:'production', due:7  }),
    t('Finish steel frame powder coating — Delhi hotel order',        production, ashok,      { p:'high',   team:'production', due:1,  ack:true,    updates:1 }),
    t('Verify chair count against PI before dispatch',                production, dispatch,   { p:'high',   team:'production', due:0,  ack:true,    updates:4 }),
    t('Sand and polish teak table tops — Goa resort',                 production, mohit,      { p:'medium', team:'production', due:2  }),
    t('Set up production jig for new outdoor bench model',            production, nishant,    { p:'low',    team:'production', due:10 }),
    t('Document QC checklist for resort furniture batch',             production, nishant,    { p:'low',    team:'production', due:6  }),

    // ── PROCUREMENT (15) ────────────────────────────────────────────────────
    t('Follow up with vendor for cane material delivery',        procurement, nishant,    { p:'high',   team:'procurement', due:0,  urgent:true, ack:true,  updates:3 }),
    t('Order 200m upholstery fabric for August production',      procurement, production, { p:'high',   team:'procurement', due:1,  ack:true,    updates:2 }),
    t('Get price comparison for teak wood — 3 vendors',          procurement, nishant,    { p:'medium', team:'procurement', due:2,  ack:true }),
    t('Confirm steel pipe delivery for July orders',             procurement, production, { p:'high',   team:'procurement', due:-1, urgent:true, ack:true }),
    t('Place order for foam and padding material',               procurement, production, { p:'medium', team:'procurement', due:1,  ack:true,    updates:5 }),
    t('Check stock level of outdoor coating material',           procurement, nishant,    { p:'medium', team:'procurement', due:0  }),
    t('Negotiate rate for bulk cane order — new vendor',         procurement, nishant,    { p:'medium', team:'procurement', due:3  }),
    t('Confirm powder coat vendor capacity for next month',      procurement, production, { p:'medium', team:'procurement', due:2,  ack:true }),
    t('Purchase 50 units of SS hardware for outdoor chairs',     procurement, production, { p:'high',   team:'procurement', due:1,  ack:true,    updates:1 }),
    t('Verify GST invoice from fabric supplier',                 procurement, accounts,   { p:'medium', team:'procurement', due:0,  ack:true }),
    t('Place emergency order for UV-resistant thread',           procurement, production, { p:'high',   team:'procurement', due:0,  urgent:true, ack:true,  updates:4 }),
    t('Get sample of new rattan weave from supplier',            procurement, nishant,    { p:'low',    team:'procurement', due:5  }),
    t('Update vendor contact list for 2026',                     procurement, nishant,    { p:'low',    team:'procurement', due:7  }),
    t('Clear outstanding payment to foam vendor',                procurement, accounts,   { p:'high',   team:'procurement', due:0,  urgent:true, ack:true,  updates:2 }),
    t('Confirm delivery timeline for wood veneer order',         procurement, production, { p:'medium', team:'procurement', due:2,  ack:true }),

    // ── ACCOUNTS (15) ───────────────────────────────────────────────────────
    t('Send payment reminder to Treebo Hotel — 2nd installment',     accounts, nishant,  { p:'high',   team:'accounts', due:0,  urgent:true, ack:true,  updates:3 }),
    t('Collect payment update from Pune brewery client',             accounts, dhruv,    { p:'high',   team:'accounts', due:1,  ack:true,    updates:2 }),
    t('Send GST invoice to Mumbai restaurant after delivery',        accounts, dispatch, { p:'high',   team:'accounts', due:0,  ack:true,    updates:1 }),
    t('Follow up on outstanding amount from Surat restaurant',       accounts, nishant,  { p:'high',   team:'accounts', due:-2, urgent:true, ack:true }),
    t('Reconcile July bank statement against received payments',     accounts, nishant,  { p:'medium', team:'accounts', due:2,  ack:true }),
    t('Send proforma invoice to Goa resort for advance payment',     accounts, ashok,    { p:'medium', team:'accounts', due:1,  ack:true,    updates:4 }),
    t('Verify advance payment receipt from Delhi hotel',             accounts, nishant,  { p:'high',   team:'accounts', due:0,  ack:true,    updates:2 }),
    t('Prepare TDS calculation for July vendor payments',            accounts, nishant,  { p:'medium', team:'accounts', due:3  }),
    t('Send payment follow-up to Bhopal hotel — 30 day overdue',     accounts, dhruv,    { p:'high',   team:'accounts', due:-3, urgent:true, ack:true }),
    t('Generate monthly outstanding report for MD review',           accounts, nishant,  { p:'high',   team:'accounts', due:1,  ack:true,    updates:5 }),
    t('Clear advance to carpenter for site visit — Jaipur',          accounts, aditya,   { p:'medium', team:'accounts', due:0,  ack:true }),
    t('Update payment status in records after Hyderabad receipt',    accounts, nishant,  { p:'low',    team:'accounts', due:2  }),
    t('Prepare expense summary for owner review',                    accounts, nishant,  { p:'medium', team:'accounts', due:4  }),
    t('Send credit note to Jaipur client for returned item',         accounts, nishant,  { p:'medium', team:'accounts', due:2,  ack:true }),
    t('Follow up with Chandigarh client for balance payment',        accounts, mohit,    { p:'high',   team:'accounts', due:0,  urgent:true, ack:true,  updates:3 }),

    // ── AFTER SALES (10) ────────────────────────────────────────────────────
    t('Coordinate site repair for damaged chair — Jaipur hotel',    aditya, nishant, { p:'high',   team:'after_sales', due:0,  urgent:true, ack:true, updates:4 }),
    t('Follow up with Treebo Hotel post-delivery satisfaction',     aditya, dhruv,   { p:'medium', team:'after_sales', due:2,  ack:true }),
    t('Arrange replacement for warped table — Pune cafe',           aditya, ashok,   { p:'high',   team:'after_sales', due:1,  ack:true,    updates:2 }),
    t('Collect feedback from Mumbai restaurant after installation',  aditya, mohit,   { p:'medium', team:'after_sales', due:3  }),
    t('Schedule warranty repair visit to Delhi hotel',              aditya, nishant, { p:'medium', team:'after_sales', due:2,  ack:true }),
    t('Document client complaint re fabric peeling — Goa resort',   aditya, nishant, { p:'high',   team:'after_sales', due:0,  urgent:true, ack:true, updates:6 }),
    t('Send repair update to Hyderabad client after visit',         aditya, ashok,   { p:'medium', team:'after_sales', due:1,  ack:true }),
    t('Follow up on unresolved complaint from Bangalore resort',    aditya, dhruv,   { p:'high',   team:'after_sales', due:-1, urgent:true, ack:true }),
    t('Coordinate carpenter visit to Gujarat hotel for repair',     aditya, nishant, { p:'medium', team:'after_sales', due:3  }),
    t('Collect signed satisfaction form from Indore hotel',         aditya, mohit,   { p:'low',    team:'after_sales', due:5  }),

    // ── DISPATCH (10) ────────────────────────────────────────────────────────
    t('Confirm dispatch schedule for Mumbai restaurant order',      dispatch, nishant,    { p:'high',   team:'dispatch', due:0,  urgent:true, ack:true, updates:3 }),
    t('Confirm packing list for export shipment — Dubai resort',    dispatch, nishant,    { p:'high',   team:'dispatch', due:1,  ack:true,    updates:2 }),
    t('Arrange transport for Goa resort delivery — 40 chairs',      dispatch, ashok,      { p:'high',   team:'dispatch', due:0,  urgent:true, ack:true, updates:5 }),
    t('Coordinate loading and packaging for Pune brewery order',    dispatch, production, { p:'medium', team:'dispatch', due:1,  ack:true }),
    t('Send dispatch confirmation to Delhi hotel with tracking',    dispatch, mohit,      { p:'medium', team:'dispatch', due:0,  ack:true,    updates:1 }),
    t('Verify delivery challan for Hyderabad shipment',             dispatch, accounts,   { p:'medium', team:'dispatch', due:2,  ack:true }),
    t('Repack damaged chairs before Bangalore dispatch',            dispatch, production, { p:'high',   team:'dispatch', due:0,  urgent:true, ack:true, updates:4 }),
    t('Update dispatch log for all July deliveries',                dispatch, nishant,    { p:'medium', team:'dispatch', due:2  }),
    t('Coordinate with transporter for Rajasthan delivery route',   dispatch, nishant,    { p:'medium', team:'dispatch', due:3  }),
    t('Confirm receiver availability for Chandigarh delivery',      dispatch, ashok,      { p:'low',    team:'dispatch', due:4,  ack:true }),
  ]
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 BOE UAT Seed Starting...\n')

  // ── Step 1: Create / find users ───────────────────────────────────────────
  console.log('Step 1: Creating test users...')
  const createdUsers = []

  for (const user of TEST_USERS) {
    const { data: existing } = await sb.from('users').select('id').eq('email', user.email).single()

    if (existing) {
      console.log(`  ⏭  Exists: ${user.full_name}`)
      createdUsers.push({ ...user, id: existing.id })
      continue
    }

    const { data: authData, error: authErr } = await sb.auth.admin.createUser({
      email: user.email,
      password: UAT_PASSWORD,
      email_confirm: true,
    })

    if (authErr || !authData?.user) {
      console.error(`  ❌ Auth: ${user.full_name} — ${authErr?.message}`)
      continue
    }

    const { error: dbErr } = await sb.from('users').insert({
      id:        authData.user.id,
      full_name: user.full_name,
      email:     user.email,
      phone:     null,
      role:      user.role,
      team:      user.team,
      position:  user.position,
      is_active: true,
    })

    if (dbErr) {
      console.error(`  ❌ DB: ${user.full_name} — ${dbErr.message}`)
      continue
    }

    console.log(`  ✅ Created: ${user.full_name}`)
    createdUsers.push({ ...user, id: authData.user.id })
  }

  console.log(`\n  ${createdUsers.length} users ready.\n`)

  // ── Step 2: Build user id map ─────────────────────────────────────────────
  const find = (keyword) => createdUsers.find(u => u.full_name.includes(keyword))?.id
  const ids = {
    nishant:    find('Nishant'),
    dhruv:      find('Dhruv'),
    ashok:      find('Ashok'),
    mohit:      find('Mohit'),
    prerna:     find('Prerna'),
    rohit:      find('Rohit'),
    karan:      find('Karan'),
    aditya:     find('Aditya'),
    production: find('Production'),
    procurement:find('Procurement'),
    accounts:   find('Accounts'),
    dispatch:   find('Dispatch'),
  }

  // ── Step 3: Create tasks ──────────────────────────────────────────────────
  console.log('Step 2: Creating tasks...')
  const taskDefs = buildTasks(ids)
  const valid    = taskDefs.filter(t => t.assigned_to && t.created_by)

  if (valid.length < taskDefs.length) {
    console.warn(`  ⚠  ${taskDefs.length - valid.length} tasks skipped (missing user id)`)
  }

  const inserted = []

  for (const def of valid) {
    const { _updates, ...row } = def  // strip metadata field

    const { data, error } = await sb.from('tasks').insert(row).select('id').single()

    if (error) {
      console.error(`  ❌ Task: "${def.title}" — ${error.message}`)
    } else {
      inserted.push({ id: data.id, def })
    }
  }

  console.log(`  ✅ ${inserted.length} tasks created.\n`)

  // ── Step 4: Activity logs ─────────────────────────────────────────────────
  console.log('Step 3: Adding activity logs...')
  let logCount = 0

  for (const { id, def } of inserted) {
    // "created" log for every task
    await sb.from('task_activity_log').insert({
      task_id:  id,
      actor_id: def.created_by,
      action:   'created',
      note:     'Task created and assigned',
    })
    logCount++

    // Update logs based on _updates count
    const n = def._updates || 0
    for (let i = 0; i < n; i++) {
      const note = pick(UPDATES)
      const ageHours = (n - i) * 6 + Math.floor(Math.random() * 4)

      await sb.from('task_activity_log').insert({
        task_id:     id,
        actor_id:    def.assigned_to,
        action:      'updated',
        note,
        from_status: i === 0 ? 'pending' : null,
        to_status:   null,
        created_at:  hoursAgo(ageHours),
      })
      logCount++
    }
  }

  // Mark every 7th task as completed
  const toComplete = inserted.filter((_, i) => i % 7 === 0)
  for (const { id, def } of toComplete) {
    await sb.from('tasks').update({
      status:         'completed',
      last_update_at: new Date().toISOString(),
    }).eq('id', id)

    await sb.from('task_activity_log').insert({
      task_id:     id,
      actor_id:    def.assigned_to,
      action:      'completed',
      note:        'Task marked as completed',
      from_status: def.status,
      to_status:   'completed',
    })
    logCount++
  }

  // Mark some as working / waiting / blocked
  const completedIds = new Set(toComplete.map(x => x.id))
  const remaining    = inserted.filter(x => !completedIds.has(x.id))

  const patches = [
    { status: 'working',  slice: [0, 12] },
    { status: 'waiting',  slice: [12, 18] },
    { status: 'blocked',  slice: [18, 22] },
    { status: 'started',  slice: [22, 30] },
  ]

  for (const { status, slice } of patches) {
    for (const { id, def } of remaining.slice(...slice)) {
      await sb.from('tasks').update({ status, last_update_at: new Date().toISOString() }).eq('id', id)
      await sb.from('task_activity_log').insert({
        task_id:     id,
        actor_id:    def.assigned_to,
        action:      'status_changed',
        note:        `Status updated to ${status}`,
        from_status: 'pending',
        to_status:   status,
      })
      logCount++
    }
  }

  console.log(`  ✅ ${logCount} activity log entries added.\n`)

  // ── Final summary ─────────────────────────────────────────────────────────
  const completed = toComplete.length
  const working   = patches.find(p => p.status === 'working')
  const nWorking  = (working.slice[1] - working.slice[0])

  console.log('═══════════════════════════════════════════════')
  console.log('  UAT SEED COMPLETE')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Test users created  : ${createdUsers.length}`)
  console.log(`  Tasks created       : ${inserted.length}`)
  console.log(`  Tasks completed     : ${completed}`)
  console.log(`  Tasks set working   : ${nWorking}`)
  console.log(`  Activity logs added : ${logCount}`)
  console.log(`  Test password       : ${UAT_PASSWORD}`)
  console.log('═══════════════════════════════════════════════')
  console.log('\nLogin credentials:')
  for (const u of createdUsers) {
    console.log(`  ${u.role.padEnd(8)} | ${u.email.padEnd(34)} | ${UAT_PASSWORD}`)
  }
  console.log('\n⚠  Remember to clean up with: node scripts/uat-cleanup.mjs\n')
}

main().catch(console.error)
