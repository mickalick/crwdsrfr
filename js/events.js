let allData = null;
let allVenues = null; // keyed by venue id — loaded from venues.json for type/area filtering
let currentDateStr = toLocalDateStr(new Date());
let currentSearch = '';

// Selected filter values. Names are stored as venue ids (unambiguous),
// types and areas as their raw string values.
const selectedVenueIds = new Set();
const selectedTypes = new Set();
const selectedAreas = new Set();
const expandedGroups = { name: false, type: false, area: false };

const TYPE_LABELS = {
  "music-hall": "Music Hall",
  "club": "Club",
  "theater": "Theater",
  "arena": "Arena",
  "bar": "Bar",
  "outdoor": "Outdoor",
  "brewery": "Brewery",
  "jazz-bar": "Jazz Bar",
  "comedy-club": "Comedy Club"
};

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

function sortableName(name) {
  return name.replace(/^the\s+/i, '');
}

function updateSubHead() {
  const subHeadSpan = document.querySelector('.subHead span');
  const term = currentSearch.trim();
  subHeadSpan.textContent = term === ''
    ? 'All shows for:'
    : `All shows that include "${term}" for:`;
}

let matchingDates = new Set();

function updateMatchingDates() {
  matchingDates = new Set();
  if (!allData) return;

  const term = currentSearch.toLowerCase().trim();
  const filtersActive = hasActiveVenueFilters();
  if (term === '' && !filtersActive) return; // nothing active = no dots, default calendar view

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

    if (matchesSearch && matchesVenueFilter) {
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

function applyFilters() {
  updateSubHead();

  if (!allData) return;

  let filtered = allData.events.filter(e => e.date === currentDateStr);

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

function renderEvents(events) {
  const container = document.getElementById('calendarCards');

  $(container).fadeTo(150, 0, function() {
    container.querySelectorAll('.venueCard').forEach(el => el.remove());
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('withResults').style.display = 'block';

    const grouped = {};
    events.forEach(event => {
      if (!grouped[event.venueId]) grouped[event.venueId] = [];
      grouped[event.venueId].push(event);
    });

    const calendarEnd = document.getElementById('calendarEnd');

    Object.entries(grouped)
      .sort(([a], [b]) => {
        const nameA = sortableName(allData.venues[a]?.name ?? '');
        const nameB = sortableName(allData.venues[b]?.name ?? '');
        return nameA.localeCompare(nameB);
      })
      .forEach(([venueId, venueEvents]) => {
      const venue = allData.venues[venueId];
      if (!venue) return;

      // Sort same-day events earliest to latest. Events without a time
      // (rendered as "See Event") sort to the end rather than being
      // treated as midnight, since we don't actually know when they start.
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
        else timeDisplay = 'See Event';

        const titleLink = event.eventUrl || venue.eventsUrl || null;
        const titleHtml = titleLink
          ? `<a href="${titleLink}" target="_blank">${event.title}</a>`
          : event.title;

        // Only render the .ticketLink wrapper at all when there's an
        // actual ticket URL. Previously this div was always rendered
        // (just left empty when there was no link), which meant the
        // .ticketLink:hover effect in the CSS still fired on empty,
        // non-clickable boxes.
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

      const venueUrl = venue.url ?? venue.eventsUrl ?? '#';
      const cardHtml = `
        <div class="venueCard">
          <div class="venue">
            <h4><a href="${venueUrl}" target="_blank">${venue.name}</a></h4>
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

    if (Object.keys(grouped).length === 0) {
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
    toggleBtn.textContent = `Show All (${chips.length - lineThreeStart} more)`;
    toggleBtn.addEventListener('click', () => {
      expandedGroups[groupKey] = true;
      collapseChipRow(wrap, groupKey);
    });
  }

  wrap.appendChild(toggleBtn);
}

function refreshFilterUI() {
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

  if (active.length === 0) {
    wrapper.style.display = 'none';
    chipsWrap.innerHTML = '';
    return;
  }

  wrapper.style.display = 'flex';
  chipsWrap.innerHTML = active.map(f => `
    <button type="button" class="chip active-chip" data-group="${f.group}" data-value="${f.value}">${f.label} <span class="chip-remove">&times;</span></button>
  `).join('') + `<button type="button" class="chip chip-reset" id="resetAllFilters">Reset</button>`;

  chipsWrap.querySelectorAll('.active-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const { group, value } = chip.dataset;
      const set = group === 'name' ? selectedVenueIds : group === 'type' ? selectedTypes : selectedAreas;
      set.delete(value);
      refreshFilterUI();
    });
  });

  document.getElementById('resetAllFilters').addEventListener('click', () => {
    selectedVenueIds.clear();
    selectedTypes.clear();
    selectedAreas.clear();
    refreshFilterUI();
  });
}

function buildCalendarFilterChips() {
  if (!allVenues) return;
  const venues = Object.values(allVenues);

  const nameWrap = document.getElementById('calendarVenueFilters');
  const typeWrap = document.getElementById('calendarTypeFilters');
  const areaWrap = document.getElementById('calendarAreaFilters');

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

  [nameWrap, typeWrap, areaWrap].forEach(wrap => {
    wrap.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const { filter, value } = chip.dataset;
        const set = filter === 'name' ? selectedVenueIds : filter === 'type' ? selectedTypes : selectedAreas;
        if (set.has(value)) set.delete(value); else set.add(value);
        refreshFilterUI();
      });
    });
  });

  collapseChipRow(nameWrap, 'name');
  collapseChipRow(typeWrap, 'type');
  collapseChipRow(areaWrap, 'area');
}

async function loadEvents() {
  const [eventsRes, venuesRes] = await Promise.all([
    fetch('/data/events.json'),
    fetch('/data/venues.json'),
  ]);
  allData = await eventsRes.json();
  const venuesList = await venuesRes.json();
  allVenues = Object.fromEntries(venuesList.map(v => [v.id, v]));
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
  document.querySelector('#currentSelector h3').textContent = formatted;
  document.getElementById('datePicker')._flatpickr.setDate(date, false);
  currentDateStr = toLocalDateStr(date);
  applyFilters();
}

document.querySelector('#currentSelector h3').textContent = today.toLocaleDateString('en-US', options);

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
    document.querySelector('#currentSelector h3').textContent = formatted;
    currentDateStr = toLocalDateStr(selectedDates[0]);
    applyFilters();
  }
});

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
    const prev = new Date(current);
    prev.setDate(prev.getDate() - 1);
    setDate(prev);
  });
  document.getElementById('nextArrow').addEventListener('click', function() {
    const current = document.getElementById('datePicker')._flatpickr.selectedDates[0];
    const next = new Date(current);
    next.setDate(next.getDate() + 1);
    setDate(next);
  });
  document.getElementById('calendarFilterToggle').addEventListener('click', function() {
    const panel = document.getElementById('calendarFilters');
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'flex';
    this.classList.toggle('active', !isOpen);
    if (!isOpen) buildCalendarFilterChips(); // re-measure now that the panel has real layout
  });
});
