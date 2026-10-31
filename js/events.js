let allData = null;
let eventsById = new Map(); // event id → event, for the hype/comment buttons
let allVenues = null; // keyed by venue id — loaded from venues.json for type/area filtering
let currentDateStr = toLocalDateStr(new Date());
let currentSearch = '';
let calendarViewMode = 'day'; // 'day' | 'week'
let calendarSortMethod = 'venue-name'; // 'venue-name' | 'show-title' | 'show-time' | 'hype-count'
let calendarShowGenres = true; // whether genre chips render on event tiles
let filterMode = 'include'; // 'include' | 'exclude' — applies to every active filter category (venue name/type/area, genre)

// Show History: the same page, listing the last HISTORY_DAYS days of shows (newest first)
// instead of the calendar. Lives at /?history so Back, refresh and links work.
const HISTORY_DAYS = 14; // same as the fetch script keeps in events.json
let historyMode = new URLSearchParams(window.location.search).has('history');

// Selected filter values. Names are stored as venue ids (unambiguous),
// types and areas as their raw string values.
const selectedVenueIds = new Set();
const selectedTypes = new Set();
const selectedAreas = new Set();
const selectedGenres = new Set();
const expandedGroups = { name: false, type: false, area: false, genre: false };

// Set when the calendar is opened with a link to one show (/?show=<event id>),
// e.g. from a profile's Hyped list. Cleared once that show has been revealed.
let focusEventId = new URLSearchParams(window.location.search).get('show');

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
    if (['venue-name', 'show-title', 'show-time', 'hype-count'].includes(parsed.sortMethod)) {
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
      filterMode: filterMode,
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
    if (parsed.filterMode === 'include' || parsed.filterMode === 'exclude') {
      filterMode = parsed.filterMode;
    }
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

// Today, as YYYY-MM-DD in local time (fresh each call, in case the page stays open past midnight)
function todayStr() {
  return toLocalDateStr(new Date());
}

// First day Show History covers
function historyStartStr() {
  const d = new Date();
  d.setDate(d.getDate() - HISTORY_DAYS);
  return toLocalDateStr(d);
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

  if (historyMode) {
    subHeadSpan.textContent = term === ''
      ? 'Last Two Weeks of Shows:'
      : `Last Two Weeks of Shows including "${term}":`;
  } else if (calendarViewMode === 'week') {
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

  const today = todayStr();
  allData.events.forEach(event => {
    if (event.date < today) return; // past days can't be picked

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
//
// In exclude mode this same "matches any" result gets negated below —
// an unrecognized venue (no venue data) is never a raw match either way,
// so it's simply never affected by a venue-based filter in either mode.
function venueMatchesFilters(venue) {
  const matchesAny = !!venue && (
    selectedVenueIds.has(venue.id) ||
    selectedTypes.has(venue.type) ||
    selectedAreas.has(venue.area)
  );
  return filterMode === 'exclude' ? !matchesAny : matchesAny;
}

// Genre lives on the event itself (not the venue), so it's checked as its
// own filter dimension: an event must match AT LEAST ONE selected genre
// (union within genres), and that result is ANDed against the venue-based
// filters above — e.g. selecting "Jazz" + "Grog Shop" shows only jazz
// shows AT Grog Shop, not all jazz shows everywhere plus all Grog Shop shows
// (in include mode — in exclude mode it hides jazz shows AND Grog Shop shows,
// since De Morgan's law turns "AND of two matches" into "OR of two negated
// matches" once every category is negated the same way).
function hasActiveGenreFilters() {
  return selectedGenres.size > 0;
}

function eventMatchesGenreFilters(event) {
  if (selectedGenres.size === 0) return true;
  const genres = event.genres || [];
  const matchesAny = genres.some(g => selectedGenres.has(g));
  return filterMode === 'exclude' ? !matchesAny : matchesAny;
}

// Hype/comment counts for the shows being rendered. Only fetched before rendering
// when sorting by Most Hyped (the order depends on them); otherwise the buttons
// load their counts after the cards appear.
let currentStats = null;
let renderRun = 0;

function socialReady() {
  return !!(window.CrwdSocial && window.CrwdCore && CrwdCore.enabled);
}

async function applyFilters() {
  updateSubHead();

  if (!allData) return;

  let filtered;
  if (historyMode) {
    const today = todayStr(), start = historyStartStr();
    filtered = allData.events.filter(e => e.date < today && e.date >= start);
  } else if (calendarViewMode === 'week') {
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

  // A linked show always appears, even if a saved filter would hide it
  if (focusEventId && !filtered.some(e => e.id === focusEventId)) {
    const linked = allData.events.find(e => e.id === focusEventId);
    const shown = historyMode
      ? (linked && linked.date < todayStr())
      : (linked && (calendarViewMode === 'week' ? getWeekDates(currentDateStr) : [currentDateStr]).includes(linked.date));
    if (shown) filtered.push(linked);
  }

  // Most Hyped needs the counts first. A newer date/filter change cancels this one.
  const run = ++renderRun;
  currentStats = null;
  if (!historyMode && calendarSortMethod === 'hype-count' && socialReady()) {
    await CrwdCore.ready;
    const stats = await CrwdSocial.loadStats('event', [...new Set(filtered.map(e => e.id))]);
    if (run !== renderRun) return;
    currentStats = stats;
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
  const splitPerShow = calendarSortMethod === 'show-title' || calendarSortMethod === 'show-time' || calendarSortMethod === 'hype-count';

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

  // Most Hyped: highest count first; ties go to the earlier show, then A-Z
  const hypesOf = (group) => currentStats?.[group.events[0].id]?.hypes ?? 0;
  const compareGroups = (a, b) => {
    if (calendarSortMethod === 'hype-count') {
      const diff = hypesOf(b) - hypesOf(a);
      if (diff !== 0) return diff;
      const time = (a.events[0].time || '99:99').localeCompare(b.events[0].time || '99:99');
      return time !== 0 ? time : a.events[0].title.localeCompare(b.events[0].title);
    }
    return String(groupSortKey(a)).localeCompare(String(groupSortKey(b)));
  };

  groups
    .sort(compareGroups)
    .forEach(({ venueId, events: venueEvents }) => {
      const venue = allData.venues[venueId];
      if (!venue) return;

      const sortedEvents = [...venueEvents].sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });

      const eventsHtml = sortedEvents.map(event => eventHtml(event, venue)).join('');
      container.insertBefore(
        document.createRange().createContextualFragment(venueCardHtml(venueId, venue, eventsHtml)),
        beforeNode
      );
    });

  return groups.length > 0;
}

function venueCardHtml(venueId, venue, eventsHtml) {
  return `
        <div class="venueCard">
          <div class="venue">
            <h4><a href="/venues/${venueId}/">${venue.name}</a></h4>
          </div>
          <div class="venueEvents">
            ${eventsHtml}
          </div>
        </div>`;
}

// One show's row. In Show History the ticket link's spot holds the "Add to my Show History" button.
function eventHtml(event, venue) {
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

  // No ticket URL: an invisible placeholder keeps the columns lined up
  const linkHtml = historyMode
    ? `<div class="historyAdd"><button type="button" class="historyAddButton" aria-pressed="false" aria-label="Add to my Show History" title="Add to my Show History"></button></div>`
    : event.ticketUrl
      ? `<div class="ticketLink"><a href="${event.ticketUrl}" target="_blank"><span class="icon" id="opn"></span></a></div>`
      : '<div class="ticketLink isPlaceholder" aria-hidden="true"></div>';

  // Rendered as its own full-width row below the name/time/price line
  // (not inline with them) so it only adds height to the event tile —
  // it never affects the width or alignment of the existing content.
  const genresHtml = (event.genres && event.genres.length > 0)
    ? `<div class="eventGenres">${event.genres.map(g => `
        <span class="genre-chip" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</span>
      `).join('')}</div>`
    : '';

  // Empty slot for the hype + comment buttons; attachEventSocial() fills it
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
}

// Show History: newest first, in the order shows happened. A card holds one venue's shows only
// when they started at the same time; otherwise each show gets its own card.
function renderHistoryCards(events, container, beforeNode) {
  const byTimeDesc = [...events].sort((a, b) => {
    if (!a.time && !b.time) return a.title.localeCompare(b.title);
    if (!a.time) return 1; // no time listed: end of the day's list
    if (!b.time) return -1;
    return b.time.localeCompare(a.time) || a.title.localeCompare(b.title);
  });
  const cards = [];
  byTimeDesc.forEach(event => {
    const last = cards[cards.length - 1];
    if (last && last.venueId === event.venueId && last.time === (event.time || null)) last.events.push(event);
    else cards.push({ venueId: event.venueId, time: event.time || null, events: [event] });
  });
  let any = false;
  cards.forEach(card => {
    const venue = allData.venues[card.venueId];
    if (!venue) return;
    any = true;
    container.insertBefore(
      document.createRange().createContextualFragment(venueCardHtml(card.venueId, venue, card.events.map(e => eventHtml(e, venue)).join(''))),
      beforeNode
    );
  });
  return any;
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

    if (historyMode) {
      // Newest day first
      [...new Set(events.map(e => e.date))].sort().reverse().forEach(dateStr => {
        const dayEvents = events.filter(e => e.date === dateStr);
        renderDateSeparator(dateStr, container, calendarEnd);
        if (renderHistoryCards(dayEvents, container, calendarEnd)) anyRendered = true;
      });
    } else if (calendarViewMode === 'week') {
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
    revealFocusedEvent();
    attachEventSocial();
    if (historyMode) refreshHistoryButtons();
  });
}

// ---------- Hype + comment buttons (js/crwd-social.js) ----------
// Fills each rendered show's .eventSocial slot. Counts for every show on screen
// load in one batch; a newer render (date/filter change) cancels an older one.
let socialRun = 0;

async function attachEventSocial() {
  if (!window.CrwdSocial || !window.CrwdCore || !CrwdCore.enabled) return;
  const slots = [...document.querySelectorAll('#calendarCards .eventSocial')];
  if (slots.length === 0) return;
  const run = ++socialRun;

  await CrwdCore.ready; // so "already hyped" reflects whoever is signed in
  const ids = [...new Set(slots.map(slot => slot.closest('.event').dataset.eventId))];
  // Reuse the counts Most Hyped already fetched, when they cover these shows
  const stats = (currentStats && ids.every(id => currentStats[id]))
    ? currentStats
    : await CrwdSocial.loadStats('event', ids);
  if (run !== socialRun) return;

  slots.forEach(slot => {
    if (!slot.isConnected) return;
    const id = slot.closest('.event').dataset.eventId;
    const event = eventsById.get(id);
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

// ---------- "Add to my Show History" (Show History view) ----------
// Adds the show to the Show History list on your profile (profiles.about.history), or takes it
// back off. Entries added here carry the show's id (event_id) so the button knows they're there.
let myHistory = null;      // your about.history, once loaded (null: signed out / not loaded)
let myHistoryFor = null;   // whose list that is
const HISTORY_MAX = 500;   // same limit as the profile's Show History

async function loadMyHistory() {
  const user = window.CrwdCore && CrwdCore.enabled ? CrwdCore.user : null;
  if (!user) { myHistory = null; myHistoryFor = null; return null; }
  const { data, error } = await CrwdCore.sb.from('profiles').select('about').eq('id', user.id).single();
  if (error) { console.warn('[calendar] show history', error); return myHistory; }
  myHistory = Array.isArray(data?.about?.history) ? data.about.history : [];
  myHistoryFor = user.id;
  return myHistory;
}

function inMyHistory(eventId) {
  return !!myHistory && myHistory.some(h => h && h.event_id === eventId);
}

function setHistoryButton(btn, added) {
  btn.setAttribute('aria-pressed', added ? 'true' : 'false');
  const label = added ? 'Remove from my Show History' : 'Add to my Show History';
  btn.setAttribute('aria-label', label);
  btn.title = label;
  btn.classList.toggle('isAdded', added);
}

async function refreshHistoryButtons() {
  const buttons = [...document.querySelectorAll('#calendarCards .historyAddButton')];
  if (!buttons.length) return;
  if (window.CrwdCore && CrwdCore.enabled) {
    await CrwdCore.ready;
    if (CrwdCore.user && myHistoryFor !== CrwdCore.user.id) await loadMyHistory();
    if (!CrwdCore.user) { myHistory = null; myHistoryFor = null; }
  }
  buttons.forEach(btn => setHistoryButton(btn, inMyHistory(btn.closest('.event').dataset.eventId)));
}

// What gets saved: the acts (or the show title), the venue and the date, same shape as an entry
// typed in on the profile, plus the show's id
function historyEntryFor(event) {
  const names = (event.performers || []).map(p => p && p.name).filter(Boolean);
  const acts = (names.length ? names.join(', ') : event.title).trim().slice(0, 200);
  const entry = { acts: acts || 'Show', date: event.date, event_id: event.id };
  const venue = (allData.venues[event.venueId]?.name || '').trim().slice(0, 80);
  if (venue) entry.venue = venue;
  return entry;
}

async function toggleShowHistory(btn) {
  if (!window.CrwdUI || !CrwdUI.requireSignIn()) return; // signed out: opens Sign In
  const event = eventsById.get(btn.closest('.event').dataset.eventId);
  if (!event || btn.disabled) return;
  btn.disabled = true;
  try {
    // Read the latest list first, so edits made elsewhere (another tab, Edit Profile) aren't lost
    const { data, error } = await CrwdCore.sb.from('profiles').select('about').eq('id', CrwdCore.user.id).single();
    if (error) throw error;
    const about = Object.assign({}, data?.about || {});
    let list = Array.isArray(about.history) ? about.history.slice() : [];
    const adding = !list.some(h => h && h.event_id === event.id);
    if (adding) {
      if (list.length >= HISTORY_MAX) { alert('Your Show History is full (' + HISTORY_MAX + ' shows). Remove some on your profile to add more.'); return; }
      list.push(historyEntryFor(event));
    } else {
      list = list.filter(h => !(h && h.event_id === event.id));
    }
    if (list.length) about.history = list; else delete about.history;
    await CrwdCore.updateProfile({ about: about });
    myHistory = list;
    myHistoryFor = CrwdCore.user.id;
    // The same show can't appear twice, but keep every copy of the button in step anyway
    document.querySelectorAll(`.event[data-event-id="${CSS.escape(event.id)}"] .historyAddButton`).forEach(b => setHistoryButton(b, adding));
  } catch (e) {
    alert((e && e.message) || 'That couldn\'t be saved. Please try again.');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('calendarCards').addEventListener('click', function (e) {
  const btn = e.target.closest('.historyAddButton');
  if (btn) toggleShowHistory(btn);
});

// ---------- Switching between the calendar and Show History ----------
// push: add a browser history entry (a click). render: redraw the list now (loadEvents draws it itself).
function setHistoryMode(on, push, render) {
  historyMode = on;
  document.body.classList.toggle('isHistory', on);
  const link = document.getElementById('historyLink');
  link.textContent = on ? 'Back to Upcoming' : 'Recent History';
  link.href = on ? '/' : '/?history';
  document.getElementById('historyIntro').hidden = !on;
  // The View menu doesn't apply to Show History
  document.getElementById('calendarSettings').classList.remove('open');
  document.getElementById('calendarSettingsToggle').classList.remove('open');
  if (push) history.pushState({ history: on }, '', on ? '/?history' : '/');
  if (render !== false) applyFilters();
}

document.getElementById('historyLink').addEventListener('click', function (e) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab: let the link work
  e.preventDefault();
  setHistoryMode(!historyMode, true);
});

// Back / Forward between the two
window.addEventListener('popstate', function () {
  const on = new URLSearchParams(window.location.search).has('history');
  if (on !== historyMode) setHistoryMode(on, false);
});

// "OSEES … · Beachland Ballroom · Sun, Oct 19"
function eventContext(event) {
  const [y, m, d] = event.date.split('-').map(Number);
  const day = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return [event.title, allData.venues[event.venueId]?.name, day].filter(Boolean).join(' · ');
}

// /?show=<event id>: open the calendar on that show's date
function jumpToLinkedShow() {
  if (!focusEventId) return;
  const linked = allData.events.find(e => e.id === focusEventId);
  if (!linked) { focusEventId = null; return; } // no longer listed: just open today
  // A show that's already happened (e.g. from a profile's Hyped list) opens in Show History
  if (linked.date < todayStr()) {
    if (!historyMode) setHistoryMode(true, false, false); // loadEvents draws it next
    return;
  }
  const [y, m, d] = linked.date.split('-').map(Number); // local date, never via UTC
  const date = new Date(y, m - 1, d);
  document.querySelector('#current h3').textContent = date.toLocaleDateString('en-US', options);
  datePickerFp.setDate(date, false);
  currentDateStr = linked.date;
  updateNavArrows();
}

// ...then scroll to the show and highlight it
function revealFocusedEvent() {
  if (!focusEventId) return;
  const el = document.querySelector(`.event[data-event-id="${CSS.escape(focusEventId)}"]`);
  focusEventId = null;
  // Drop ?show= so a refresh or a later date change behaves normally (keeps ?history)
  history.replaceState(null, '', window.location.pathname + (historyMode ? '?history' : '') + window.location.hash);
  if (!el) return;
  el.classList.add('isLinked');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  clearLinkedHighlight(el);
}

// The yellow highlight goes away after its two pulses, or as soon as the mouse moves over the show
function clearLinkedHighlight(el) {
  let timer;
  const clear = () => {
    el.classList.remove('isLinked');
    el.removeEventListener('animationend', onEnd);
    el.removeEventListener('pointermove', onMove);
    clearTimeout(timer);
  };
  const onEnd = e => { if (e.target === el && e.animationName === 'eventLinkedPulse') clear(); };
  // Only real movement: the scroll can slide the show under a mouse that isn't moving
  const onMove = e => { if (e.movementX || e.movementY) clear(); };
  el.addEventListener('animationend', onEnd);
  el.addEventListener('pointermove', onMove);
  timer = setTimeout(clear, 2600); // backup (reduced motion has no animation, so no animationend)
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
  const prefix = filterMode === 'exclude' ? 'Not ' : '';
  const active = [];

  selectedVenueIds.forEach(id => {
    active.push({ group: 'name', value: id, label: prefix + (allVenues?.[id]?.name ?? id) });
  });
  selectedTypes.forEach(t => {
    active.push({ group: 'type', value: t, label: prefix + (TYPE_LABELS[t] || t) });
  });
  selectedAreas.forEach(a => {
    active.push({ group: 'area', value: a, label: prefix + a });
  });
  selectedGenres.forEach(g => {
    active.push({ group: 'genre', value: g, label: prefix + genreLabel(g) });
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
  eventsById = new Map(allData.events.map(e => [e.id, e]));
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
  document.getElementById('filterModeInclude').classList.toggle('active', filterMode === 'include');
  document.getElementById('filterModeExclude').classList.toggle('active', filterMode === 'exclude');
  buildCalendarFilterChips();
  renderActiveFilters();
  updateMatchingDates();
  datePickerFp.redraw();
  jumpToLinkedShow();
  updateNavArrows();
  applyFilters();
}

const options = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
const today = new Date();

// Past days aren't on the calendar any more (they're in Show History): Back stops at today
function updateNavArrows() {
  const prev = document.getElementById('prevArrow');
  const atToday = currentDateStr <= todayStr();
  prev.classList.toggle('isDisabled', atToday);
  prev.setAttribute('aria-disabled', atToday ? 'true' : 'false');
}

function setDate(date) {
  // Never before today (e.g. a week back from 3 days out lands on today)
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date < todayMidnight) date = todayMidnight;
  const formatted = date.toLocaleDateString('en-US', options);
  document.querySelector('#current h3').textContent = formatted;
  document.getElementById('datePicker')._flatpickr.setDate(date, false);
  currentDateStr = toLocalDateStr(date);
  updateNavArrows();
  applyFilters();
}

document.querySelector('#current h3').textContent = today.toLocaleDateString('en-US', options);

let lastAutoClose = 0;

// Opens the date picker to the right of the calendar icon, lined up with its top.
// Not enough room on the right (phones): it drops below the icon instead, like before.
function placeBesideSelector(fp) {
  const anchor = document.getElementById('currentSelector');
  const cal = fp.calendarContainer;
  const box = anchor.getBoundingClientRect();
  const gap = 8;
  const width = cal.offsetWidth || 308; // flatpickr's default width, in case it isn't measured yet
  const fitsRight = box.right + gap + width <= document.documentElement.clientWidth - gap;
  const left = fitsRight ? box.right + gap : Math.max(gap, box.left);
  const top = fitsRight ? box.top : box.bottom + gap;
  cal.style.left = (left + window.scrollX) + 'px';
  cal.style.top = (top + window.scrollY) + 'px';
  cal.style.right = 'auto';
}

const datePickerFp = flatpickr('#datePicker', {
  defaultDate: today,
  minDate: 'today', // past days are greyed out; they live in Show History now
  positionElement: document.getElementById('currentSelector'),
  position: placeBesideSelector,
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
    updateNavArrows();
    applyFilters();
  }
});

loadCalendarSettingsFromStorage();
document.getElementById('calendarToggleDay').classList.toggle('active', calendarViewMode === 'day');
document.getElementById('calendarToggleWeek').classList.toggle('active', calendarViewMode === 'week');
document.getElementById('calendarSortMethod').value = calendarSortMethod;
document.getElementById('calendarShowGenres').checked = calendarShowGenres;
applyGenreVisibility();
setHistoryMode(historyMode, false); // opened at /?history: show that view from the start

loadEvents();

// Signing in or out changes which shows are "already hyped": refresh the buttons
if (socialReady()) {
  document.body.classList.add('socialOn');
  CrwdCore.onChange(() => {
    currentStats = null; // its "already hyped" flags belong to the previous user
    attachEventSocial();
    if (historyMode) refreshHistoryButtons(); // whose Show History it is may have changed
  });
} else {
  // Accounts unavailable (e.g. Supabase didn't load): no counts to sort by
  document.querySelector('#calendarSortMethod option[value="hype-count"]')?.remove();
  if (calendarSortMethod === 'hype-count') calendarSortMethod = 'venue-name';
  document.getElementById('calendarSortMethod').value = calendarSortMethod;
}

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
    if (this.classList.contains('isDisabled')) return; // already on today
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

  function setFilterMode(mode) {
    filterMode = mode;
    document.getElementById('filterModeInclude').classList.toggle('active', mode === 'include');
    document.getElementById('filterModeExclude').classList.toggle('active', mode === 'exclude');
    refreshFilterUI(); // re-applies every filter category immediately
  }

  document.getElementById('filterModeInclude').addEventListener('click', () => setFilterMode('include'));
  document.getElementById('filterModeExclude').addEventListener('click', () => setFilterMode('exclude'));

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
