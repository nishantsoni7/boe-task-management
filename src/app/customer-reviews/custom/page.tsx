'use client'

import { CustomSubmissionsScreen } from '../CustomSubmissionsScreen'

// The verifier's queue of Custom Review Submissions: reviews employees arranged
// themselves, with the screenshot that proves each was published. The screen
// sends anyone without `verify` back to the module root.
export default function CustomSubmissionsPage() {
  return <CustomSubmissionsScreen />
}
