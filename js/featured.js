// featured.js
// Data layer + grid/modal rendering for the Featured page.
//
// Data source: data/featured-media.json, an array of:
//   { id, title, date ('YYYY-MM-DD'), image, url, venueId }
//
// venueId matches an id in data/venues.json (same relationship
// events.json and board-media.json use), resolved via that file rather
// than duplicated as a string on each entry, so a venue rename doesn't
// require touching every featured post.
//
// Items are sorted ascending by date (soonest first — these are upcoming
// promoted shows, the opposite of the board's "most recent photo" sort)
// and grouped by exact date into headline sections, similar in spirit to
// the day-by-day grouping used in the calendar's week view. Each date
// group renders its own grid, capped at 5 columns but shrinking to fit
// however many items that date actually has (via a --group-cols custom
// property set per group in featured.css) rather than stretching 2 or 3
// images to fill a 5-wide row.
//
// The modal (title / venue link / date / "Learn More" link out to
// item.url) supports prev/next across the full flat, date-sorted list —
// same UX as the board's modal. The venue name in the modal links to
// that venue's page on the site, at /venues/{venueId}/.

(function () {
	const FEATURED_MEDIA_URL = '../data/featured-media.json';
	const VENUES_URL = '../data/venues.json';
	const MAX_GROUP_COLS = 5;

	const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	// Matches the `options` object events.js uses for its own date display
	// (#current h3 / week-of headers) — keeps the two pages' date styling
	// in sync from one source of truth in each file.
	const HEADLINE_DATE_OPTIONS = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };

	// --- Date helpers ---------------------------------------------------
	// Dates are stored as plain "YYYY-MM-DD" strings. Never round-trip
	// these through `new Date()` for sorting — string comparison on ISO
	// dates sorts correctly and safely without any timezone risk. A Date
	// object is only ever constructed here (for the headline's weekday),
	// and always from explicit local y/m/d parts — the same approach
	// events.js's getWeekDates()/setDate() use — rather than handing the
	// raw "YYYY-MM-DD" string to `new Date()`, which parses as UTC and
	// can shift the displayed day depending on the browser's timezone.

	function sortByDateAsc(list) {
		return list.slice().sort((a, b) => {
			if (a.date === b.date) return 0;
			return a.date < b.date ? -1 : 1;
		});
	}

	function parseDateParts(dateStr) {
		const parts = String(dateStr).split('-');
		if (parts.length !== 3) return null;
		const [year, month, day] = parts.map(Number);
		if (!year || !month || month < 1 || month > 12 || !day) return null;
		return { year, month, day };
	}

	function formatDateDisplay(dateStr) {
		const p = parseDateParts(dateStr);
		if (!p) return dateStr;
		return `${MONTH_ABBR[p.month - 1]} ${p.day}, ${p.year}`;
	}

	function formatDateHeadline(dateStr) {
		const p = parseDateParts(dateStr);
		if (!p) return dateStr;
		const date = new Date(p.year, p.month - 1, p.day); // local, not UTC/string-parsed
		return date.toLocaleDateString('en-US', HEADLINE_DATE_OPTIONS);
	}

	// --- Validation -------------------------------------------------------

	function isValidItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (!item.date || !parseDateParts(item.date)) {
			console.warn('featured.js: skipping item with missing/invalid date', item);
			return false;
		}
		if (!item.image) {
			console.warn('featured.js: skipping item missing image', item);
			return false;
		}
		return true;
	}

	// --- Venue name lookup ------------------------------------------------
	// data/venues.json is an array of venue objects, e.g.
	// { id, name, url, eventsUrl, type, address, area, lat, lng } — same
	// file board.js and events.js resolve venueId against.

	function buildVenueLookup(venuesData) {
		const lookup = {};
		const list = Array.isArray(venuesData) ? venuesData : [];

		list.forEach((venue) => {
			if (venue && venue.id) {
				lookup[venue.id] = venue;
			}
		});

		return lookup;
	}

	function resolveVenueName(venueId, venueLookup) {
		if (!venueId) return '';
		const venue = venueLookup && venueLookup[venueId];
		if (venue && venue.name) return venue.name;
		console.warn('featured.js: no venue match for venueId', venueId);
		return venueId;
	}

	function venuePageUrl(venueId) {
		return `/venues/${venueId}/`;
	}

	// --- Data fetching ------------------------------------------------------

	function fetchFeaturedMedia() {
		return fetch(FEATURED_MEDIA_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${FEATURED_MEDIA_URL}: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				const list = Array.isArray(data) ? data : [];
				return sortByDateAsc(list.filter(isValidItem));
			});
	}

	function fetchVenueLookup() {
		return fetch(VENUES_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${VENUES_URL}: ${res.status}`);
				return res.json();
			})
			.then(buildVenueLookup)
			.catch((err) => {
				console.warn('featured.js: could not load venues for name lookup', err);
				return {};
			});
	}

	function groupByDate(list) {
		const groups = [];
		let currentGroup = null;

		list.forEach((item) => {
			if (!currentGroup || currentGroup.date !== item.date) {
				currentGroup = { date: item.date, items: [] };
				groups.push(currentGroup);
			}
			currentGroup.items.push(item);
		});

		return groups;
	}

	// --- Grid + modal rendering (specific to /featured.html) ----------------

	const groupsEl = document.getElementById('featuredGroups');
	if (!groupsEl) return; // Not on the featured page.

	const emptyMsg = document.getElementById('featuredEmpty');

	const modal = document.getElementById('featuredModal');
	const modalMediaInner = document.getElementById('featuredModalMediaInner');
	const modalPrevBtn = document.getElementById('featuredModalPrev');
	const modalNextBtn = document.getElementById('featuredModalNext');
	const modalTitle = document.getElementById('featuredModalTitle');
	const modalSub = document.getElementById('featuredModalSub');
	const modalLink = document.getElementById('featuredModalLink');

	let items = []; // all valid, date-sorted (ascending) items
	let venueLookup = {};
	let modalIndex = -1; // index of the currently open item within `items`

	// --- Data loading ---------------------------------------------------

	function loadMedia() {
		Promise.all([fetchFeaturedMedia(), fetchVenueLookup()])
			.then(([mediaItems, lookup]) => {
				items = mediaItems;
				venueLookup = lookup;
				renderGroups();
			})
			.catch((err) => {
				console.warn('featured.js: could not load featured media', err);
				emptyMsg.hidden = false;
				emptyMsg.textContent = 'Could not load featured shows right now — try again later.';
			});
	}

	// --- Grid rendering ---------------------------------------------------

	function renderGroups() {
		groupsEl.innerHTML = '';

		if (items.length === 0) {
			emptyMsg.hidden = false;
			return;
		}
		emptyMsg.hidden = true;

		const fragment = document.createDocumentFragment();
		groupByDate(items).forEach((group) => fragment.appendChild(buildDateGroup(group)));
		groupsEl.appendChild(fragment);
	}

	function buildDateGroup(group) {
		const section = document.createElement('div');
		section.className = 'featuredDateGroup';

		const heading = document.createElement('h3');
		heading.className = 'featuredDateHeadline';
		heading.textContent = formatDateHeadline(group.date);
		section.appendChild(heading);

		const grid = document.createElement('div');
		grid.className = 'featuredGrid';
		// Caps at MAX_GROUP_COLS but shrinks for smaller groups so 2-3
		// items on a given night don't stretch to fill a 5-wide row —
		// see the `repeat(var(--group-cols), 1fr)` rule in featured.css.
		grid.style.setProperty('--group-cols', Math.min(group.items.length, MAX_GROUP_COLS));

		group.items.forEach((item) => grid.appendChild(buildTile(item)));
		section.appendChild(grid);

		return section;
	}

	function buildTile(item) {
		const tile = document.createElement('button');
		tile.type = 'button';
		tile.className = 'featuredTile';
		tile.setAttribute('aria-label', item.title ? `Open ${item.title}` : 'Open featured show');

		const thumbWrap = document.createElement('div');
		thumbWrap.className = 'featuredTileThumb';

		const img = document.createElement('img');
		img.src = item.image;
		img.alt = item.title || '';
		img.loading = 'lazy';
		thumbWrap.appendChild(img);
		tile.appendChild(thumbWrap);

		if (item.title) {
			const caption = document.createElement('span');
			caption.className = 'featuredTileCaption';
			caption.textContent = item.title;
			tile.appendChild(caption);
		}

		const venueName = resolveVenueName(item.venueId, venueLookup);
		if (venueName) {
			const venueEl = document.createElement('span');
			venueEl.className = 'featuredTileVenue';
			venueEl.textContent = `at ${venueName}`;
			tile.appendChild(venueEl);
		}

		tile.addEventListener('click', () => openModal(item));

		return tile;
	}

	// --- Modal --------------------------------------------------------------

	function renderModalItem(item) {
		modalMediaInner.innerHTML = '';

		const img = document.createElement('img');
		img.src = item.image;
		img.alt = item.title || '';
		modalMediaInner.appendChild(img);

		modalTitle.textContent = item.title || 'Untitled';

		modalSub.innerHTML = '';
		const venueName = resolveVenueName(item.venueId, venueLookup);
		if (venueName) {
			const venueLink = document.createElement('a');
			venueLink.className = 'featuredModalVenueLink';
			venueLink.href = venuePageUrl(item.venueId);
			venueLink.textContent = venueName;
			modalSub.appendChild(venueLink);
			modalSub.append(` · ${formatDateDisplay(item.date)}`);
		} else {
			modalSub.textContent = formatDateDisplay(item.date);
		}

		if (item.url) {
			modalLink.href = item.url;
			modalLink.hidden = false;
		} else {
			modalLink.removeAttribute('href');
			modalLink.hidden = true;
		}

		updateModalNavState();
	}

	function updateModalNavState() {
		const hasMultiple = items.length > 1;
		modalPrevBtn.hidden = !hasMultiple;
		modalNextBtn.hidden = !hasMultiple;
		if (hasMultiple) {
			modalPrevBtn.disabled = modalIndex <= 0;
			modalNextBtn.disabled = modalIndex >= items.length - 1;
		}
	}

	function showModalIndex(newIndex) {
		if (newIndex < 0 || newIndex >= items.length) return;
		modalIndex = newIndex;
		renderModalItem(items[modalIndex]);
	}

	function openModal(item) {
		modalIndex = items.indexOf(item);
		renderModalItem(item);

		modal.hidden = false;
		document.body.classList.add('boardModalOpen');
	}

	function closeModal() {
		modal.hidden = true;
		document.body.classList.remove('boardModalOpen');
		modalMediaInner.innerHTML = '';
		modalIndex = -1;
	}

	modalPrevBtn.addEventListener('click', () => showModalIndex(modalIndex - 1));
	modalNextBtn.addEventListener('click', () => showModalIndex(modalIndex + 1));

	modal.addEventListener('click', (e) => {
		if (e.target.closest('[data-featclose]')) closeModal();
	});

	document.addEventListener('keydown', (e) => {
		if (modal.hidden) return;
		if (e.key === 'Escape') closeModal();
		if (e.key === 'ArrowLeft') showModalIndex(modalIndex - 1);
		if (e.key === 'ArrowRight') showModalIndex(modalIndex + 1);
	});

	// --- Init -----------------------------------------------------------------

	document.addEventListener('DOMContentLoaded', loadMedia);
})();
