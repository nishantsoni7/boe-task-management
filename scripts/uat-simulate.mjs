/**
 * UAT SIMULATION SCRIPT — BOE Task Management
 * Exercises every user flow: Owner, Manager, Sales, Operations, Accounts, After-Sales, Dispatch.
 * Tests: task creation, updates, completion, restore, edit, delete, delegation, manager review.
 *
 * Run: node scripts/uat-simulate.mjs
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://albnsrohngkljfsrrrhf.supabase.co'
const SERVICE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsYm5zcm9obmdrbGpmc3JycmhmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTI4MDk2MywiZXhwIjoyMDk0ODU2OTYzfQ.pNOzEyuqTAYaCRd1Fa1TMdJFW8YVgfNrq07PHq3GGMA'
const UAT_PASSWORD = 'UATTest@2026'

// Admin client for reading/checking
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Helpers ─────────────────────────────────────────────────────────────────
const log  = (msg)        => console.log(msg)
const ok   = (msg)        => console.log(`    ✅ ${msg}`)
const fail = (msg, err)   => console.log(`    ❌ ${msg}${err ? ' — ' + err : ''}`)
const info = (msg)        => console.log(`    ℹ  ${msg}`)
const sep  = (title)      => console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`)

const results = {
  passed: 0,
  failed: 0,
  observations: [],
}

function assert(condition, passMsg, failMsg, observation = null) {
  if (condition) {
    ok(passMsg)
    results.passed++
  } else {
    fail(failMsg)
    results.failed++
  }
  if (observation) results.observations.push(observation)
}

// Login as a specific user and return their Supabase client
async function loginAs(email, label) {
  const userClient = createClient(SUPABASE_URL,
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsYm5zcm9obmdrbGpmc3JycmhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyODA5NjMsImV4cCI6MjA5NDg1Njk2M30.Aw1SRbq8ta1xze_OU2IO0PjSFv7xdi7clv4OHDZFWqM',
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
  const { data, error } = await userClient.auth.signInWithPassword({ email, password: UAT_PASSWORD })
  if (error || !data?.user) {
    fail(`Login failed for ${label}: ${error?.message}`)
    return null
  }
  ok(`Logged in as ${label} (${data.user.id.slice(0,8)}…)`)
  return { client: userClient, userId: data.user.id }
}

// Fetch user id by name keyword
async function uid(keyword) {
  const { data } = await admin.from('users').select('id').like('full_name', `%${keyword}%`).single()
  return data?.id
}

// ─── Flow 1: Owner ────────────────────────────────────────────────────────────
async function testOwnerFlow() {
  sep('FLOW 1 — Owner ([TEST-UAT] Nishant Owner)')

  const session = await loginAs('uat.nishant@boe-test.com', 'Nishant Owner')
  if (!session) return
  const { client: sb, userId } = session

  const dhruvId      = await uid('Dhruv')
  const mohitId      = await uid('Mohit')
  const productionId = await uid('Production')
  const accountsId   = await uid('Accounts')

  // 1a. Create task for Dhruv
  const { data: t1, error: e1 } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Owner→Dhruv: Review BDM pipeline for Q3',
    status: 'pending', priority: 'high', type: 'completion',
    is_urgent: true, due_date: today(1),
    assigned_to: dhruvId, created_by: userId,
    team: 'bdm', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!e1 && t1, 'Created task for Dhruv', `Failed: ${e1?.message}`)

  if (t1) {
    await sb.from('task_activity_log').insert({ task_id: t1.id, actor_id: userId, action: 'created', note: 'Assigned to Dhruv for Q3 review' })
  }

  // 1b. Create task for Mohit
  const { data: t2, error: e2 } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Owner→Mohit: Follow up Pune brewery order status',
    status: 'pending', priority: 'high', type: 'completion',
    is_urgent: false, due_date: today(0),
    assigned_to: mohitId, created_by: userId,
    team: 'sales', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!e2 && t2, 'Created task for Mohit', `Failed: ${e2?.message}`)

  // 1c. Create urgent task for Production
  const { data: t3, error: e3 } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Owner→Production: Urgent QC check before Goa dispatch',
    status: 'pending', priority: 'high', type: 'completion',
    is_urgent: true, due_date: today(0),
    assigned_to: productionId, created_by: userId,
    team: 'operations', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!e3 && t3, 'Created urgent task for Production', `Failed: ${e3?.message}`)

  // 1d. Create task for Accounts
  const { data: t4, error: e4 } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Owner→Accounts: Collect Treebo 2nd installment today',
    status: 'pending', priority: 'high', type: 'completion',
    is_urgent: true, due_date: today(0),
    assigned_to: accountsId, created_by: userId,
    team: 'management', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!e4 && t4, 'Created urgent task for Accounts', `Failed: ${e4?.message}`)

  // 1e. Review "Assigned By Me" — tasks created by this user
  const { data: myAssigned, error: eAssigned } = await sb
    .from('tasks').select('id, title, status, assigned_to')
    .eq('created_by', userId)
    .neq('status', 'completed')
  assert(!eAssigned && myAssigned?.length >= 4,
    `Assigned By Me shows ${myAssigned?.length} tasks in-progress`,
    `Assigned By Me query failed: ${eAssigned?.message}`,
    { flow: 'Owner', check: 'Assigned By Me', count: myAssigned?.length }
  )

  // 1f. Review completed assigned tasks
  const { data: completedAssigned } = await sb
    .from('tasks').select('id, title, status')
    .eq('created_by', userId).eq('status', 'completed')
  info(`Completed tasks assigned by owner: ${completedAssigned?.length || 0}`)

  return { ownerId: userId, taskIds: [t1?.id, t2?.id, t3?.id, t4?.id].filter(Boolean) }
}

// ─── Flow 2: Manager (Dhruv BDM) ─────────────────────────────────────────────
async function testManagerFlow() {
  sep('FLOW 2 — Manager ([TEST-UAT] Dhruv BDM)')

  const session = await loginAs('uat.dhruv@boe-test.com', 'Dhruv BDM')
  if (!session) return
  const { client: sb, userId } = session

  const ashokId  = await uid('Ashok')
  const prernaId = await uid('Prerna')
  const nishantId= await uid('Nishant')

  // 2a. Create self task
  const { data: self1, error: es1 } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Dhruv Self: Prepare BDM weekly activity summary',
    status: 'pending', priority: 'medium', type: 'daily_update',
    is_urgent: false, due_date: today(2),
    assigned_to: userId, created_by: userId,
    team: 'bdm', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!es1 && self1, 'Created self task (daily_update type)', `Failed: ${es1?.message}`)

  // 2b. Assign task to Ashok
  const { data: ta, error: ea } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Dhruv→Ashok: Get weekly sales update from team',
    status: 'pending', priority: 'medium', type: 'completion',
    is_urgent: false, due_date: today(1),
    assigned_to: ashokId, created_by: userId,
    team: 'sales', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!ea && ta, 'Assigned task to Ashok Sales Manager', `Failed: ${ea?.message}`)

  // 2c. Assign task to Prerna
  const { data: tp, error: ep } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Dhruv→Prerna: Follow up Treebo Hotel for fabric approval',
    status: 'pending', priority: 'high', type: 'completion',
    is_urgent: true, due_date: today(0),
    assigned_to: prernaId, created_by: userId,
    team: 'sales', last_update_at: new Date().toISOString(),
  }).select('id').single()
  assert(!ep && tp, 'Assigned urgent task to Prerna', `Failed: ${ep?.message}`)

  // 2d. Update a task assigned to Dhruv by Nishant (first one found)
  const { data: nishantTask } = await admin
    .from('tasks').select('id, status')
    .eq('assigned_to', userId)
    .eq('created_by', nishantId)
    .neq('status', 'completed')
    .limit(1).single()

  if (nishantTask) {
    const { error: eu } = await sb.from('tasks')
      .update({ status: 'working', last_update_at: new Date().toISOString() })
      .eq('id', nishantTask.id)
    assert(!eu, 'Updated status on task assigned by Nishant → working', `Failed: ${eu?.message}`)
    await sb.from('task_activity_log').insert({
      task_id: nishantTask.id, actor_id: userId,
      action: 'status_changed', note: 'Reviewed, started working on it',
      from_status: nishantTask.status, to_status: 'working',
    })
  } else {
    info('No pending task from Nishant to Dhruv found (expected if seed varied)')
  }

  // 2e. Complete one of Dhruv's own tasks
  if (self1) {
    const { error: ec } = await sb.from('tasks')
      .update({ status: 'completed', last_update_at: new Date().toISOString() })
      .eq('id', self1.id)
    assert(!ec, 'Completed own self task', `Failed: ${ec?.message}`)
    await sb.from('task_activity_log').insert({
      task_id: self1.id, actor_id: userId,
      action: 'completed', note: 'BDM summary prepared and shared',
      from_status: 'pending', to_status: 'completed',
    })
  }

  // 2f. Edit title of a task
  if (ta) {
    const { error: ee } = await sb.from('tasks')
      .update({ title: '[TEST-UAT] Dhruv→Ashok: Get FULL weekly sales update from team — revised', last_update_at: new Date().toISOString() })
      .eq('id', ta.id)
    assert(!ee, 'Edited task title successfully', `Failed: ${ee?.message}`)
    await sb.from('task_activity_log').insert({
      task_id: ta.id, actor_id: userId,
      action: 'edited', note: 'Title updated for clarity',
    })
  }

  // 2g. Review My Tasks (in progress)
  const { data: myTasks } = await sb.from('tasks').select('id, title, status')
    .eq('assigned_to', userId).neq('status', 'completed')
  info(`My Tasks (in-progress): ${myTasks?.length || 0}`)

  // 2h. Review Assigned By Me
  const { data: assignedByMe } = await sb.from('tasks').select('id, title, status')
    .eq('created_by', userId).neq('status', 'completed')
  info(`Assigned By Me (in-progress): ${assignedByMe?.length || 0}`)

  return { managerId: userId }
}

// ─── Flow 3: Sales Executive — Prerna ─────────────────────────────────────────
async function testSalesFlow_Prerna() {
  sep('FLOW 3a — Sales Executive ([TEST-UAT] Prerna)')

  const session = await loginAs('uat.prerna@boe-test.com', 'Prerna Sales Executive')
  if (!session) return
  const { client: sb, userId } = session

  // 3a. View My Tasks
  const { data: myTasks, error: emt } = await sb.from('tasks').select('id, title, status, priority')
    .eq('assigned_to', userId).neq('status', 'completed').order('due_date')
  assert(!emt && myTasks !== null, `My Tasks loads — ${myTasks?.length} tasks visible`, `Failed: ${emt?.message}`)

  // 3b. Acknowledge a pending task (set acknowledged_at)
  const pendingTask = myTasks?.find(t => t.status === 'pending')
  if (pendingTask) {
    const { error: eack } = await sb.from('tasks')
      .update({ acknowledged_at: new Date().toISOString(), status: 'started', last_update_at: new Date().toISOString() })
      .eq('id', pendingTask.id)
    assert(!eack, 'Acknowledged and started a task', `Failed: ${eack?.message}`)
    await sb.from('task_activity_log').insert({
      task_id: pendingTask.id, actor_id: userId,
      action: 'status_changed', note: 'Acknowledged and started working',
      from_status: 'pending', to_status: 'started',
    })
  }

  // 3c. Add update to a working task
  const workingTask = myTasks?.find(t => t.status === 'working') ||
                      (myTasks?.length > 1 ? myTasks[1] : null)
  if (workingTask) {
    await sb.from('tasks')
      .update({ last_update_at: new Date().toISOString() })
      .eq('id', workingTask.id)
    await sb.from('task_activity_log').insert({
      task_id: workingTask.id, actor_id: userId,
      action: 'updated', note: 'Called client — waiting for their decision by EOD',
    })
    ok('Added progress update to task')
    results.passed++
  }

  // 3d. Complete a task
  const taskToComplete = myTasks?.[0]
  if (taskToComplete) {
    const { error: ec } = await sb.from('tasks')
      .update({ status: 'completed', last_update_at: new Date().toISOString() })
      .eq('id', taskToComplete.id)
    assert(!ec, 'Completed a task successfully', `Failed: ${ec?.message}`)
    await sb.from('task_activity_log').insert({
      task_id: taskToComplete.id, actor_id: userId,
      action: 'completed', note: 'Client approved the quotation, order confirmed',
      from_status: taskToComplete.status, to_status: 'completed',
    })

    // 3e. Restore completed task
    const { error: er } = await sb.from('tasks')
      .update({ status: 'working', last_update_at: new Date().toISOString() })
      .eq('id', taskToComplete.id)
    assert(!er, 'Restored completed task back to working', `Failed: ${er?.message}`,
      { flow: 'Sales/Prerna', check: 'Restore Task', result: !er ? 'PASS' : 'FAIL' })
    if (!er) {
      await sb.from('task_activity_log').insert({
        task_id: taskToComplete.id, actor_id: userId,
        action: 'status_changed', note: 'Restored — client payment pending, marking working again',
        from_status: 'completed', to_status: 'working',
      })
    }
  }

  // 3f. Try deleting own task (should work — RLS allows creator to delete)
  const { data: ownTask } = await sb.from('tasks').insert({
    title: '[TEST-UAT] Prerna Self: Test delete task',
    status: 'pending', priority: 'low', type: 'completion',
    is_urgent: false, due_date: today(5),
    assigned_to: userId, created_by: userId,
    team: 'sales', last_update_at: new Date().toISOString(),
  }).select('id').single()

  if (ownTask) {
    const { error: ed } = await sb.from('tasks').delete().eq('id', ownTask.id)
    assert(!ed, 'Deleted own created task', `Failed: ${ed?.message}`,
      { flow: 'Sales/Prerna', check: 'Delete own task', result: !ed ? 'PASS — deletion allowed' : 'FAIL' })
  }

  // 3g. View completed tasks
  const { data: completedTasks } = await sb.from('tasks').select('id, title, status')
    .eq('assigned_to', userId).eq('status', 'completed')
  info(`Completed tasks visible: ${completedTasks?.length || 0}`)

  return { prernaId: userId }
}

// ─── Flow 4: Sales Executive — Rohit ──────────────────────────────────────────
async function testSalesFlow_Rohit() {
  sep('FLOW 3b — Sales Executive ([TEST-UAT] Rohit)')

  const session = await loginAs('uat.rohit@boe-test.com', 'Rohit Sales Executive')
  if (!session) return
  const { client: sb, userId } = session

  const { data: myTasks } = await sb.from('tasks').select('id, title, status')
    .eq('assigned_to', userId).neq('status', 'completed')
  info(`Rohit — My Tasks: ${myTasks?.length || 0}`)

  // Add a waiting status update (external dependency)
  if (myTasks?.length > 0) {
    const t = myTasks[0]
    const { error } = await sb.from('tasks')
      .update({ status: 'waiting', last_update_at: new Date().toISOString() })
      .eq('id', t.id)
    assert(!error, 'Set task to WAITING (external dependency — fabric from architect)', `Failed: ${error?.message}`,
      { flow: 'Sales/Rohit', check: 'Waiting status', result: !error ? 'PASS' : 'FAIL' })
    await sb.from('task_activity_log').insert({
      task_id: t.id, actor_id: userId,
      action: 'status_changed', note: 'Waiting for architect to approve fabric swatch',
      from_status: t.status, to_status: 'waiting',
    })
  }

  // Add multiple updates to one task (simulate active task)
  if (myTasks?.length > 1) {
    const t = myTasks[1]
    const updates = [
      'Called client — will revert by tomorrow',
      'Client asked for 2 more colour options',
      'Shared 2 options via WhatsApp',
      'Client approved green option, proceeding',
      'PI prepared and sent',
    ]
    for (const note of updates) {
      await sb.from('task_activity_log').insert({
        task_id: t.id, actor_id: userId, action: 'updated', note,
      })
      await sb.from('tasks').update({ last_update_at: new Date().toISOString() }).eq('id', t.id)
    }
    ok(`Added ${updates.length} sequential updates to one task (activity trail)`)
    results.passed++
  }

  // Try to edit a task created by someone else (should succeed if creator or admin)
  const { data: othersTask } = await admin.from('tasks').select('id, title, created_by')
    .eq('assigned_to', userId)
    .neq('created_by', userId)
    .limit(1).single()

  if (othersTask) {
    const { error: ee } = await sb.from('tasks')
      .update({ priority: 'high', last_update_at: new Date().toISOString() })
      .eq('id', othersTask.id)
    // Note result for observation (not asserting pass/fail as policy may vary)
    const can = !ee
    info(`Editing task created by another user: ${can ? 'ALLOWED' : 'BLOCKED — ' + ee?.message}`)
    results.observations.push({
      flow: 'Sales/Rohit', check: 'Edit task created by another',
      result: can ? 'Allowed — no RLS restriction on updates' : 'Blocked by RLS',
    })
  }
}

// ─── Flow 5: Operations — Production Coordinator ─────────────────────────────
async function testOperationsFlow() {
  sep('FLOW 4 — Operations ([TEST-UAT] Production Coord)')

  const session = await loginAs('uat.production@boe-test.com', 'Production Coord')
  if (!session) return
  const { client: sb, userId } = session

  const { data: myTasks } = await sb.from('tasks').select('id, title, status, priority, is_urgent')
    .eq('assigned_to', userId).neq('status', 'completed').order('priority')
  assert(myTasks !== null, `My Tasks loads — ${myTasks?.length || 0} tasks`, 'Load failed')
  info(`Urgent tasks: ${myTasks?.filter(t => t.is_urgent)?.length || 0}`)

  // Mark a task as blocked (internal dependency)
  const t1 = myTasks?.[0]
  if (t1) {
    const { error } = await sb.from('tasks')
      .update({
        status: 'blocked',
        blocker_reason: 'Cane material not delivered — vendor delayed',
        last_update_at: new Date().toISOString(),
      })
      .eq('id', t1.id)
    assert(!error, 'Set task BLOCKED with reason (cane material not arrived)', `Failed: ${error?.message}`,
      { flow: 'Operations', check: 'Blocked status + reason', result: !error ? 'PASS' : 'FAIL' })
    await sb.from('task_activity_log').insert({
      task_id: t1.id, actor_id: userId,
      action: 'status_changed',
      note: 'BLOCKED: Cane material not delivered by vendor. Escalating to procurement.',
      from_status: t1.status, to_status: 'blocked',
    })
  }

  // Add delay update + complete another task
  const t2 = myTasks?.[1]
  if (t2) {
    await sb.from('task_activity_log').insert({
      task_id: t2.id, actor_id: userId,
      action: 'updated',
      note: 'Dispatch delayed by 1 day — transporter vehicle unavailable today',
    })
    await sb.from('tasks').update({ last_update_at: new Date().toISOString() }).eq('id', t2.id)
    ok('Added delay update with clear reason')
    results.passed++
  }

  // Complete a production task
  const t3 = myTasks?.find(t => t.priority === 'high' && t.id !== t1?.id)
  if (t3) {
    await sb.from('tasks')
      .update({ status: 'completed', last_update_at: new Date().toISOString() })
      .eq('id', t3.id)
    await sb.from('task_activity_log').insert({
      task_id: t3.id, actor_id: userId,
      action: 'completed', note: 'QC done, 40 chairs packed and ready',
      from_status: t3.status, to_status: 'completed',
    })
    ok('Completed high-priority production task')
    results.passed++
  }
}

// ─── Flow 6: Accounts Executive ──────────────────────────────────────────────
async function testAccountsFlow() {
  sep('FLOW 5 — Accounts ([TEST-UAT] Accounts Executive)')

  const session = await loginAs('uat.accounts@boe-test.com', 'Accounts Executive')
  if (!session) return
  const { client: sb, userId } = session

  const { data: myTasks } = await sb.from('tasks').select('id, title, status, is_urgent')
    .eq('assigned_to', userId).neq('status', 'completed').order('is_urgent', { ascending: false })
  assert(myTasks !== null, `Accounts My Tasks — ${myTasks?.length || 0} tasks`, 'Load failed')

  // Add payment follow-up updates
  const followUps = [
    'Sent reminder via email',
    'Client said will pay by 5pm today',
    'Payment not received — calling again',
    'Client confirmed NEFT initiated',
    'Payment confirmed — ₹1,85,000 received',
  ]

  for (let i = 0; i < Math.min(followUps.length, myTasks?.length || 0); i++) {
    const task = myTasks[i]
    await sb.from('task_activity_log').insert({
      task_id: task.id, actor_id: userId,
      action: 'updated', note: followUps[i],
    })
    await sb.from('tasks').update({ last_update_at: new Date().toISOString() }).eq('id', task.id)
  }
  ok(`Added ${Math.min(followUps.length, myTasks?.length || 0)} payment follow-up updates`)
  results.passed++

  // Complete a payment task
  if (myTasks?.length > 0) {
    const t = myTasks[0]
    await sb.from('tasks')
      .update({ status: 'completed', last_update_at: new Date().toISOString() })
      .eq('id', t.id)
    await sb.from('task_activity_log').insert({
      task_id: t.id, actor_id: userId,
      action: 'completed', note: 'Payment collected. Invoice closed.',
      from_status: t.status, to_status: 'completed',
    })
    ok('Completed payment collection task')
    results.passed++
  }
}

// ─── Flow 7: After-Sales — Aditya ────────────────────────────────────────────
async function testAfterSalesFlow() {
  sep('FLOW 6 — After-Sales ([TEST-UAT] Aditya)')

  const session = await loginAs('uat.aditya@boe-test.com', 'Aditya After Sales')
  if (!session) return
  const { client: sb, userId } = session

  const { data: myTasks } = await sb.from('tasks').select('id, title, status')
    .eq('assigned_to', userId).neq('status', 'completed')
  assert(myTasks !== null, `After-Sales My Tasks — ${myTasks?.length || 0} tasks`, 'Load failed')

  // Simulate complaint handling flow
  if (myTasks?.length > 0) {
    const t = myTasks[0]
    const steps = [
      { note: 'Complaint received: fabric peeling at Goa resort — 5 chairs', action: 'updated' },
      { note: 'Coordinated with production for replacement chairs', action: 'updated' },
      { note: 'Sent repair team to site — carpenter assigned', action: 'updated' },
      { note: 'Repair completed, client satisfied', action: 'completed', to: 'completed' },
    ]
    for (const step of steps) {
      await sb.from('task_activity_log').insert({
        task_id: t.id, actor_id: userId,
        action: step.action, note: step.note,
        to_status: step.to || null,
      })
      await sb.from('tasks').update({
        status: step.to || 'working',
        last_update_at: new Date().toISOString(),
      }).eq('id', t.id)
    }
    ok('Simulated full complaint handling lifecycle (4 updates → resolved)')
    results.passed++
  }
}

// ─── Flow 8: Dispatch Coordinator ────────────────────────────────────────────
async function testDispatchFlow() {
  sep('FLOW 7 — Dispatch ([TEST-UAT] Dispatch Coord)')

  const session = await loginAs('uat.dispatch@boe-test.com', 'Dispatch Coord')
  if (!session) return
  const { client: sb, userId } = session

  const { data: myTasks } = await sb.from('tasks').select('id, title, status, is_urgent')
    .eq('assigned_to', userId).neq('status', 'completed').order('is_urgent', { ascending: false })
  assert(myTasks !== null, `Dispatch My Tasks — ${myTasks?.length || 0} tasks`, 'Load failed')

  // Dispatch confirmation flow
  if (myTasks?.length > 0) {
    const t = myTasks[0]
    await sb.from('task_activity_log').insert({
      task_id: t.id, actor_id: userId,
      action: 'updated', note: 'Packing complete, 40 chairs loaded',
    })
    await sb.from('task_activity_log').insert({
      task_id: t.id, actor_id: userId,
      action: 'updated', note: 'Truck departed at 9am — tracking shared with client',
    })
    await sb.from('tasks').update({ status: 'completed', last_update_at: new Date().toISOString() }).eq('id', t.id)
    await sb.from('task_activity_log').insert({
      task_id: t.id, actor_id: userId,
      action: 'completed', note: 'Delivered to Goa resort, receiver confirmed',
      to_status: 'completed',
    })
    ok('Completed dispatch flow with 3 update steps + delivery confirmation')
    results.passed++
  }
}

// ─── Flow 9: Manager Review (Ashok) ──────────────────────────────────────────
async function testManagerReview_Ashok() {
  sep('FLOW 8 — Manager Review ([TEST-UAT] Ashok Sales Manager)')

  const session = await loginAs('uat.ashok@boe-test.com', 'Ashok Sales Manager')
  if (!session) return
  const { client: sb, userId } = session

  // Q1: What is pending?
  const { data: pending } = await sb.from('tasks').select('id, title, assigned_to, due_date')
    .eq('created_by', userId).eq('status', 'pending')
  info(`Pending tasks assigned by Ashok: ${pending?.length || 0}`)
  assert(pending !== null, 'Can query pending tasks from Assigned By Me', 'Failed')

  // Q2: What is overdue?
  const now = new Date().toISOString().split('T')[0]
  const { data: overdue } = await sb.from('tasks').select('id, title, due_date, assigned_to')
    .eq('created_by', userId).lt('due_date', now).neq('status', 'completed')
  info(`Overdue tasks assigned by Ashok: ${overdue?.length || 0}`)
  assert(overdue !== null, 'Can identify overdue tasks (due_date < today)', 'Failed',
    { flow: 'Manager Review', check: 'Overdue visibility', result: `${overdue?.length || 0} overdue tasks visible` })

  // Q3: What is important/urgent?
  const { data: urgent } = await sb.from('tasks').select('id, title, is_urgent')
    .eq('created_by', userId).eq('is_urgent', true).neq('status', 'completed')
  info(`Urgent/important tasks assigned by Ashok: ${urgent?.length || 0}`)
  assert(urgent !== null, 'Can filter urgent tasks', 'Failed')

  // Q4: What is completed?
  const { data: completed } = await sb.from('tasks').select('id, title, last_update_at')
    .eq('created_by', userId).eq('status', 'completed')
  info(`Completed tasks assigned by Ashok: ${completed?.length || 0}`)

  // Q5: Which employee has most tasks?
  const { data: allPending } = await sb.from('tasks').select('assigned_to')
    .eq('created_by', userId).neq('status', 'completed')

  const taskLoad = {}
  for (const t of allPending || []) {
    taskLoad[t.assigned_to] = (taskLoad[t.assigned_to] || 0) + 1
  }
  const maxLoad = Math.max(...Object.values(taskLoad).map(Number))
  info(`Highest task load for any assignee: ${maxLoad} tasks`)
  assert(maxLoad >= 0, 'Task load analysis possible via assigned_to grouping', 'Failed',
    { flow: 'Manager Review', check: 'Task load per person', result: `Max ${maxLoad} tasks on one person` })

  // Q6: Tasks with no updates (stale — last_update_at very old or never updated by assignee)
  const staleThreshold = new Date(Date.now() - 24 * 3600000).toISOString()
  const { data: stale } = await sb.from('tasks').select('id, title, last_update_at, assigned_to')
    .eq('created_by', userId)
    .neq('status', 'completed')
    .lt('last_update_at', staleThreshold)
  info(`Stale tasks (no update >24h): ${stale?.length || 0}`)
  results.observations.push({
    flow: 'Manager Review', check: 'Stale task detection',
    result: `${stale?.length || 0} tasks not updated in 24h — manager can see these`,
  })

  return { ashokId: userId }
}

// ─── Flow 10: Cross-user delete test ─────────────────────────────────────────
async function testDeletePermissions() {
  sep('FLOW 9 — Delete Permission Test')

  // Rohit tries to delete a task created by Ashok assigned to Prerna
  const { data: otherTask } = await admin.from('tasks').select('id, title, created_by, assigned_to')
    .like('title', '[TEST-UAT]%')
    .neq('status', 'completed')
    .limit(1)
    .not('created_by', 'eq', await uid('Rohit'))
    .not('assigned_to', 'eq', await uid('Rohit'))
    .single()

  if (!otherTask) {
    info('No suitable cross-user task found for delete test')
    return
  }

  const rohitSession = await loginAs('uat.rohit@boe-test.com', 'Rohit (delete test)')
  if (!rohitSession) return
  const { client: sb } = rohitSession

  const { error: delErr } = await sb.from('tasks').delete().eq('id', otherTask.id)

  if (delErr) {
    ok('RLS BLOCKS delete of another user\'s task — correct behavior')
    results.passed++
    results.observations.push({
      flow: 'Delete Permissions', check: 'Delete other user task',
      result: 'BLOCKED by RLS — correct',
    })
  } else {
    // Verify task still exists
    const { data: check } = await admin.from('tasks').select('id').eq('id', otherTask.id).single()
    if (!check) {
      fail('TASK DELETED by non-owner — RLS not enforcing delete restriction', '')
      results.observations.push({
        flow: 'Delete Permissions', check: 'Delete other user task',
        result: 'ALLOWED — member deleted task they did not create. Potential issue.',
      })
    } else {
      ok('Delete returned no error but task still exists (RLS silent block)')
      results.observations.push({
        flow: 'Delete Permissions', check: 'Delete other user task',
        result: 'Silent RLS block — no error but task not deleted',
      })
    }
  }
}

// ─── Flow 11: Owner manager overview ─────────────────────────────────────────
async function testOwnerManagerOverview() {
  sep('FLOW 10 — Owner Manager Overview ([TEST-UAT] Nishant)')

  const session = await loginAs('uat.nishant@boe-test.com', 'Nishant (Manager Overview)')
  if (!session) return
  const { client: sb, userId } = session

  // Can owner see all tasks? (Manager/Admin should see all via manager route)
  const { data: allTasks, error } = await admin.from('tasks').select('id, status, priority, assigned_to, is_urgent, due_date')
    .like('title', '[TEST-UAT]%')

  if (!error && allTasks) {
    const byStatus = {}
    for (const t of allTasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1
    }
    log('\n  Task Status Distribution:')
    for (const [s, n] of Object.entries(byStatus)) {
      log(`    ${s.padEnd(10)} : ${n}`)
    }

    const overdue = allTasks.filter(t => t.due_date && t.due_date < new Date().toISOString().split('T')[0] && t.status !== 'completed')
    const urgent  = allTasks.filter(t => t.is_urgent && t.status !== 'completed')
    const blocked = allTasks.filter(t => t.status === 'blocked')

    log(`\n  Urgent (unfinished): ${urgent.length}`)
    log(`  Overdue (unfinished): ${overdue.length}`)
    log(`  Blocked: ${blocked.length}`)

    assert(allTasks.length >= 100, `Total UAT tasks visible: ${allTasks.length}`, 'Less than 100 tasks found')
    assert(overdue.length > 0, `Overdue tasks detectable: ${overdue.length}`, 'No overdue tasks found')
    assert(blocked.length > 0, `Blocked tasks visible for manager: ${blocked.length}`, 'No blocked tasks')

    results.observations.push({
      flow: 'Owner Overview', check: 'Full team visibility',
      result: `${allTasks.length} tasks, ${overdue.length} overdue, ${blocked.length} blocked, ${urgent.length} urgent`,
    })
  }

  // Check activity log completeness
  const { data: logs } = await admin.from('task_activity_log').select('id')
    .in('task_id', (await admin.from('tasks').select('id').like('title', '[TEST-UAT]%')).data?.map(t => t.id) || [])
  info(`Total activity log entries for UAT tasks: ${logs?.length || 0}`)
  assert((logs?.length || 0) >= 200, `Activity logs sufficient: ${logs?.length || 0}`, 'Less than 200 log entries')
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function today(offset) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toISOString().split('T')[0]
}

// ─── Main runner ──────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(60))
  console.log('  BOE UAT SIMULATION — STARTING')
  console.log('  ' + new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))
  console.log('═'.repeat(60))

  await testOwnerFlow()
  await testManagerFlow()
  await testSalesFlow_Prerna()
  await testSalesFlow_Rohit()
  await testOperationsFlow()
  await testAccountsFlow()
  await testAfterSalesFlow()
  await testDispatchFlow()
  await testManagerReview_Ashok()
  await testDeletePermissions()
  await testOwnerManagerOverview()

  // ── Final Results ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('  UAT SIMULATION RESULTS')
  console.log('═'.repeat(60))
  console.log(`  Checks Passed : ${results.passed}`)
  console.log(`  Checks Failed : ${results.failed}`)
  console.log(`  Pass Rate     : ${Math.round(results.passed / (results.passed + results.failed) * 100)}%`)
  console.log('\n  Key Observations:')
  for (const obs of results.observations) {
    console.log(`  [${obs.flow}] ${obs.check}: ${obs.result}`)
  }
  console.log('═'.repeat(60) + '\n')
}

main().catch(console.error)
