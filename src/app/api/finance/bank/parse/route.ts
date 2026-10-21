import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { BankStatementError, parseHdfcStatement } from '@/lib/finance/bankStatement'

// Reading an uploaded HDFC statement (.xls / .xlsx) and saying what importing
// it would do. It WRITES NOTHING: the import itself is the import_bank_statement
// RPC, called by the page after the owner has seen this preview.
//
// WHY A ROUTE: the xlsx library is large and has no business in the browser
// bundle, and a spreadsheet is untrusted input — it is parsed here, on the
// server, behind the same permission the RPCs enforce.
//
// THE PERMISSION IS ASKED OF THE DATABASE, not decided here: preview_bank_statement
// begins with assert_bank_reconcile_door(), so a caller without finance.reconcile
// is refused by the same code that guards the import.

const MAX_BYTES = 5 * 1024 * 1024

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ ok: false, code, message }, { status })

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return fail(401, 'UNAUTHORIZED', 'Sign in again.')

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail(400, 'BAD_REQUEST', 'No file was received.')
  }
  const file = form.get('file')
  if (!(file instanceof File)) return fail(400, 'NO_FILE', 'Choose a statement file.')
  if (file.size === 0) return fail(400, 'EMPTY_FILE', 'That file is empty.')
  if (file.size > MAX_BYTES) return fail(400, 'TOO_LARGE', 'That file is larger than 5 MB; a bank statement is not.')
  if (!/\.(xls|xlsx)$/i.test(file.name)) return fail(400, 'WRONG_TYPE', 'Upload the .xls file downloaded from NetBanking.')

  const requested = form.get('account')
  const account = requested === 'hdfc' || requested === 'hdfc_sec' ? requested : null

  let statement
  try {
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { type: 'buffer', cellDates: false })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) throw new BankStatementError('The file has no sheet.')
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: '' })
    statement = parseHdfcStatement(rows)
  } catch (e) {
    if (e instanceof BankStatementError) return fail(422, 'NOT_A_STATEMENT', e.message)
    return fail(422, 'UNREADABLE', 'That file could not be read as a bank statement.')
  }

  const { data: preview, error } = await supabase.rpc('preview_bank_statement', {
    p_account_number: statement.accountNumber,
    p_account: account,
    p_lines: statement.lines,
  })
  if (error) {
    if (/BANK_FORBIDDEN|BANK_UNAUTHENTICATED/.test(error.message) || error.code === '42501') {
      return fail(403, 'FORBIDDEN', 'You do not have permission to reconcile bank statements.')
    }
    return fail(500, 'PREVIEW_FAILED', 'The statement was read, but checking it against the stored lines failed.')
  }

  // The full number goes back to the owner's own page, which hands it to
  // import_bank_statement; the page only ever DISPLAYS the last four digits.
  const { accountNumber, ...rest } = statement
  return NextResponse.json({
    ok: true,
    fileName: file.name,
    accountNumber,
    accountLast4: accountNumber.slice(-4),
    statement: rest,
    preview,
  })
}
