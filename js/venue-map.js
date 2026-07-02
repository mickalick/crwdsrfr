const TYPE_LABELS = {
  "music-hall": "Music Hall",
  "club": "Club",
  "theater": "Theater",
  "arena": "Arena",
  "bar": "Bar"
};

let map, markers = {}, infoWindow, activeFilter = "all", activeVenueId = null;

function nextEventLine(v) {
  if (!v.events || v.events.length === 0) {
    return '<div class="v-empty">No events listed right now</div>';
  }
  const e = v.events[0];
  return `<div class="v-next"><span class="dot"></span>${e.title} — ${e.date}</div>`;
}

function buildFilterChips() {
  const wrap = document.getElementById('filters');
  const types = ["all", ...new Set(window.VENUES.map(v => v.type))];
  wrap.innerHTML = types.map(t =>
    `<button class="chip ${t === activeFilter ? 'active' : ''}" data-type="${t}">
      ${t === 'all' ? 'All' : TYPE_LABELS[t] || t}
    </button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeFilter = chip.dataset.type;
      buildFilterChips();
      renderList();
      applyMapFilter();
    });
  });
}

function visibleVenues() {
  const q = document.getElementById('search').value.trim().toLowerCase();
  return window.VENUES.filter(v => {
    const matchesType = activeFilter === 'all' || v.type === activeFilter;
    const matchesSearch = !q || v.name.toLowerCase().includes(q);
    return matchesType && matchesSearch;
  });
}

function renderList() {
  const list = document.getElementById('venueList');
  const vs = visibleVenues();
  document.getElementById('count').textContent = `${vs.length} venue${vs.length === 1 ? '' : 's'} shown`;

  list.innerHTML = vs.map(v => `
    <div class="venue-item ${v.id === activeVenueId ? 'selected' : ''}" data-id="${v.id}">
      <div class="v-name">${v.name}</div>
      <div class="v-meta">${TYPE_LABELS[v.type] || v.type} · ${v.address}</div>
      ${nextEventLine(v)}
    </div>
  `).join('');

  list.querySelectorAll('.venue-item').forEach(item => {
    item.addEventListener('click', () => selectVenue(item.dataset.id, true));
  });
}

function buildPinElement(venue, selected) {
  const pin = document.createElement('div');
  pin.className = `pin ${venue.events.length ? 'has-show' : ''} ${selected ? 'selected' : ''}`;
  const inner = document.createElement('div');
  inner.className = 'dot-inner';
  pin.appendChild(inner);
  return pin;
}

function applyMapFilter() {
  const visibleIds = new Set(visibleVenues().map(v => v.id));
  Object.entries(markers).forEach(([id, marker]) => {
    marker.map = visibleIds.has(id) ? map : null;
  });
}

function selectVenue(id, fromList) {
  activeVenueId = id;
  const venue = window.VENUES.find(v => v.id === id);
  if (!venue) return;

  Object.entries(markers).forEach(([vid, marker]) => {
    const v = window.VENUES.find(x => x.id === vid);
    marker.content = buildPinElement(v, vid === id);
  });

  renderList();

  if (fromList) {
    map.panTo({ lat: venue.lat, lng: venue.lng });
    map.setZoom(15);
  }

  const eventsHtml = venue.events.length
    ? venue.events.map(e => `
        <div class="iw-event">
          <a href="${e.eventUrl}">${e.title}</a><br>
          <span class="when">${e.date}</span>
        </div>`).join('')
    : `<div class="iw-event"><span class="when">No upcoming events listed</span></div>`;

  infoWindow.setContent(`
    <div class="iw">
      <div class="iw-title">${venue.name}</div>
      <div class="iw-meta">${TYPE_LABELS[venue.type] || venue.type} · ${venue.address}</div>
      ${eventsHtml}
    </div>
  `);
  infoWindow.open({ anchor: markers[id], map });
}

async function initMap() {
  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  map = new Map(document.getElementById("map"), {
    center: { lat: 41.4993, lng: -81.6944 },
    zoom: 12,
    mapId: "CRWDSRFR_VENUE_MAP",
    disableDefaultUI: true,
    zoomControl: true
  });

  infoWindow = new google.maps.InfoWindow();

  window.VENUES.forEach(v => {
    const marker = new AdvancedMarkerElement({
      map,
      position: { lat: v.lat, lng: v.lng },
      content: buildPinElement(v, false),
      title: v.name
    });
    marker.addListener('click', () => selectVenue(v.id, false));
    markers[v.id] = marker;
  });

  buildFilterChips();
  renderList();

  document.getElementById('search').addEventListener('input', () => {
    renderList();
    applyMapFilter();
  });
}

// Google's loader calls this by name once the API script finishes loading.
window.initMap = initMap;