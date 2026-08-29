// board.js
// Data layer + grid/modal rendering for the media board.
//
// Data source: data/board-media.json, an array of:
//   { id, type ('photo'|'video'), src, thumbnail, title, date ('YYYY-MM-DD'),
//     venueId, submittedBy }
//
// venueId matches an id in data/venues.json (same relationship events.json
// uses for its own venueId field). Display names are resolved via that file
// rather than duplicated as a string on each board entry, so a venue rename
// doesn't require touching every board post.
//
// The reusable, page-agnostic pieces (fetching, sorting, filtering by venue,
// date formatting) are exposed on window.BoardMedia so a future venue page
// can pull "board posts for this venue" without duplicating this logic.
// Only the grid/modal rendering below is specific to /board/, and is guarded
// to no-op if #boardGrid isn't present on the page.

(function () {
	const BOARD_MEDIA_URL = '../data/board-media.json';
	const VENUES_URL = '../data/venues.json';
	const BATCH_SIZE = 15;

	// --- Date helpers -------------------------------------------------------
	// Dates are stored as plain "YYYY-MM-DD" strings. Never round-trip these
	// through `new Date()` for sorting or comparison — that can shift the day
	// depending on the browser's local timezone. String comparison on ISO
	// dates sorts correctly and safely.

	function sortByDateDesc(list) {
		return list.slice().sort((a, b) => {
			if (a.date === b.date) return 0;
			return a.date > b.date ? -1 : 1;
		});
	}

	function formatDateDisplay(dateStr) {
		// Build the display string directly from the parsed components
		// rather than constructing a Date object from the raw string.
		const parts = String(dateStr).split('-');
		if (parts.length !== 3) return dateStr;
		const [year, month, day] = parts.map(Number);
		const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		if (!month || month < 1 || month > 12) return dateStr;
		return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
	}

	// --- Validation -----------------------------------------------------------

	function isValidItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (item.type !== 'photo' && item.type !== 'video') {
			console.warn('board.js: skipping item with unknown type', item);
			return false;
		}
		if (!item.src || !item.date) {
			console.warn('board.js: skipping item missing src/date', item);
			return false;
		}
		return true;
	}

	// --- Venue name lookup ------------------------------------------------
	// data/venues.json is an array of venue objects, e.g.
	// { id, name, url, eventsUrl, type, address, area, lat, lng }.
	// The lookup is keyed by id -> full venue object, so callers can pull
	// more than just the name later (e.g. linking out via `url`).

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
		console.warn('board.js: no venue match for venueId', venueId);
		return venueId;
	}

	// --- Data fetching (reusable) -------------------------------------------

	function fetchBoardMedia() {
		return fetch(BOARD_MEDIA_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${BOARD_MEDIA_URL}: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				const list = Array.isArray(data) ? data : [];
				return sortByDateDesc(list.filter(isValidItem));
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
				console.warn('board.js: could not load venues for name lookup', err);
				return {};
			});
	}

	function filterByVenueId(items, venueId) {
		return items.filter((item) => item.venueId === venueId);
	}

	// Expose the page-agnostic pieces for reuse (e.g. a future venue page
	// rendering "Board posts from this venue").
	window.BoardMedia = {
		fetchBoardMedia,
		fetchVenueLookup,
		filterByVenueId,
		sortByDateDesc,
		formatDateDisplay,
		resolveVenueName,
	};

	// --- Grid + modal rendering (specific to /board/) -----------------------

	const grid = document.getElementById('boardGrid');
	if (!grid) return; // Not on the board page — data layer above is still available.

	const sentinel = document.getElementById('boardSentinel');
	const emptyMsg = document.getElementById('boardEmpty');
	const loadingMsg = document.getElementById('boardLoading');

	const modal = document.getElementById('boardModal');
	const modalMedia = document.getElementById('boardModalMedia');
	const modalTitle = document.getElementById('boardModalTitle');
	const modalSub = document.getElementById('boardModalSub');
	const modalCredit = document.getElementById('boardModalCredit');

	let items = [];
	let venueLookup = {};
	let renderedCount = 0;
	let observer = null;

	function loadMedia() {
		Promise.all([fetchBoardMedia(), fetchVenueLookup()])
			.then(([mediaItems, lookup]) => {
				items = mediaItems;
				venueLookup = lookup;

				if (items.length === 0) {
					emptyMsg.hidden = false;
					return;
				}

				renderNextBatch();
				setupObserver();
			})
			.catch((err) => {
				console.warn('board.js: could not load media', err);
				emptyMsg.hidden = false;
				emptyMsg.textContent = 'Could not load the board right now — try again later.';
			});
	}

	function renderNextBatch() {
		const batch = items.slice(renderedCount, renderedCount + BATCH_SIZE);
		if (batch.length === 0) return;

		const fragment = document.createDocumentFragment();
		batch.forEach((item) => fragment.appendChild(buildTile(item)));
		grid.appendChild(fragment);

		renderedCount += batch.length;

		if (renderedCount >= items.length && observer) {
			observer.disconnect();
			observer = null;
		}
	}

	function buildTile(item) {
		const tile = document.createElement('button');
		tile.type = 'button';
		tile.className = 'boardTile';
		tile.setAttribute('aria-label', item.title ? `Open ${item.title}` : 'Open media');

		const thumbSrc = item.thumbnail || (item.type === 'photo' ? item.src : '');

		const thumbWrap = document.createElement('div');
		thumbWrap.className = 'boardTileThumb';

		if (thumbSrc) {
			const img = document.createElement('img');
			img.src = thumbSrc;
			img.alt = item.title || '';
			img.loading = 'lazy';
			thumbWrap.appendChild(img);
		} else {
			thumbWrap.classList.add('boardTileThumb-empty');
		}

		if (item.type === 'video') {
			const playIcon = document.createElement('span');
			playIcon.className = 'boardTilePlayIcon';
			playIcon.setAttribute('aria-hidden', 'true');
			thumbWrap.appendChild(playIcon);
		}

		tile.appendChild(thumbWrap);

		if (item.title) {
			const caption = document.createElement('span');
			caption.className = 'boardTileCaption';
			caption.textContent = item.title;
			tile.appendChild(caption);
		}

		if (item.submittedBy) {
			const caption = document.createElement('span');
			caption.className = 'boardTileSubmitted';
			caption.textContent = item.submittedBy ? `from ${item.submittedBy}` : '';
			tile.appendChild(caption);
		}

		tile.addEventListener('click', () => openModal(item));

		return tile;
	}

	// --- Lazy load trigger ------------------------------------------------

	function setupObserver() {
		if (!('IntersectionObserver' in window)) {
			// Fallback: render everything at once if IO isn't supported.
			renderNextBatch();
			while (renderedCount < items.length) renderNextBatch();
			return;
		}

		observer = new IntersectionObserver((entries) => {
			entries.forEach((entry) => {
				if (entry.isIntersecting && renderedCount < items.length) {
					loadingMsg.hidden = false;
					renderNextBatch();
					loadingMsg.hidden = true;
				}
			});
		}, { rootMargin: '400px 0px' });

		observer.observe(sentinel);
	}

	// --- Modal --------------------------------------------------------------

	function openModal(item) {
		modalMedia.innerHTML = '';

		if (item.type === 'video') {
			const video = document.createElement('video');
			video.src = item.src;
			video.controls = true;
			video.autoplay = true;
			video.playsInline = true;
			modalMedia.appendChild(video);
		} else {
			const img = document.createElement('img');
			img.src = item.src;
			img.alt = item.title || '';
			modalMedia.appendChild(img);
		}

		modalTitle.textContent = item.title || 'Untitled';

		const subParts = [];
		const venueName = resolveVenueName(item.venueId, venueLookup);
		if (venueName) subParts.push(venueName);
		if (item.date) subParts.push(formatDateDisplay(item.date));
		modalSub.textContent = subParts.join(' · ');

		modalCredit.textContent = item.submittedBy ? `from ${item.submittedBy}` : '';

		modal.hidden = false;
		document.body.classList.add('boardModalOpen');
	}

	function closeModal() {
		modal.hidden = true;
		document.body.classList.remove('boardModalOpen');

		// Stop any playing video when the modal closes.
		const video = modalMedia.querySelector('video');
		if (video) video.pause();
		modalMedia.innerHTML = '';
	}

	modal.addEventListener('click', (e) => {
		if (e.target.closest('[data-boardclose]')) closeModal();
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !modal.hidden) closeModal();
	});

	// --- Init -----------------------------------------------------------------

	document.addEventListener('DOMContentLoaded', loadMedia);
})();
