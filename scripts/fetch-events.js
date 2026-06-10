import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Setup for resolving file paths relative to this script
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to events.json, one level up from /scripts
const OUTPUT_PATH = join(__dirname, '..', 'events.json');

// Your SeatGeek API key
const SEATGEEK_CLIENT_ID = 'OTM4MDQ4OHwxNzgxMDUwNjkxLjk4OTY5NA';

// Rocket Arena's SeatGeek venue ID
const ROCKET_ARENA_VENUE_ID = 120;

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchRocketArena() {
  try {
    const url = `https://api.seatgeek.com/2/events?venue.id=${ROCKET_ARENA_VENUE_ID}&per_page=50&client_id=${SEATGEEK_CLIENT_ID}`;
    const res = await fetch(url);
    const data = await res.json();

    return data.events.map(event => {
      const datetime = new Date(event.datetime_local);
      const date = datetime.toISOString().split('T')[0];
      const time = datetime.toTimeString().slice(0, 5);

      const performers = event.performers.map(p => ({
        name: p.name,
        headliner: p.primary ?? false,
      }));

      const headliner = performers.find(p => p.headliner)?.name ?? event.title;
      const slug = headliner.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      return {
        id: `rocket-arena-${date}-${slug}`,
        title: event.title,
        venueId: 'rocket-arena',
        date,
        time,
        doors: null,
        price: null,
        performers,
        ticketUrl: event.url,
        source: 'seatgeek',
        manual: false,
      };
    });
  } catch (err) {
    console.error('fetchRocketArena error:', err.message);
    return [];
  }
}

async function fetchGrogShop() {
  try {
    const res = await fetch('https://grogshop.gs/event-details/');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    $('.tw-section').each((i, el) => {
      const titleEl = $(el).find('.tw-name a');
      const dateEl = $(el).find('.tw-event-date');
      const doorsEl = $(el).find('.tw-event-door-time');
      const showEl = $(el).find('.tw-event-time');
      const ticketEl = $(el).find('.tw-buy-tix-btn');
      const priceEl = $(el).find('.tw-price');

      if (!titleEl.length || !dateEl.length) return;

      const fullTitle = titleEl.text().trim();
      const dateRaw = dateEl.text().trim();
      const doorsRaw = doorsEl.text().trim();
      const showRaw = showEl.text().replace('Show:', '').trim();
      const ticketUrl = ticketEl.attr('href') ?? null;
      const price = priceEl.length ? priceEl.text().trim() : null;

      // Parse supporting acts from .tw-attractions spans
      const supportSpans = $(el).find('.tw-attractions span');
      const supporters = [];
      supportSpans.each((j, span) => {
        supporters.push($(span).text().trim());
      });

      const headlinerName = fullTitle.split(/,| –| -/)[0].trim();
      const performers = [{ name: headlinerName, headliner: true }];
      supporters.forEach(s => performers.push({ name: s, headliner: false }));

      const title = supporters.length
        ? `${headlinerName} w/ ${supporters.join(', ')}`
        : headlinerName;

      // Parse date — "Wed, Jun 10"
      const dateParts = dateRaw.replace(/^[A-Za-z]+,\s*/, '').trim();
      const [month, day] = dateParts.split(' ');
      const monthMap = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
      };
      const monthIndex = monthMap[month];
      if (monthIndex === undefined) return;

      const currentYear = new Date().getFullYear();
      const today = new Date();
      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, parseInt(day));
      if (eventDateThisYear < today) year = currentYear + 1;
      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = eventDate.toISOString().split('T')[0];

      function normalizeTime(t) {
        if (!t) return null;
        const [time, modifier] = t.trim().split(' ');
        let [hours, minutes] = time.split(':').map(Number);
        if (modifier?.toLowerCase() === 'pm' && hours !== 12) hours += 12;
        if (modifier?.toLowerCase() === 'am' && hours === 12) hours = 0;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }

      const slug = headlinerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      events.push({
        id: `grog-shop-${date}-${slug}`,
        title,
        venueId: 'grog-shop',
        date,
        time: normalizeTime(showRaw),
        doors: normalizeTime(doorsRaw),
        price,
        performers,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchGrogShop error:', err.message);
    return [];
  }
}

async function fetchAgora() {
  try {
    const res = await fetch('https://www.agoracleveland.com/events/all');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    $('.entry').each((i, el) => {
      const titleEl = $(el).find('h3.carousel_item_title_small a');
      const supportEl = $(el).find('h4.supporting');
      const dateEl = $(el).find('span.date');
      const timeEl = $(el).find('span.time');
      const ticketEl = $(el).find('a.btn-tickets');

      if (!titleEl.length || !dateEl.length) return;

      const headlinerName = titleEl.text().trim();
      const dateRaw = dateEl.text().replace(/[^a-zA-Z0-9,\s]/g, '').trim();
      const parsedDate = new Date(dateRaw);
      if (isNaN(parsedDate)) return;
      const date = parsedDate.toISOString().split('T')[0];

      const timeRaw = timeEl.text().replace('Doors', '').trim();
      const timeClean = timeRaw.replace(/[^0-9:\sAPMapm]/g, '').trim();

      function normalizeTime(t) {
        if (!t) return null;
        const [time, modifier] = t.trim().split(' ');
        let [hours, minutes] = time.split(':').map(Number);
        if (modifier?.toLowerCase() === 'pm' && hours !== 12) hours += 12;
        if (modifier?.toLowerCase() === 'am' && hours === 12) hours = 0;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }

      const supporters = supportEl.length
        ? supportEl.text().split(';').map(s => s.trim()).filter(Boolean)
        : [];

      const performers = [{ name: headlinerName, headliner: true }];
      supporters.forEach(s => performers.push({ name: s, headliner: false }));

      const title = supporters.length
        ? `${headlinerName} w/ ${supporters.join(', ')}`
        : headlinerName;

      const ticketUrl = ticketEl.attr('href') ?? null;
      const slug = headlinerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      events.push({
        id: `the-agora-${date}-${slug}`,
        title,
        venueId: 'the-agora',
        date,
        time: null,
        doors: normalizeTime(timeClean),
        price: null,
        performers,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchAgora error:', err.message);
    return [];
  }
}

async function fetchBeachland() {
  try {
    const res = await fetch('https://www.beachlandballroom.com/shows');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    $('.uui-layout88_item').each((i, el) => {
      const headlinerEl = $(el).find('h3.headliner');
      const supportEl = $(el).find('h3.artist-field');
      const month = $(el).find('.event-month').text().trim();
      const day = $(el).find('.event-day').text().trim();
      const doors = $(el).find('.uui-text-size-xlarge-white.bodyfont').first().text().trim();
      const showTime = $(el).find('.text-block-73').text().trim();
      const relativeUrl = $(el).find('a').attr('href');
      const nocoverEl = $(el).find('.text-block-61').filter((i, e) => $(e).text().trim() === 'No Cover');
      const isNoCover = nocoverEl.length && !nocoverEl.hasClass('w-condition-invisible');
      const price = isNoCover ? 'No Cover' : null;

      if (!headlinerEl.length || !month || !day) return;

      const headliner = headlinerEl.text().trim();
      const support = supportEl.text().trim();

      const currentYear = new Date().getFullYear();
      const monthMap = {
        Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
        Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
      };
      const monthIndex = monthMap[month];
      if (monthIndex === undefined) return;

      let year = currentYear;
      const today = new Date();
      const eventDateThisYear = new Date(currentYear, monthIndex, parseInt(day));
      if (eventDateThisYear < today) year = currentYear + 1;

      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = eventDate.toISOString().split('T')[0];

      function normalizeTime(t) {
        if (!t) return null;
        const [time, modifier] = t.split(' ');
        let [hours, minutes] = time.split(':').map(Number);
        if (modifier?.toLowerCase() === 'pm' && hours !== 12) hours += 12;
        if (modifier?.toLowerCase() === 'am' && hours === 12) hours = 0;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      }

      const performers = [{ name: headliner, headliner: true }];
      if (support) performers.push({ name: support, headliner: false });

      const slug = headliner.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      events.push({
        id: `beachland-ballroom-${date}-${slug}`,
        title: support ? `${headliner} with ${support}` : headliner,
        venueId: 'beachland-ballroom',
        date,
        time: normalizeTime(showTime),
        doors: normalizeTime(doors),
        price,
        performers,
        ticketUrl: relativeUrl ? `https://www.beachlandballroom.com${relativeUrl}` : null,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchBeachland error:', err.message);
    return [];
  }
}

// ─── Manual entries (Cebars etc.) ─────────────────────────────────────────────

function loadManualEntries() {
  try {
    const existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf-8'));
    return existing.events.filter(e => e.manual === true);
  } catch {
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching events...');

  const [rocketArena, grogShop, agora, beachland] = await Promise.all([
    fetchRocketArena(),
    fetchGrogShop(),
    fetchAgora(),
    fetchBeachland(),
  ]);

  const manualEntries = loadManualEntries();

  const allEvents = [
    ...rocketArena,
    ...grogShop,
    ...agora,
    ...beachland,
    ...manualEntries,
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  const output = {
    venues: {
      'grog-shop': { name: 'Grog Shop', url: 'https://grogshop.gs', eventsUrl: 'https://grogshop.gs/event-details/', city: 'Cleveland Heights' },
      'the-agora': { name: 'The Agora', url: 'https://agoracleveland.com', eventsUrl: 'https://www.agoracleveland.com/events/all', city: 'Cleveland' },
      'rocket-arena': { name: 'Rocket Arena', url: 'https://rocketarena.com', eventsUrl: 'https://seatgeek.com/venues/rocket-arena/tickets', city: 'Cleveland' },
      'beachland-ballroom': { name: 'Beachland Ballroom', url: 'https://beachlandballroom.com', eventsUrl: 'https://www.beachlandballroom.com', city: 'Cleveland' },
      'cebars': { name: 'Cebars', url: null, eventsUrl: null, city: 'Cleveland' },
    },
    events: allEvents,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Done! Wrote ${allEvents.length} events to events.json`);
}

main();