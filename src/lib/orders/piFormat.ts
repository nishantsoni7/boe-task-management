/**
 * THE APPROVED PI FORMAT — the Excel workbook sales staff fill in to prepare a PI.
 *
 * It is a fixed, approved file, not something the app generates: it carries
 * example data on purpose, so a reader can see how each part is filled. So it is
 * served byte for byte, and never rebuilt, blanked or re-exported.
 *
 * WHERE IT LIVES. The repository is public, so the workbook is NOT checked in and
 * NOT under public/. It sits in the private `order-files` bucket at a key outside
 * `submissions/`. That bucket's client policies only ever reach
 * `submissions/{uuid}/...` (order_file_submission_id() is null for any other
 * prefix), so no browser session can list, read or overwrite it. Only the service
 * role reads it, and only inside /api/orders/pi-format after the reader has
 * passed the Orders module-entry rule.
 *
 * WHO MAY DOWNLOAD IT. Anybody who can enter Order Management: an active admin, or
 * an active user with effective `orders.view`. NOT `orders.create`. A viewer who
 * cannot upload a PI still needs to see what one looks like.
 */

/** The dashboard control: one link, offered to everyone who reaches the page. */
export const PI_FORMAT_ACTION = {
  label: 'Download PI Format',
  href: '/api/orders/pi-format',
  title: 'Download the approved PI Excel format, with example data showing how to fill it in',
} as const

/** The name the browser saves it under. */
export const PI_FORMAT_FILENAME = 'BOE-PI-Format.xlsx'

/** The object key inside ORDER_FILES_BUCKET. Deliberately outside `submissions/`. */
export const PI_FORMAT_OBJECT_PATH = 'templates/pi-format.xlsx'

export const PI_FORMAT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/**
 * The approved workbook's identity. The route refuses to serve any other bytes,
 * so a replaced or corrupted object is reported rather than handed to sales.
 */
export const PI_FORMAT_SHA256 = 'bca0709880fae20db990107a5239efd18227de6b42c4caf4f494a311f8aa167f'
export const PI_FORMAT_BYTES = 2_197_031
