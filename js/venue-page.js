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
      else timeDisplay = 'See Event';

      const titleLink = event.eventUrl || venueMeta?.eventsUrl || null;
      const titleHtml = titleLink
        ? `<a href="${titleLink}" target="_blank">${event.title}</a>`
        : event.title;

      const linkHtml = event.ticketUrl
        ? `<div class="ticketLink"><a href="${event.ticketUrl}" target="_blank"><span class="icon" id="opn"></span></a></div>`
        : '';

      return `
        <div class="event">
          <div class="eventInfo">
            <span class="eventName">${titleHtml}</span>
            <span class="eventTime">${timeDisplay}</span>
            <span class="eventCost">${event.price ?? 'See Event'}</span>
          </div>
          ${linkHtml}
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
  const res = await fetch('/data/events.json');
  const allData = await res.json();

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

// Google's loader calls this by name once the API script finishes loading —
// same convention venue-map.js already uses.
window.initMap = initMap;

loadVenueEvents();
