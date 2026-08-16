/**
 * UAT CLEANUP SCRIPT — BOE Task Management
 * Removes all [TEST-UAT] users and tasks.
 *
 * Credentials and target come from the environment (see .env.example) and are
 * validated by scripts/lib/uatEnv.mjs, which also refuses to run against a
 * hosted project without an explicit override.
 *
 * Run: node scripts/uat-cleanup.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { createUatAdminClient, resolveUatEnvOrExit } from './lib/uatEnv.mjs'

const env = resolveUatEnvOrExit()
const sb = createUatAdminClient(env, createClient)

async function main() {
  console.log('🧹 UAT Cleanup Starting...\n')

  // 1. Find all [TEST-UAT] tasks
  const { data: tasks } = await sb
    .from('tasks')
    .select('id')
    .like('title', '[TEST-UAT]%')

  const taskIds = (tasks || []).map(t => t.id)
  console.log(`Found ${taskIds.length} [TEST-UAT] tasks.`)

  if (taskIds.length > 0) {
    // 2. Delete activity logs for these tasks
    const { error: logErr } = await sb
      .from('task_activity_log')
      .delete()
      .in('task_id', taskIds)
    if (logErr) console.error('  ❌ Log delete error:', logErr.message)
    else console.log('  ✅ Activity logs deleted.')

    // 3. Delete notifications for these tasks
    await sb.from('notifications').delete().in('task_id', taskIds)

    // 4. Delete tasks
    const { error: taskErr } = await sb
      .from('tasks')
      .delete()
      .in('id', taskIds)
    if (taskErr) console.error('  ❌ Task delete error:', taskErr.message)
    else console.log(`  ✅ ${taskIds.length} tasks deleted.`)
  }

  // 5. Find [TEST-UAT] users
  const { data: users } = await sb
    .from('users')
    .select('id, full_name, email')
    .like('full_name', '[TEST-UAT]%')

  const userIds = (users || []).map(u => u.id)
  console.log(`\nFound ${userIds.length} [TEST-UAT] users.`)

  for (const user of users || []) {
    // Delete from users table
    await sb.from('users').delete().eq('id', user.id)

    // Delete from Supabase Auth
    const { error: authErr } = await sb.auth.admin.deleteUser(user.id)
    if (authErr) console.error(`  ❌ Auth delete: ${user.full_name} — ${authErr.message}`)
    else console.log(`  ✅ Deleted: ${user.full_name} (${user.email})`)
  }

  console.log('\n✅ UAT Cleanup Complete.\n')
}

main().catch(console.error)
