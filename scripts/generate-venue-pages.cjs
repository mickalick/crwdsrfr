/* generate-venue-pages.cjs
   Run whenever venues.json changes (new venue added, details edited):
     node generate-venue-pages.cjs
   Reads templates/venue-page.html and data/venues.json, and writes one
   static page per venue to venues/{id}/index.html. Fully regenerates
   every venue page on every run — see the conversation history for why
   that's the right call at this venue count.
*/
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'venue-page.html');
const VENUES_PATH = path.join(__dirname, '..', 'data', 'venues.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'venues');

const TYPE_LABELS = {
  "music-hall": "Music Hall",
  "club": "Club",
  "theater": "Theater",
  "arena": "Arena",
  "bar": "Bar",
  "outdoor": "Outdoor",
  "brewery": "Brewery",
  "jazz-bar": "Jazz Bar",
  "comedy-club": "Comedy Club",
  "diy": "DIY"
};

// Matches the same convention as events.js/venue-map.js — ignore a
// leading "The " when alphabetizing.
function sortableName(name) {
  return name.replace(/^the\s+/i, '');
}

// Minimal HTML-escaping for values interpolated into attributes/text.
// Venue names/addresses are your own data, not user input, but this
// guards against anything with a stray & or " breaking the markup.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function main() {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  const venues = JSON.parse(fs.readFileSync(VENUES_PATH, 'utf-8'));

  const sorted = [...venues].sort((a, b) =>
    sortableName(a.name).localeCompare(sortableName(b.name))
  );

  sorted.forEach((venue, i) => {
    const prev = sorted[(i - 1 + sorted.length) % sorted.length];
    const next = sorted[(i + 1) % sorted.length];

    const replacements = {
      '[VENUE NAME]': escapeHtml(venue.name),
      '[AREA]': escapeHtml(venue.area),
      '[TYPE]': escapeHtml(TYPE_LABELS[venue.type] || venue.type),
      '[ADDRESS]': escapeHtml(venue.address),
      '[PHONE_LINE]': venue.phone ? `<br/> ${escapeHtml(venue.phone)}` : '',
      '[URL]': escapeHtml(venue.url),
      '[LAT]': venue.lat,
      '[LNG]': venue.lng,
      '[ID]': venue.id,
      '[PREV_ID]': prev.id,
      '[PREV_NAME]': escapeHtml(prev.name),
      '[NEXT_ID]': next.id,
      '[NEXT_NAME]': escapeHtml(next.name),
    };

    let html = template;
    for (const [placeholder, value] of Object.entries(replacements)) {
      html = html.split(placeholder).join(value);
    }

    const venueDir = path.join(OUTPUT_DIR, venue.id);
    fs.mkdirSync(venueDir, { recursive: true });
    fs.writeFileSync(path.join(venueDir, 'index.html'), html);
  });

  console.log(`Generated ${sorted.length} venue pages in ${OUTPUT_DIR}`);
}

main();
