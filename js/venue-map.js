const TYPE_LABELS = {
  "music-hall": "Music Hall",
  "club": "Club",
  "theater": "Theater",
  "arena": "Arena",
  "bar": "Bar"
};

let map, markers = {}, infoWindow, activeVenueId = null, idleListener = null;

function visibleVenues() {
  const q = document.getElementById('venueSearch').value.trim().toLowerCase();
  return window.VENUES.filter(v => !q || v.name.toLowerCase().includes(q));
}

function renderList() {
  const list = document.getElementById('venueList');
  const vs = visibleVenues().sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById('count').textContent = `${vs.length} venue${vs.length === 1 ? '' : 's'} shown`;

  list.innerHTML = vs.map(v => `
    <div class="venue-item ${v.id === activeVenueId ? 'selected' : ''}" data-id="${v.id}">
      <div class="v-name">${v.name}</div>
      <div class="v-meta">${TYPE_LABELS[v.type] || v.type} · ${v.address}</div>
    </div>
  `).join('');

  list.querySelectorAll('.venue-item').forEach(item => {
    item.addEventListener('click', () => selectVenue(item.dataset.id, true));
  });
}

function buildPinElement(venue, selected) {
  const pin = document.createElement('div');
  pin.className = `pin ${selected ? 'selected' : ''}`;
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

function deselectVenue() {
  activeVenueId = null;
  infoWindow.close();
  Object.entries(markers).forEach(([vid, marker]) => {
    const v = window.VENUES.find(x => x.id === vid);
    marker.content = buildPinElement(v, false);
  });
  renderList();
  map.panTo({ lat: 41.4993, lng: -81.6944 });
  map.setZoom(9);
}

function selectVenue(id, fromList) {
  if (id === activeVenueId) {
    deselectVenue();
    return;
  }

  activeVenueId = id;
  const venue = window.VENUES.find(v => v.id === id);
  if (!venue) return;

  infoWindow.close();

  // cancel any previously pending idle open
  if (idleListener) {
    google.maps.event.removeListener(idleListener);
    idleListener = null;
  }

  Object.entries(markers).forEach(([vid, marker]) => {
    const v = window.VENUES.find(x => x.id === vid);
    marker.content = buildPinElement(v, vid === id);
  });

  renderList();

  infoWindow.setContent(`
    <div class="iw">
      <div class="iw-title">${venue.name}</div>
      <div class="iw-meta">${TYPE_LABELS[venue.type] || venue.type} · ${venue.address}</div>
    </div>
  `);

  map.moveCamera({ center: { lat: venue.lat, lng: venue.lng }, zoom: 14 });

  idleListener = google.maps.event.addListenerOnce(map, 'idle', () => {
    idleListener = null;
    infoWindow.open({ anchor: markers[id], map });
  });
}

async function initMap() {
  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  map = new Map(document.getElementById("map"), {
    center: { lat: 41.4993, lng: -81.6944 },
    zoom: 9,
    mapId: "CRWDSRFR_VENUE_MAP",
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    isFractionalZoomEnabled: false
  });

  infoWindow = new google.maps.InfoWindow();

  map.addListener('dragend', () => {
    if (idleListener) {
      google.maps.event.removeListener(idleListener);
      idleListener = null;
    }
    infoWindow.close();
    activeVenueId = null;
    Object.entries(markers).forEach(([vid, marker]) => {
      const v = window.VENUES.find(x => x.id === vid);
      marker.content = buildPinElement(v, false);
    });
    renderList();
  });

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

  renderList();

  document.getElementById('venueSearch').addEventListener('input', () => {
    renderList();
    applyMapFilter();
  });
}

// Google's loader calls this by name once the API script finishes loading.
window.initMap = initMap;