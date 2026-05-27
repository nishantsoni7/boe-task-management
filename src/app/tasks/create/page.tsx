'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

type User = { id: string; full_name: string; team: string; role: string }

const TEMPLATES = {
  sales: [
    'Follow up with [Client] about [Topic]',
    'Proposal to be sent to [Client] by [Date]',
    'Call [Client] at [Hotel] — confirm [Spec]',
    'Meeting scheduled with [Client] — prepare [Document]',
  ],
  operations: [
    'Quality check — [Item] — before [Event]',
    'Vendor coordination — [Supplier] — [Requirement]',
    'Dispatch confirmation — [Order] — by [Date]',
    'Production update — [Item] — status check',
  ],
  design: [
    'Design revision — [Project] — [Changes]',
    'Sample preparation — [Item] — for [Client]',
    'Approval pending — [Design] — from [Person]',
  ],
  purchase: [
    'Purchase order — [Item] — from [Vendor]',
    'Price negotiation — [Material] — with [Supplier]',
    'Stock check — [Item] — reorder if below [Qty]',
  ],
}

export default function CreateTaskPage() {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [priority, setPriority] = useState('medium')
  const [type, setType] = useState('completion')
  const [isUrgent, setIsUrgent] = useState(false)
  const [dueDate, setDueDate] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [team, setTeam] = useState('sales')
  const [users, setUsers] = useState<User[]>([])
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('users')
        .select('*')
        .eq('id', user.id)
        .single()

      if (profile) {
        setCurrentUser(profile)
        setTeam(profile.team)
      }

      const { data: allUsers } = await supabase
        .from('users')
        .select('id, full_name, team, role')
        .eq('is_active', true)
        .order('full_name')

      if (allUsers) setUsers(allUsers)
    }
    init()
  }, [])

  const templates = TEMPLATES[team as keyof typeof TEMPLATES] || TEMPLATES.sales

  const handleSubmit = async () => {
    if (!title.trim() || !assigneeId) return
    setLoading(true)

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    // Check for duplicate
    const { data: existing } = await supabase
      .from('tasks')
      .select('id, title')
      .eq('assigned_to', assigneeId)
      .not('status', 'eq', 'completed')

    const titleWords = title.toLowerCase().split(' ').filter(w => w.length > 3)
    const duplicate = existing?.find(t => {
      const matches = titleWords.filter(w => t.title.toLowerCase().includes(w))
      return matches.length >= 3
    })

    if (duplicate) {
      const confirm = window.confirm(
        `A similar task may already exist:\n"${duplicate.title}"\n\nCreate anyway?`
      )
      if (!confirm) { setLoading(false); return }
    }

    const { data: task, error } = await supabase.from('tasks').insert({
      title: title.trim(),
      note: note.trim() || null,
      priority,
      type,
      is_urgent: isUrgent,
      due_date: dueDate || null,
      assigned_to: assigneeId,
      created_by: user.id,
      team,
      status: 'pending',
    }).select().single()

    if (!error && task) {
      await supabase.from('task_activity_log').insert({
        task_id: task.id,
        actor_id: user.id,
        action: 'created',
        note: `Task created and assigned`,
      })

      await supabase.from('notifications').insert({
        user_id: assigneeId,
        task_id: task.id,
        type: 'task_assigned',
        title: 'New task assigned to you',
        body: title.trim(),
        is_push_sent: true,
      })

      router.push('/dashboard')
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.back()} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-white font-semibold text-base flex-1">New Task</h1>
        <button
          onClick={handleSubmit}
          disabled={loading || !title.trim() || !assigneeId}
          className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          {loading ? 'Saving...' : 'Create'}
        </button>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto flex flex-col gap-4">

        {/* Title */}
        <div>
          <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Task Title
          </label>
          <textarea
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done? Be specific — who, what, by when."
            rows={3}
            className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
          />
          {title.length > 0 && title.length < 20 && (
            <p className="text-yellow-500 text-xs mt-1">Be more specific — who, what, and by when?</p>
          )}

          {/* Templates */}
          <button
            onClick={() => setShowTemplates(!showTemplates)}
            className="text-blue-400 text-xs mt-2 hover:text-blue-300"
          >
            {showTemplates ? 'Hide templates' : 'Use a template'}
          </button>

          {showTemplates && (
            <div className="mt-2 flex flex-col gap-2">
              {templates.map((t, i) => (
                <button
                  key={i}
                  onClick={() => { setTitle(t); setShowTemplates(false) }}
                  className="text-left bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs px-3 py-2.5 rounded-xl transition-colors"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Assignee */}
        <div>
          <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Assign To
          </label>
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
          >
            <option value="">Select team member</option>
            {users.map(u => (
              <option key={u.id} value={u.id}>
                {u.full_name} — {u.team}
              </option>
            ))}
          </select>
        </div>

        {/* Priority + Type */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              Priority
            </label>
            <div className="flex gap-2">
              {['low', 'medium', 'high'].map(p => (
                <button
                  key={p}
                  onClick={() => setPriority(p)}
                  className={`flex-1 py-2 rounded-xl text-xs font-semibold capitalize transition-colors ${
                    priority === p
                      ? p === 'high' ? 'bg-red-600 text-white'
                        : p === 'medium' ? 'bg-yellow-600 text-white'
                        : 'bg-gray-600 text-white'
                      : 'bg-gray-800 text-gray-400'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
              Type
            </label>
            <div className="flex gap-2">
              {[['completion', 'One-time'], ['daily_update', 'Daily']].map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setType(val)}
                  className={`flex-1 py-2 rounded-xl text-xs font-semibold transition-colors ${
                    type === val ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Due Date */}
        <div>
          <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Due Date
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
            style={{colorScheme: 'dark'}}
          />
        </div>

        {/* Team */}
        <div>
          <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Team
          </label>
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500"
          >
            {['sales', 'operations', 'design', 'purchase', 'bdm', 'management'].map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>

        {/* Urgent toggle */}
        <div
          onClick={() => setIsUrgent(!isUrgent)}
          className={`flex items-center justify-between px-4 py-3 rounded-xl border cursor-pointer transition-colors ${
            isUrgent ? 'bg-red-950 border-red-700' : 'bg-gray-900 border-gray-700'
          }`}
        >
          <div>
            <p className={`text-sm font-semibold ${isUrgent ? 'text-red-400' : 'text-gray-300'}`}>
              Mark as Urgent
            </p>
            <p className="text-gray-500 text-xs mt-0.5">Sends immediate push notification</p>
          </div>
          <div className={`w-10 h-6 rounded-full transition-colors ${isUrgent ? 'bg-red-600' : 'bg-gray-700'}`}>
            <div className={`w-5 h-5 bg-white rounded-full mt-0.5 transition-transform ${isUrgent ? 'translate-x-4' : 'translate-x-0.5'}`} />
          </div>
        </div>

        {/* Note */}
        <div>
          <label className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">
            Note (optional)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Any additional context..."
            rows={2}
            className="w-full bg-gray-900 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none"
          />
        </div>

      </div>
    </div>
  )
}