let allData = null;
let currentDateStr = toLocalDateStr(new Date());
let currentSearch = '';

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

function updateSubHead() {
  const subHeadSpan = document.querySelector('.subHead span');
  const term = currentSearch.trim();
  subHeadSpan.textContent = term === ''
    ? 'All shows for:'
    : `All shows that include "${term}" for:`;
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

  renderEvents(filtered);
}

function resetSearch() {
  const input = document.getElementById('search');
  input.value = '';
  currentSearch = '';
  document.getElementById('searchWrapper').classList.remove('hasValue');
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
        const nameA = allData.venues[a]?.name ?? '';
        const nameB = allData.venues[b]?.name ?? '';
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

async function loadEvents() {
  const res = await fetch('events.json');
  allData = await res.json();
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

flatpickr('#datePicker', {
  defaultDate: today,
  positionElement: document.getElementById('currentSelector'),
  position: 'below auto',
  disableMobile: true,
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
    } else {
      fp.open();
    }
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
});
