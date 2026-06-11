// @ts-check
// Seeds demo tasks for screenshots, prints the task IDs so they can be cleaned up.
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL      = 'https://albnsrohngkljfsrrrhf.supabase.co'
const SERVICE_ROLE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFsYm5zcm9obmdrbGpmc3JycmhmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTI4MDk2MywiZXhwIjoyMDk0ODU2OTYzfQ.pNOzEyuqTAYaCRd1Fa1TMdJFW8YVgfNrq07PHq3GGMA'
const USER_EMAIL        = 'boesales8@gmail.com'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

;(async () => {
  // Get user ID
  const { data: users, error: userErr } = await supabase
    .from('users')
    .select('id, full_name, role, team')
    .eq('email', USER_EMAIL)
    .limit(1)

  if (userErr || !users?.length) {
    console.error('Could not find user:', userErr)
    process.exit(1)
  }

  const user = users[0]
  console.log('User:', user.full_name, '|', user.role, '|', user.team, '| ID:', user.id)

  const now = new Date().toISOString()
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const nextWeek  = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)

  const tasks = [
    {
      title: 'Follow up with Al-Noor Textiles on fabric approval',
      note: 'Client needs final confirmation on fabric shade before production order is placed. Call Mr. Hamid and share the updated swatch images from the sample folder. Get written confirmation via email.',
      status: 'working',
      priority: 'high',
      type: 'completion',
      is_urgent: true,
      due_date: tomorrow,
      assigned_to: user.id,
      created_by: user.id,
      team: user.team,
      acknowledged_at: now,
      last_update_at: now,
    },
    {
      title: 'Send updated price list to Gulf Exports buyers',
      note: 'Prepare revised pricing sheet with new GSM rates for the summer collection. Send to the 3 buyers confirmed at last week\'s meeting. CC the manager.',
      status: 'pending',
      priority: 'medium',
      type: 'completion',
      is_urgent: false,
      due_date: nextWeek,
      assigned_to: user.id,
      created_by: user.id,
      team: user.team,
      last_update_at: now,
    },
    {
      title: 'Confirm shipment date for Order #BOE-2847',
      note: 'Coordinate with the logistics team to confirm the loading date. Update the client tracker sheet and notify the client by EOD. Mention any delays in the task update.',
      status: 'waiting',
      priority: 'high',
      type: 'completion',
      is_urgent: false,
      due_date: yesterday,
      assigned_to: user.id,
      created_by: user.id,
      team: user.team,
      waiting_on_type: 'external',
      waiting_on_text: 'Logistics team confirmation on container booking',
      acknowledged_at: now,
      last_update_at: now,
    },
  ]

  const { data: inserted, error: insertErr } = await supabase
    .from('tasks')
    .insert(tasks)
    .select('id, title, status')

  if (insertErr) {
    console.error('Insert failed:', insertErr)
    process.exit(1)
  }

  console.log('\nSeeded tasks:')
  inserted.forEach(t => console.log(`  ${t.id}  [${t.status}]  ${t.title}`))
  console.log('\nFirst task ID for detail screenshot:', inserted[0].id)

  // Write IDs to file for cleanup
  const fs = require('fs')
  fs.writeFileSync('scripts/.demo-task-ids.json', JSON.stringify(inserted.map(t => t.id)))
  console.log('IDs saved to scripts/.demo-task-ids.json')
})()
