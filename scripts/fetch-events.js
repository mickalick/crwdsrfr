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

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

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
        eventUrl: null,
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

      const venueName = $(el).find('.tw-venue-details .tw-venue-name').text().trim();
      if (!venueName || venueName !== 'Grog Shop') return;

      const fullTitle = titleEl.text().trim();
      const dateRaw = dateEl.text().trim();
      const doorsRaw = doorsEl.text().trim();
      const showRaw = showEl.text().replace('Show:', '').trim();
      const ticketUrl = ticketEl.attr('href') ?? null;
      const eventUrl = titleEl.attr('href') ?? null;
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
      const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = toLocalDateStr(eventDate);

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
        eventUrl,
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
      const date = toLocalDateStr(parsedDate);

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
      const eventUrl = titleEl.attr('href') ?? null;
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
        eventUrl,
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
      const doors = $(el).find('.presenter-div.time .uui-text-size-xlarge-white.bodyfont').first().text().trim();
      const showTime = $(el).find('.text-block-73').text().trim();
      const relativeUrl = $(el).find('a').attr('href');
      const nocoverEl = $(el).find('.text-block-61').filter((i, e) => $(e).text().trim() === 'No Cover');
      const isNoCover = nocoverEl.length && !nocoverEl.hasClass('w-condition-invisible');
      const price = isNoCover ? 'No Cover' : null;

      if (!headlinerEl.length || !headlinerEl.text().trim() || !month || !day) return;

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
      const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;

      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = toLocalDateStr(eventDate);

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
      const fullUrl = relativeUrl ? `https://www.beachlandballroom.com${relativeUrl}` : null;

      events.push({
        id: `beachland-ballroom-${date}-${slug}`,
        title: support ? `${headliner} with ${support}` : headliner,
        venueId: 'beachland-ballroom',
        date,
        time: normalizeTime(showTime),
        doors: normalizeTime(doors),
        price,
        performers,
        eventUrl: fullUrl,
        ticketUrl: fullUrl ? `${fullUrl}#tickets` : null,
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

async function fetchMetroparks() {
  try {
    const res = await fetch('https://www.clevelandmetroparks.com/parks/special-events/summerconcertseries');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    const venueIdMap = {
      'The Noshery at Huntington Beach Concerts': 'metroparks-huntington',
      'Euclid Beach Concerts': 'metroparks-euclid-beach',
      'Edgewater Beach Concerts': 'metroparks-edgewater',
      'Emerald Necklace Marina Concerts': 'metroparks-emerald-necklace',
      'The Galley at Patrick S. Parker Community Sailing Center Concerts': 'metroparks-galley',
      "Merwin's Wharf Concerts": 'metroparks-merwins-wharf',
    };

    const monthMap = {
      Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
      Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
      June: 5, July: 6, August: 7, September: 8, October: 9,
      November: 10, December: 11, January: 0, February: 1,
      March: 2, April: 3,
    };

    $('.accordion-listing__item').each((i, el) => {
      const venueName = $(el).find('.accordion-button').text().trim();
      const venueId = venueIdMap[venueName];
      if (!venueId) return;

      $(el).find('.accordion-content p').each((j, p) => {
        const text = $(p).text().trim();
        const match = text.match(/^(\w+)\s+(\d+)\s*[-–]\s*(.+?)\s*\|\s*(.+)$/);
        if (!match) return;

        const [, monthStr, dayStr, artistRaw, genre] = match;
        const monthIndex = monthMap[monthStr];
        if (monthIndex === undefined) return;

        const day = parseInt(dayStr);
        const today = new Date();
        const currentYear = today.getFullYear();
        const eventDateThisYear = new Date(currentYear, monthIndex, day);
        const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
        const year = eventDateThisYear < todayMidnight ? currentYear + 1 : currentYear;
        const date = toLocalDateStr(new Date(year, monthIndex, day));

        const artistName = artistRaw.trim();
        const slug = artistName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

        events.push({
          id: `${venueId}-${date}-${slug}`,
          title: artistName,
          venueId,
          date,
          time: '17:00',
          doors: null,
          price: 'Free',
          performers: [{ name: artistName, headliner: true }],
          eventUrl: 'https://www.clevelandmetroparks.com/parks/special-events/summerconcertseries',
          ticketUrl: null,
          source: 'scrape',
          manual: false,
        });
      });
    });

    return events;
  } catch (err) {
    console.error('fetchMetroparks error:', err.message);
    return [];
  }
}

async function fetchRockinOnTheRiver() {
  try {
    const venueId = 'rockin-on-the-river';
    const defaultDoors = '17:30';
    const defaultTime = '18:15';

    const res = await fetch('https://www.rockinontheriver.com/2026?shem=rimspwouoe');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    // Each event lives inside one of Wix's repeater item containers.
    // We can't rely on the randomized IDs (they change per page build),
    // but the repeater + rich-text/button class fragments are stable.
    $('[id*="__item-"]').each((i, el) => {
      const $el = $(el);

      // Only treat this as an event card if it has both a date paragraph
      // and a title heading - filters out image-only / nested wrapper divs.
      const dateEl = $el.find('> div > p.wixui-rich-text__text, p.wixui-rich-text__text').first();
      const titleEl = $el.find('h4.wixui-rich-text__text').first();

      if (!dateEl.length || !titleEl.length) return;

      const dateRaw = dateEl.text().trim();
      // Collapse any whitespace runs (including literal newlines that
      // sometimes sneak into the source title text) into a single space.
      const titleRaw = titleEl.text().trim().replace(/\s+/g, ' ');
      if (!dateRaw || !titleRaw) return;

      const parsedDate = new Date(dateRaw);
      if (isNaN(parsedDate)) return;

      // Dedupe guard: Wix's nested containers mean the same card can be
      // matched more than once as we walk through `[id*="__item-"]`.
      const date = toLocalDateStr(parsedDate);
      const dupeKey = `${date}::${titleRaw}`;
      if (events.some(e => e._dupeKey === dupeKey)) return;

      // Ticket/price link + URL. Some events (e.g. free community shows)
      // have no ticket button at all.
      const ticketEl = $el.find('a.wixui-button').first();
      const ticketText = ticketEl.length ? ticketEl.text().trim() : null;
      const eventUrl = ticketEl.length ? (ticketEl.attr('href') ?? null) : null;

      // Parse price out of common formats:
      // "TICKETS PRICED AT $10", "$15 PRESALE | $20 GATE", "PRESALE $25 | GATE $40"
      let price = null;
      if (ticketText) {
        if (/free/i.test(ticketText)) {
          price = 'Free';
        } else {
          price = ticketText
            .replace(/TICKETS PRICED AT/i, '')
            .trim();
        }
      }

      // Special-case override for shows with a non-default start time,
      // e.g. "SHOW STARTS AT 7:00 PM" appended to the title.
      let time = defaultTime;
      let doors = defaultDoors;
      const timeOverrideMatch = titleRaw.match(/SHOW STARTS AT\s+([\d:]+\s*[APap][Mm])/);
      let cleanTitle = titleRaw;
      if (timeOverrideMatch) {
        const [hours, minutes] = timeOverrideMatch[1].match(/[\d:]+/)[0].split(':').map(Number);
        const isPM = /pm/i.test(timeOverrideMatch[1]);
        let h = hours;
        if (isPM && h !== 12) h += 12;
        if (!isPM && h === 12) h = 0;
        time = `${String(h).padStart(2, '0')}:${String(minutes ?? 0).padStart(2, '0')}`;
        doors = null;
        cleanTitle = titleRaw.replace(/SHOW STARTS AT\s+[\d:]+\s*[APap][Mm]/, '').trim();
      }

      const headlinerName = cleanTitle.split(/\s+with\s+/i)[0].trim().replace(/,\s*$/, '');
      const slug = headlinerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      // Simple performer split: headliner is everything before " with ",
      // supporters are comma-separated after it. Good enough given the
      // consistent "X with Y, Z" naming convention on this page.
      const performers = [{ name: headlinerName, headliner: true }];
      const afterWith = cleanTitle.split(/\s+with\s+/i)[1];
      if (afterWith) {
        afterWith.split(',').map(s => s.trim()).filter(Boolean).forEach(name => {
          performers.push({ name, headliner: false });
        });
      }

      events.push({
        _dupeKey: dupeKey,
        id: `${venueId}-${date}-${slug}`,
        title: cleanTitle,
        venueId,
        date,
        time,
        doors,
        price,
        performers,
        eventUrl,
        ticketUrl: eventUrl,
        source: 'scrape',
        manual: false,
      });
    });

    // Strip the internal dedupe key before returning
    return events.map(({ _dupeKey, ...ev }) => ev);
  } catch (err) {
    console.error('fetchRockinOnTheRiver error:', err.message);
    return [];
  }
}

async function fetchCainPark() {
  try {
    const venueId = 'cain-park';
    const res = await fetch('https://cainpark.com/events/?view=list');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    // Parses "Doors: 6 pm // Show: 7 pm" or "Show: 12 pm" (doors-only text
    // is never seen on this site, but we handle missing doors gracefully)
    function parseDoorsShow(text) {
      if (!text) return { doors: null, time: null };
      const doorsMatch = text.match(/Doors:\s*([\d:]+\s*[apAP][mM])/);
      const showMatch = text.match(/Show:\s*([\d:]+\s*[apAP][mM])/);
      return {
        doors: doorsMatch ? to24Hour(doorsMatch[1]) : null,
        time: showMatch ? to24Hour(showMatch[1]) : null,
      };
    }

    function to24Hour(t) {
      const cleaned = t.trim().toLowerCase().replace(/\s+/g, '');
      const match = cleaned.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/);
      if (!match) return null;
      let [, hours, minutes, meridian] = match;
      hours = parseInt(hours, 10);
      minutes = minutes ? parseInt(minutes, 10) : 0;
      if (meridian === 'pm' && hours !== 12) hours += 12;
      if (meridian === 'am' && hours === 12) hours = 0;
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    // Cain Park's cost text comes in a few shapes:
    // "$23.75 to $77.50", "$23.75 to $77.50 / Day Of : $70", "Free / Day Of : $Free"
    // We keep it as a display string rather than trying to force a single number.
    function cleanPrice(text) {
      if (!text) return null;
      const cleaned = text.replace(/\s+/g, ' ').trim();
      if (!cleaned) return null;
      if (/^free\b/i.test(cleaned)) return 'Free';
      return cleaned;
    }

    function slugify(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    const currentYear = new Date().getFullYear();

    // --- Single-day events ---
    $('.rhpSingleEvent').each((i, el) => {
      const $el = $(el);

      const titleEl = $el.find('#eventTitle, .eventTitleDiv a').first();
      const title = titleEl.text().trim().replace(/\s+/g, ' ');
      if (!title) return;

      const dateRaw = $el.find('#eventDate, .eventDateListTop').first().text().trim();
      // Date format: "Thu, Jun 18" - no year given, so attach current year.
      // Handles a Dec->Jan rollover by bumping the year if the parsed
      // month is earlier than today's month by a lot (e.g. event in Jan,
      // today is Dec).
      const parsedDate = new Date(`${dateRaw}, ${currentYear}`);
      if (isNaN(parsedDate)) return;
      const now = new Date();
      if (parsedDate.getMonth() < now.getMonth() - 6) {
        parsedDate.setFullYear(currentYear + 1);
      }
      const date = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;

      const doorsShowText = $el.find('.eventDoorStartDate, .rhp-event__time-text--list').first().text().trim();
      const { doors, time } = parseDoorsShow(doorsShowText);

      const priceText = $el.find('.eventCost, .rhp-event__cost-text--list').first().text().trim();
      const price = cleanPrice(priceText);

      const ctaEl = $el.find('.rhp-event-list-cta a, .rhp-event-cta a').first();
      const ctaText = ctaEl.text().trim();
      const ctaHref = ctaEl.attr('href') || null;
      // "Free Show" and other javascript:void(0) buttons have no real URL
      const ticketUrl = ctaHref && !ctaHref.startsWith('javascript:') ? ctaHref : null;

      const eventUrl = $el.find('.eventMoreInfo a, a.url').first().attr('href') || null;

      const slug = slugify(title);

      events.push({
        id: `${venueId}-${date}-${slug}`,
        title,
        venueId,
        date,
        time,
        doors,
        price,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });

    // --- Multi-day series events (e.g. Arts Festival, Peter Pan Jr.) ---
    // Each <li class="rhp-event-series-individual"> inside one of these
    // wrappers represents one real, separate performance date - we expand
    // each into its own event entry rather than treating the series as one.
    $('.rhpEventSeries').each((i, el) => {
      const $el = $(el);

      const seriesTitle = $el.find('.eventSeriesTitle a, h2 a').first().text().trim().replace(/\s+/g, ' ');
      if (!seriesTitle) return;

      const seriesPriceText = $el.find('.rhp-event-price-box, .seriesCostDiv').first().text().trim();
      const seriesPrice = cleanPrice(seriesPriceText);

      const seriesUrl = $el.find('.eventMoreInfo a').first().attr('href') || null;

      // Used to infer the year for each "Jul 10"-style date inside the list,
      // since individual list items don't carry a year themselves.
      const rangeLabel = $el.find('.eventDateListTop, .eventMonth').first().text().trim();
      const rangeYearMatch = rangeLabel.match(/(\d{4})/);
      const seriesYear = rangeYearMatch ? parseInt(rangeYearMatch[1], 10) : currentYear;

      $el.find('li.rhp-event-series-individual').each((j, li) => {
        const $li = $(li);

        const dateRaw = $li.find('.rhp-event-series-date').first().text().trim();
        if (!dateRaw) return;

        const parsedDate = new Date(`${dateRaw}, ${seriesYear}`);
        if (isNaN(parsedDate)) return;
        const now = new Date();
        if (parsedDate.getMonth() < now.getMonth() - 6) {
          parsedDate.setFullYear(seriesYear + 1);
        }
        const date = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;

        const doorsShowText = $li.find('.rhp-event-series-time').first().text().trim();
        const { doors, time } = parseDoorsShow(doorsShowText);

        const ctaEl = $li.find('a').first();
        const ctaText = ctaEl.text().trim();
        const ctaHref = ctaEl.attr('href') || null;
        const ticketUrl = ctaHref && !ctaHref.startsWith('javascript:') ? ctaHref : null;

        // Individual performances in a series don't show their own price -
        // the series-level price (e.g. "$10 - $21") applies to all dates,
        // except free series like Arts Festival where the CTA itself says "Free".
        const price = /free/i.test(ctaText) ? 'Free' : seriesPrice;

        const slug = slugify(seriesTitle);

        events.push({
          id: `${venueId}-${date}-${slug}`,
          title: seriesTitle,
          venueId,
          date,
          time,
          doors,
          price,
          performers: [{ name: seriesTitle, headliner: true }],
          eventUrl: seriesUrl,
          ticketUrl,
          source: 'scrape',
          manual: false,
        });
      });
    });

    return events;
  } catch (err) {
    console.error('fetchCainPark error:', err.message);
    return [];
  }
}



// ─── Manual entries (Cebars etc.) ─────────────────────────────────────────────

function loadManualEntries() {
  try {
    const manual = JSON.parse(readFileSync(join(__dirname, '..', 'manual-events.json'), 'utf-8'));
    return manual.events ?? [];
  } catch {
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching events...');

  const [rocketArena, grogShop, agora, beachland, metroparks, rockinOnTheRiver, cainPark] = await Promise.all([
    fetchRocketArena(),
    fetchGrogShop(),
    fetchAgora(),
    fetchBeachland(),
    fetchMetroparks(),
    fetchRockinOnTheRiver(),
    fetchCainPark(),
  ]);

  const manualEntries = loadManualEntries();

  const todayStr = toLocalDateStr(new Date());

  const allEvents = [
    ...rocketArena,
    ...grogShop,
    ...agora,
    ...beachland,
    ...metroparks,
    ...rockinOnTheRiver,
    ...cainPark,
    ...manualEntries,
  ].filter(e => e.date >= todayStr)
   .sort((a, b) => new Date(a.date) - new Date(b.date));

  const output = {
    venues: {
      'grog-shop': { name: 'Grog Shop', url: 'https://grogshop.gs', eventsUrl: 'https://grogshop.gs/event-details/', city: 'Cleveland Heights' },
      'the-agora': { name: 'The Agora', url: 'https://agoracleveland.com', eventsUrl: 'https://www.agoracleveland.com/events/all', city: 'Cleveland' },
      'rocket-arena': { name: 'Rocket Arena', url: 'https://rocketarena.com', eventsUrl: 'https://seatgeek.com/venues/rocket-arena/tickets', city: 'Cleveland' },
      'beachland-ballroom': { name: 'Beachland Ballroom', url: 'https://beachlandballroom.com', eventsUrl: 'https://www.beachlandballroom.com/shows', city: 'Cleveland' },
      'metroparks-huntington': { name: 'The Noshery at Huntington Beach', url: 'https://www.clevelandmetroparks.com/parks/visit/parks/huntington-reservation/the-noshery', eventsUrl: null, city: 'Bay Village' },
      'metroparks-euclid-beach': { name: 'Euclid Beach', url: 'https://www.clevelandmetroparks.com/parks/visit/parks/euclid-creek-reservation/euclid-beach-park', eventsUrl: null, city: 'Cleveland' },
      'metroparks-edgewater': { name: 'Edgewater Beach', url: 'https://www.clevelandmetroparks.com/parks/visit/parks/lakefront-reservation/edgewater-beach', eventsUrl: null, city: 'Cleveland' },
      'metroparks-emerald-necklace': { name: 'Emerald Necklace Marina', url: 'https://www.clevelandmetroparks.com/parks/visit/parks/rocky-river-reservation/emerald-necklace-marina', eventsUrl: null, city: 'Rocky River' },
      'metroparks-galley': { name: 'The Galley at East 55th Marina', url: 'https://www.clevelandmetroparks.com/parks/visit/parks/lakefront-reservation/the-galley', eventsUrl: null, city: 'Cleveland' },
      'metroparks-merwins-wharf': { name: "Merwin's Wharf", url: 'https://www.clevelandmetroparks.com/parks/visit/parks/lakefront-reservation/merwin-s-wharf', eventsUrl: null, city: 'Cleveland' },
      'rockin-on-the-river': { name: 'Rockin on the River', url: 'https://www.rockinontheriver.com', eventsUrl: 'https://www.rockinontheriver.com/2026', city: 'Lorain' },
      'cain-park': { name: 'Cain Park', url: 'https://cainpark.com', eventsUrl: 'https://cainpark.com/events/?view=list', city: 'Cleveland Heights' },
      'cebars': { name: 'Cebars', url: 'https://www.facebook.com/groups/51071547181', eventsUrl: null, city: 'Cleveland' },
      'paninis-westlake': { name: 'Paninis Westlake', url: 'https://www.facebook.com/PaninisWestlake/', eventsUrl: null, city: 'Cleveland' },
      'whiskey-island': { name: 'Whiskey Island', url: 'https://www.whiskeyislandstillandeatery.net/', eventsUrl: 'https://www.whiskeyislandstillandeatery.net/bands.html', city: 'Cleveland' },
    },
    events: allEvents,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Done! Wrote ${allEvents.length} events to events.json`);
}

main();