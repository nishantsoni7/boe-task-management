import { createClient as createServerClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { EXPIRING_SOON_DAYS, daysUntilWarrantyExpiry } from '@/lib/assets/warranty'
import { assetNotification } from '@/lib/assets/assetNotifications'

// Warranty-expiry reminders.
//
// "Warranty expiring soon" is the one required notification that no user action
// produces — a warranty crosses the 30-day line by itself, at midnight, with
// nobody clicking anything. It therefore needs a sweep.
//
// BOE has no scheduler for application code (the only cron in this system is a
// database job for task health), so this endpoint is called opportunistically
// by the Asset Inventory screen when someone who can act on the result opens
// it. That is honest about what it is: reminders appear when the inventory is
// being looked at, which is when they can be acted on anyway.
//
// Two properties make that safe rather than spammy:
//   * the recipient set and title come from the same assetNotification() rules
//     every other asset notification uses — there is no second vocabulary;
//   * duplicate suppression for this type uses a SEVEN-DAY window (see
//     /api/assets/notify), so opening the inventory ten times in an afternoon
//     produces at most one reminder per asset per week.
//
// It reads with the SERVICE ROLE deliberately: the sweep must see every asset
// with an expiring warranty, not only the ones the person who happened to open
// the page can read. Nothing is returned to the caller except counts.

export async function POST() {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const today = new Date()
  const horizon = new Date(today.getTime() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)

  // Assets whose warranty ends between today and the horizon. An already
  // expired warranty is deliberately NOT swept: the reminder exists to prompt a
  // renewal decision before the date, and a daily "this expired six months ago"
  // is noise. Retired and disposed assets are excluded for the same reason —
  // nobody is going to renew a warranty on something written off.
  const { data: assets, error } = await supabase
    .from('assets')
    .select('id, asset_name, asset_code, warranty_expiry_date, status')
    .not('warranty_expiry_date', 'is', null)
    .gte('warranty_expiry_date', iso(today))
    .lte('warranty_expiry_date', iso(horizon))
    .not('status', 'in', '("retired","disposed")')

  if (error) {
    console.error('[assets/warranty-sweep] read failed:', error.message)
    return NextResponse.json({ error: 'Could not check warranties' }, { status: 500 })
  }

  const rows = assets ?? []
  if (rows.length === 0) return NextResponse.json({ checked: 0, notified: 0 })

  const { data: adminRows } = await supabase
    .from('users').select('id').eq('role', 'admin').eq('is_active', true)
  const admins = (adminRows ?? []).map((r: { id: string }) => r.id)
  if (admins.length === 0) return NextResponse.json({ checked: rows.length, notified: 0 })

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  type PendingRow = {
    user_id: string
    task_id: null
    entity_id: string
    type: 'asset_warranty_expiring'
    title: string
    body: null
    is_push_sent: boolean
  }
  const pending: PendingRow[] = []

  for (const asset of rows) {
    const days = daysUntilWarrantyExpiry(asset.warranty_expiry_date, today)
    const { title } = assetNotification('asset_warranty_expiring', {
      assetName: asset.asset_name,
      assetCode: asset.asset_code,
      daysToExpiry: days,
    })

    for (const adminId of admins) {
      // The actor is not excluded here the way it is for user actions: nobody
      // "did" this, so an admin reading their own inventory should still be
      // reminded about a warranty they are responsible for.
      const { data: dup } = await supabase
        .from('notifications')
        .select('id')
        .eq('user_id', adminId)
        .eq('type', 'asset_warranty_expiring')
        .eq('entity_id', asset.id)
        .gte('created_at', windowStart)
        .limit(1)

      if (dup && dup.length > 0) continue

      pending.push({
        user_id: adminId,
        task_id: null,
        entity_id: asset.id,
        type: 'asset_warranty_expiring',
        title,
        body: null,
        is_push_sent: true,
      })
    }
  }

  if (pending.length === 0) return NextResponse.json({ checked: rows.length, notified: 0 })

  const { error: insertError } = await supabase.from('notifications').insert(pending)
  if (insertError) {
    console.error('[assets/warranty-sweep] insert failed:', insertError.message)
    return NextResponse.json({ error: 'Could not create warranty reminders' }, { status: 500 })
  }

  return NextResponse.json({ checked: rows.length, notified: pending.length })
}
