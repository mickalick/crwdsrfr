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

  const [rocketArena, grogShop, agora, beachland, metroparks, rockinOnTheRiver, cainPark, happyDog, mahalls, bopStop, globeIron, jacobsPavilion] = await Promise.all([
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
    ...happyDog,
    ...mahalls,
    ...bopStop,
    ...globeIron,
    ...jacobsPavilion,
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