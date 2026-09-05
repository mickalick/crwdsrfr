let allData = null;
let allVenues = null; // keyed by venue id — loaded from venues.json for type/area filtering
let currentDateStr = toLocalDateStr(new Date());
let currentSearch = '';
let calendarViewMode = 'day'; // 'day' | 'week'
let calendarSortMethod = 'venue-name'; // 'venue-name' | 'show-title' | 'show-time'
let calendarShowGenres = true; // whether genre chips render on event tiles

// Selected filter values. Names are stored as venue ids (unambiguous),
// types and areas as their raw string values.
const selectedVenueIds = new Set();
const selectedTypes = new Set();
const selectedAreas = new Set();
const selectedGenres = new Set();
const expandedGroups = { name: false, type: false, area: false, genre: false };

const FILTER_STORAGE_KEY = 'crwdsrfr_calendar_filters';
const CALENDAR_SETTINGS_KEY = 'crwdsrfr_calendar_settings';

// Persists view mode + sort method to localStorage, same pattern as filters.
function saveCalendarSettingsToStorage() {
  try {
    const payload = {
      viewMode: calendarViewMode,
      sortMethod: calendarSortMethod,
      showGenres: calendarShowGenres,
    };
    localStorage.setItem(CALENDAR_SETTINGS_KEY, JSON.stringify(payload));
  } catch (e) {
    // localStorage unavailable — settings simply won't persist this session
  }
}

// Reads previously saved view mode + sort method back in. Falls back to
// the defaults ('day' / 'venue-name') if nothing's stored or values are invalid.
function loadCalendarSettingsFromStorage() {
  try {
    const raw = localStorage.getItem(CALENDAR_SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.viewMode === 'day' || parsed.viewMode === 'week') {
      calendarViewMode = parsed.viewMode;
    }
    if (['venue-name', 'show-title', 'show-time'].includes(parsed.sortMethod)) {
      calendarSortMethod = parsed.sortMethod;
    }
    if (typeof parsed.showGenres === 'boolean') {
      calendarShowGenres = parsed.showGenres;
    }
  } catch (e) {
    // Corrupt or missing data — just start with defaults
  }
}

// Purely a CSS toggle — genre chips are always rendered into the DOM by
// renderVenueCards, this just shows/hides them instantly via a body class
// without needing to re-render any event tiles.
function applyGenreVisibility() {
  document.body.classList.toggle('hide-genres', !calendarShowGenres);
}

// Persists selected filters to localStorage so they survive tab close /
// revisit. Fails silently if storage is unavailable (private browsing,
// disabled storage, quota issues, etc) — filters just won't persist.
function saveFiltersToStorage() {
  try {
    const payload = {
      venueIds: [...selectedVenueIds],
      types: [...selectedTypes],
      areas: [...selectedAreas],
      genres: [...selectedGenres],
    };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // localStorage unavailable — filters simply won't persist this session
  }
}

// Reads previously saved filters back into the selected sets. Called once,
// before the first chip render, so stored filters show as active on load.
// Any ids/values no longer valid (e.g. a venue was removed from venues.json)
// are harmless — they simply won't match anything once venueMatchesFilters
// runs against the current allVenues, and get pruned next time filters change.
function loadFiltersFromStorage() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    (parsed.venueIds || []).forEach(id => selectedVenueIds.add(id));
    (parsed.types || []).forEach(t => selectedTypes.add(t));
    (parsed.areas || []).forEach(a => selectedAreas.add(a));
    (parsed.genres || []).forEach(g => selectedGenres.add(g));
  } catch (e) {
    // Corrupt or missing data — just start with no filters
  }
}

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
  "diy": "DIY",
  "festival": "Festival",
  "other": "Other"
};

// Genre labels + colors are the single source of truth in data/genres.json
// (fetched in loadEvents, below) rather than hardcoded here — edit that
// file to change how a genre displays or looks, no code changes needed.
let genreMeta = {}; // populated from data/genres.json — { [genre]: { label, color } }

function titleCase(str) {
  return str
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Looks up the label set in data/genres.json first; falls back to
// titleCase() for any genre not yet added there, so a brand-new genre
// never breaks — it just won't have a custom label until you add one.
function genreLabel(genre) {
  return genreMeta[genre]?.label || titleCase(genre);
}

// Looks up the color set in data/genres.json first; falls back to a
// deterministic hash so any genre not yet added there still gets a
// stable color (just not one you chose) rather than no color at all.
function genreColor(genre) {
  if (genreMeta[genre]?.color) return genreMeta[genre].color;

  let hash = 0;
  for (let i = 0; i < genre.length; i++) {
    hash = (hash * 31 + genre.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue}, 65%, 60%)`;
}

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeekDates(startDateStr) {
  const [y, m, d] = startDateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d); // local date, not UTC — avoids the off-by-one issues toLocalDateStr already guards against
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(start);
    dt.setDate(start.getDate() + i);
    dates.push(toLocalDateStr(dt));
  }
  return dates;
}

function formatTime(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

function sortableName(name) {
  return name.replace(/^the\s+/i, '');
}

function updateSubHead() {
  const subHeadSpan = document.querySelector('.subHead span');
  const term = currentSearch.trim();

  if (calendarViewMode === 'week') {
    subHeadSpan.textContent = term === ''
      ? 'All shows for week of:'
      : `All shows including "${term}" for week of:`;
  } else {
    subHeadSpan.textContent = term === ''
      ? 'All shows for:'
      : `All shows including "${term}" for:`;
  }
}

let matchingDates = new Set();

function updateMatchingDates() {
  matchingDates = new Set();
  if (!allData) return;

  const term = currentSearch.toLowerCase().trim();
  const filtersActive = hasActiveVenueFilters();
  const genreFiltersActive = hasActiveGenreFilters();
  if (term === '' && !filtersActive && !genreFiltersActive) return; // nothing active = no dots, default calendar view

  allData.events.forEach(event => {
    const venue = allData.venues[event.venueId];

    let matchesSearch = true;
    if (term !== '') {
      const matchesTitle = event.title.toLowerCase().includes(term);
      const matchesVenue = venue?.name.toLowerCase().includes(term);
      const matchesPerformer = event.performers?.some(p =>
        p.name.toLowerCase().includes(term)
      );
      matchesSearch = matchesTitle || matchesVenue || matchesPerformer;
    }

    const matchesVenueFilter = !filtersActive || venueMatchesFilters(allVenues?.[event.venueId]);
    const matchesGenreFilter = eventMatchesGenreFilters(event);

    if (matchesSearch && matchesVenueFilter && matchesGenreFilter) {
      matchingDates.add(event.date);
    }
  });
}

function hasActiveVenueFilters() {
  return selectedVenueIds.size > 0 || selectedTypes.size > 0 || selectedAreas.size > 0;
}

// Name > Type > Area, but "priority" here just means each category is
// checked in that order — a venue matches if it satisfies ANY selected
// filter across all three categories (union, not intersection). e.g.
// selecting one venue name plus an area shows that venue AND every
// venue in that area, not just venues that match both.
function venueMatchesFilters(venue) {
  if (!venue) return false;
  if (selectedVenueIds.has(venue.id)) return true;
  if (selectedTypes.has(venue.type)) return true;
  if (selectedAreas.has(venue.area)) return true;
  return false;
}

// Genre lives on the event itself (not the venue), so it's checked as its
// own filter dimension: an event must match AT LEAST ONE selected genre
// (union within genres), and that result is ANDed against the venue-based
// filters above — e.g. selecting "Jazz" + "Grog Shop" shows only jazz
// shows AT Grog Shop, not all jazz shows everywhere plus all Grog Shop shows.
function hasActiveGenreFilters() {
  return selectedGenres.size > 0;
}

function eventMatchesGenreFilters(event) {
  if (selectedGenres.size === 0) return true;
  const genres = event.genres || [];
  return genres.some(g => selectedGenres.has(g));
}

function applyFilters() {
  updateSubHead();

  if (!allData) return;

  let filtered;
  if (calendarViewMode === 'week') {
    const weekSet = new Set(getWeekDates(currentDateStr));
    filtered = allData.events.filter(e => weekSet.has(e.date));
  } else {
    filtered = allData.events.filter(e => e.date === currentDateStr);
  }

  if (currentSearch.trim() !== '') {
    const term = currentSearch.toLowerCase().trim();
    filtered = filtered.filter(event => {
      const venue = allData.venues[event.venueId];
      const matchesTitle = event.title.toLowerCase().includes(term);
      const matchesVenue = venue?.name.toLowerCase().includes(term);
      const matchesPerformer = event.performers?.some(p =>
        p.name.toLowerCase().includes(term)
      );
      return matchesTitle || matchesVenue || matchesPerformer;
    });
  }

  if (hasActiveVenueFilters()) {
    filtered = filtered.filter(event => venueMatchesFilters(allVenues?.[event.venueId]));
  }

  if (hasActiveGenreFilters()) {
    filtered = filtered.filter(event => eventMatchesGenreFilters(event));
  }

  renderEvents(filtered);
}

function resetSearch() {
  const input = document.getElementById('search');
  input.value = '';
  currentSearch = '';
  document.getElementById('searchWrapper').classList.remove('hasValue');
  updateMatchingDates();
  datePickerFp.redraw();
  applyFilters();
  input.focus();
}

function renderVenueCards(events, container, beforeNode) {
  // Show Title and Show Time sorting give each show its own tile, even when
  // a venue has multiple shows that day — only the default Venue Name sort
  // groups them into a single card the way the calendar has always worked.
  const splitPerShow = calendarSortMethod === 'show-title' || calendarSortMethod === 'show-time';

  let groups;
  if (splitPerShow) {
    groups = events.map(event => ({ venueId: event.venueId, events: [event] }));
  } else {
    const grouped = {};
    events.forEach(event => {
      if (!grouped[event.venueId]) grouped[event.venueId] = [];
      grouped[event.venueId].push(event);
    });
    groups = Object.entries(grouped).map(([venueId, venueEvents]) => ({ venueId, events: venueEvents }));
  }

  const groupSortKey = (group) => {
    if (calendarSortMethod === 'show-title') {
      const titles = group.events.map(e => e.title).sort((a, b) => a.localeCompare(b));
      return titles[0] ?? '';
    }
    if (calendarSortMethod === 'show-time') {
      const times = group.events.map(e => e.time).filter(Boolean).sort();
      return times[0] ?? '99:99'; // events with no time sort to the end
    }
    return sortableName(allData.venues[group.venueId]?.name ?? '');
  };

  groups
    .sort((a, b) => String(groupSortKey(a)).localeCompare(String(groupSortKey(b))))
    .forEach(({ venueId, events: venueEvents }) => {
      const venue = allData.venues[venueId];
      if (!venue) return;

      const sortedEvents = [...venueEvents].sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });

      const eventsHtml = sortedEvents.map(event => {
        const showTime = formatTime(event.time);
        const doorsTime = formatTime(event.doors);

        let timeDisplay = '';
        if (showTime && doorsTime) timeDisplay = `${showTime} (Doors ${doorsTime})`;
        else if (showTime) timeDisplay = showTime;
        else if (doorsTime) timeDisplay = `Doors ${doorsTime}`;
        else timeDisplay = 'Check Time';

        const titleLink = event.eventUrl || venue.eventsUrl || null;
        const titleHtml = titleLink
          ? `<a href="${titleLink}" target="_blank">${event.title}</a>`
          : event.title;

        const linkHtml = event.ticketUrl
          ? `<div class="ticketLink"><a href="${event.ticketUrl}" target="_blank"><span class="icon" id="opn"></span></a></div>`
          : '';

        // Rendered as its own full-width row below the name/time/price line
        // (not inline with them) so it only adds height to the event tile —
        // it never affects the width or alignment of the existing content.
        const genresHtml = (event.genres && event.genres.length > 0)
          ? `<div class="eventGenres">${event.genres.map(g => `
              <span class="genre-chip" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</span>
            `).join('')}</div>`
          : '';

        return `
          <div class="event">
            <div class="eventInfo">
              <span class="eventName">${titleHtml}</span>
              <span class="eventTime">${timeDisplay}</span>
              <span class="eventCost">${event.price ?? 'Check Price'}</span>
              ${genresHtml}
            </div>
            ${linkHtml}
          </div>`;
      }).join('');

      const cardHtml = `
        <div class="venueCard">
          <div class="venue">
            <h4><a href="/venues/${venueId}/">${venue.name}</a></h4>
          </div>
          <div class="venueEvents">
            ${eventsHtml}
          </div>
        </div>`;

      container.insertBefore(
        document.createRange().createContextualFragment(cardHtml),
        beforeNode
      );
    });

  return groups.length > 0;
}

function renderDateSeparator(dateStr, container, beforeNode) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const formatted = new Date(y, m - 1, d).toLocaleDateString('en-US', options);
  container.insertBefore(
    document.createRange().createContextualFragment(`<h2 class="dateSeparator">${formatted}</h2>`),
    beforeNode
  );
}

function renderEvents(events) {
  const container = document.getElementById('calendarCards');

  $(container).fadeTo(150, 0, function() {
    container.querySelectorAll('.venueCard, .dateSeparator').forEach(el => el.remove());
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('withResults').style.display = 'block';

    const calendarEnd = document.getElementById('calendarEnd');
    let anyRendered = false;

    if (calendarViewMode === 'week') {
      getWeekDates(currentDateStr).forEach(dateStr => {
        const dayEvents = events.filter(e => e.date === dateStr);
        if (dayEvents.length === 0) return;
        anyRendered = true;
        renderDateSeparator(dateStr, container, calendarEnd);
        renderVenueCards(dayEvents, container, calendarEnd);
      });
    } else {
      anyRendered = renderVenueCards(events, container, calendarEnd);
    }

    if (!anyRendered) {
      document.getElementById('emptyState').style.display = 'block';
      document.getElementById('withResults').style.display = 'none';
    }

    $(container).fadeTo(150, 1);
  });
}

function collapseChipRow(wrap, groupKey) {
  wrap.querySelectorAll('.chip-show-all').forEach(el => el.remove());
  const chips = [...wrap.querySelectorAll('.chip')];
  chips.forEach(c => c.style.display = '');

  if (chips.length === 0) return;

  const lineOneTop = chips[0].offsetTop;
  const lineTwoStart = chips.findIndex(c => c.offsetTop !== lineOneTop);
  if (lineTwoStart === -1) return; // everything fits on line 1

  const lineTwoTop = chips[lineTwoStart].offsetTop;
  const lineThreeStart = chips.findIndex((c, i) => i >= lineTwoStart && c.offsetTop !== lineTwoTop);
  if (lineThreeStart === -1) return; // everything fits within 2 lines

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'chip chip-show-all';

  if (expandedGroups[groupKey]) {
    toggleBtn.textContent = 'Show Less';
    toggleBtn.addEventListener('click', () => {
      expandedGroups[groupKey] = false;
      collapseChipRow(wrap, groupKey);
    });
  } else {
    chips.slice(lineThreeStart).forEach(c => c.style.display = 'none');
    toggleBtn.textContent = `Show All`;
    toggleBtn.addEventListener('click', () => {
      expandedGroups[groupKey] = true;
      collapseChipRow(wrap, groupKey);
    });
  }

  wrap.appendChild(toggleBtn);
}

function refreshFilterUI() {
  saveFiltersToStorage();
  buildCalendarFilterChips();
  renderActiveFilters();
  updateMatchingDates();
  datePickerFp.redraw();
  applyFilters();
}

function renderActiveFilters() {
  const wrapper = document.getElementById('activeFiltersWrapper');
  const chipsWrap = document.getElementById('activeFilters');
  const active = [];

  selectedVenueIds.forEach(id => {
    active.push({ group: 'name', value: id, label: allVenues?.[id]?.name ?? id });
  });
  selectedTypes.forEach(t => {
    active.push({ group: 'type', value: t, label: TYPE_LABELS[t] || t });
  });
  selectedAreas.forEach(a => {
    active.push({ group: 'area', value: a, label: a });
  });
  selectedGenres.forEach(g => {
    active.push({ group: 'genre', value: g, label: genreLabel(g), color: genreColor(g) });
  });

  if (active.length === 0) {
    wrapper.style.display = 'none';
    chipsWrap.innerHTML = '';
    return;
  }

  wrapper.style.display = 'flex';
  chipsWrap.innerHTML = active.map(f => `
    <button type="button" class="chip active-chip" data-group="${f.group}" data-value="${f.value}"${f.color ? ` style="--genre-color: ${f.color}"` : ''}>${f.label} <span class="chip-remove">&times;</span></button>
  `).join('') + `<button type="button" class="chip chip-reset" id="resetAllFilters">Reset</button>`;

  chipsWrap.querySelectorAll('.active-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const { group, value } = chip.dataset;
      const set = group === 'name' ? selectedVenueIds : group === 'type' ? selectedTypes : group === 'area' ? selectedAreas : selectedGenres;
      set.delete(value);
      refreshFilterUI();
    });
  });

  document.getElementById('resetAllFilters').addEventListener('click', () => {
    selectedVenueIds.clear();
    selectedTypes.clear();
    selectedAreas.clear();
    selectedGenres.clear();
    refreshFilterUI();
  });
}

function buildCalendarFilterChips() {
  if (!allVenues) return;
  const venues = Object.values(allVenues);

  const nameWrap = document.getElementById('calendarVenueFilters');
  const typeWrap = document.getElementById('calendarTypeFilters');
  const areaWrap = document.getElementById('calendarAreaFilters');
  const genreWrap = document.getElementById('calendarGenreFilters');

  const sortedVenues = [...venues].sort((a, b) =>
    sortableName(a.name).localeCompare(sortableName(b.name))
  );
  nameWrap.innerHTML = sortedVenues.map(v => `
    <button type="button" class="chip ${selectedVenueIds.has(v.id) ? 'active' : ''}" data-filter="name" data-value="${v.id}">${v.name}</button>
  `).join('');

  const types = [...new Set(venues.map(v => v.type))].sort();
  typeWrap.innerHTML = types.map(t => `
    <button type="button" class="chip ${selectedTypes.has(t) ? 'active' : ''}" data-filter="type" data-value="${t}">${TYPE_LABELS[t] || t}</button>
  `).join('');

  const areas = [...new Set(venues.map(v => v.area))].sort();
  areaWrap.innerHTML = areas.map(a => `
    <button type="button" class="chip ${selectedAreas.has(a) ? 'active' : ''}" data-filter="area" data-value="${a}">${a}</button>
  `).join('');

  // Genres live on events, not venues, so this list comes from whatever
  // distinct genre values are currently loaded in allData.events rather
  // than from allVenues like the other three chip rows.
  const genres = [...new Set((allData?.events ?? []).flatMap(e => e.genres ?? []))].sort();
  genreWrap.innerHTML = genres.map(g => `
    <button type="button" class="chip ${selectedGenres.has(g) ? 'active' : ''}" data-filter="genre" data-value="${g}" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</button>
  `).join('');

  [nameWrap, typeWrap, areaWrap, genreWrap].forEach(wrap => {
    wrap.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const { filter, value } = chip.dataset;
        const set = filter === 'name' ? selectedVenueIds : filter === 'type' ? selectedTypes : filter === 'area' ? selectedAreas : selectedGenres;
        if (set.has(value)) set.delete(value); else set.add(value);
        refreshFilterUI();
      });
    });
  });

  collapseChipRow(nameWrap, 'name');
  collapseChipRow(typeWrap, 'type');
  collapseChipRow(areaWrap, 'area');
  collapseChipRow(genreWrap, 'genre');
}

async function loadEvents() {
  const [eventsRes, venuesRes, genresRes] = await Promise.all([
    fetch('/data/events.json'),
    fetch('/data/venues.json'),
    fetch('/data/genres.json'),
  ]);
  allData = await eventsRes.json();
  const venuesList = await venuesRes.json();
  allVenues = Object.fromEntries(venuesList.map(v => [v.id, v]));
  try {
    genreMeta = await genresRes.json();
  } catch (e) {
    // Missing/invalid genres.json isn't fatal — genreLabel()/genreColor()
    // already fall back to titleCase()/hash color for every genre.
    genreMeta = {};
  }
  loadFiltersFromStorage();
  buildCalendarFilterChips();
  renderActiveFilters();
  updateMatchingDates();
  datePickerFp.redraw();
  applyFilters();
}

const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
const today = new Date();

function setDate(date) {
  const formatted = date.toLocaleDateString('en-US', options);
  document.querySelector('#current h3').textContent = formatted;
  document.getElementById('datePicker')._flatpickr.setDate(date, false);
  currentDateStr = toLocalDateStr(date);
  applyFilters();
}

document.querySelector('#current h3').textContent = today.toLocaleDateString('en-US', options);

let lastAutoClose = 0;

const datePickerFp = flatpickr('#datePicker', {
  defaultDate: today,
  positionElement: document.getElementById('currentSelector'),
  position: 'below auto',
  disableMobile: true,
  clickOpens: false,
  onDayCreate: function(dObj, dStr, fp, dayElem) {
    const dateStr = toLocalDateStr(dayElem.dateObj);
    if (matchingDates.has(dateStr)) {
      dayElem.classList.add('has-results');
    }
  },
  onClose: function() {
    lastAutoClose = Date.now();
  },
  onChange: function(selectedDates) {
    if (!allData || selectedDates.length === 0) return;
    const formatted = selectedDates[0].toLocaleDateString('en-US', options);
    document.querySelector('#current h3').textContent = formatted;
    currentDateStr = toLocalDateStr(selectedDates[0]);
    applyFilters();
  }
});

loadCalendarSettingsFromStorage();
document.getElementById('calendarToggleDay').classList.toggle('active', calendarViewMode === 'day');
document.getElementById('calendarToggleWeek').classList.toggle('active', calendarViewMode === 'week');
document.getElementById('calendarSortMethod').value = calendarSortMethod;
document.getElementById('calendarShowGenres').checked = calendarShowGenres;
applyGenreVisibility();

loadEvents();

document.getElementById('search').addEventListener('input', function() {
  currentSearch = this.value;
  document.getElementById('searchWrapper').classList.toggle('hasValue', currentSearch.trim() !== '');
  updateMatchingDates();
  datePickerFp.redraw();
  applyFilters();
});

document.getElementById('search').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    this.blur(); // dismisses the mobile keyboard
  }
});

document.addEventListener('DOMContentLoaded', function() {
  function toggleDatePicker(e) {
    e.preventDefault();
    e.stopPropagation();
    const fp = document.getElementById('datePicker')._flatpickr;

    if (fp.isOpen) {
      fp.close();
      return;
    }
    if (Date.now() - lastAutoClose < 300) return;

    fp.open();
  }

  const currentSelector = document.getElementById('currentSelector');
  currentSelector.addEventListener('mouseup', toggleDatePicker);
  currentSelector.addEventListener('touchend', toggleDatePicker);
  
  document.getElementById('prevArrow').addEventListener('click', function() {
    const current = document.getElementById('datePicker')._flatpickr.selectedDates[0];
    const step = calendarViewMode === 'week' ? 7 : 1;
    const prev = new Date(current);
    prev.setDate(prev.getDate() - step);
    setDate(prev);
  });
  document.getElementById('nextArrow').addEventListener('click', function() {
    const current = document.getElementById('datePicker')._flatpickr.selectedDates[0];
    const step = calendarViewMode === 'week' ? 7 : 1;
    const next = new Date(current);
    next.setDate(next.getDate() + step);
    setDate(next);
  });
  document.getElementById('calendarFilterToggle').addEventListener('click', function() {
    const panel = document.getElementById('calendarFilters');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    this.classList.toggle('active', !isOpen);
    if (!isOpen) buildCalendarFilterChips(); // re-measure now that the panel has real layout
  });
  function setViewMode(mode) {
    calendarViewMode = mode;
    document.getElementById('calendarToggleDay').classList.toggle('active', mode === 'day');
    document.getElementById('calendarToggleWeek').classList.toggle('active', mode === 'week');
    saveCalendarSettingsToStorage();
    applyFilters();
  }

  document.getElementById('calendarToggleDay').addEventListener('click', () => setViewMode('day'));
  document.getElementById('calendarToggleWeek').addEventListener('click', () => setViewMode('week'));

  document.getElementById('calendarSortMethod').addEventListener('change', function() {
    calendarSortMethod = this.value;
    saveCalendarSettingsToStorage();
    applyFilters();
  });

  document.getElementById('calendarShowGenres').addEventListener('change', function() {
    calendarShowGenres = this.checked;
    saveCalendarSettingsToStorage();
    applyGenreVisibility();
  });
});