const TYPE_LABELS = {
  "music-hall": "Music Hall",
  "club": "Club",
  "theater": "Theater",
  "arena": "Arena",
  "bar": "Bar",
  'outdoor': "Outdoor"
};

let map, markers = {}, infoWindow, activeFilter = null, activeVenueId = null, idleListener = null;
let showFilters = false;

function toggleFilters() {
  showFilters = !showFilters;
  const filterRow = document.getElementById('filters');
  filterRow.style.display = showFilters ? 'flex' : 'none';
  document.getElementById('filterToggle').classList.toggle('active', showFilters);
}

function buildFilterChips() {
  const wrap = document.getElementById('filters');
  const types = [...new Set(window.VENUES.map(v => v.type))].sort();
  wrap.innerHTML = types.map(t =>
    `<button class="chip ${t === activeFilter ? 'active' : ''}" data-type="${t}">
      ${TYPE_LABELS[t] || t}
    </button>`
  ).join('');
  wrap.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      activeFilter = activeFilter === chip.dataset.type ? null : chip.dataset.type;
      buildFilterChips();
      renderList();
      applyMapFilter();
    });
  });
}

function visibleVenues() {
  const q = document.getElementById('venueSearch').value.trim().toLowerCase();
  return window.VENUES.filter(v => {
    const matchesType = !activeFilter || v.type === activeFilter;
    const matchesSearch = !q || v.name.toLowerCase().includes(q);
    return matchesType && matchesSearch;
  });
}

function renderList() {
  const list = document.getElementById('venueList');
  const vs = visibleVenues().sort((a, b) => a.name.localeCompare(b.name));
  document.getElementById('count').textContent = `${vs.length} venue${vs.length === 1 ? '' : 's'}`;

  list.innerHTML = vs.map(v => `
    <div class="venue-item ${v.id === activeVenueId ? 'selected' : ''}" data-id="${v.id}">
      <div class="v-name">${v.name}</div>
      <div class="v-meta">${v.address} <br/> ${TYPE_LABELS[v.type] || v.type}</div>
    </div>
  `).join('');

  list.querySelectorAll('.venue-item').forEach(item => {
    item.addEventListener('click', () => selectVenue(item.dataset.id, true));
  });
}

function buildPinElement(venue, selected) {
  const wrap = document.createElement('div');
  wrap.className = `pin-anchor ${selected ? 'selected' : ''}`;

  const pin = document.createElement('div');
  pin.className = 'pin';
  const inner = document.createElement('div');
  inner.className = 'dot-inner';
  pin.appendChild(inner);
  wrap.appendChild(pin);

  return wrap;
}

function applyMapFilter() {
  const visibleIds = new Set(visibleVenues().map(v => v.id));
  Object.entries(markers).forEach(([id, marker]) => {
    marker.map = visibleIds.has(id) ? map : null;
  });
}

function deselectVenue(resetView = true) {
  activeVenueId = null;
  infoWindow.close();
  Object.entries(markers).forEach(([vid, marker]) => {
    const v = window.VENUES.find(x => x.id === vid);
    marker.content = buildPinElement(v, false);
  });
  renderList();

  if (resetView) {
    map.panTo({ lat: 41.4993, lng: -81.6944 });
    map.setZoom(9);
  }
}

let panAnimationId = null;
let currentCenter = null; // our own source of truth while animating, avoids querying a lagging map

function smoothPanTo(map, target, duration = 450) {
  if (panAnimationId) {
    cancelAnimationFrame(panAnimationId);
    panAnimationId = null;
  }

  const c = map.getCenter();
  const start = currentCenter || { lat: c.lat(), lng: c.lng() };
  const dLat = target.lat - start.lat, dLng = target.lng - start.lng;
  const startTime = performance.now();

  return new Promise(resolve => {
    function step(now) {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      currentCenter = { lat: start.lat + dLat * eased, lng: start.lng + dLng * eased };
      map.setCenter(currentCenter);
      if (t < 1) {
        panAnimationId = requestAnimationFrame(step);
      } else {
        panAnimationId = null;
        resolve();
      }
    }
    panAnimationId = requestAnimationFrame(step);
  });
}

function selectVenue(id, fromList) {
  if (id === activeVenueId) {
    deselectVenue(fromList);
    return;
  }

  activeVenueId = id;
  const venue = window.VENUES.find(v => v.id === id);
  if (!venue) return;

  infoWindow.close(); // force a clean rebind to the new anchor instead of reusing stale state

  Object.entries(markers).forEach(([vid, marker]) => {
    const v = window.VENUES.find(x => x.id === vid);
    marker.content = buildPinElement(v, vid === id);
  });

  renderList();

  infoWindow.setContent(`
    <div class="iw">
      <div class="iw-title">${venue.name}</div>
      <div class="iw-meta">${venue.address} <br/> ${TYPE_LABELS[venue.type] || venue.type}</div>
    </div>
  `);

  infoWindow.open({ anchor: markers[id], map });
  if (map.getZoom() !== 14) map.setZoom(14);
  smoothPanTo(map, { lat: venue.lat, lng: venue.lng });
}

async function initMap() {
  const { Map } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");

  map = new Map(document.getElementById("map"), {
    center: { lat: 41.4993, lng: -81.6944 },
    zoom: 9,
    mapId: "CRWDSRFR_VENUE_MAP",
    renderingType: google.maps.RenderingType.RASTER, // temporary diagnostic
    disableDefaultUI: true,
    zoomControl: true,
    gestureHandling: 'greedy',
    isFractionalZoomEnabled: false
  });

  ['center_changed', 'zoom_changed', 'bounds_changed', 'dragstart', 'drag', 'dragend', 'idle', 'resize'].forEach(evt => {
    map.addListener(evt, () => {
      const c = map.getCenter();
      const z = map.getZoom();
      console.log(`[${performance.now().toFixed(0)}ms] ${evt}`, c ? `${c.lat().toFixed(5)}, ${c.lng().toFixed(5)}` : '', 'zoom:', z);
    });
  });

  const mapDiv = document.getElementById('map');
  new ResizeObserver(entries => {
    const r = entries[0].contentRect;
    console.log(`[${performance.now().toFixed(0)}ms] map container resized`, `${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
  }).observe(mapDiv);

  infoWindow = new google.maps.InfoWindow({
    disableAutoPan: true // we handle panning ourselves in selectVenue; letting both run causes competing animations
  });

  map.addListener('dragend', () => {
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

  buildFilterChips();
  renderList();

  document.getElementById('venueSearch').addEventListener('input', () => {
    renderList();
    applyMapFilter();
  });

  document.getElementById('filterToggle').addEventListener('click', toggleFilters);
}

// Google's loader calls this by name once the API script finishes loading.
window.initMap = initMap;