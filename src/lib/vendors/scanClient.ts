import type { createClient } from '@/lib/supabase/client'
import { ScanError } from '@/lib/exhibitionLeads/scanClient'
import type { VendorScanApiResponse, VendorScanResult } from './scan'

// The browser's half of scanning a vendor's card or name plate. The photograph is shrunk by the same helper the
// Exhibition Leads scan uses (shrinkPhoto), then sent once; nothing is kept.

type Supabase = ReturnType<typeof createClient>

export { ScanError, shrinkPhoto } from '@/lib/exhibitionLeads/scanClient'

export async function scanVendorPhoto(supabase: Supabase, photo: Blob): Promise<VendorScanResult> {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new ScanError('auth', 'Your session ended. Sign in again, then scan.')

  const body = new FormData()
  body.set('image', new File([photo], 'scan.jpg', { type: 'image/jpeg' }))

  let res: Response
  try {
    res = await fetch('/api/vendors/scan', {
      method: 'POST', body, headers: { Authorization: `Bearer ${session.access_token}` },
    })
  } catch {
    throw new ScanError('failed', 'No connection. Check the network, or type the details.')
  }
  const json = await res.json().catch(() => null) as VendorScanApiResponse | null
  if (!json) throw new ScanError('failed', 'Could not read the photo right now. Try again, or type the details.')
  if (!json.ok) throw new ScanError(json.code, json.error)
  return json.result
}
