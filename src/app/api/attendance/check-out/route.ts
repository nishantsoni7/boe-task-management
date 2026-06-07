import { NextResponse } from 'next/server'

// Manual check-out removed in Attendance V1.1.
// BOE attendance is recorded via fingerprint machine and imported by CSV upload.
export async function POST() {
  return NextResponse.json(
    { error: 'Manual check-out is disabled. Use the attendance CSV import.' },
    { status: 410 }
  )
}
