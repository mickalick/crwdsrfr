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

async function fetchHappyDog() {
  try {
    const venueId = 'happy-dog';
    const res = await fetch('https://app.opendate.io/v/happy-dog-1767');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

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

    function slugify(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    // Each event card is a Bootstrap col wrapping a .confirm-card. The
    // .card-body's direct <p> children appear in a fixed order:
    // [0] title link, [1] date, [2] doors/show time, [3] venue line.
    $('.confirm-card').each((i, el) => {
      const $el = $(el);
      const $body = $el.find('.card-body').first();
      const paragraphs = $body.find('> p');

      const titleLink = paragraphs.eq(0).find('a').first();
      const title = titleLink.text().trim().replace(/\s+/g, ' ');
      const eventUrl = titleLink.attr('href') || null;
      if (!title || !eventUrl) return;

      const dateRaw = paragraphs.eq(1).text().trim();
      const parsedDate = new Date(dateRaw);
      if (isNaN(parsedDate)) return;
      const date = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;

      const timeText = paragraphs.eq(2).text().trim();
      const doorsMatch = timeText.match(/Doors:\s*([\d:]+\s*[APap][Mm])/);
      const showMatch = timeText.match(/Show:\s*([\d:]+\s*[APap][Mm])/);
      const doors = doorsMatch ? to24Hour(doorsMatch[1]) : null;
      const time = showMatch ? to24Hour(showMatch[1]) : null;

      // Titles commonly list multiple acts separated by " / ", e.g.
      // "The Phantom A.D. / Oongow!!! / Riptide Suicide". Some titles also
      // use " w/ " to introduce the lineup, e.g. "Kid Tigrrr Record Release
      // w/ R U Three / Benjamin Liar" - splitting on " / " alone would wrongly
      // chop "w/" in two and leave a dangling "w" on the headliner name.
      // So: split on " / " first to get every raw segment, then specifically
      // check the FIRST segment for an embedded " w/ " boundary (that's the
      // only place "w/" has shown up) and split it further if found.
      // Titles commonly list multiple acts separated by " / ", e.g.
      // "The Phantom A.D. / Oongow!!! / Riptide Suicide". Some titles also
      // use " w/ " to introduce the lineup, e.g. "Kid Tigrrr Record Release
      // w/ R U Three / Benjamin Liar". Splitting on " / " directly would
      // wrongly treat the "/" inside "w/" as a separator too, mangling the
      // headliner name. So we temporarily mask " w/ " with a placeholder,
      // split on " / " as normal, then un-mask and split each segment on
      // the placeholder to recover the "w/" boundary separately.
      const W_PLACEHOLDER = '\u0000WSLASH\u0000';
      const maskedTitle = title.replace(/\s+w\/\s+/gi, W_PLACEHOLDER);
      const rawSegments = maskedTitle.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
      const acts = [];
      rawSegments.forEach(seg => {
        seg.split(W_PLACEHOLDER).map(s => s.trim()).filter(Boolean).forEach(part => acts.push(part));
      });
      const performers = acts.map((name, idx) => ({ name, headliner: idx === 0 }));

      const slug = slugify(acts[0] || title);

      events.push({
        id: `${venueId}-${date}-${slug}`,
        title,
        venueId,
        date,
        time,
        doors,
        price: null,
        performers,
        eventUrl,
        ticketUrl: eventUrl,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchHappyDog error:', err.message);
    return [];
  }
}

async function fetchMahalls() {
  try {
    const venueId = 'mahalls';
    const baseUrl = 'https://mahalls20lanes.com/api/plot/v1/listings';

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

    function slugify(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    // Strips the wrapping <span> the API puts around dateTime, e.g.
    // "<span>06/17/26 •  7pm</span>" -> "06/17/26 •  7pm"
    function stripHtml(str) {
      return str.replace(/<[^>]*>/g, '').trim();
    }

    async function fetchPage(page) {
      const url = `${baseUrl}?currentpage=${page}&notLoaded=false&listingsPerPage=24&_locale=user`;
      const res = await fetch(url);
      return res.json();
    }

    // Fetch page 1 first to learn how many total pages exist (the API
    // reports this on every individual event via "maxPages"), then fetch
    // the rest and concatenate.
    const firstPage = await fetchPage(1);
    if (!Array.isArray(firstPage) || !firstPage.length) return [];

    const maxPages = firstPage[0].maxPages || 1;
    const allRaw = [...firstPage];

    for (let page = 2; page <= maxPages; page++) {
      const nextPage = await fetchPage(page);
      if (Array.isArray(nextPage)) allRaw.push(...nextPage);
    }

    const events = allRaw.map(raw => {
      // dateTime looks like "<span>06/17/26 •  7pm</span>" - strip the span,
      // then split on the bullet to get the date and show time separately.
      const dateTimeClean = stripHtml(raw.dateTime || '');
      const [datePart, timePart] = dateTimeClean.split('•').map(s => s.trim());

      // datePart is "06/17/26" (m/d/y per the page's data-date-format)
      let date = null;
      if (datePart) {
        const [month, day, yearShort] = datePart.split('/').map(s => s.trim());
        const year = `20${yearShort}`;
        date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }

      const time = timePart ? to24Hour(timePart) : null;

      // doors field looks like "Doors: 7pm"
      const doorsMatch = (raw.doors || '').match(/Doors:\s*([\d:]+\s*[apAP][mM])/);
      const doors = doorsMatch ? to24Hour(doorsMatch[1]) : null;

      // Lineup comes pre-split from the API when present; fall back to
      // just the title as a single headliner when it's missing.
      let performers;
      if (raw.lineup && Array.isArray(raw.lineup.standard) && raw.lineup.standard.length) {
        performers = raw.lineup.standard.map((p, idx) => ({
          name: p.title,
          headliner: idx === 0,
        }));
      } else {
        performers = [{ name: raw.title, headliner: true }];
      }

      // fromPrice is either "Tickets from $20.00", "Free entry", or similar.
      let price = null;
      if (raw.fromPrice) {
        if (/free/i.test(raw.fromPrice)) {
          price = 'Free';
        } else {
          price = raw.fromPrice.replace(/^Tickets from\s*/i, '').trim();
        }
      }

      const ticketUrl = raw.hasTickets && raw.ticket && raw.ticket.link ? raw.ticket.link : null;

      const slug = slugify(raw.title);

      return {
        id: `${venueId}-${date}-${slug}`,
        title: raw.title,
        venueId,
        date,
        time,
        doors,
        price,
        performers,
        eventUrl: raw.permalink || null,
        ticketUrl,
        source: 'scrape',
        manual: false,
      };
    }).filter(ev => ev.date); // drop anything we failed to parse a date for

    return events;
  } catch (err) {
    console.error('fetchMahalls error:', err.message);
    return [];
  }
}

async function fetchBopStop() {
  const events = [];
  const seenIds = new Set();
  function getMonthsToFetch(count) {
    const today = new Date();
    const months = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
      months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
    }
    return months;
  }
  function normalizeTime(t) {
    if (!t) return null;
    const match = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!match) return null;
    let [, hours, minutes, modifier] = match;
    hours = parseInt(hours, 10);
    if (modifier.toLowerCase() === 'pm' && hours !== 12) hours += 12;
    if (modifier.toLowerCase() === 'am' && hours === 12) hours = 0;
    return `${String(hours).padStart(2, '0')}:${minutes}`;
  }
  const months = getMonthsToFetch(3);
  for (const { year, month } of months) {
    try {
      const monthUrl = `https://www.themusicsettlement.org/events/${year}/${String(month).padStart(2, '0')}`;
      const res = await fetch(monthUrl);
      const html = await res.text();
      const $ = cheerio.load(html);
      $('td').each((i, td) => {
        const dayText = $(td).children('p.day').first().text().trim();
        const day = parseInt(dayText, 10);
        if (!day) return; // skip empty/padding cells
        $(td).children('div.event').each((j, eventEl) => {
          const isBopStop = $(eventEl).children('ul.categories').find('li.bop-stop').length > 0;
          if (!isBopStop) return; // skip recitals, school closures, etc.
          const titleLink = $(eventEl).children('p.title').find('a').first();
          const rawTitle = titleLink.text().trim();
          const href = titleLink.attr('href');
          if (!rawTitle || !href) return;
          if (/closed/i.test(rawTitle)) return; // skip "BOP STOP Closed" and similar closure notices
          const title = rawTitle.replace(/\s*@\s*BOP STOP\s*$/i, '').trim();
          const timeRaw = $(eventEl).children('p.time').first().text().trim();
          const eventDate = new Date(year, month - 1, day);
          const date = toLocalDateStr(eventDate);
          const fullUrl = href.startsWith('http') ? href : `https://www.themusicsettlement.org${href}`;
          const slugMatch = href.match(/\/events\/\d{4}\/\d{2}\/\d{2}\/([^/]+)/);
          const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          const id = `bop-stop-${date}-${slug}`;
          if (seenIds.has(id)) return;
          seenIds.add(id);
          events.push({
            id,
            title,
            venueId: 'bop-stop',
            date,
            time: normalizeTime(timeRaw),
            doors: null,
            price: null,
            performers: [{ name: title, headliner: true }],
            eventUrl: fullUrl,
            ticketUrl: fullUrl,
            source: 'scrape',
            manual: false,
          });
        });
      });
    } catch (err) {
      console.error(`fetchBopStop error (${year}-${month}):`, err.message);
    }
  }
  return events;
}

async function fetchGlobeIron() {
  try {
    const res = await fetch('https://aegwebprod.blob.core.windows.net/json/events/339/events.json');
    const data = await res.json();
    const events = [];

    for (const ev of data.events || []) {
      if (!ev.active || ev.publishStatus !== 1) continue;

      const eventDateTime = ev.eventDateTime; // e.g. "2026-06-21T19:00:00"
      if (!eventDateTime) continue;
      const date = eventDateTime.slice(0, 10);
      const time = eventDateTime.slice(11, 16);
      const doors = ev.doorDateTime ? ev.doorDateTime.slice(11, 16) : null;

      const headliner = ev.title?.headlinersText?.trim();
      if (!headliner) continue;

      const supporting = ev.title?.supportingText?.trim();
      const tour = ev.title?.tour?.trim();
      const hasRealSupport = supporting && supporting !== tour;

      const title = hasRealSupport ? `${headliner} with ${supporting}` : headliner;

      const performers = [{ name: headliner, headliner: true }];
      if (hasRealSupport) performers.push({ name: supporting, headliner: false });

      events.push({
        id: `globe-iron-${ev.eventId}`,
        title,
        venueId: 'globe-iron',
        date,
        time,
        doors,
        price: null,
        performers,
        eventUrl: `https://globeironcle.com/events/detail?event_id=${ev.eventId}`,
        ticketUrl: ev.ticketing?.url || null,
        source: 'scrape',
        manual: false,
      });
    }

    return events;
  } catch (err) {
    console.error('fetchGlobeIron error:', err.message);
    return [];
  }
}

async function fetchJacobsPavilion() {
  try {
    const res = await fetch('https://aegwebprod.blob.core.windows.net/json/events/224/events.json');
    const data = await res.json();
    const events = [];

    for (const ev of data.events || []) {
      if (!ev.active || ev.publishStatus !== 1) continue;

      const eventDateTime = ev.eventDateTime;
      if (!eventDateTime) continue;
      const date = eventDateTime.slice(0, 10);
      const time = eventDateTime.slice(11, 16);
      const doors = ev.doorDateTime ? ev.doorDateTime.slice(11, 16) : null;

      const headliner = ev.title?.headlinersText?.trim();
      if (!headliner) continue;

      const supporting = ev.title?.supportingText?.trim();
      const tour = ev.title?.tour?.trim();
      const hasRealSupport = supporting && supporting !== tour;

      const title = hasRealSupport ? `${headliner} with ${supporting}` : headliner;

      const performers = [{ name: headliner, headliner: true }];
      if (hasRealSupport) performers.push({ name: supporting, headliner: false });

      events.push({
        id: `jacobs-pavilion-${ev.eventId}`,
        title,
        venueId: 'jacobs-pavilion',
        date,
        time,
        doors,
        price: null,
        performers,
        eventUrl: `https://jacobspavilion.com/events/detail?event_id=${ev.eventId}`,
        ticketUrl: ev.ticketing?.url || null,
        source: 'scrape',
        manual: false,
      });
    }

    return events;
  } catch (err) {
    console.error('fetchJacobsPavilion error:', err.message);
    return [];
  }
}

async function fetchMusicBox() {
  const events = [];
  const seenIds = new Set();

  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function parsePage(html) {
    const $ = cheerio.load(html);
    const today = new Date();
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const currentYear = today.getFullYear();

    $('.event-archive').each((i, el) => {
      const titleLink = $(el).find('h2.event-arc-title a').first();
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      if (!title || !href) return;

      const dateText = $(el).find('p.event-date').first().text().trim();
      const dateMatch = dateText.match(/([A-Za-z]{3})\s+(\d{1,2})/);
      if (!dateMatch) return;
      const monthIndex = monthMap[dateMatch[1]];
      const day = parseInt(dateMatch[2], 10);
      if (monthIndex === undefined) return;

      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, day);
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const eventDate = new Date(year, monthIndex, day);
      const date = toLocalDateStr(eventDate);

      const time = normalizeTime($(el).find('p.event-arc-time.showtime').first().text().trim());
      const doorsRaw = $(el).find('.event-arc-info p.event-arc-time').first().text().trim();
      const doors = normalizeTime(doorsRaw.replace(/doors open:?/i, ''));

      const room = $(el).find('p.event-arc-venue').first().text().trim() || null;

      let price = $(el).find('div.ticket_price').first().clone().find('.tixMobile').remove().end().text().trim() || null;
      if (!price && /free entry/i.test($(el).text())) price = 'Free';

      const ticketHref = $(el).find('a.resLink').first().attr('href');
      const ticketUrl = ticketHref
        ? (ticketHref.startsWith('http') ? ticketHref : `https://musicboxcle.com${ticketHref}`)
        : null;

      const eventUrl = href.startsWith('http') ? href : `https://musicboxcle.com${href}`;
      const slugMatch = href.match(/\/event\/([^/]+)\/?/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      const id = `music-box-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'music-box',
        date,
        time,
        doors,
        price,
        room,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  }

  try {
    const firstRes = await fetch('https://musicboxcle.com/schedule/');
    const firstHtml = await firstRes.text();
    const $ = cheerio.load(firstHtml);

    let lastPage = 1;
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/schedule\/page\/(\d+)\/?/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > lastPage) lastPage = num;
      }
    });
    lastPage = Math.min(lastPage, 30); // safety cap

    parsePage(firstHtml);

    for (let page = 2; page <= lastPage; page++) {
      try {
        const res = await fetch(`https://musicboxcle.com/schedule/page/${page}/`);
        const html = await res.text();
        parsePage(html);
      } catch (err) {
        console.error(`fetchMusicBox error (page ${page}):`, err.message);
      }
    }
  } catch (err) {
    console.error('fetchMusicBox error:', err.message);
  }

  return events;
}

async function fetchWinchester() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function parsePage($) {
    $('.tw-section').each((i, el) => {
      const titleEl = $(el).find('.tw-name a');
      const dateEl = $(el).find('.tw-event-date');
      const fullTitle = titleEl.text().trim();
      const eventUrl = titleEl.attr('href') || null;
      const dateRaw = dateEl.text().trim().replace(/,$/, ''); // "Jun 21"
      if (!fullTitle || !eventUrl || !dateRaw) return;

      // Defensive venue check, in case the feed ever mixes venues (3 Thirty 3 runs multiple spots)
      const venueName = $(el).find('.tw-venue-details .tw-venue-name').text().trim();
      if (venueName && !/winchester/i.test(venueName)) return;

      const [month, day] = dateRaw.split(' ');
      const monthIndex = monthMap[month];
      if (monthIndex === undefined || !day) return;

      const today = new Date();
      const currentYear = today.getFullYear();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, parseInt(day));
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = toLocalDateStr(eventDate);

      const showRaw = $(el).find('.tw-event-time').first().text().trim();
      const doorsRaw = $(el).find('.tw-event-door-time').first().text().replace(/doors:?/i, '').trim();

      // Only split the title if TicketWeb actually tagged separate attractions;
      // otherwise the title already contains the full bill as plain text.
      const supportSpans = $(el).find('.tw-attractions span');
      let title = fullTitle;
      let performers = [{ name: fullTitle, headliner: true }];
      if (supportSpans.length) {
        const headlinerName = fullTitle.split(/,| –| -/)[0].trim();
        const supporters = [];
        supportSpans.each((j, span) => supporters.push($(span).text().trim()));
        performers = [{ name: headlinerName, headliner: true }];
        supporters.forEach(s => performers.push({ name: s, headliner: false }));
        title = `${headlinerName} w/ ${supporters.join(', ')}`;
      }

      let price = $(el).find('.tw-price').first().text().trim() || null;
      if (price === '$0.00') price = 'Free';

      const ticketUrl = $(el).find('.tw-buy-tix-btn').first().attr('href') || null;

      const slugMatch = eventUrl.match(/\/tm-event\/([^/]+)\/?/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const id = `winchester-music-tavern-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'winchester-music-tavern',
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
  }

  try {
    let url = 'https://thewinchestermusictavern.com/event-details/';
    let pageCount = 0;
    const maxPages = 40; // safety cap

    while (url && pageCount < maxPages) {
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);

      parsePage($);

      const nextLink = $('a').filter((i, el) => /^next/i.test($(el).text().trim())).first();
      url = nextLink.length ? nextLink.attr('href') : null;
      pageCount++;
    }
  } catch (err) {
    console.error('fetchWinchester error:', err.message);
  }

  return events;
}

async function fetchHouseOfBlues() {
  const events = [];
  const seenIds = new Set();
  const limit = 36;
  const baseUrl = 'https://content.livenationapi.com/v1/venues/KovZpZAEAA1A/events';

  function extractDoorsTime(text) {
    if (!text) return null;
    const match = text.match(/doors? open.{0,15}?(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
    if (!match) return null;
    const m2 = match[1].replace(/\./g, '').toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (!m2) return null;
    let h = parseInt(m2[1], 10);
    const min = m2[2] || '00';
    if (m2[3] === 'pm' && h !== 12) h += 12;
    if (m2[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }

  try {
    let offset = 0;
    while (true) {
      const res = await fetch(`${baseUrl}?offset=${offset}&limit=${limit}`);
      const data = await res.json();
      const batch = Array.isArray(data) ? data : (data.events || []);
      if (!batch.length) break;

      for (const ev of batch) {
        if (ev.status_code === 'cancelled') continue;

        const id = `house-of-blues-${ev.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const title = ev.name;
        const performers = Array.isArray(ev.artists) && ev.artists.length
          ? ev.artists.map((a, i) => ({ name: a.name, headliner: i === 0 }))
          : [{ name: title, headliner: true }];

        events.push({
          id,
          title,
          venueId: 'house-of-blues',
          date: ev.start_date_local,
          time: ev.start_time_local ? ev.start_time_local.slice(0, 5) : null,
          doors: extractDoorsTime(ev.important_info),
          price: null,
          performers,
          eventUrl: ev.url || 'https://cleveland.houseofblues.com/shows',
          ticketUrl: ev.url || null,
          source: 'scrape',
          manual: false,
        });
      }

      if (batch.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    console.error('fetchHouseOfBlues error:', err.message);
  }

  return events;
}

async function fetchFwdNightclub() {
  try {
    const res = await fetch('https://www.fwdnightclub.com/events');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    function slugify(name) {
      return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    $('div.event.w-dyn-item').each((i, el) => {
      const $el = $(el);
      const dateAttr = $el.attr('event-date'); // e.g. "June 21, 2026 12:00 PM"
      const title = $el.find('p.event-name').first().text().trim();
      if (!dateAttr || !title) return;

      const parsedDate = new Date(dateAttr);
      if (isNaN(parsedDate)) return;

      const date = toLocalDateStr(parsedDate);
      const time = `${String(parsedDate.getHours()).padStart(2, '0')}:${String(parsedDate.getMinutes()).padStart(2, '0')}`;

      const tag = $el.find('.event_tag p').first().text().trim() || null; // "DAY" or "NIGHT"

      const ticketUrl = $el.find('a[itemprop="offers"]').first().attr('href') || null;

      const slug = slugify(title);

      events.push({
        id: `fwd-nightclub-${date}-${slug}`,
        title,
        venueId: 'fwd-nightclub',
        date,
        time,
        doors: null,
        price: null,
        tag,
        performers: [{ name: title, headliner: true }],
        eventUrl: ticketUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchFwdNightclub error:', err.message);
    return [];
  }
}

async function fetchCollisionBend() {
  try {
    const res = await fetch('https://collisionbendbrewery.com/events/');
    const html = await res.text();
    const $ = cheerio.load(html);
    const events = [];

    const venueIdMap = {
      '43117': 'collision-bend-euclid',
      '11716': 'collision-bend-cleveland',
    };

    // Recurring/weekly events are excluded by default, except for ones
    // explicitly allowlisted here by exact title (e.g. Brunch Singo).
    const RECURRING_ALLOWLIST = ['Brunch Singo at Collision Bend CLE'];

    $('li.list_item').each((i, el) => {
      const $el = $(el);
      const classAttr = $el.attr('class') || '';
      const locMatch = classAttr.match(/loc_(\d+)/);
      const venueId = locMatch ? venueIdMap[locMatch[1]] : null;
      if (!venueId) return; // unrecognized location, skip

      const titleLink = $el.find('.name a').first();
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      if (!title || !href) return;

      const dateText = $el.find('.date').first().text().replace(/\s+/g, ' ').trim();
      const isRecurring = /^every\b/i.test(dateText);
      if (isRecurring && !RECURRING_ALLOWLIST.includes(title)) return;

      // For recurring events we keep, the real next date follows "Next:"
      const relevantText = dateText.includes('Next:') ? dateText.split('Next:')[1] : dateText;
      const dateMatch = relevantText.match(/([A-Za-z]+ \d{1,2}, \d{4})\s*@\s*(\d{1,2}:\d{2}\s*[ap]m)/i);
      if (!dateMatch) return;

      const parsedDate = new Date(`${dateMatch[1]} ${dateMatch[2]}`);
      if (isNaN(parsedDate)) return;

      const date = toLocalDateStr(parsedDate);
      const time = `${String(parsedDate.getHours()).padStart(2, '0')}:${String(parsedDate.getMinutes()).padStart(2, '0')}`;

      const eventUrl = `https://collisionbendbrewery.com${href}`;
      const slugMatch = href.match(/\/events\/([^/]+)\/?$/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      events.push({
        id: `${venueId}-${date}-${slug}`,
        title,
        venueId,
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });

    return events;
  } catch (err) {
    console.error('fetchCollisionBend error:', err.message);
    return [];
  }
}

async function fetchMercuryMusicLounge() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function parsePage($) {
    $('.tw-section').each((i, el) => {
      const titleEl = $(el).find('.tw-name a');
      const dateEl = $(el).find('.tw-event-date');
      const fullTitle = titleEl.text().trim();
      const eventUrl = titleEl.attr('href') || null;
      const dateRaw = dateEl.text().trim().replace(/,$/, ''); // "Jun 22"
      if (!fullTitle || !eventUrl || !dateRaw) return;

      // Defensive venue check, in case the feed ever mixes venues
      const venueName = $(el).find('.tw-venue-details .tw-venue-name').text().trim();
      if (venueName && !/mercury/i.test(venueName)) return;

      const [month, day] = dateRaw.split(' ');
      const monthIndex = monthMap[month];
      if (monthIndex === undefined || !day) return;

      const today = new Date();
      const currentYear = today.getFullYear();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, parseInt(day));
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const eventDate = new Date(year, monthIndex, parseInt(day));
      const date = toLocalDateStr(eventDate);

      const showRaw = $(el).find('.tw-event-time').first().text().trim();
      const doorsRaw = $(el).find('.tw-event-door-time').first().text().trim();

      // Only split the title if TicketWeb actually tagged separate attractions;
      // otherwise the title already contains the full bill as plain text.
      const supportSpans = $(el).find('.tw-attractions span');
      let title = fullTitle;
      let performers = [{ name: fullTitle, headliner: true }];
      if (supportSpans.length) {
        const headlinerName = fullTitle.split(/,| –| -/)[0].trim();
        const supporters = [];
        supportSpans.each((j, span) => supporters.push($(span).text().trim()));
        performers = [{ name: headlinerName, headliner: true }];
        supporters.forEach(s => performers.push({ name: s, headliner: false }));
        title = `${headlinerName} w/ ${supporters.join(', ')}`;
      }

      let price = $(el).find('.tw-price').first().text().trim() || null;
      if (price === '$0.00') price = 'Free';

      const ticketUrl = $(el).find('.tw-buy-tix-btn').first().attr('href') || null;

      const slugMatch = eventUrl.match(/\/tm-event\/([^/]+)\/?/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const id = `mercury-music-lounge-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'mercury-music-lounge',
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
  }

  try {
    let url = 'https://www.mercurymusiclakewood.com/';
    let pageCount = 0;
    const maxPages = 40; // safety cap

    while (url && pageCount < maxPages) {
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);

      parsePage($);

      const nextLink = $('a').filter((i, el) => /^next/i.test($(el).text().trim())).first();
      url = nextLink.length ? nextLink.attr('href') : null;
      pageCount++;
    }
  } catch (err) {
    console.error('fetchMercuryMusicLounge error:', err.message);
  }

  return events;
}

async function fetchRockHall() {
  const events = [];
  try {
    const baseUrl = 'https://rockhall25.wpenginepowered.com/index.php';
    const persistedQueryHash = 'fdb7f20ecb81c499c6ba1d0c3f92ae2771a9a5b6c540a73cf3cc48c3023b8a40';
    const size = 12;
    let offset = 0;
    let hasMore = true;
    let safetyCounter = 0;

    while (hasMore && safetyCounter < 10) {
      const variables = encodeURIComponent(JSON.stringify({ taxonomies: [], offset, size, language: 'en' }));
      const extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: persistedQueryHash } }));
      const url = `${baseUrl}?graphql&operationName=EventsByTaxonomy&variables=${variables}&extensions=${extensions}`;

      const res = await fetch(url);
      const data = await res.json();

      const nodes = data?.data?.events?.nodes || [];
      for (const ev of nodes) {
        const ed = ev.eventData;
        if (!ed?.startDate) continue;

        // startDate looks like UTC ("...+00:00") but is actually already
        // Cleveland local time mislabeled - slice it directly, don't run it
        // through a Date object's local-time getters.
        const date = ed.startDate.slice(0, 10);
        const time = ed.startDate.slice(11, 16);

        let price = null;
        if (ed.price) {
          const parts = [];
          if (ed.price.gaPrice != null) parts.push(`GA $${ed.price.gaPrice}`);
          if (ed.price.membersPrice != null) parts.push(`Members $${ed.price.membersPrice}`);
          if (ed.price.priceWithAdmission != null) parts.push(`With Admission $${ed.price.priceWithAdmission}`);
          if (parts.length) price = parts.join(', ');
        }
        if (!price && Array.isArray(ed.pricingType)) {
          if (ed.pricingType.includes('free-with-rsvp')) price = 'Free (RSVP required)';
          else if (ed.pricingType.includes('free-with-admission')) price = 'Free with Museum Admission';
        }

        const slug = ev.uri.replace(/^\/event\//, '').replace(/\/$/, '');

        events.push({
          id: `rock-hall-${date}-${slug}`,
          title: ev.title,
          venueId: 'rock-hall',
          date,
          time,
          doors: null,
          price,
          performers: [{ name: ev.title, headliner: true }],
          eventUrl: `https://rockhall.com${ev.uri}`,
          ticketUrl: ed.ticketLink || null,
          source: 'scrape',
          manual: false,
        });
      }

      hasMore = data?.data?.events?.pageInfo?.offsetPagination?.hasMore ?? false;
      offset += size;
      safetyCounter++;
    }

    return events;
  } catch (err) {
    console.error('fetchRockHall error:', err.message);
    return events;
  }
}

async function fetchBlossomMusicCenter() {
  const events = [];
  const seenIds = new Set();
  const limit = 36;
  const baseUrl = 'https://content.livenationapi.com/v1/venues/KovZpZAEAtAA/events';

  function extractDoorsTime(text) {
    if (!text) return null;
    const match = text.match(/doors? open.{0,15}?(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)/i);
    if (!match) return null;
    const m2 = match[1].replace(/\./g, '').toLowerCase().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
    if (!m2) return null;
    let h = parseInt(m2[1], 10);
    const min = m2[2] || '00';
    if (m2[3] === 'pm' && h !== 12) h += 12;
    if (m2[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }

  try {
    let offset = 0;
    while (true) {
      const res = await fetch(`${baseUrl}?offset=${offset}&limit=${limit}`);
      const data = await res.json();
      const batch = Array.isArray(data) ? data : (data.events || []);
      if (!batch.length) break;

      for (const ev of batch) {
        if (ev.status_code === 'cancelled') continue;

        const id = `blossom-music-center-${ev.id}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const title = ev.name;
        const performers = Array.isArray(ev.artists) && ev.artists.length
          ? ev.artists.map((a, i) => ({ name: a.name, headliner: i === 0 }))
          : [{ name: title, headliner: true }];

        events.push({
          id,
          title,
          venueId: 'blossom-music-center',
          date: ev.start_date_local,
          time: ev.start_time_local ? ev.start_time_local.slice(0, 5) : null,
          doors: extractDoorsTime(ev.important_info),
          price: null,
          performers,
          eventUrl: ev.url || 'https://www.blossommusic.com/shows',
          ticketUrl: ev.url || null,
          source: 'scrape',
          manual: false,
        });
      }

      if (batch.length < limit) break;
      offset += limit;
    }
  } catch (err) {
    console.error('fetchBlossomMusicCenter error:', err.message);
  }

  return events;
}

async function fetchPlayhouseSquare() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11,
    January:0, February:1, March:2, April:3, June:5, July:6, August:7, September:8, October:9, November:10, December:11 };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 30);
  const cutoffStr = toLocalDateStr(cutoff);

  function slugify(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function parseEventItems($) {
    const parsed = [];
    $('.m-eventItem').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('h3.m-eventItem__title a').first();
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      if (!title || !href) return;

      const presentedBy = $el.find('h4.m-eventItem__tagline').first().text().trim() || null;
      const room = $el.find('.venue_title').first().text().trim() || null;

      const dateText = $el.find('.m-eventItem__date').first().text().replace(/\s+/g, ' ').trim();
      const dateMatch = dateText.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*-\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?,\s*(\d{4})/);
      if (!dateMatch) return;

      const [, startMonth, startDay, endMonth, endDay, yearStr] = dateMatch;
      const year = parseInt(yearStr, 10);
      const startMonthIndex = monthMap[startMonth];
      if (startMonthIndex === undefined) return;

      const startDate = new Date(year, startMonthIndex, parseInt(startDay, 10));
      const date = toLocalDateStr(startDate);

      let endDateStr = null;
      if (endDay) {
        const endMonthIndex = endMonth ? monthMap[endMonth] : startMonthIndex;
        if (endMonthIndex !== undefined) {
          const endDate = new Date(year, endMonthIndex, parseInt(endDay, 10));
          endDateStr = toLocalDateStr(endDate);
        }
      }

      const ticketUrl = $el.find('a.tickets').first().attr('href') || null;
      const eventUrl = href.startsWith('http') ? href : `https://www.playhousesquare.org${href}`;
      const slugMatch = href.match(/\/events\/detail\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : slugify(title);

      parsed.push({
        title,
        venueId: 'playhouse-square',
        date,
        endDate: endDateStr,
        room,
        presentedBy,
        eventUrl,
        ticketUrl,
        slug,
      });
    });
    return parsed;
  }

  async function fetchShowings(eventUrl) {
    try {
      const res = await fetch(eventUrl);
      const html = await res.text();
      const $ = cheerio.load(html);
      const showings = [];

      $('ul.showings_left li.entry').each((i, el) => {
        const $el = $(el);
        const monthAbbr = $el.find('.date__month').first().text().trim();
        const dayYearRaw = $el.find('.date__day').first().text().trim(); // "21, 2026"
        const [dayStr, yearStr] = dayYearRaw.split(',').map(s => s.trim());
        const monthIndex = monthMap[monthAbbr];
        if (monthIndex === undefined || !dayStr || !yearStr) return;

        const showDate = new Date(parseInt(yearStr, 10), monthIndex, parseInt(dayStr, 10));
        const date = toLocalDateStr(showDate);
        const time = normalizeTime($el.find('.time').first().text().trim());
        const ticketUrl = $el.find('.ticket a').first().attr('href') || null;

        showings.push({ date, time, ticketUrl });
      });

      return showings;
    } catch (err) {
      console.error(`fetchShowings error (${eventUrl}):`, err.message);
      return [];
    }
  }

  function addEvent(ev) {
    if (seenIds.has(ev.id)) return;
    seenIds.add(ev.id);
    events.push(ev);
  }

  try {
    const res = await fetch('https://www.playhousesquare.org/events');
    const html = await res.text();
    const $ = cheerio.load(html);
    let baseEvents = parseEventItems($);

    let offset = baseEvents.length;
    let safetyCounter = 0;
    while (safetyCounter < 30) {
      const ajaxUrl = `https://www.playhousesquare.org/events/events_ajax/${offset}?category=0&venue=0&team=0&per_page=12&came_from_page=event-list-page`;
      const ajaxRes = await fetch(ajaxUrl);
      const raw = await ajaxRes.text();

      let fragment;
      try {
        fragment = JSON.parse(raw);
      } catch {
        fragment = raw;
      }
      if (!fragment || !fragment.trim()) break;

      const $$ = cheerio.load(fragment);
      const newBaseEvents = parseEventItems($$);
      if (!newBaseEvents.length) break;

      baseEvents.push(...newBaseEvents);
      offset += newBaseEvents.length;
      safetyCounter++;
    }

    for (const base of baseEvents) {
      if (base.endDate) {
        const allShowings = await fetchShowings(base.eventUrl);
        // Rolling window: only expand showtimes within the next 30 days.
        // Later performances get picked up on future runs as the window moves.
        const showings = allShowings.filter(s => s.date <= cutoffStr);

        if (showings.length) {
          showings.forEach(s => {
            addEvent({
              id: `playhouse-square-${s.date}-${s.time ? s.time.replace(':', '') : 'tba'}-${base.slug}`,
              title: base.title,
              venueId: 'playhouse-square',
              date: s.date,
              endDate: null,
              time: s.time,
              doors: null,
              price: null,
              room: base.room,
              presentedBy: base.presentedBy,
              performers: [{ name: base.title, headliner: true }],
              eventUrl: base.eventUrl,
              ticketUrl: s.ticketUrl || base.ticketUrl,
              source: 'scrape',
              manual: false,
            });
          });
          continue;
        }

        // No showings at all (e.g. streaming/on-demand "events"), or every
        // showing fell outside the 30-day window - skip for now rather than
        // emitting a vague placeholder; a future run will pick it up once
        // it's within range. Only exception: genuinely no showings list
        // existed (not a live-performance event), where we keep the original
        // single date-range entry so it doesn't disappear from the site entirely.
        if (!allShowings.length) {
          addEvent({
            id: `playhouse-square-${base.date}-${base.slug}`,
            title: base.title,
            venueId: 'playhouse-square',
            date: base.date,
            endDate: base.endDate,
            time: null,
            doors: null,
            price: null,
            room: base.room,
            presentedBy: base.presentedBy,
            performers: [{ name: base.title, headliner: true }],
            eventUrl: base.eventUrl,
            ticketUrl: base.ticketUrl,
            source: 'scrape',
            manual: false,
          });
        }
        continue;
      }

      addEvent({
        id: `playhouse-square-${base.date}-${base.slug}`,
        title: base.title,
        venueId: 'playhouse-square',
        date: base.date,
        endDate: base.endDate,
        time: null,
        doors: null,
        price: null,
        room: base.room,
        presentedBy: base.presentedBy,
        performers: [{ name: base.title, headliner: true }],
        eventUrl: base.eventUrl,
        ticketUrl: base.ticketUrl,
        source: 'scrape',
        manual: false,
      });
    }

    return events;
  } catch (err) {
    console.error('fetchPlayhouseSquare error:', err.message);
    return events;
  }
}

async function fetchFoundry() {
  const events = [];
  const seenIds = new Set();

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  // Foundry's TicketWeb dates are "June 30, 2026" (full month name + year),
  // unlike the "Jun 21" short form other TicketWeb venues use.
  const fullMonthMap = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
  };

  function parseFullDate(dateRaw) {
    const match = dateRaw.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/);
    if (!match) return null;
    const monthIndex = fullMonthMap[match[1]];
    if (monthIndex === undefined) return null;
    return { monthIndex, day: parseInt(match[2], 10), year: parseInt(match[3], 10) };
  }



  function parsePage($) {
    $('.tw-section').each((i, el) => {
      const titleEl = $(el).find('.tw-name a').first();
      const fullTitle = titleEl.text().trim();
      const eventUrl = titleEl.attr('href') || null;
      if (!fullTitle || !eventUrl) return;

      const supportSpans = $(el).find('.tw-attractions span');
      let title = fullTitle;
      let performers = [{ name: fullTitle, headliner: true }];
      if (supportSpans.length) {
        const headlinerName = fullTitle.split(/,| –| -/)[0].trim();
        const supporters = [];
        supportSpans.each((j, span) => supporters.push($(span).text().trim()));
        performers = [{ name: headlinerName, headliner: true }];
        supporters.forEach(s => performers.push({ name: s, headliner: false }));
        title = `${headlinerName} w/ ${supporters.join(', ')}`;
      }

      let price = $(el).find('.tw-price').first().text().trim() || null;
      if (price === '$0.00') price = 'Free';

      const slugMatch = eventUrl.match(/\/tm-event\/([^/]+)\/?/);
      const baseSlug = slugMatch ? slugMatch[1] : fullTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      // Foundry lists recurring events with one .tw-date-time block per date
      // and a matching .tw-info-price-buy-tix link, in the same order (see
      // the "combine-events" multi-date pattern). Zip them together so each
      // date becomes its own event entry.
      const dateBlocks = $(el).find('.tw-date-time');
      const ticketLinks = $(el).find('.tw-info-price-buy-tix a.tw-buy-tix-btn');

      dateBlocks.each((j, dateEl) => {
        const dateRaw = $(dateEl).find('.tw-event-date').text().trim();
        const parsed = parseFullDate(dateRaw);
        if (!parsed) return;

        const eventDate = new Date(parsed.year, parsed.monthIndex, parsed.day);
        const date = toLocalDateStr(eventDate);

        const showRaw = $(dateEl).find('.tw-event-time').first().text().trim();
        const ticketUrl = ticketLinks.eq(j).attr('href') || null;

        const id = `foundry-concert-club-${date}-${baseSlug}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);

        events.push({
          id,
          title,
          venueId: 'foundry-concert-club',
          date,
          time: normalizeTime(showRaw),
          doors: null,
          price,
          performers,
          eventUrl,
          ticketUrl,
          source: 'scrape',
          manual: false,
        });
      });
    });
  }

  try {
    let url = 'https://www.foundryconcertclub.com/';
    let pageCount = 0;
    const maxPages = 20; // safety cap

    while (url && pageCount < maxPages) {
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);

      parsePage($);

      const nextLink = $('a').filter((i, el) => /^next/i.test($(el).text().trim())).first();
      url = nextLink.length ? nextLink.attr('href') : null;
      pageCount++;
    }
  } catch (err) {
    console.error('fetchFoundry error:', err.message);
  }

  return events;
}

async function fetchDunlaps() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  try {
    const res = await fetch('https://www.dunlapsbar.com/events');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('.event-list-item').each((i, el) => {
      const titleEl = $(el).find('.el-header a').first();
      const title = titleEl.text().trim();
      const hrefRaw = titleEl.attr('href');
      if (!title || !hrefRaw) return;
      const eventUrl = `https://www.dunlapsbar.com${hrefRaw}`;

      // "Wed Jul  1 2026,  8:00 PM" — note the irregular double-spacing
      // around single-digit days/hours, hence the loose \s+ matching.
      const dateRaw = $(el).find('h6.event-date').first().text().trim();
      const dateMatch = dateRaw.match(/[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!dateMatch) return; // skip multi-date/ongoing listings with no single showtime (e.g. "July 16 - December 17")

      const [, month, day, year, hour, minute, modifier] = dateMatch;
      const monthIndex = monthMap[month];
      if (monthIndex === undefined) return;

      const eventDate = new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));
      const date = toLocalDateStr(eventDate);

      let h = parseInt(hour, 10);
      if (modifier.toLowerCase() === 'pm' && h !== 12) h += 12;
      if (modifier.toLowerCase() === 'am' && h === 12) h = 0;
      const time = `${String(h).padStart(2, '0')}:${minute}`;

      // Doors are always exactly 1 hour before showtime at this venue
      const doorsHour = (h - 1 + 24) % 24;
      const doors = `${String(doorsHour).padStart(2, '0')}:${minute}`;

      const headliner = title;
      const performers = [{ name: headliner, headliner: true }];
      $(el).find('.event-supporting-acts b').each((j, b) => {
        performers.push({ name: $(b).text().trim(), headliner: false });
      });

      const ticketHrefRaw = $(el).find('.el-showtimes a.btn-primary').first().attr('href');
      const ticketUrl = ticketHrefRaw ? `https://www.dunlapsbar.com${ticketHrefRaw}` : null;

      const slugMatch = hrefRaw.match(/\/events\/(\d+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const id = `dunlaps-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'dunlaps-corner-bar',
        date,
        time,
        doors,
        price: null,
        performers,
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchDunlaps error:', err.message);
  }

  return events;
}

async function fetchWelcomeToTheFarm() {
  const events = [];
  const venueSlug = 'welcoetothefarm'; // typo is intentional — it's BeatGig's actual slug for this venue
  const venueTimezone = 'America/New_York';

  function toVenueLocalParts(utcIso) {
    const date = new Date(utcIso);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: venueTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(date);
    const get = type => parts.find(p => p.type === type).value;
    let hour = get('hour');
    if (hour === '24') hour = '00'; // some Node ICU builds return 24 instead of 00 at midnight
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      time: `${hour}:${get('minute')}`,
    };
  }

  // Captured verbatim from the live "load more" request — reusing as-is
  // since a trimmed-down query is untested against BeatGig's schema.
  const query = `query VenueCalendarBookings($slug: String!, $start: DateTime!, $offset: Int!, $limit: Int!) {
  venue: organizationBySlug(slug: $slug) {
    ...VenuePublic
    __typename
  }
  calendarBookings(
    start: $start
    limit: $limit
    offset: $offset
    organizationSlugs: [$slug]
  ) {
    bookings: calendarBookings {
      ...VenueCalendarBooking
      __typename
    }
    canFetchMore
    __typename
  }
}
fragment VenuePublic on Organization {
  id
  name
  slug
  __typename
}
fragment VenueCalendarBooking on CalendarBooking {
  artistName
  artistSlug
  publicEventDescription
  startTime
  id
  ticketLinkUrl
  ticketLinkTitle
  __typename
}`;

  try {
    let offset = 0;
    const limit = 18;
    let canFetchMore = true;
    let pageCount = 0;
    const maxPages = 20; // safety cap
    const startIso = new Date().toISOString();

    while (canFetchMore && pageCount < maxPages) {
      const res = await fetch('https://backend.beatgig.com/api/v1/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationName: 'VenueCalendarBookings',
          query,
          variables: { slug: venueSlug, start: startIso, offset, limit },
        }),
      });
      const json = await res.json();
      const bookings = json?.data?.calendarBookings?.bookings ?? [];

      bookings.forEach(b => {
        if (!b.artistName || !b.startTime) return;
        const { date, time } = toVenueLocalParts(b.startTime);
        const title = (b.publicEventDescription || b.artistName).trim();

        events.push({
          id: `welcome-to-the-farm-${b.id}`,
          title,
          venueId: 'welcome-to-the-farm',
          date,
          time,
          doors: null,
          price: null,
          performers: [{ name: b.artistName.trim(), headliner: true }],
          eventUrl: null,
          ticketUrl: b.ticketLinkUrl || null,
          source: 'beatgig',
          manual: false,
        });
      });

      canFetchMore = json?.data?.calendarBookings?.canFetchMore ?? false;
      offset += limit;
      pageCount++;
    }
  } catch (err) {
    console.error('fetchWelcomeToTheFarm error:', err.message);
  }

  return events;
}

async function fetchHilarities() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  function parseShowDate(dateRaw) {
    // "Thu, Jul 16, 2026"
    const m = dateRaw.trim().match(/^[A-Za-z]+,\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
    if (!m) return null;
    const monthIndex = monthMap[m[1]];
    if (monthIndex === undefined) return null;
    return { monthIndex, day: parseInt(m[2], 10), year: parseInt(m[3], 10) };
  }

  // Fetches the per-event page for events whose listing entry has no single
  // showtime (multi-date "July 16 - July 18" style listings), and expands
  // the "CLICK TIME TO PURCHASE TICKETS" block into individual showings.
  // Sold-out times (rendered as a <span>, no href) are kept with
  // ticketUrl: null rather than dropped, since the show itself still happens.
  async function fetchShowtimes(eventUrl) {
    try {
      const res = await fetch(eventUrl);
      const html = await res.text();
      const $ = cheerio.load(html);
      const showings = [];

      $('.event-times-list h6.event-date').each((i, el) => {
        const $dateHeader = $(el);
        const parsed = parseShowDate($dateHeader.text());
        if (!parsed) return;
        const showDate = new Date(parsed.year, parsed.monthIndex, parsed.day);
        const date = toLocalDateStr(showDate);

        const $group = $dateHeader.next('.event-list-button-group');
        $group.find('.event-btn-inline').each((j, btn) => {
          const $btn = $(btn);
          const time = normalizeTime($btn.text());
          const href = $btn.is('a') ? $btn.attr('href') : null;
          const ticketUrl = href ? `https://hilarities.com${href}` : null;
          showings.push({ date, time, ticketUrl });
        });
      });

      return showings;
    } catch (err) {
      console.error(`fetchHilaritiesShowtimes error (${eventUrl}):`, err.message);
      return [];
    }
  }

  try {
    const res = await fetch('https://hilarities.com/events');
    const html = await res.text();
    const $ = cheerio.load(html);
    const multiDateEvents = [];

    $('.event-list-item').each((i, el) => {
      const $el = $(el);
      const titleEl = $el.find('.el-header a').first();
      const title = titleEl.text().trim();
      const hrefRaw = titleEl.attr('href');
      if (!title || !hrefRaw) return;
      const eventUrl = `https://hilarities.com${hrefRaw}`;
      const slugMatch = hrefRaw.match(/\/events\/(\d+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

      const dateRaw = $el.find('h6.event-date').first().text().trim();
      const dateMatch = dateRaw.match(/[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);

      if (!dateMatch) {
        // Multi-date event ("July 16 - July 18") — handled in the pass below
        multiDateEvents.push({ title, eventUrl, slug });
        return;
      }

      const [, month, day, year, hour, minute, modifier] = dateMatch;
      const monthIndex = monthMap[month];
      if (monthIndex === undefined) return;

      const eventDate = new Date(parseInt(year, 10), monthIndex, parseInt(day, 10));
      const date = toLocalDateStr(eventDate);

      let h = parseInt(hour, 10);
      if (modifier.toLowerCase() === 'pm' && h !== 12) h += 12;
      if (modifier.toLowerCase() === 'am' && h === 12) h = 0;
      const time = `${String(h).padStart(2, '0')}:${minute}`;

      const ticketHrefRaw = $el.find('.el-showtimes a.btn-primary').first().attr('href');
      const ticketUrl = ticketHrefRaw ? `https://hilarities.com${ticketHrefRaw}` : null;

      const id = `hilarities-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'hilarities',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });

    for (const base of multiDateEvents) {
      const showings = await fetchShowtimes(base.eventUrl);
      showings.forEach(s => {
        const id = `hilarities-${s.date}-${s.time ? s.time.replace(':', '') : 'tba'}-${base.slug}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);

        events.push({
          id,
          title: base.title,
          venueId: 'hilarities',
          date: s.date,
          time: s.time,
          doors: null,
          price: null,
          performers: [{ name: base.title, headliner: true }],
          eventUrl: base.eventUrl,
          ticketUrl: s.ticketUrl,
          source: 'scrape',
          manual: false,
        });
      });
    }
  } catch (err) {
    console.error('fetchHilarities error:', err.message);
  }

  return events;
}

async function fetchVanAken() {
  const events = [];
  const seenIds = new Set();

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    const minutes = m ? parseInt(m, 10) : 0;
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  function parsePage($) {
    $('.events_card').each((i, el) => {
      const $el = $(el);
      const linkEl = $el.find('a.events_card-item').first();
      const hrefRaw = linkEl.attr('href');
      const title = $el.find('h3.heading-style-h4').first().text().trim();
      if (!hrefRaw || !title) return;

      // Slug ends in -YYYY-MM-DD — use this instead of parsing "Jun 27" +
      // guessing the year, since it's exact and avoids ambiguity around
      // year-end rollover.
      const dateMatch = hrefRaw.match(/-(\d{4})-(\d{2})-(\d{2})$/);
      if (!dateMatch) return;
      const [, year, month, day] = dateMatch;
      const date = `${year}-${month}-${day}`;

      const eventUrl = hrefRaw.startsWith('http') ? hrefRaw : `https://www.thevanakendistrict.com${hrefRaw}`;

      const detailTexts = $el.find('.layout422_location-wrapper .text-size-small');
      const timeRaw = detailTexts.eq(0).text().trim(); // "10:30 AM - 3 PM"
      const room = detailTexts.eq(1).text().trim() || null;

      const startRaw = timeRaw.split('-')[0]?.trim();
      const time = normalizeTime(startRaw);

      const slugMatch = hrefRaw.match(/\/events-at-the-district\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${date}`;
      const id = `van-aken-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'van-aken-district',
        date,
        time,
        doors: null,
        price: null,
        room,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });
  }

   try {
    let url = 'https://www.thevanakendistrict.com/events-at-the-district';
    let pageCount = 0;
    const maxPages = 20; // safety cap (you mentioned ~6 pages currently)

    while (url && pageCount < maxPages) {
      const res = await fetch(url);
      const html = await res.text();
      const $ = cheerio.load(html);

      parsePage($);

      const nextLink = $('a').filter((i, el) => $(el).text().trim() === 'Next').first();
      const nextHref = nextLink.length ? nextLink.attr('href') : null;
      // Webflow renders this as a relative URL (e.g. "?97ab8971_page=2"),
      // which fetch() can't use directly — resolve it against the current page.
      url = nextHref ? new URL(nextHref, url).toString() : null;
      pageCount++;
    }
  } catch (err) {
    console.error('fetchVanAken error:', err.message);
  }

  return events;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchTreelawn() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  // Fetches one page, retrying on bad status OR a suspiciously empty result —
  // TicketWeb's Treelawn Music Hall page has been intermittently flaky
  // (506 errors, thin/stale responses) despite working fine in a browser.
  async function fetchPageWithRetry(url, maxAttempts = 4) {
    let lastHtml = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url);
        const html = await res.text();
        lastHtml = html;
        const $ = cheerio.load(html);
        const itemCount = $('li.media').length;

        if (res.ok && itemCount > 0) {
          return $;
        }

        console.warn(`fetchTreelawn: attempt ${attempt} for ${url} got status ${res.status}, ${itemCount} items — retrying`);
      } catch (err) {
        console.warn(`fetchTreelawn: attempt ${attempt} for ${url} threw: ${err.message}`);
      }

      if (attempt < maxAttempts) {
        await sleep(attempt * 1500); // 1.5s, 3s, 4.5s backoff
      }
    }

    console.error(`fetchTreelawn: all ${maxAttempts} attempts failed for ${url}, giving up on this page`);
    return cheerio.load(lastHtml);
  }

  async function fetchRoom(baseUrl, room, roomSlug) {
    let pageCount = 0;
    const maxPages = 15; // safety cap
    let sawNewOnLastPage = true;

    while (pageCount < maxPages && sawNewOnLastPage) {
      pageCount++;
      sawNewOnLastPage = false;

      const $ = await fetchPageWithRetry(`${baseUrl}?page=${pageCount}`);
      const items = $('li.media');

      if (items.length === 0) break;

      items.each((i, el) => {
        const $el = $(el);

        const statusText = $el.find('.event-status').text().trim();
        if (/cancelled/i.test(statusText)) return; // drop cancelled shows entirely

        const titleLink = $el.find('.event-name a').first();
        const title = titleLink.text().trim();
        // Angular renders the real href from data-ng-href client-side — the
        // raw page source (what fetch() actually gets) only has data-ng-href,
        // so href alone comes back undefined. Fall back to it explicitly.
        const eventUrl = titleLink.attr('href') || titleLink.attr('data-ng-href');
        if (!title || !eventUrl) return;

        const dateRaw = $el.find('.event-date').first().text().replace(/\s+/g, ' ').trim();
        // "Sun Jun 28 7:00 PM - 9:00 PM (Doors 6:00 PM)" or "Mon Jun 29 7:30 PM"
        const dateMatch = dateRaw.match(
          /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}\s*[AP]M)(?:\s*-\s*\d{1,2}:\d{2}\s*[AP]M)?(?:\s*\(Doors\s+(\d{1,2}:\d{2}\s*[AP]M)\))?/i
        );
        if (!dateMatch) return;

        const [, monthStr, dayStr, startTimeRaw, doorsTimeRaw] = dateMatch;
        const monthIndex = monthMap[monthStr];
        if (monthIndex === undefined) return;
        const day = parseInt(dayStr, 10);

        const today = new Date();
        const currentYear = today.getFullYear();
        const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
        let year = currentYear;
        const eventDateThisYear = new Date(currentYear, monthIndex, day);
        if (eventDateThisYear < todayMidnight) year = currentYear + 1;
        const eventDate = new Date(year, monthIndex, day);
        const date = toLocalDateStr(eventDate);

        const time = normalizeTime(startTimeRaw);
        const doors = doorsTimeRaw ? normalizeTime(doorsTimeRaw) : null;

        // "Find Tickets" vs "Tickets Currently Not Available Through TicketWeb"
        // both link to the same /event/ URL — only treat it as a working
        // ticket link when the status text confirms tickets are findable.
        const ticketUrl = /not available/i.test(statusText) ? null : eventUrl;

        const idMatch = eventUrl.match(/-tickets\/(\d+)/);
        const ticketwebId = idMatch ? idMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const id = `treelawn-${roomSlug}-${date}-${ticketwebId}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);
        sawNewOnLastPage = true;

        events.push({
          id,
          title,
          venueId: 'treelawn',
          room,
          date,
          time,
          doors,
          price: null,
          performers: [{ name: title, headliner: true }],
          eventUrl,
          ticketUrl,
          source: 'scrape',
          manual: false,
        });
      });
    }
  }

  await fetchRoom('https://www.ticketweb.com/venue/treelawn-music-hall-cleveland-oh/525645', 'Treelawn Music Hall', 'music-hall');
  await fetchRoom('https://www.ticketweb.com/venue/treelawn-social-club-cleveland-oh/524805', 'Treelawn Social Club', 'social-club');

  return events;
}

async function fetchHofbrauhaus() {
  const events = [];
  const seenIds = new Set();
  const skipTitles = ['World Cup Specials']; // add more here if needed, e.g. 'CLOSED FOR DINNER SERVICE'

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  try {
    const res = await fetch('https://www.hofbrauhauscleveland.com/events');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('article.eventlist-event--upcoming').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('h1.eventlist-title a.eventlist-title-link').first();
      const title = titleLink.text().trim();
      if (!title || skipTitles.includes(title) || /closed/i.test(title)) return;

      const hrefRaw = titleLink.attr('href');
      if (!hrefRaw) return;
      const eventUrl = hrefRaw.startsWith('http') ? hrefRaw : `https://www.hofbrauhauscleveland.com${hrefRaw}`;

      // Exact ISO date straight from the datetime attribute — no parsing needed
      const date = $el.find('time.event-date').first().attr('datetime');
      if (!date) return;

      const startTimeText = $el.find('time.event-time-localized-start').first().text().trim();
      const time = normalizeTime(startTimeText);

      const slugMatch = hrefRaw.match(/\/events\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `hofbrauhaus-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'hofbrauhaus-cleveland',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchHofbrauhaus error:', err.message);
  }

  return events;
}

async function fetchQuintanasSpeakeasy() {
  const events = [];
  const seenIds = new Set();
  const monthMap = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
  };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{1,2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    const minutes = String(parseInt(m, 10)).padStart(2, '0'); // fixes "9:0pm" typos in source
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${minutes}`;
  }

  function resolveYear(monthIndex, day) {
    const today = new Date();
    const currentYear = today.getFullYear();
    const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
    const thisYearDate = new Date(currentYear, monthIndex, day);
    return thisYearDate < todayMidnight ? currentYear + 1 : currentYear;
  }

  const dateLeadRegex = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?:/i;
  const sessionLeadRegex = /^(\d{1,2}:\d{1,2}\s*[ap]m)\s*-\s*(\d{1,2}:\d{1,2}\s*[ap]m)/i;

  try {
    const res = await fetch('https://qbds.net/speakeasy-events/');
    const html = await res.text();
    const $ = cheerio.load(html);

    let current = null; // tracks the most recent dated event, for orphan session paragraphs to attach to

    $('p').each((i, el) => {
      const $p = $(el);
      const text = $p.text().replace(/\s+/g, ' ').trim();
      if (!text) return;

      const dateMatch = text.match(dateLeadRegex);

      if (dateMatch) {
        const monthIndex = monthMap[dateMatch[1]];
        const day = parseInt(dateMatch[2], 10);
        current = null; // reset unless we successfully build a valid event below

        if (monthIndex === undefined) return;

        const title = $p.find('strong').first().text().trim();
        if (!title || /closed/i.test(title)) return;

        const timeMatch = text.match(/(\d{1,2}:\d{1,2}\s*[ap]m)\s*[-–]\s*(\d{1,2}:\d{1,2}\s*[ap]m|midnight)/i);
        const time = timeMatch ? normalizeTime(timeMatch[1]) : null;

        const year = resolveYear(monthIndex, day);
        const date = toLocalDateStr(new Date(year, monthIndex, day));

        const ticketHref = $p.find('a[href*="eventbrite"]').first().attr('href') || null;

        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const id = `quintanas-speakeasy-${date}-${slug}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);

        const eventObj = {
          id,
          title,
          venueId: 'quintanas-speakeasy',
          date,
          time,
          doors: null,
          price: null,
          performers: [{ name: title, headliner: true }],
          eventUrl: 'https://qbds.net/speakeasy-events/',
          ticketUrl: ticketHref,
          source: 'scrape',
          manual: false,
        };

        events.push(eventObj);
        current = eventObj; // subsequent orphan paragraphs may attach more sessions to this
        return;
      }

      // Not a dated paragraph — check if it's an orphan extra session
      // (e.g. Tarot Night's separate 6:30-7:30 / 7:30-8:30 ticket links)
      const sessionMatch = text.match(sessionLeadRegex);
      if (sessionMatch && current) {
        const ticketHref = $p.find('a[href*="eventbrite"]').first().attr('href') || null;
        const time = normalizeTime(sessionMatch[1]);
        const slug = current.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const id = `quintanas-speakeasy-${current.date}-${slug}-${time || i}`;
        if (seenIds.has(id)) return;
        seenIds.add(id);

        events.push({
          ...current,
          id,
          time,
          ticketUrl: ticketHref,
        });
      }
      // Otherwise it's just description continuation text — ignored
    });
  } catch (err) {
    console.error('fetchQuintanasSpeakeasy error:', err.message);
  }

  return events;
}

async function fetchCoda() {
  const events = [];
  const seenIds = new Set();

  function parseExcerptHour(hourStr, minStr, meridiem) {
    let h = parseInt(hourStr, 10);
    const m = minStr ? minStr.replace(':', '') : '00';
    if (meridiem) {
      const mer = meridiem.toLowerCase();
      if (mer === 'pm' && h !== 12) h += 12;
      if (mer === 'am' && h === 12) h = 0;
    } else if (h >= 1 && h <= 11) {
      // No AM/PM given in the excerpt — assume PM (this is an evening venue)
      h += 12;
    }
    return `${String(h).padStart(2, '0')}:${m.padStart(2, '0')}`;
  }

  try {
    const res = await fetch('https://danteboccuzzi.com/coda/');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('article.wfea-grid_event').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('.wfea-header__title a').first();
      const title = titleLink.text().trim();
      const eventUrl = titleLink.attr('href');
      if (!title || !eventUrl) return;

      const isoDateTime = $el.find('time.wfea-grid__date-time').first().attr('datetime');
      if (!isoDateTime) return;
      const date = isoDateTime.split('T')[0]; // already YYYY-MM-DD
      const isoTime = isoDateTime.split('T')[1]?.slice(0, 5) || null; // fallback HH:MM

      const excerpt = $el.find('.wfea-grid__excerpt').first().text().replace(/\s+/g, ' ').trim();

      const showMatch = excerpt.match(/Show\s+at\s+(\d{1,2})(:\d{2})?\s*(am|pm)?/i);
      const doorsMatch = excerpt.match(/Doors\s+at\s+(\d{1,2})(:\d{2})?\s*(am|pm)?/i);
      const priceMatch = excerpt.match(/\$(\d+(?:\.\d{2})?)/);

      const time = showMatch
        ? parseExcerptHour(showMatch[1], showMatch[2], showMatch[3])
        : isoTime;
      const doors = doorsMatch
        ? parseExcerptHour(doorsMatch[1], doorsMatch[2], doorsMatch[3])
        : null;
      const price = priceMatch ? `$${priceMatch[1]}` : null;

      const idMatch = eventUrl.match(/tickets-(\d+)/);
      const ticketwebId = idMatch ? idMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `coda-${date}-${ticketwebId}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'coda',
        date,
        time,
        doors,
        price,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl: eventUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchCoda error:', err.message);
  }

  return events;
}

async function fetchProsperitySocialClub() {
  const events = [];
  const seenIds = new Set();

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  try {
    const res = await fetch('https://www.prosperitysocialclub.com/events');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('article.eventlist-event--upcoming').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('h1.eventlist-title a.eventlist-title-link').first();
      const title = titleLink.text().trim();
      if (!title) return;

      const hrefRaw = titleLink.attr('href');
      if (!hrefRaw) return;
      const eventUrl = hrefRaw.startsWith('http') ? hrefRaw : `https://www.prosperitysocialclub.com${hrefRaw}`;

      // Multi-day listings (e.g. 8pm-midnight) repeat time.event-date twice —
      // taking only the first occurrence collapses these to a single day,
      // which is what we want here rather than treating it as a 2-day event.
      const date = $el.find('time.event-date').first().attr('datetime');
      if (!date) return;

      const startTimeText = $el.find('time.event-time-localized').first().text().trim();
      const time = normalizeTime(startTimeText);

      const slugMatch = hrefRaw.match(/\/events\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `prosperity-social-club-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'prosperity-social-club',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchProsperitySocialClub error:', err.message);
  }

  return events;
}

async function fetchSixty6() {
  const events = [];
  const seenIds = new Set();

  try {
    const res = await fetch('https://thesixty6.com/events/');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('script[type="application/ld+json"]').each((i, el) => {
      const raw = $(el).html();
      if (!raw || !raw.includes('"@type": "Event"')) return;

      let data;
      try {
        data = JSON.parse(raw);
      } catch (err) {
        return; // skip any malformed JSON-LD block rather than crashing the run
      }

      const title = data.name?.trim();
      const eventUrl = data.url;
      if (!title || !eventUrl) return;

      // "2026-6-28T14:00+0:00" — the "+0:00" is not a real UTC offset (it
      // doesn't match the page's actual GMT-04:00), so parse the date/time
      // components directly as already-local rather than treating this as
      // a genuine UTC timestamp.
      const dtMatch = (data.startDate || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{2}):(\d{2})/);
      if (!dtMatch) return;
      const [, year, month, day, hour, minute] = dtMatch;
      const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      const time = `${hour}:${minute}`;

      // Most shows are free/no-ticket, but a few (e.g. Prom Night) embed a
      // real Eventbrite link inside the prose description — grab it if present.
      const description = data.description || '';
      const ticketMatch = description.match(/href=['"]?(https:\/\/www\.eventbrite\.com\/[^'"]+)['"]?/);
      const ticketUrl = ticketMatch ? ticketMatch[1] : null;

      const slugMatch = eventUrl.match(/\/events\/([^/]+)\/?/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `sixty6-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'the-sixty6',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchSixty6 error:', err.message);
  }

  return events;
}

async function fetchJollyScholar() {
  const events = [];
  const seenIds = new Set();
  const monthMap = {
    January: 0, February: 1, March: 2, April: 3, May: 4, June: 5,
    July: 6, August: 7, September: 8, October: 9, November: 10, December: 11
  };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  try {
    const res = await fetch('https://thejollyscholar.com/cleveland-university-circle-the-jolly-scholar-events');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('section[id]').each((i, el) => {
      const $el = $(el);
      const sectionId = $el.attr('id');

      const title = $el.find('h2').first().text().trim();
      if (!title) return;

      // "Wednesday July 8th" — weekday, month, ordinal day, no year
      const dayRaw = $el.find('.event-day').first().text().trim();
      const dateMatch = dayRaw.match(/^[A-Za-z]+\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/);
      if (!dateMatch) return;
      const monthIndex = monthMap[dateMatch[1]];
      const day = parseInt(dateMatch[2], 10);
      if (monthIndex === undefined) return;

      const today = new Date();
      const currentYear = today.getFullYear();
      const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, day);
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const date = toLocalDateStr(new Date(year, monthIndex, day));

      const timeRaw = $el.find('.event-time').first().text().trim();
      const startRaw = timeRaw.split('-')[0]?.trim();
      const time = normalizeTime(startRaw);

      const id = `jolly-scholar-${date}-${sectionId}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'jolly-scholar',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl: `https://thejollyscholar.com/cleveland-university-circle-the-jolly-scholar-events#${sectionId}`,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchJollyScholar error:', err.message);
  }

  return events;
}

async function fetchTheIvy() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  try {
    const res = await fetch('https://www.ivycle.com/the-ivy-events');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('li[data-hook="event-list-item"]').each((i, el) => {
      const $el = $(el);

      const title = $el.find('[data-hook="ev-list-item-title"]').first().text().trim();
      const ticketUrl = $el.find('[data-hook="ev-rsvp-button"]').first().attr('href') || null;
      if (!title) return;

      // "Aug 14, 2026, 8:00 PM – Aug 15, 2026, 2:30 AM" — only the start half matters here
      const dateRaw = $el.find('[data-hook="date"]').first().text().trim();
      const startRaw = dateRaw.split(/[–-]/)[0].trim();
      const dateMatch = startRaw.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
      if (!dateMatch) return;

      const [, monthStr, dayStr, yearStr, timeStr] = dateMatch;
      const monthIndex = monthMap[monthStr];
      if (monthIndex === undefined) return;
      const date = toLocalDateStr(new Date(parseInt(yearStr, 10), monthIndex, parseInt(dayStr, 10)));
      const time = normalizeTime(timeStr);

      const eventUrl = ticketUrl; // event-details page doubles as the ticket/RSVP link here
      const slugMatch = (ticketUrl || '').match(/\/event-details\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `the-ivy-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'the-ivy',
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchTheIvy error:', err.message);
  }

  return events;
}

async function fetchBentMace() {
  const events = [];
  const seenIds = new Set();

  try {
    const res = await fetch('https://bentmace.org/events/');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('ul.tribe-events-calendar-list li.tribe-events-calendar-list__event-row').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('.tribe-events-calendar-list__event-title-link').first();
      const fullTitle = titleLink.text().trim();
      const eventUrl = titleLink.attr('href');
      if (!fullTitle || !eventUrl) return;

      const date = $el.find('time.tribe-events-calendar-list__event-datetime').first().attr('datetime');
      if (!date) return;

      // "June 28 @ 8:00 pm" — only need the time portion after the @
      const startText = $el.find('.tribe-event-date-start').first().text().trim();
      const timeMatch = startText.match(/@\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
      let time = null;
      if (timeMatch) {
        let [, h, m, mod] = timeMatch;
        h = parseInt(h, 10);
        if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
        if (mod.toLowerCase() === 'am' && h === 12) h = 0;
        time = `${String(h).padStart(2, '0')}:${m}`;
      }

      // Multi-band bills are written as "Band A / Band B / Band C" in the title
      const acts = fullTitle.split('/').map(s => s.trim()).filter(Boolean);
      const performers = acts.length > 1
        ? acts.map((name, idx) => ({ name, headliner: idx === 0 }))
        : [{ name: fullTitle, headliner: true }];

      const slugMatch = eventUrl.match(/\/event\/([^/]+)\/?/);
      const slug = slugMatch ? slugMatch[1] : fullTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `bent-mace-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title: fullTitle,
        venueId: 'bent-mace',
        date,
        time,
        doors: null,
        price: null,
        performers,
        eventUrl,
        ticketUrl: null,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchBentMace error:', err.message);
  }

  return events;
}

async function fetchBside() {
  const events = [];
  const seenIds = new Set();
  const monthMap = { January:0, February:1, March:2, April:3, May:4, June:5, July:6, August:7, September:8, October:9, November:10, December:11 };

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }

  try {
    const res = await fetch('https://bsideliquorlounge.com/');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('.flexmedia--artistevents-wrap').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('.artisteventsname').closest('a');
      const title = $el.find('.artisteventsname').first().text().trim();
      const eventUrl = titleLink.attr('href');
      if (!title || !eventUrl) return;

      // "Sunday, June 28th 4:00PM Doors /  4:00PM Show" — weekday/month/day, no year
      const dateTimeRaw = $el.find('.artisteventstime').first().text().replace(/\s+/g, ' ').trim();
      const dateMatch = dateTimeRaw.match(/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?/);
      if (!dateMatch) return;

      const monthIndex = monthMap[dateMatch[1]];
      const day = parseInt(dateMatch[2], 10);
      if (monthIndex === undefined) return;

      const today = new Date();
      const currentYear = today.getFullYear();
      const todayMidnight = new Date(currentYear, today.getMonth(), today.getDate());
      let year = currentYear;
      const eventDateThisYear = new Date(currentYear, monthIndex, day);
      if (eventDateThisYear < todayMidnight) year = currentYear + 1;
      const date = toLocalDateStr(new Date(year, monthIndex, day));

      // Grab the FIRST doors/show time match only — one live listing has a
      // rendering glitch duplicating "Show" text, so don't assume a clean string
      const doorsMatch = dateTimeRaw.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*Doors/i);
      const showMatch = dateTimeRaw.match(/(\d{1,2}:\d{2}\s*[AP]M)\s*Show/i);
      const doors = doorsMatch ? normalizeTime(doorsMatch[1]) : null;
      const time = showMatch ? normalizeTime(showMatch[1]) : doors;

      let price = $el.find('.artistseventsprice').first().text().trim() || null;
      if (price === '$0.00') price = 'Free';

      const ticketUrl = $el.find('.eventsbutton a.button-primary').first().attr('href') || null;

      const idMatch = eventUrl.match(/\/tm-event\/([^/]+)\/?/);
      const slug = idMatch ? idMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `bside-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'bside-liquor-lounge',
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
  } catch (err) {
    console.error('fetchBside error:', err.message);
  }

  return events;
}

async function fetchNoClass() {
  const events = [];
  const seenIds = new Set();

  function normalizeTime(t) {
    if (!t) return null;
    const match = t.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (!match) return null;
    let [, h, m, mod] = match;
    h = parseInt(h, 10);
    const minutes = m || '00';
    if (mod.toLowerCase() === 'pm' && h !== 12) h += 12;
    if (mod.toLowerCase() === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${minutes}`;
  }

  try {
    const res = await fetch('https://www.noclasscle.com/');
    const html = await res.text();
    const $ = cheerio.load(html);

    $('article.eventlist-event--upcoming').each((i, el) => {
      const $el = $(el);

      const titleLink = $el.find('h1.eventlist-title a.eventlist-title-link').first();
      const title = titleLink.text().trim();
      const hrefRaw = titleLink.attr('href');
      if (!title || !hrefRaw) return;
      const eventUrl = hrefRaw.startsWith('http') ? hrefRaw : `https://www.noclasscle.com${hrefRaw}`;

      const date = $el.find('time.event-date').first().attr('datetime');
      if (!date) return;

      const startTimeText = $el.find('.event-time-12hr-start').first().text().trim();
      const time = normalizeTime(startTimeText);

      // Description is "<br>"-separated: band names first, then a "———"
      // divider, then logistics lines like "Doors: 7pm" / "Cost: $15"
      const descHtml = $el.find('.eventlist-description .sqs-html-content p').first().html() || '';
      const lines = descHtml
        .split(/<br\s*\/?>/i)
        .map(s => $('<div>').html(s).text().trim())
        .filter(Boolean);

      const dividerIdx = lines.findIndex(l => /^—+$/.test(l));
      const performerLines = dividerIdx === -1 ? [] : lines.slice(0, dividerIdx);
      const infoLines = dividerIdx === -1 ? lines : lines.slice(dividerIdx + 1);

      const performers = performerLines.length
        ? performerLines.map((name, idx) => ({ name, headliner: idx === 0 }))
        : [{ name: title, headliner: true }];

      let doors = null;
      let price = null;

      infoLines.forEach(line => {
        const doorsMatch = line.match(/^doors:\s*(.+)$/i);
        if (doorsMatch) doors = normalizeTime(doorsMatch[1]);

        const costMatch = line.match(/^cost:\s*(.+)$/i);
        if (costMatch) {
          const raw = costMatch[1].trim();
          price = raw.toLowerCase() === 'free' ? 'Free' : (/^\$/.test(raw) ? raw : `$${raw}`);
        }
      });

      // Most shows are "Tickets: At The Door" (no real link), but grab an
      // outbound link (e.g. Eventbrite) if one's actually present
      const descLink = $el.find('.eventlist-description a[href]').filter((j, a) => {
        const href = $(a).attr('href') || '';
        return href.startsWith('http') && !href.includes('noclasscle.com');
      }).first().attr('href');
      const ticketUrl = descLink || null;

      const slugMatch = hrefRaw.match(/\/events\/([^/?]+)/);
      const slug = slugMatch ? slugMatch[1] : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const id = `no-class-${date}-${slug}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'no-class',
        date,
        time,
        doors,
        price,
        performers,
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchNoClass error:', err.message);
  }

  return events;
}

async function fetchClevelandOrchestra() {
  const events = [];
  const seenIds = new Set();

  try {
    const res = await fetch('https://www.clevelandorchestra.com/api/event-instances.json');
    const data = await res.json();

    const today = new Date();
    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    Object.values(data).forEach(instance => {
      const title = instance.event?.title?.trim();
      const startDateLocal = instance.startDateLocal; // e.g. "2026-07-01T20:00:00" — use this, NOT instance.event.startDateLocal (can be stale)
      if (!title || !startDateLocal) return;

      const [date, timeRaw] = startDateLocal.split('T');
      const time = timeRaw ? timeRaw.slice(0, 5) : null; // "20:00:00" -> "20:00"

      const [y, m, d] = date.split('-').map(Number);
      const eventDate = new Date(y, m - 1, d);
      if (eventDate < todayMidnight) return; // skip anything already in the past

      const room = instance.venue?.title || null;
      const ticketUrl = instance.booking?.bookingLinkURL || instance.ticketingSystemId || null;

      const eventUrlPath = instance.event?.url;
      const eventUrl = eventUrlPath ? `https://www.clevelandorchestra.com${eventUrlPath}` : null;

      const id = `cleveland-orchestra-${instance.id}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);

      events.push({
        id,
        title,
        venueId: 'cleveland-orchestra',
        room,
        date,
        time,
        doors: null,
        price: null,
        performers: [{ name: title, headliner: true }],
        eventUrl,
        ticketUrl,
        source: 'scrape',
        manual: false,
      });
    });
  } catch (err) {
    console.error('fetchClevelandOrchestra error:', err.message);
  }

  return events;
}



// ─── Manual entries (Cebars etc.) ─────────────────────────────────────────────

function loadManualEntries() {
  const manualPath = join(__dirname, '..', 'manual-events.json');
  try {
    const manual = JSON.parse(readFileSync(manualPath, 'utf-8'));
    const entries = manual.events ?? [];
    console.log(`Loaded ${entries.length} manual entries from ${manualPath}`);
    return entries;
  } catch (err) {
    console.error(`Failed to load manual entries from ${manualPath}:`, err.message);
    return [];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching events...');

  const [rocketArena, grogShop, agora, beachland, metroparks, rockinOnTheRiver, cainPark, happyDog, mahalls, bopStop, globeIron, jacobsPavilion, musicBox, winchester, houseOfBlues, fwdNightclub, collisionBend, mercuryMusicLounge, rockHall, blossomMusicCenter, playhouseSquare, foundry, dunlaps, welcomeToTheFarm, hilarities, vanAken, treelawn, hofbrauhaus, quintanasSpeakeasy, coda, prosperitySocialClub, sixty6, jollyScholar, theIvy, bentMace, bside, noClass, clevelandOrchestra] = await Promise.all([
    fetchRocketArena(),
    fetchGrogShop(),
    fetchAgora(),
    fetchBeachland(),
    fetchMetroparks(),
    fetchRockinOnTheRiver(),
    fetchCainPark(),
    fetchHappyDog(),
    fetchMahalls(),
    fetchBopStop(),
    fetchGlobeIron(),
    fetchJacobsPavilion(),
    fetchMusicBox(),
    fetchWinchester(),
    fetchHouseOfBlues(),
    fetchFwdNightclub(),
    fetchCollisionBend(),
    fetchMercuryMusicLounge(),
    fetchRockHall(),
    fetchBlossomMusicCenter(),
    fetchPlayhouseSquare(),
    fetchFoundry(),
    fetchDunlaps(),
    fetchWelcomeToTheFarm(),
    fetchHilarities(),
    fetchVanAken(),
    fetchTreelawn(),
    fetchHofbrauhaus(),
    fetchQuintanasSpeakeasy(),
    fetchCoda(),
    fetchProsperitySocialClub(),
    fetchSixty6(),
    fetchJollyScholar(),
    fetchTheIvy(),
    fetchBentMace(),
    fetchBside(),
    fetchNoClass(),
    fetchClevelandOrchestra(),
  ]);


  // ─── Per-venue event counts ──────────────────────────────────────────────
  console.log('Rocket Arena:', rocketArena.length);
  console.log('Grog Shop:', grogShop.length);
  console.log('The Agora:', agora.length);
  console.log('Beachland Ballroom:', beachland.length);
  console.log('Metroparks:', metroparks.length);
  console.log('Rockin on the River:', rockinOnTheRiver.length);
  console.log('Cain Park:', cainPark.length);
  console.log('Happy Dog:', happyDog.length);
  console.log('Mahalls:', mahalls.length);
  console.log('Bop Stop:', bopStop.length);
  console.log('Globe Iron:', globeIron.length);
  console.log('Jacobs Pavilion:', jacobsPavilion.length);
  console.log('Music Box:', musicBox.length);
  console.log('Winchester:', winchester.length);
  console.log('House of Blues:', houseOfBlues.length);
  console.log('FWD Nightclub:', fwdNightclub.length);
  console.log('Collision Bend:', collisionBend.length);
  console.log('Mercury Music Lounge:', mercuryMusicLounge.length);
  console.log('Rock Hall:', rockHall.length);
  console.log('Blossom:', blossomMusicCenter.length);
  console.log('Playhouse:', playhouseSquare.length);
  console.log('Foundry:', foundry.length);
  console.log('Dunlaps:', dunlaps.length);
  console.log('Welcome To the Farm:', welcomeToTheFarm.length);
  console.log('Hilarities:', hilarities.length);
  console.log('Van Aken:', vanAken.length);
  console.log('Treelawn:', treelawn.length);
  console.log('Hofbrauhaus:', hofbrauhaus.length);
  console.log('Quintanas:', quintanasSpeakeasy.length);
  console.log('CODA:', coda.length);
  console.log('Prosperity:', prosperitySocialClub.length);
  console.log('Sixty 6:', sixty6.length);
  console.log('Jolly Scholar:', jollyScholar.length);
  console.log('The Ivy:', theIvy.length);
  console.log('Bent Mace:', bentMace.length);
  console.log('B Side:', bside.length);
  console.log('No Class:', noClass.length);
  console.log('Cleveland Orchestra:', clevelandOrchestra.length);


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
    ...happyDog,
    ...mahalls,
    ...bopStop,
    ...globeIron,
    ...jacobsPavilion,
    ...musicBox,
    ...winchester,
    ...houseOfBlues,
    ...fwdNightclub,
    ...collisionBend,
    ...mercuryMusicLounge,
    ...rockHall,
    ...blossomMusicCenter,
    ...playhouseSquare,
    ...foundry,
    ...dunlaps,
    ...welcomeToTheFarm,
    ...hilarities,
    ...vanAken,
    ...treelawn,
    ...hofbrauhaus,
    ...quintanasSpeakeasy,
    ...coda,
    ...prosperitySocialClub,
    ...sixty6,
    ...jollyScholar,
    ...theIvy,
    ...bentMace,
    ...bside,
    ...noClass,
    ...clevelandOrchestra,
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
      'cain-park': { name: 'Cain Park', url: 'https://cainpark.com/', eventsUrl: 'https://cainpark.com/events/?view=list', city: 'Cleveland Heights' },
      'happy-dog': { name: 'Happy Dog', url: 'https://happydogcleveland.com/', eventsUrl: 'https://app.opendate.io/v/happy-dog-1767', city: 'Cleveland' },
      'mahalls': { name: 'Mahalls', url: 'https://mahalls20lanes.com/', eventsUrl: 'https://mahalls20lanes.com/events/', city: 'Lakewood' },
      'bop-stop': { name: 'Bop Stop', url: 'https://www.themusicsettlement.org/bop-stop/overview', eventsUrl: 'https://www.themusicsettlement.org/events/center/bop-stop', city: 'Cleveland' },
      'globe-iron': { name: 'Globe Iron', url: 'https://globeironcle.com/', eventsUrl: 'https://globeironcle.com/calendar/', city: 'Cleveland' },
      'jacobs-pavilion': { name: 'Jacobs Pavilion', url: 'https://jacobspavilion.com/', eventsUrl: 'https://jacobspavilion.com/calendar/', city: 'Cleveland' },
      'music-box': { name: 'Music Box Supper Club', url: 'https://musicboxcle.com/', eventsUrl: 'https://musicboxcle.com/schedule/', city: 'Cleveland' },
      'winchester-music-tavern': { name: 'The Winchester Music Tavern', url: 'https://thewinchestermusictavern.com/', eventsUrl: 'https://thewinchestermusictavern.com/event-details/', city: 'Lakewood' },
      'house-of-blues': { name: 'House of Blues', url: 'https://cleveland.houseofblues.com/', eventsUrl: 'https://cleveland.houseofblues.com/shows', city: 'Cleveland' },
      'fwd-nightclub': { name: 'FWD Day + Nightclub', url: 'https://www.fwdnightclub.com/', eventsUrl: 'https://www.fwdnightclub.com/events', city: 'Cleveland' },
      'collision-bend-cleveland': { name: 'Collision Bend Cleveland', url: 'https://collisionbendbrewery.com/location/cleveland-ohio-11716', eventsUrl: 'https://collisionbendbrewery.com/events/', city: 'Cleveland' },
      'collision-bend-euclid': { name: 'Collision Bend Euclid', url: 'https://collisionbendbrewery.com/location/euclid-ohio-43117', eventsUrl: 'https://collisionbendbrewery.com/events/', city: 'Euclid' },
      'mercury-music-lounge': { name: 'Mercury Music Lounge', url: 'https://www.mercurymusiclakewood.com/', eventsUrl: 'https://www.mercurymusiclakewood.com/', city: 'Lakewood' },
      'rock-hall': { name: 'Rock & Roll Hall of Fame', url: 'https://rockhall.com/', eventsUrl: 'https://rockhall.com/events/', city: 'Cleveland' },
      'blossom-music-center': { name: 'Blossom Music Center', url: 'https://www.blossommusic.com/', eventsUrl: 'https://www.blossommusic.com/shows', city: 'Cuyahoga Falls' },
      'playhouse-square': { name: 'Playhouse Square', url: 'https://www.playhousesquare.org/', eventsUrl: 'https://www.playhousesquare.org/events', city: 'Cleveland' },
      'foundry-concert-club': { name: 'The Foundry Concert Club', url: 'https://www.foundryconcertclub.com/', eventsUrl: 'https://www.foundryconcertclub.com/', city: 'Cleveland' },
      'dunlaps-corner-bar': { name: 'Dunlaps', url: 'https://www.dunlapsbar.com/', eventsUrl: 'https://www.dunlapsbar.com/events', city: 'Cleveland' },
      'welcome-to-the-farm': { name: 'Welcome to the Farm', url: 'https://welcometothefarm.com/cleveland', eventsUrl: 'https://welcometothefarm.com/cleveland', city: 'Cleveland' },
      'hilarities': { name: 'Hilarities', url: 'https://hilarities.com/', eventsUrl: 'https://hilarities.com/events', city: 'Cleveland' },
      'van-aken-district': { name: 'Van Aken District', url: 'https://www.thevanakendistrict.com/', eventsUrl: 'https://www.thevanakendistrict.com/events-at-the-district', city: 'Shaker Heights' },
      'treelawn': { name: 'The Treelawn', url: 'https://thetreelawn.com/', eventsUrl: 'https://thetreelawn.com/', city: 'Cleveland' },
      'hofbrauhaus-cleveland': { name: 'Hofbrauhaus', url: 'https://www.hofbrauhauscleveland.com/', eventsUrl: 'https://www.hofbrauhauscleveland.com/events', city: 'Cleveland' },
      'quintanas-speakeasy': { name: 'Quintanas Speakeasy', url: 'https://qbds.net/speakeasy/', eventsUrl: 'https://qbds.net/speakeasy-events/', city: 'Cleveland Heights' },
      'coda': { name: 'CODA', url: 'https://danteboccuzzi.com/coda/', eventsUrl: 'https://danteboccuzzi.com/coda/', city: 'Cleveland' },
      'prosperity-social-club': { name: 'Prosperity Social Club', url: 'https://www.prosperitysocialclub.com/', eventsUrl: 'https://www.prosperitysocialclub.com/events', city: 'Cleveland' },
      'the-sixty6': { name: 'The Sixty 6', url: 'https://thesixty6.com/', eventsUrl: 'https://thesixty6.com/events/', city: 'Cleveland' },
      'jolly-scholar': { name: 'The Jolly Scholar', url: 'https://thejollyscholar.com/', eventsUrl: 'https://thejollyscholar.com/cleveland-university-circle-the-jolly-scholar-events', city: 'Cleveland' },
      'the-ivy': { name: 'The Ivy', url: 'https://www.ivycle.com/', eventsUrl: 'https://www.ivycle.com/the-ivy-events', city: 'Cleveland' },
      'bent-mace': { name: 'Bent Mace', url: 'https://www.ivycle.com/', eventsUrl: 'https://bentmace.org/events/', city: 'Cleveland' },
      'bside-liquor-lounge': { name: 'B Side Liquor Lounge', url: 'https://bsideliquorlounge.com/', eventsUrl: 'https://bsideliquorlounge.com/', city: 'Cleveland Heights' },
      'no-class': { name: 'No Class', url: 'https://www.noclasscle.com/', eventsUrl: 'https://www.noclasscle.com/', city: 'Cleveland' },
      'cleveland-orchestra': { name: 'The Cleveland Orchestra', url: 'https://www.clevelandorchestra.com/', eventsUrl: 'https://www.clevelandorchestra.com/tickets/calendar', city: 'Cleveland' },
      'cebars': { name: 'Cebars', url: 'https://www.facebook.com/groups/51071547181', eventsUrl: null, city: 'Cleveland' },
      'paninis-westlake': { name: 'Paninis Westlake', url: 'https://www.facebook.com/PaninisWestlake/', eventsUrl: null, city: 'Cleveland' },
      'whiskey-island': { name: 'Whiskey Island', url: 'https://www.whiskeyislandstillandeatery.net/', eventsUrl: 'https://www.whiskeyislandstillandeatery.net/bands.html', city: 'Cleveland' },
      'cavottas-garden-bar': { name: 'Cavottas Garden Bar', url: 'https://cavottas.com/cavottas-garden-bar', eventsUrl: 'https://cavottas.com/cavottas-garden-bar', city: 'Cleveland' },
      'sound-stage-tavern': { name: 'Sound Stage Tavern', url: 'https://www.soundstagetavern.com/', eventsUrl: 'https://www.soundstagetavern.com/calendar', city: 'Wickliffe' },
      'smedleys': { name: 'Smedleys', url: 'https://www.facebook.com/people/Smedleys-Cleveland/61571250336346/', eventsUrl: null, city: 'Cleveland' },
      'seeing-double': { name: 'Seeing Double Speakeasy Bar', url: 'https://www.seeingdoublecle.com/', eventsUrl: 'https://www.seeingdoublecle.com/music', city: 'Cleveland' },
      'huntington-bank-field': { name: 'Huntington Bank Field', url: 'https://huntingtonbankfield.com/', eventsUrl: 'https://huntingtonbankfield.com/events/', city: 'Cleveland' },
      'chagrin-tavern': { name: 'Chagrin Tavern on the River', url: 'https://www.chagrintavernontheriver.com/', eventsUrl: 'https://www.chagrintavernontheriver.com/events-1', city: 'Eastlake' },
      'shooters': { name: 'Shooters', url: 'https://www.shooterscleveland.com/', eventsUrl: 'https://speakeasygo.com/shooters-cleveland?vid=VN-dexa', city: 'Cleveland' },
      'crobar': { name: 'crobar', url: 'https://www.crobar1921.com/', eventsUrl: 'https://www.crobar1921.com/events', city: 'Cleveland' },
      'nightjar': { name: 'Nightjar', url: 'https://www.nightjarjazzbar.com/', eventsUrl: 'https://www.nightjarjazzbar.com/live-music-schedule', city: 'Woodmere' },
    },
    events: allEvents,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Done! Wrote ${allEvents.length} events to events.json`);
}

main();