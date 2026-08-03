/* geocode-venues.cjs
   Run manually when adding new venues to venues.json:
     node geocode-venues.cjs
   Reads venues.json, geocodes any venue missing lat/lng, and writes
   the coordinates back into venues.json directly. Never needs to run
   on a schedule — only when a venue with no coordinates is added.
*/
const fs = require('fs');
const path = require('path');

const VENUES_PATH = path.join(__dirname, '..', 'data', 'venues.json');
const API_KEY = process.env.GOOGLE_GEOCODE_API_KEY;

async function geocodeAddress(address) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') throw new Error(`Geocode failed for "${address}": ${data.status}`);
  return data.results[0].geometry.location; // { lat, lng }
}

(async function main() {
  const venues = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf8'));
  let updated = false;

  for (const venue of venues) {
    if (typeof venue.lat === 'number' && typeof venue.lng === 'number') continue; // already geocoded
    console.log(`Geocoding ${venue.name}...`);
    try {
      const { lat, lng } = await geocodeAddress(venue.address);
      venue.lat = lat;
      venue.lng = lng;
      updated = true;
      console.log(`  → ${lat}, ${lng}`);
    } catch (err) {
      console.warn(`  ✗ ${err.message}`);
    }
  }

  if (updated) {
    fs.writeFileSync(VENUES_PATH, JSON.stringify(venues, null, 2));
    console.log('Updated venues.json with new coordinates.');
  } else {
    console.log('Nothing to geocode — every venue already has coordinates.');
  }
})();
