'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter, useParams } from 'next/navigation'

type Task = {
  id: string
  title: string
  note: string | null
  status: string
  priority: string
  type: string
  is_urgent: boolean
  due_date: string | null
  acknowledged_at: string | null
  created_at: string
  assigned_to: string
  created_by: string
  delegated_by: string | null
  blocker_reason: string | null
  team: string
}

type LogEntry = {
  id: string
  action: string
  note: string | null
  from_status: string | null
  to_status: string | null
  created_at: string
  actor_id: string
  actor_name?: string
}

function formatLogAction(entry: LogEntry): string {
  if (entry.action === 'status_changed') {
    return `Status: ${entry.from_status ?? '?'} → ${entry.to_status ?? '?'}`
  }
  if (entry.action === 'acknowledged')     return 'Task acknowledged'
  if (entry.action === 'delegated')        return 'Task delegated'
  if (entry.action === 'created')          return 'Task created'
  if (entry.action === 'deadline_changed') return 'Deadline updated'
  if (entry.action === 'escalated')        return 'Escalated'
  return entry.action.replace(/_/g, ' ')
}

export default function TaskDetailPage() {
  const [task, setTask]                         = useState<Task | null>(null)
  const [log,  setLog]                          = useState<LogEntry[]>([])
  const [currentUserId, setCurrentUserId]       = useState('')
  const [loading, setLoading]                   = useState(true)
  const [blockerReason, setBlockerReason]       = useState('')
  const [showBlockerInput, setShowBlockerInput] = useState(false)
  const [pendingStatus, setPendingStatus]       = useState('')
  const router   = useRouter()
  const params   = useParams()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setCurrentUserId(user.id)
      const { data: taskData } = await supabase
        .from('tasks').select('*').eq('id', params.id).single()
      if (taskData) setTask(taskData)
      await loadLog(params.id as string)
      setLoading(false)
    }
    init()
  }, [])

  const loadLog = async (taskId: string) => {
    const { data: logData } = await supabase
      .from('task_activity_log')
      .select(`
        id, action, note, from_status, to_status, created_at, actor_id,
        users:actor_id ( full_name )
      `)
      .eq('task_id', taskId)
      .order('created_at', { ascending: false })
    if (logData) {
      setLog((logData as any[]).map(e => ({ ...e, actor_name: e.users?.full_name ?? null })))
    }
  }

  const acknowledge = async () => {
    if (!task) return
    const now = new Date().toISOString()
    await supabase.from('tasks').update({ acknowledged_at: now }).eq('id', task.id)
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId, action: 'acknowledged', note: null,
    })
    setTask({ ...task, acknowledged_at: now })
    await loadLog(task.id)
  }

  const updateStatus = async (newStatus: string) => {
    if (!task) return
    if (newStatus === 'waiting' || newStatus === 'blocked') {
      setPendingStatus(newStatus)
      setShowBlockerInput(true)
      return
    }
    await applyStatusChange(newStatus, null)
  }

  const applyStatusChange = async (newStatus: string, reason: string | null) => {
    if (!task) return
    const oldStatus = task.status
    const updates: Record<string, unknown> = {
      status: newStatus,
      last_update_at: new Date().toISOString(),
    }
    if (reason)                    updates.blocker_reason = reason
    if (newStatus === 'completed') updates.completed_at = new Date().toISOString()
    await supabase.from('tasks').update(updates).eq('id', task.id)
    await supabase.from('task_activity_log').insert({
      task_id: task.id, actor_id: currentUserId, action: 'status_changed',
      from_status: oldStatus, to_status: newStatus, note: reason ?? null,
    })
    setTask({ ...task, status: newStatus, blocker_reason: reason })
    setShowBlockerInput(false)
    setBlockerReason('')
    setPendingStatus('')
    await loadLog(task.id)
    if (newStatus === 'completed') setTimeout(() => router.push('/dashboard'), 1000)
  }

  const isOverdue  = task?.due_date && new Date(task.due_date) < new Date()
  const isAssignee = task?.assigned_to === currentUserId

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const formatTime = (d: string) =>
    new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Loading...</p>
    </div>
  )
  if (!task) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Task not found</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950">

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push('/dashboard')} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-white font-semibold text-base flex-1">Task Detail</h1>
        {task.status === 'pending'   && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-gray-700 text-gray-200">pending</span>}
        {task.status === 'started'   && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-blue-900 text-blue-300">started</span>}
        {task.status === 'working'   && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-yellow-900 text-yellow-300">working</span>}
        {task.status === 'waiting'   && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-purple-900 text-purple-300">waiting</span>}
        {task.status === 'blocked'   && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-red-900 text-red-300">blocked</span>}
        {task.status === 'completed' && <span className="text-xs px-2.5 py-1 rounded-full font-semibold bg-green-900 text-green-300">completed</span>}
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto flex flex-col gap-4">

        {task.is_urgent && (
          <div className="bg-red-950 border border-red-700 rounded-xl px-4 py-2.5">
            <p className="text-red-400 text-xs font-semibold uppercase tracking-wide">⚡ Urgent Task</p>
          </div>
        )}

        {isOverdue && task.status !== 'completed' && (
          <div className="bg-red-950 border border-red-700 rounded-xl px-4 py-2.5">
            <p className="text-red-400 text-xs font-semibold">⚠ Overdue — action required</p>
          </div>
        )}

        {/* Title card */}
        <div className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <p className="text-white font-medium text-base leading-snug mb-3">{task.title}</p>
          <div className="flex flex-wrap gap-2 text-xs">
            {task.priority === 'high'   && <span className="px-2 py-0.5 rounded-full font-medium bg-red-950 text-red-400">high priority</span>}
            {task.priority === 'medium' && <span className="px-2 py-0.5 rounded-full font-medium bg-yellow-950 text-yellow-400">medium priority</span>}
            {task.priority === 'low'    && <span className="px-2 py-0.5 rounded-full font-medium bg-gray-800 text-gray-400">low priority</span>}
            <span className="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full capitalize">{task.type}</span>
            {task.due_date && !isOverdue && <span className="bg-gray-800 text-gray-400 px-2 py-0.5 rounded-full">Due {formatDate(task.due_date)}</span>}
            {task.due_date &&  isOverdue && <span className="bg-red-950 text-red-400 px-2 py-0.5 rounded-full">Due {formatDate(task.due_date)}</span>}
          </div>
          {task.note && (
            <p className="text-gray-400 text-sm mt-3 pt-3 border-t border-gray-800">{task.note}</p>
          )}
        </div>

        {/* Acknowledge */}
        {!task.acknowledged_at && isAssignee && (
          <button onClick={acknowledge}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-4 rounded-2xl text-sm transition-colors">
            Tap to Acknowledge Task
          </button>
        )}
        {task.acknowledged_at && (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-green-950 border border-green-800 rounded-xl">
            <span className="text-green-400 text-xs">✓ Acknowledged {formatTime(task.acknowledged_at)}</span>
          </div>
        )}

        {/* Blocker display */}
        {task.blocker_reason && (
          <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3">
            <p className="text-red-400 text-xs font-semibold mb-1">Blocker</p>
            <p className="text-red-300 text-sm">{task.blocker_reason}</p>
          </div>
        )}

        {/* Status buttons */}
        {isAssignee && task.status !== 'completed' && (
          <div>
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">Update Status</p>
            <div className="flex flex-col gap-2">

              <button onClick={() => updateStatus('pending')}
                style={task.status === 'pending' ? {backgroundColor:'#374151', color:'#e5e7eb'} : {backgroundColor:'#1f2937', color:'#9ca3af'}}>
                <span style={{display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius:'12px', fontSize:'14px', fontWeight:600, width:'100%'}}>
                  <span style={{width:'8px', height:'8px', borderRadius:'50%', background: task.status === 'pending' ? '#d1d5db' : '#4b5563', flexShrink:0}} />
                  Pending
                  {task.status === 'pending' && <span style={{marginLeft:'auto', fontSize:'11px', opacity:0.5, fontWeight:400}}>current</span>}
                </span>
              </button>

              <button onClick={() => updateStatus('started')}
                style={task.status === 'started' ? {backgroundColor:'#1e3a8a', color:'#bfdbfe'} : {backgroundColor:'#1f2937', color:'#9ca3af'}}>
                <span style={{display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius:'12px', fontSize:'14px', fontWeight:600, width:'100%'}}>
                  <span style={{width:'8px', height:'8px', borderRadius:'50%', background: task.status === 'started' ? '#60a5fa' : '#4b5563', flexShrink:0}} />
                  Started
                  {task.status === 'started' && <span style={{marginLeft:'auto', fontSize:'11px', opacity:0.5, fontWeight:400}}>current</span>}
                </span>
              </button>

              <button onClick={() => updateStatus('working')}
                style={task.status === 'working' ? {backgroundColor:'#713f12', color:'#fef08a'} : {backgroundColor:'#1f2937', color:'#9ca3af'}}>
                <span style={{display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius:'12px', fontSize:'14px', fontWeight:600, width:'100%'}}>
                  <span style={{width:'8px', height:'8px', borderRadius:'50%', background: task.status === 'working' ? '#facc15' : '#4b5563', flexShrink:0}} />
                  Working
                  {task.status === 'working' && <span style={{marginLeft:'auto', fontSize:'11px', opacity:0.5, fontWeight:400}}>current</span>}
                </span>
              </button>

              <button onClick={() => updateStatus('waiting')}
                style={task.status === 'waiting' ? {backgroundColor:'#581c87', color:'#e9d5ff'} : {backgroundColor:'#1f2937', color:'#9ca3af'}}>
                <span style={{display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius:'12px', fontSize:'14px', fontWeight:600, width:'100%'}}>
                  <span style={{width:'8px', height:'8px', borderRadius:'50%', background: task.status === 'waiting' ? '#c084fc' : '#4b5563', flexShrink:0}} />
                  Waiting
                  {task.status === 'waiting' && <span style={{marginLeft:'auto', fontSize:'11px', opacity:0.5, fontWeight:400}}>current</span>}
                </span>
              </button>

              <button onClick={() => updateStatus('blocked')}
                style={task.status === 'blocked' ? {backgroundColor:'#7f1d1d', color:'#fecaca'} : {backgroundColor:'#1f2937', color:'#9ca3af'}}>
                <span style={{display:'flex', alignItems:'center', gap:'12px', padding:'14px 16px', borderRadius:'12px', fontSize:'14px', fontWeight:600, width:'100%'}}>
                  <span style={{width:'8px', height:'8px', borderRadius:'50%', background: task.status === 'blocked' ? '#f87171' : '#4b5563', flexShrink:0}} />
                  Blocked
                  {task.status === 'blocked' && <span style={{marginLeft:'auto', fontSize:'11px', opacity:0.5, fontWeight:400}}>current</span>}
                </span>
              </button>

            </div>

            {/* Blocker input */}
            {showBlockerInput && (
              <div className="mt-3 bg-gray-900 border border-gray-700 rounded-xl p-4">
                <p className="text-gray-300 text-sm font-medium mb-2">Who or what is blocking this?</p>
                <textarea
                  value={blockerReason}
                  onChange={(e) => setBlockerReason(e.target.value)}
                  placeholder="e.g. Waiting for client to send fabric sample"
                  rows={2}
                  className="w-full bg-gray-800 text-white rounded-xl px-3 py-2.5 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600 resize-none mb-3"
                />
                <div className="flex gap-2">
                  <button onClick={() => applyStatusChange(pendingStatus, blockerReason)}
                    disabled={!blockerReason.trim()}
                    className="flex-1 bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-semibold py-2.5 rounded-xl">
                    Confirm
                  </button>
                  <button onClick={() => { setShowBlockerInput(false); setBlockerReason('') }}
                    className="flex-1 bg-gray-800 text-gray-300 text-sm font-semibold py-2.5 rounded-xl">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <button onClick={() => updateStatus('completed')}
              className="w-full mt-3 bg-green-800 hover:bg-green-700 text-green-200 font-semibold py-3.5 rounded-2xl text-sm transition-colors">
              ✓ Mark as Completed
            </button>
          </div>
        )}

        {/* Completed state */}
        {task.status === 'completed' && (
          <div className="bg-green-950 border border-green-800 rounded-2xl px-4 py-4 text-center">
            <p className="text-green-400 font-semibold text-sm">✓ Task Completed</p>
          </div>
        )}

        {/* Activity log */}
        {log.length > 0 && (
          <div>
            <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-3">Activity Log</p>
            <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              {log.map((entry, i) => (
                <div key={entry.id}
                  className={`flex gap-3 items-start px-4 py-3 ${i < log.length - 1 ? 'border-b border-gray-800' : ''}`}>
                  <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 bg-gray-600" />
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-300 text-xs">
                      {formatLogAction(entry)}
                      {entry.note && <span className="text-gray-500"> — {entry.note}</span>}
                    </p>
                    <p className="text-gray-600 text-xs mt-0.5">
                      {entry.actor_name && <span className="text-gray-500 mr-1">{entry.actor_name} ·</span>}
                      {formatTime(entry.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}