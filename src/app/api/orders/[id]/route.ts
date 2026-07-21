import { NextRequest, NextResponse } from 'next/server'

// DELETE /api/orders/[id] — permanently refused.
//
// This route used to hard-delete a Confirmed Order with a SERVICE-ROLE client,
// guarded only by an admin check plus two business checks. That made it the most
// dangerous delete path in the system: a service-role client bypasses RLS
// entirely, so no policy could ever constrain it, and any Order that happened to
// lack provenance and approved payments was one request away from being erased.
//
// Confirmed Orders are now permanent business history (migration
// 20260705000000). The database enforces that for every path, including this
// one — public.orders has no DELETE policy at all, and the BEFORE DELETE trigger
// orders_prevent_delete raises for the service role and direct SQL too. So this
// handler could not delete an Order even if it tried.
//
// It is kept, rather than removed, so that anything still calling it gets a
// clear explanation instead of a 404 that reads like a bug. Removing a test
// Order during the testing phase goes through Admin Control Center → Test Data
// Cleanup, which is admin-gated, audited, and refuses anything that is not
// verified test data.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await params

  return NextResponse.json({
    error:
      'Confirmed Orders are permanent business history and cannot be deleted. '
      + 'A test Order can be removed through Admin Control Center → Test Data Cleanup while testing is enabled.',
  }, { status: 403 })
}
