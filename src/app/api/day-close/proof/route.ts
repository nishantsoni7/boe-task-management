// POST /api/day-close/proof   body: the photo itself (image/jpeg, shrunk by the browser), answers { path }.
// Stored in the private 'day-proof' bucket under the caller's own folder; the path is then sent with
// "Done" on an item, which checks it is the caller's own (src/lib/dayClose/rules.ts isOwnPhotoPath).

import { NextRequest } from 'next/server'
import { dayCloseRoute } from '@/lib/dayClose/route'
import { uploadProof } from '@/lib/dayClose/server'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim()
  const bytes = await req.arrayBuffer().catch(() => new ArrayBuffer(0))
  return dayCloseRoute(req, 'proof', caller => uploadProof(caller, bytes, type))
}
