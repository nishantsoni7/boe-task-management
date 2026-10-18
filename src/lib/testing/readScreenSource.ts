import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source-text tests read a screen's file to check what it contains. When a big
 * screen is split into sibling files, the code those tests look for moves with
 * it, and they would fail for a reason that is not a defect. Register the split
 * here and read the screen through readScreenSource: it returns the file followed
 * by its extracted siblings, so a test keeps asking "does this screen contain X".
 *
 * Tests that slice a FUNCTION out of a screen (indexOf('function Foo(')) should
 * keep reading the single file that holds that function.
 */
export const SCREEN_SIBLINGS: Record<string, string[]> = {
  'src/app/finance/received/ReceivedPaymentsView.tsx': [
    'src/app/finance/received/receivedPaymentsModel.tsx',
  ],
}

export function readScreenSource(path: string): string {
  const key = path.replace(/\\/g, '/')
  const files = [key, ...(SCREEN_SIBLINGS[key] ?? [])]
  return files.map(f => readFileSync(join(process.cwd(), f), 'utf8')).join('\n')
}
