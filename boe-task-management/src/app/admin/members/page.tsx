'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

type Member = {
  id: string
  full_name: string
  email: string
  phone: string | null
  role: string
  team: string
  is_active: boolean
  created_at: string
}

const TEAMS = ['sales', 'operations', 'design', 'purchase', 'bdm', 'management']
const ROLES = ['member', 'manager', 'admin']

export default function MembersPage() {
  const [members, setMembers]     = useState<Member[]>([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')
  const [full_name, setFullName]  = useState('')
  const [email, setEmail]         = useState('')
  const [phone, setPhone]         = useState('')
  const [role, setRole]           = useState('member')
  const [team, setTeam]           = useState('sales')
  const [password, setPassword]   = useState('')
  const router   = useRouter()
  const supabase = createClient()

  useEffect(() => {
    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: profile } = await supabase
        .from('users').select('role').eq('id', user.id).single()

      if (profile?.role !== 'admin') {
        router.push('/dashboard')
        return
      }

      await loadMembers()
      setLoading(false)
    }
    init()
  }, [])

  const loadMembers = async () => {
    const { data } = await supabase
      .from('users')
      .select('*')
      .order('full_name')
    if (data) setMembers(data)
  }

  const handleCreate = async () => {
    if (!full_name.trim() || !email.trim() || !password.trim()) {
      setError('Name, email and password are required')
      return
    }
    setSaving(true)
    setError('')

    const res = await fetch('/api/create-user', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email:     email.trim(),
        password:  password.trim(),
        full_name: full_name.trim(),
        phone:     phone.trim() || null,
        role,
        team,
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Failed to create member')
      setSaving(false)
      return
    }

    setFullName('')
    setEmail('')
    setPhone('')
    setPassword('')
    setRole('member')
    setTeam('sales')
    setShowForm(false)
    await loadMembers()
    setSaving(false)
  }

  const toggleActive = async (member: Member) => {
    await supabase
      .from('users')
      .update({ is_active: !member.is_active })
      .eq('id', member.id)
    await loadMembers()
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-400 text-sm">Loading...</p>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950">

      {/* Top bar */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => router.push('/dashboard')} className="text-gray-400 hover:text-white text-sm">
          ← Back
        </button>
        <h1 className="text-white font-semibold text-base flex-1">Team Members</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
        >
          {showForm ? 'Cancel' : '+ Add Member'}
        </button>
      </div>

      <div className="px-4 py-6 max-w-lg mx-auto flex flex-col gap-4">

        {/* Add member form */}
        {showForm && (
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-4 flex flex-col gap-3">
            <p className="text-white text-sm font-semibold mb-1">New Team Member</p>

            {error && (
              <div className="bg-red-950 border border-red-800 rounded-xl px-3 py-2">
                <p className="text-red-400 text-xs">{error}</p>
              </div>
            )}

            <input
              value={full_name}
              onChange={e => setFullName(e.target.value)}
              placeholder="Full name"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Email address"
              type="email"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
            <input
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="Phone number (optional)"
              type="tel"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
            <input
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Temporary password"
              type="password"
              className="w-full bg-gray-800 text-white rounded-xl px-4 py-3 text-sm border border-gray-700 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />

            {/* Role */}
            <div>
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">Role</p>
              <div className="flex gap-2">
                {ROLES.map(r => (
                  <button key={r} onClick={() => setRole(r)}
                    style={role === r ? {background:'#2563eb',color:'#fff'} : {background:'#1f2937',color:'#9ca3af'}}
                    className="flex-1 py-2 rounded-xl text-xs font-semibold capitalize transition-colors">
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Team */}
            <div>
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider mb-2">Team</p>
              <div className="flex flex-wrap gap-2">
                {TEAMS.map(t => (
                  <button key={t} onClick={() => setTeam(t)}
                    style={team === t ? {background:'#2563eb',color:'#fff'} : {background:'#1f2937',color:'#9ca3af'}}
                    className="px-3 py-2 rounded-xl text-xs font-semibold capitalize transition-colors">
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={saving}
              className="w-full bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 hover:bg-blue-500 text-white font-semibold py-3.5 rounded-xl text-sm transition-colors mt-1"
            >
              {saving ? 'Creating...' : 'Create Member'}
            </button>
          </div>
        )}

        {/* Members list */}
        <div className="flex flex-col gap-2">
          {members.map((member) => (
            <div key={member.id}
              style={{background:'#111827', border:'1px solid #1f2937', borderRadius:'16px', padding:'14px'}}>
              <div className="flex items-center gap-3">
                <div style={{width:'40px', height:'40px', borderRadius:'50%', background:'#1f2937', display:'flex', alignItems:'center', justifyContent:'center', fontSize:'13px', fontWeight:600, color:'#9ca3af', flexShrink:0}}>
                  {member.full_name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium">{member.full_name}</p>
                  <p className="text-gray-500 text-xs">{member.email}</p>
                </div>
                <button
                  onClick={() => toggleActive(member)}
                  style={{
                    padding:'4px 10px', borderRadius:'20px', fontSize:'11px', fontWeight:500,
                    background: member.is_active ? '#14532d' : '#1f2937',
                    color:      member.is_active ? '#86efac' : '#6b7280',
                  }}>
                  {member.is_active ? 'Active' : 'Inactive'}
                </button>
              </div>
              <div className="flex gap-2 mt-3">
                <span style={{background:'#1f2937', color:'#9ca3af', fontSize:'11px', padding:'2px 8px', borderRadius:'20px', textTransform:'capitalize'}}>
                  {member.role}
                </span>
                <span style={{background:'#1f2937', color:'#9ca3af', fontSize:'11px', padding:'2px 8px', borderRadius:'20px', textTransform:'capitalize'}}>
                  {member.team}
                </span>
                {member.phone && (
                  <span style={{background:'#1f2937', color:'#9ca3af', fontSize:'11px', padding:'2px 8px', borderRadius:'20px'}}>
                    {member.phone}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}