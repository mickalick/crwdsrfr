const venueId = document.body.dataset.venueId;

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

// Genre labels + colors come from data/genres.json — same source of truth
// (and same lookup pattern) as the main calendar in events.js. Falls back
// to titleCase()/hash color for any genre not yet added there, so a
// brand-new genre never breaks, it just won't have a custom look yet.
let genreMeta = {}; // populated from data/genres.json in loadVenueEvents

function titleCase(str) {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function genreLabel(genre) {
  return genreMeta[genre]?.label || titleCase(genre);
}

function genreColor(genre) {
  if (genreMeta[genre]?.color) return genreMeta[genre].color;

  let hash = 0;
  for (let i = 0; i < genre.length; i++) {
    hash = (hash * 31 + genre.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

const dateOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };

function renderVenueEvents(events, venueMeta) {
  const container = document.getElementById('calendarCards');
  const calendarEnd = document.getElementById('calendarEnd');
  container.querySelectorAll('.venueCard').forEach(el => el.remove());

  if (events.length === 0) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('withResults').style.display = 'none';
    return;
  }
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('withResults').style.display = 'block';

  // Group by date — same idea as the main calendar grouping by venue,
  // just with the date standing in the .venue column instead.
  const grouped = {};
  events.forEach(e => {
    if (!grouped[e.date]) grouped[e.date] = [];
    grouped[e.date].push(e);
  });

  Object.entries(grouped).forEach(([dateStr, dateEvents]) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const formatted = new Date(y, m - 1, d).toLocaleDateString('en-US', dateOptions);

    const eventsHtml = dateEvents.map(event => {
      const showTime = formatTime(event.time);
      const doorsTime = formatTime(event.doors);

      let timeDisplay = '';
      if (showTime && doorsTime) timeDisplay = `${showTime} (Doors ${doorsTime})`;
      else if (showTime) timeDisplay = showTime;
      else if (doorsTime) timeDisplay = `Doors ${doorsTime}`;
      else timeDisplay = 'Check Time';

      const titleLink = event.eventUrl || venueMeta?.eventsUrl || null;
      const titleHtml = titleLink
        ? `<a href="${titleLink}" target="_blank">${event.title}</a>`
        : event.title;

      // No ticket URL: an invisible placeholder keeps the columns lined up
      const linkHtml = event.ticketUrl
        ? `<div class="ticketLink"><a href="${event.ticketUrl}" target="_blank"><span class="icon" id="opn"></span></a></div>`
        : '<div class="ticketLink isPlaceholder" aria-hidden="true"></div>';

      // Same markup/classes as the main calendar's genre chips, so the
      // existing .eventGenres / .genre-chip CSS in style.css applies here
      // with no changes needed. Unlike the main calendar, venue pages
      // don't check the "Display genre where available" setting — genres
      // always show here regardless of what a visitor set elsewhere.
      const genresHtml = (event.genres && event.genres.length > 0)
        ? `<div class="eventGenres">${event.genres.map(g => `
            <span class="genre-chip" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</span>
          `).join('')}</div>`
        : '';

      return `
        <div class="event" data-event-id="${event.id}">
          <div class="eventInfo">
            <span class="eventName">${titleHtml}</span>
            <span class="eventTime">${timeDisplay}</span>
            <span class="eventCost">${event.price ?? 'Check Price'}</span>
            ${genresHtml}
          </div>
          ${linkHtml}
          <div class="eventSocial"></div>
        </div>`;
    }).join('');

    const cardHtml = `
      <div class="venueCard">
        <div class="venue">
          <h4>${formatted}</h4>
        </div>
        <div class="venueEvents">
          ${eventsHtml}
        </div>
      </div>`;

    container.insertBefore(
      document.createRange().createContextualFragment(cardHtml),
      calendarEnd
    );
  });
}

async function loadVenueEvents() {
  const [eventsRes, genresRes] = await Promise.all([
    fetch('/data/events.json'),
    fetch('/data/genres.json')
  ]);
  const allData = await eventsRes.json();

  try {
    genreMeta = await genresRes.json();
  } catch (e) {
    // Missing/invalid genres.json isn't fatal — genreLabel()/genreColor()
    // already fall back to titleCase()/hash color for every genre.
    genreMeta = {};
  }

  const todayStr = toLocalDateStr(new Date());
  const events = allData.events
    .filter(e => e.venueId === venueId && e.date >= todayStr)
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      if (!a.time && !b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

  renderVenueEvents(events, allData.venues[venueId]);
  venueEvents = events;
  venueName = allData.venues[venueId]?.name || '';
  attachEventSocial();
}

async function initMap() {
  const mapEl = document.getElementById('venueMap');
  if (!mapEl) return;

  const lat = parseFloat(mapEl.dataset.lat);
  const lng = parseFloat(mapEl.dataset.lng);
  const name = mapEl.dataset.name;

  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  const map = new Map(mapEl, {
    center: { lat, lng },
    zoom: 15,
    mapId: "CRWDSRFR_VENUE_MAP",
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'cooperative'
  });

  new AdvancedMarkerElement({ map, position: { lat, lng }, title: name });
}

// Hype button under "Visit Site" (js/crwd-social.js). Same button and behavior
// as the act modal's. Runs once accounts are ready, and again if someone signs
// in or out, so "already hyped" always matches whoever is signed in.
async function mountVenueHype() {
  const slot = document.getElementById('venueHype');
  if (!slot || !venueId) return;
  const stats = (await CrwdSocial.loadStats('venue', [venueId]))[venueId];
  slot.replaceChildren(CrwdSocial.hypeButton({
    type: 'venue',
    id: venueId,
    hypes: stats.hypes,
    hyped: stats.hyped,
    large: true
  }));
}

// ---------- Hype + comment buttons on each show (same as the calendar) ----------
// Fills each show's .eventSocial slot; counts for every show load in one batch.
let venueEvents = [];
let venueName = '';
let socialRun = 0;

async function attachEventSocial() {
  if (!(window.CrwdSocial && window.CrwdCore && CrwdCore.enabled)) return;
  const slots = [...document.querySelectorAll('#calendarCards .eventSocial')];
  if (slots.length === 0) return;
  const run = ++socialRun;

  await CrwdCore.ready; // so "already hyped" reflects whoever is signed in
  const ids = [...new Set(slots.map(slot => slot.closest('.event').dataset.eventId))];
  const stats = await CrwdSocial.loadStats('event', ids);
  if (run !== socialRun) return;

  const byId = new Map(venueEvents.map(e => [e.id, e]));
  slots.forEach(slot => {
    const id = slot.closest('.event').dataset.eventId;
    const event = byId.get(id);
    const s = stats[id];
    slot.replaceChildren(CrwdSocial.reactions({
      type: 'event',
      id: id,
      hypes: s.hypes,
      comments: s.comments,
      hyped: s.hyped,
      title: event ? eventContext(event) : null // shown at the top of the comments modal
    }));
  });
}

// "OSEES … · Beachland Ballroom · Sun, Oct 19"
function eventContext(event) {
  const [y, m, d] = event.date.split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return [event.title, venueName, day].filter(Boolean).join(' · ');
}

if (window.CrwdSocial && window.CrwdCore && CrwdCore.enabled) {
  document.body.classList.add('socialOn'); // holds the buttons' space while counts load
  // Signing in or out changes what you've hyped: refresh both the venue's button and the shows'
  CrwdCore.onChange(() => {
    mountVenueHype();
    attachEventSocial();
  });
}

// Google's loader calls this by name once the API script finishes loading —
// same convention venue-map.js already uses.
window.initMap = initMap;

loadVenueEvents();
