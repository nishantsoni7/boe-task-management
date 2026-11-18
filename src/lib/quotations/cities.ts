import { SUPPLY_STATES } from './math'

/**
 * The Client card asks for the delivery CITY (18 Nov 2026). The state still decides CGST + SGST or IGST and goes on the PI draft, so
 * typing a well-known city fills the state in. A city that is not here leaves the state as it is and the card says so: the state is
 * then picked under Advanced client details. Only cities that sit in one state are listed (no "Aurangabad": there is one in Bihar too).
 */
const CITIES_OF: Record<(typeof SUPPLY_STATES)[number], string> = {
  'Andhra Pradesh': 'Visakhapatnam, Vijayawada, Guntur, Tirupati, Nellore, Kurnool, Rajahmundry, Kakinada, Anantapur, Amaravati',
  'Arunachal Pradesh': 'Itanagar',
  'Assam': 'Guwahati, Dibrugarh, Silchar, Jorhat, Tezpur',
  'Bihar': 'Patna, Gaya, Bhagalpur, Muzaffarpur, Darbhanga, Bodh Gaya',
  'Chhattisgarh': 'Raipur, Bhilai, Durg, Korba',
  'Goa': 'Panaji, Panjim, Margao, Vasco da Gama, Mapusa, Calangute, Candolim, Baga, Anjuna',
  'Gujarat': 'Ahmedabad, Surat, Vadodara, Rajkot, Gandhinagar, Bhavnagar, Jamnagar, Junagadh, Morbi, Bhuj, Anand, Vapi',
  'Haryana': 'Gurugram, Gurgaon, Faridabad, Panipat, Ambala, Karnal, Hisar, Rohtak, Sonipat, Manesar',
  'Himachal Pradesh': 'Shimla, Manali, Dharamshala, Solan, Kullu, Mandi',
  'Jharkhand': 'Ranchi, Jamshedpur, Dhanbad, Bokaro',
  'Karnataka': 'Bengaluru, Bangalore, Mysuru, Mysore, Mangaluru, Mangalore, Hubballi, Hubli, Belagavi, Belgaum, Udupi, Madikeri, Coorg, Hampi',
  'Kerala': 'Kochi, Cochin, Thiruvananthapuram, Trivandrum, Kozhikode, Calicut, Thrissur, Kollam, Kannur, Munnar, Alappuzha, Alleppey, Kovalam',
  'Madhya Pradesh': 'Bhopal, Indore, Jabalpur, Gwalior, Ujjain, Khajuraho',
  'Maharashtra': 'Mumbai, Pune, Nagpur, Nashik, Thane, Navi Mumbai, Chhatrapati Sambhajinagar, Kolhapur, Solapur, Lonavala, Mahabaleshwar, Alibag',
  'Manipur': 'Imphal',
  'Meghalaya': 'Shillong',
  'Mizoram': 'Aizawl',
  'Nagaland': 'Kohima, Dimapur',
  'Odisha': 'Bhubaneswar, Cuttack, Puri, Rourkela',
  'Punjab': 'Ludhiana, Amritsar, Jalandhar, Patiala, Mohali, Bathinda',
  'Rajasthan': 'Jodhpur, Jaipur, Udaipur, Jaisalmer, Bikaner, Ajmer, Pushkar, Kota, Mount Abu, Alwar, Bhilwara, Sikar, Chittorgarh, Bundi, Ranthambore, Sawai Madhopur, Sri Ganganagar, Barmer, Pali, Nagaur',
  'Sikkim': 'Gangtok, Pelling',
  'Tamil Nadu': 'Chennai, Coimbatore, Madurai, Tiruchirappalli, Trichy, Salem, Tirunelveli, Erode, Vellore, Ooty, Kodaikanal, Mahabalipuram, Thanjavur',
  'Telangana': 'Hyderabad, Secunderabad, Warangal, Nizamabad, Karimnagar',
  'Tripura': 'Agartala',
  'Uttar Pradesh': 'Lucknow, Kanpur, Noida, Greater Noida, Ghaziabad, Agra, Varanasi, Prayagraj, Allahabad, Meerut, Bareilly, Mathura, Vrindavan, Aligarh, Gorakhpur',
  'Uttarakhand': 'Dehradun, Haridwar, Rishikesh, Nainital, Mussoorie, Haldwani',
  'West Bengal': 'Kolkata, Howrah, Siliguri, Darjeeling, Durgapur, Asansol',
  'Andaman and Nicobar Islands': 'Port Blair',
  'Chandigarh': 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu': 'Daman, Diu, Silvassa',
  'Delhi': 'Delhi, New Delhi',
  'Jammu and Kashmir': 'Srinagar, Jammu, Gulmarg, Pahalgam',
  'Ladakh': 'Leh',
  'Lakshadweep': 'Kavaratti',
  'Puducherry': 'Puducherry, Pondicherry',
  'Outside India (export)': 'Dubai, Abu Dhabi, Sharjah, Doha, Muscat, Riyadh, Jeddah, Kuwait City, Manama, Singapore, London, Kathmandu, Colombo, Male, Bangkok',
}

const key = (city: string) => city.trim().toLowerCase().replace(/\s+/g, ' ')

const STATE_OF = new Map<string, string>()
const NAMES: string[] = []
for (const [state, list] of Object.entries(CITIES_OF)) {
  for (const city of list.split(', ')) { STATE_OF.set(key(city), state); NAMES.push(city) }
}

/** The names offered as the person types. */
export const CITY_NAMES: readonly string[] = NAMES.sort((a, b) => a.localeCompare(b))

/** The state a well-known city is in, in the spelling of SUPPLY_STATES; null for any other city. */
export const stateOfCity = (city: string | null | undefined): string | null => STATE_OF.get(key(city ?? '')) ?? null
