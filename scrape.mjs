import { load } from 'cheerio';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const BASE_URL = 'https://www.smashultimate.fr/tournaments';
const GEOCODE_API = 'https://api-adresse.data.gouv.fr/search/';
const MAX_PAGES = 10;
const GEOCODE_DELAY = 100;

// --- Cache ---
const CACHE_FILE = new URL('./geocode-cache.json', import.meta.url).pathname;
let geocodeCache = {};
if (existsSync(CACHE_FILE)) {
  geocodeCache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
}

function saveCache() {
  writeFileSync(CACHE_FILE, JSON.stringify(geocodeCache, null, 2));
}

// --- Date parsing ---
const MONTHS = {
  'January': '01', 'February': '02', 'March': '03', 'April': '04',
  'May': '05', 'June': '06', 'July': '07', 'August': '08',
  'September': '09', 'October': '10', 'November': '11', 'December': '12'
};

function parseDate(dateStr) {
  // Format: "01 April" or "01 April 2026"
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const day = parts[0].padStart(2, '0');
  const monthName = parts[1];
  const month = MONTHS[monthName];
  if (!month) return null;

  const now = new Date();
  let year = parts[2] || now.getFullYear();
  const candidate = new Date(`${year}-${month}-${day}`);

  // If date is more than 30 days in the past, assume next year
  if (!parts[2]) {
    const diffDays = (now - candidate) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) year = now.getFullYear() + 1;
  }

  return `${year}-${month}-${day}`;
}

// --- Scraping ---
async function fetchPage(filter, page) {
  const url = `${BASE_URL}?filter=${filter}&page=${page}`;
  console.log(`  Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseTournaments(html) {
  const $ = load(html);
  const tournaments = [];

  // Find upcoming tab content
  const upcomingTab = $('#upcoming');
  if (!upcomingTab.length) return tournaments;

  upcomingTab.find('tr[data-component="tournament"]').each((_, el) => {
    const $row = $(el);
    const id = $row.attr('data-id');
    const externalUrl = $row.attr('data-external_url');
    const tds = $row.find('td');

    // td[0] = icon, td[1] = date, td[2] = name, td[3] = city (mobile), td[4] = address, td[5] = seats
    const dateStr = tds.eq(1).text().trim();
    const name = tds.eq(2).text().trim();
    const city = tds.eq(3).text().trim();
    const address = tds.eq(4).text().trim();
    const seats = tds.eq(5).text().trim();

    if (name) {
      tournaments.push({
        id,
        name,
        date: parseDate(dateStr),
        dateRaw: dateStr,
        city,
        address,
        seats: seats === '-' ? null : seats,
        url: externalUrl || `https://www.smashultimate.fr/tournament/${id}`,
      });
    }
  });

  return tournaments;
}

async function scrapeFilter(filter) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(filter, page);
    const tournaments = parseTournaments(html);
    if (tournaments.length === 0) break;
    all.push(...tournaments);
  }
  return all;
}

// --- Geocoding ---
async function geocode(address) {
  if (geocodeCache[address]) return geocodeCache[address];

  await new Promise(r => setTimeout(r, GEOCODE_DELAY));
  const url = `${GEOCODE_API}?q=${encodeURIComponent(address)}&limit=1`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const feature = data.features[0];
      const [lon, lat] = feature.geometry.coordinates;
      const score = feature.properties.score;

      // If score is too low, try with just postal code + city
      if (score < 0.3) {
        const match = address.match(/(\d{5})\s+(.+)$/);
        if (match) {
          const fallbackQuery = `${match[1]} ${match[2]}`;
          const res2 = await fetch(`${GEOCODE_API}?q=${encodeURIComponent(fallbackQuery)}&limit=1`);
          const data2 = await res2.json();
          if (data2.features && data2.features.length > 0) {
            const [lon2, lat2] = data2.features[0].geometry.coordinates;
            const result = { lat: lat2, lon: lon2 };
            geocodeCache[address] = result;
            return result;
          }
        }
      }

      const result = { lat, lon };
      geocodeCache[address] = result;
      return result;
    }
  } catch (e) {
    console.warn(`  Geocoding failed for "${address}": ${e.message}`);
  }
  return null;
}

// --- Main ---
async function main() {
  console.log('=== Scraping upcoming SSBU tournaments ===\n');

  // Scrape weekly first to identify them
  console.log('Scraping weekly tournaments...');
  const weeklyTournaments = await scrapeFilter('weekly');
  const weeklyIds = new Set(weeklyTournaments.map(t => t.id));
  console.log(`  Found ${weeklyTournaments.length} weekly tournaments\n`);

  // Scrape all
  console.log('Scraping all tournaments...');
  const allTournaments = await scrapeFilter('all');
  console.log(`  Found ${allTournaments.length} total tournaments\n`);

  // Merge and categorize
  const byId = new Map();
  for (const t of allTournaments) {
    t.type = weeklyIds.has(t.id) ? 'weekly' : 'tournoi';
    byId.set(t.id, t);
  }
  // Add any weekly-only tournaments not in "all"
  for (const t of weeklyTournaments) {
    if (!byId.has(t.id)) {
      t.type = 'weekly';
      byId.set(t.id, t);
    }
  }

  const tournaments = [...byId.values()];
  console.log(`Total unique tournaments: ${tournaments.length}\n`);

  // Geocode
  console.log('Geocoding addresses...');
  let geocoded = 0;
  let failed = 0;
  for (const t of tournaments) {
    const coords = await geocode(t.address);
    if (coords) {
      t.lat = coords.lat;
      t.lon = coords.lon;
      geocoded++;
    } else {
      // Try city name as fallback
      const cityCoords = await geocode(t.city + ', France');
      if (cityCoords) {
        t.lat = cityCoords.lat;
        t.lon = cityCoords.lon;
        geocoded++;
      } else {
        failed++;
        console.warn(`  Could not geocode: "${t.name}" at "${t.address}"`);
      }
    }
  }
  saveCache();
  console.log(`  Geocoded: ${geocoded}, Failed: ${failed}\n`);

  // Filter out tournaments without coordinates
  const validTournaments = tournaments.filter(t => t.lat && t.lon);

  // Clean up internal fields
  const output = {
    scraped_at: new Date().toISOString(),
    count: validTournaments.length,
    tournaments: validTournaments.map(t => ({
      id: t.id,
      name: t.name,
      date: t.date,
      city: t.city,
      address: t.address,
      seats: t.seats,
      url: t.url,
      type: t.type,
      lat: t.lat,
      lon: t.lon,
    })),
  };

  // Write JSON
  const outPath = new URL('./tournaments.json', import.meta.url).pathname;
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.count} tournaments to tournaments.json`);

  // --inline flag: embed JSON into index.html
  if (process.argv.includes('--inline')) {
    const htmlPath = new URL('./index.html', import.meta.url).pathname;
    const mapPath = new URL('./map.html', import.meta.url).pathname;
    if (existsSync(htmlPath)) {
      let html = readFileSync(htmlPath, 'utf-8');
      html = html.replace(
        '__TOURNAMENT_DATA__',
        JSON.stringify(output)
      );
      writeFileSync(mapPath, html);
      console.log('Wrote self-contained map.html');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
