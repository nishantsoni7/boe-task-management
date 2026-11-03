/**
 * Website Leads → BOE One (Sales, Phase 2).
 *
 * Lives in the "Website Leads" Google Sheet: Extensions, Apps Script, paste this whole file, Save.
 * Then, once:
 *   1. Project Settings (the gear), Script properties, Add: CAPTURE_KEY = the same secret as SALES_CAPTURE_SECRET in Vercel.
 *   2. Choose "setup" in the function list and press Run (Google asks to allow the script: allow it).
 * From then on, every five minutes, the rows the website form added since the last run go to BOE One. The rows already in
 * the sheet when setup runs are NOT sent: they came in with the sheet import. Nothing in the sheet is changed.
 * If BOE One cannot be reached, the same rows are tried again five minutes later; a row sent twice counts once.
 */

var SHEET = 'all_leads'
var ENDPOINT = 'https://boeone.vercel.app/api/sales/capture/website'
var BATCH = 100

function setup() {
  var props = PropertiesService.getScriptProperties()
  if (!props.getProperty('CAPTURE_KEY')) throw new Error('Add the script property CAPTURE_KEY first (Project Settings, Script properties).')
  var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET)
  if (!sheet) throw new Error('There is no tab called ' + SHEET + '.')
  props.setProperty('LAST_ROW', String(sheet.getLastRow()))
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t) })
  ScriptApp.newTrigger('sendNewLeads').timeBased().everyMinutes(5).create()
  Logger.log('Ready: rows after ' + sheet.getLastRow() + ' will be sent to BOE One every five minutes.')
}

/** The form rows from `values` (rows below the header), as BOE One takes them. Rows without a number are skipped. */
function leadRows(head, values) {
  var at = function (name) { return head.indexOf(name) }
  var cell = function (row, name) { var i = at(name); return i < 0 ? '' : String(row[i] == null ? '' : row[i]).trim() }
  var out = []
  values.forEach(function (row) {
    var phone = cell(row, 'your-tel')
    if (!phone) return
    var name = cell(row, 'your-name'), email = cell(row, 'your-email'), message = cell(row, 'your-textarea')
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, [phone, email, name, message].join('|'))
    var key = digest.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0') }).join('')
    out.push({ key: key, form_type: cell(row, 'form-type'), name: name, email: email, phone: phone, location: cell(row, 'your-location'), message: message })
  })
  return out
}

function sendNewLeads() {
  var lock = LockService.getScriptLock()
  if (!lock.tryLock(10000)) return
  try {
    var props = PropertiesService.getScriptProperties()
    var key = props.getProperty('CAPTURE_KEY')
    var sheet = SpreadsheetApp.getActive().getSheetByName(SHEET)
    var last = Number(props.getProperty('LAST_ROW') || 0)
    var end = sheet.getLastRow()
    if (!key || !last || end <= last) return
    var width = sheet.getLastColumn()
    var head = sheet.getRange(1, 1, 1, width).getValues()[0].map(String)
    var rows = leadRows(head, sheet.getRange(last + 1, 1, end - last, width).getValues())
    for (var i = 0; i < rows.length; i += BATCH) {
      var res = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify({ rows: rows.slice(i, i + BATCH) }),
      })
      if (res.getResponseCode() !== 200) {
        Logger.log('BOE One answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200) + '. Trying again in five minutes.')
        return
      }
    }
    props.setProperty('LAST_ROW', String(end))
  } finally {
    lock.releaseLock()
  }
}
