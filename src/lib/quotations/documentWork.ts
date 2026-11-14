// The "Our work" page of the client document: the owner's own project photographs, matched to the kind of venue the
// quotation is for. Files are in public/quotation/work. A caption (venue name, city, what BOE supplied) is printed only
// when the owner has supplied it for that photo; until then a photo prints with no caption and never a placeholder.
// Not used, on purpose: the photograph with a client venue's sign (Geist Brewing Co.), until that client allows it.

import { countsRooms, countsSeats, type ProjectType } from './documentPlan'

export type WorkPhoto = { src: string; alt: string; caption?: string }
export type WorkSet = { kicker: string; layout: 'wide-first' | 'grid'; photos: WorkPhoto[] }

const P = (name: string, alt: string, caption?: string): WorkPhoto => ({ src: `/quotation/work/${name}.jpg`, alt, ...(caption ? { caption } : {}) })

const HOTEL = [
  P('hotel-wide', 'A hotel room with a four-poster bed, a sofa and painted panels'),
  P('hotel-1', 'A hotel bedroom under a timber-beamed roof, with a bench at the foot of the bed'),
  P('hotel-2', 'A four-poster bed in a white room'),
  P('hotel-3', 'A living and dining room with cane chairs'),
]
const RESTAURANT = [
  P('rest-1', 'A courtyard restaurant with a bar, tables and trees'),
  P('rest-2', 'A bar with glass chandeliers and cane chairs'),
  P('rest-3', 'A restaurant under a timber lattice ceiling'),
  P('rest-4', 'A dining room with arched shelves and cane chairs'),
  P('rest-5', 'A restaurant with a wall of spice spoons'),
  P('rest-6', 'An open kitchen counter with orange chairs'),
]

export function workSetFor(type: ProjectType | null): WorkSet {
  if (countsRooms(type)) return { kicker: 'Our work · hotels and resorts', layout: 'wide-first', photos: HOTEL }
  if (countsSeats(type)) return { kicker: 'Our work · restaurants, cafés and breweries', layout: 'grid', photos: RESTAURANT }
  return { kicker: 'Our work', layout: 'grid', photos: [HOTEL[1], RESTAURANT[0], HOTEL[2], RESTAURANT[2], HOTEL[3], RESTAURANT[5]] }
}

/** The line beside the pictures: the catalogue's own words. */
export const WORK_PULL = 'Furniture built for daily hospitality use: custom sizes, woods, fabrics and finishes.'
