// Which person each employee code in an attendance workbook belongs to.
//
// WHY THIS MODULE EXISTS
// ----------------------
// An attendance workbook identifies people by whatever code the device that
// wrote it uses, and the import turns that code into a user by looking it up in
// `users.fingerprint_employee_code`. When the lookup fails the block used to be
// dropped: its days were counted as "skipped", the admin was pointed at Employee
// Master, and nothing could be imported until somebody edited the employee
// record. That is the right answer for a code that is simply missing from the
// master — and the wrong answer for a workbook that comes from outside the
// device fleet entirely (the monthly file we receive from Santosh), where there
// is no device code to record because there is no device.
//
// So an admin may now name the employee for an unmatched code by hand. That
// makes the mapping an INPUT to the import rather than a fact derived from the
// database, and inputs to the import have to satisfy one hard requirement: the
// preview an admin approves and the import that follows must resolve every code
// identically. Resolution therefore lives here, is called by both routes, and is
// exercised by tests that neither route can drift away from.
//
// Nothing in this module touches the database or the request. It is given the
// blocks, the fingerprint lookup, the selectable users and the admin's choices,
// and it answers who each code is — or refuses, with a reason.

/** One admin choice: "the workbook's code X is this user". */
export type ManualEmployeeMapping = {
  excel_code: string
  user_id: string
}

/** A person a code resolved to, and how it got there. */
export type MappedEmployee = {
  id: string
  name: string
  /** True when an admin chose this employee rather than a device code matching. */
  manual: boolean
}

/** A code the file carries that no employee could be found for. */
export type UnmatchedBlock = {
  excel_code: string
  excel_name: string
  days: number
}

/** A manual choice that survived validation, echoed back so the UI can show it. */
export type AppliedManualMapping = {
  excel_code: string
  excel_name: string
  user_id: string
  employee_name: string
  days: number
}

/** The subset of a parsed block this module needs. */
export type MappableBlock = {
  empcode: string
  name: string
  days: unknown[]
}

/** A user an admin is allowed to pick, as the routes read them. */
export type SelectableUser = {
  id: string
  full_name: string | null
}

export type ResolvedMapping = {
  /** empcode → employee, for every code that resolved either way. */
  resolved: Map<string, MappedEmployee>
  /** Codes still unresolved after the manual choices were applied. */
  unmatched: UnmatchedBlock[]
  applied: AppliedManualMapping[]
}

export type MappingResult =
  | { ok: true; mapping: ResolvedMapping }
  | { ok: false; error: string }

/**
 * The `manualMappings` form field, validated into a list.
 *
 * The field is optional — an upload with no unmatched codes never sends it — and
 * absent is not the same as malformed. Absent yields an empty list; anything
 * present but not a list of `{excel_code, user_id}` string pairs is refused
 * rather than partially honoured, because a mapping silently dropped here would
 * import somebody's attendance onto the wrong person or onto nobody at all.
 */
export function parseManualMappings(
  raw: unknown,
): { ok: true; mappings: ManualEmployeeMapping[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, mappings: [] }
  if (typeof raw !== 'string') return { ok: false, error: 'Manual employee mapping must be sent as JSON text.' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'Manual employee mapping is not valid JSON.' }
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Manual employee mapping must be a list.' }
  }

  const mappings: ManualEmployeeMapping[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: 'Each manual employee mapping must be an object.' }
    }
    const { excel_code, user_id } = entry as Record<string, unknown>
    if (typeof excel_code !== 'string' || excel_code.trim() === '') {
      return { ok: false, error: 'Each manual employee mapping needs the code it applies to.' }
    }
    if (typeof user_id !== 'string' || user_id.trim() === '') {
      return { ok: false, error: 'Each manual employee mapping needs the employee it maps to.' }
    }
    mappings.push({ excel_code: excel_code.trim(), user_id: user_id.trim() })
  }

  return { ok: true, mappings }
}

/**
 * Every code in the workbook resolved to a person, or a refusal with a reason.
 *
 * Automatic matching runs first and WINS: a manual choice may only name a code
 * the device lookup could not place. Overriding a code that did match would let
 * one upload quietly redirect an employee's attendance onto a colleague, and an
 * admin who genuinely needs that has Employee Master to do it in, where the
 * change is visible afterwards.
 *
 * The refusals below are all forms of the same hazard — two codes landing on one
 * person within a single import. Both codes carry days for the same dates, they
 * would be written and then overwritten in an order nothing defines, and the
 * report would state that both were imported. That is worse than not importing,
 * so it is a refusal rather than a warning.
 */
export function resolveEmployeeMapping(input: {
  blocks: MappableBlock[]
  /** fingerprint_employee_code → user, as the device lookup provides it. */
  fingerprintToUser: Map<string, { id: string; name: string }>
  manualMappings: ManualEmployeeMapping[]
  /** The users an admin may choose from. A choice outside this list is refused. */
  selectableUsers: SelectableUser[]
}): MappingResult {
  const { blocks, fingerprintToUser, manualMappings, selectableUsers } = input

  const usersById = new Map(selectableUsers.map(u => [u.id, u]))

  // Pass 1 — the device lookup, unchanged in meaning from what both routes did
  // inline before.
  const resolved = new Map<string, MappedEmployee>()
  const unmatchedByCode = new Map<string, UnmatchedBlock>()
  const blocksByCode = new Map<string, MappableBlock>()
  /** user id → the code already claiming that person. */
  const claimedBy = new Map<string, string>()

  for (const block of blocks) {
    blocksByCode.set(block.empcode, block)
    const matched = fingerprintToUser.get(block.empcode)
    if (matched) {
      resolved.set(block.empcode, { id: matched.id, name: matched.name, manual: false })
      claimedBy.set(matched.id, block.empcode)
    } else {
      unmatchedByCode.set(block.empcode, {
        excel_code: block.empcode,
        excel_name: block.name,
        days: block.days.length,
      })
    }
  }

  // Pass 2 — the admin's choices, each checked against the file and the people
  // pass 1 already placed.
  const applied: AppliedManualMapping[] = []
  const seenCodes = new Set<string>()

  for (const mapping of manualMappings) {
    const { excel_code, user_id } = mapping

    if (seenCodes.has(excel_code)) {
      return { ok: false, error: `Code "${excel_code}" was assigned to more than one employee.` }
    }
    seenCodes.add(excel_code)

    const block = blocksByCode.get(excel_code)
    if (!block) {
      return { ok: false, error: `Code "${excel_code}" is not in this file. Re-run the preview and choose again.` }
    }

    const auto = resolved.get(excel_code)
    if (auto && !auto.manual) {
      return {
        ok: false,
        error: `Code "${excel_code}" already matches ${auto.name} by fingerprint code. ` +
               `Manual selection is only for codes that could not be matched.`,
      }
    }

    const user = usersById.get(user_id)
    if (!user) {
      return { ok: false, error: `The employee chosen for code "${excel_code}" was not found.` }
    }

    const alreadyClaimed = claimedBy.get(user_id)
    if (alreadyClaimed !== undefined) {
      return {
        ok: false,
        error: `${user.full_name ?? 'That employee'} is already being imported from code ` +
               `"${alreadyClaimed}" in this file. One employee cannot receive two codes in one import.`,
      }
    }

    const employee_name = user.full_name ?? user_id
    resolved.set(excel_code, { id: user_id, name: employee_name, manual: true })
    claimedBy.set(user_id, excel_code)
    unmatchedByCode.delete(excel_code)

    applied.push({
      excel_code,
      excel_name: block.name,
      user_id,
      employee_name,
      days: block.days.length,
    })
  }

  return {
    ok: true,
    mapping: { resolved, unmatched: [...unmatchedByCode.values()], applied },
  }
}
