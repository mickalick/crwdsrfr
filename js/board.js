// board.js
// Data layer + grid/modal/search/filter rendering for the media board.
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
// Search + filter behavior mirrors events.js: a search term matches title,
// venue name, or submitter; venue/type/area filter chips union together
// (matching ANY selected filter, not requiring all); selected filters persist
// to localStorage, while the search term itself resets on each visit — same
// split events.js already uses for its own filters vs. currentSearch.
//
// The reusable, page-agnostic data-layer pieces (fetching, sorting, filtering
// by venue, date formatting) are exposed on window.BoardMedia so a future
// venue page can pull "board posts for this venue" without duplicating this
// logic. Only the grid/modal/search/filter rendering below is specific to
// /board/, and is guarded to no-op if #boardGrid isn't present on the page.

(function () {
	const BOARD_MEDIA_URL = '../data/board-media.json';
	const VENUES_URL = '../data/venues.json';
	const BATCH_SIZE = 15;
	const FILTER_STORAGE_KEY = 'crwdsrfr_board_filters';

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
		"festival": "Festival"
	};

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

	function sortableName(name) {
		return String(name || '').replace(/^the\s+/i, '');
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
	// more than just the name (used here for type/area filtering too).

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

	// --- Grid + modal + search/filter rendering (specific to /board/) -------

	const grid = document.getElementById('boardGrid');
	if (!grid) return; // Not on the board page — data layer above is still available.

	const resultsEl = document.getElementById('boardResults');
	const loadMoreBtn = document.getElementById('boardLoadMore');
	const emptyMsg = document.getElementById('boardEmpty');
	const loadingMsg = document.getElementById('boardLoading');

	const modal = document.getElementById('boardModal');
	const modalMedia = document.getElementById('boardModalMedia');
	const modalTitle = document.getElementById('boardModalTitle');
	const modalSub = document.getElementById('boardModalSub');
	const modalCredit = document.getElementById('boardModalCredit');

	const searchInput = document.getElementById('boardSearch');
	const searchWrapper = document.getElementById('boardSearchWrapper');
	const filterToggle = document.getElementById('boardFilterToggle');
	const filterPanel = document.getElementById('boardFilters');

	let items = []; // all valid, date-sorted media
	let filteredItems = []; // items after search + filters
	let venueLookup = {};
	let renderedCount = 0;

	let currentSearch = '';
	const selectedVenueIds = new Set();
	const selectedTypes = new Set();
	const selectedAreas = new Set();
	const expandedGroups = { name: false, type: false, area: false };

	// --- Filter persistence ---------------------------------------------
	// Selected filters persist across visits; the search term itself does
	// not, matching the same split events.js uses for the calendar page.

	function saveFiltersToStorage() {
		try {
			const payload = {
				venueIds: [...selectedVenueIds],
				types: [...selectedTypes],
				areas: [...selectedAreas],
			};
			localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(payload));
		} catch (e) {
			// localStorage unavailable — filters simply won't persist this session
		}
	}

	function loadFiltersFromStorage() {
		try {
			const raw = localStorage.getItem(FILTER_STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			(parsed.venueIds || []).forEach((id) => selectedVenueIds.add(id));
			(parsed.types || []).forEach((t) => selectedTypes.add(t));
			(parsed.areas || []).forEach((a) => selectedAreas.add(a));
		} catch (e) {
			// Corrupt or missing data — just start with no filters
		}
	}

	function hasActiveVenueFilters() {
		return selectedVenueIds.size > 0 || selectedTypes.size > 0 || selectedAreas.size > 0;
	}

	// A venue matches if it satisfies ANY selected filter across all three
	// categories (union, not intersection) — same rule events.js uses.
	function venueMatchesFilters(venue) {
		if (!venue) return false;
		if (selectedVenueIds.has(venue.id)) return true;
		if (selectedTypes.has(venue.type)) return true;
		if (selectedAreas.has(venue.area)) return true;
		return false;
	}

	// --- Search + filter application -----------------------------------

	function updateSubHead() {
		const subHeadEl = document.getElementById('boardSubHead');
		const term = currentSearch.trim();
		subHeadEl.textContent = term === ''
			? 'Most Recent Posts:'
			: `Most Recent Posts including "${term}"`;
	}

	function applyFilters() {
		updateSubHead();

		let filtered = items;

		if (currentSearch.trim() !== '') {
			const term = currentSearch.toLowerCase().trim();
			filtered = filtered.filter((item) => {
				const venue = venueLookup[item.venueId];
				const matchesTitle = item.title?.toLowerCase().includes(term);
				const matchesVenue = venue?.name?.toLowerCase().includes(term);
				const matchesSubmitter = item.submittedBy?.toLowerCase().includes(term);
				return matchesTitle || matchesVenue || matchesSubmitter;
			});
		}

		if (hasActiveVenueFilters()) {
			filtered = filtered.filter((item) => venueMatchesFilters(venueLookup[item.venueId]));
		}

		filteredItems = filtered;
		resetGrid();
	}

	function resetSearch() {
		searchInput.value = '';
		currentSearch = '';
		searchWrapper.classList.remove('hasValue');
		applyFilters();
		searchInput.focus();
	}

	function refreshFilterUI() {
		saveFiltersToStorage();
		buildBoardFilterChips();
		renderActiveFilters();
		applyFilters();
	}

	// --- Data loading -------------------------------------------------------

	function loadMedia() {
		Promise.all([fetchBoardMedia(), fetchVenueLookup()])
			.then(([mediaItems, lookup]) => {
				items = mediaItems;
				venueLookup = lookup;

				loadFiltersFromStorage();
				buildBoardFilterChips();
				renderActiveFilters();
				applyFilters();
			})
			.catch((err) => {
				console.warn('board.js: could not load media', err);
				emptyMsg.hidden = false;
				emptyMsg.textContent = 'Could not load the board right now — try again later.';
			});
	}

	// --- Grid rendering (rebuilt from scratch on every search/filter change) --
	// Uses the same fadeTo(150, 0) -> rebuild -> fadeTo(150, 1) transition as
	// renderEvents() on the calendar page.

	function resetGrid() {
		$(resultsEl).fadeTo(150, 0, function () {
			grid.innerHTML = '';
			renderedCount = 0;

			if (filteredItems.length === 0) {
				emptyMsg.hidden = false;
				emptyMsg.textContent = items.length === 0
					? "Hmmm, there's nothing here yet..."
					: 'No results — try a different search or filter.';
				loadMoreBtn.hidden = true;
			} else {
				emptyMsg.hidden = true;
				renderNextBatch();
			}

			$(resultsEl).fadeTo(150, 1);
		});
	}

	function renderNextBatch() {
		const batch = filteredItems.slice(renderedCount, renderedCount + BATCH_SIZE);
		if (batch.length === 0) return;

		const fragment = document.createDocumentFragment();
		batch.forEach((item) => fragment.appendChild(buildTile(item)));
		grid.appendChild(fragment);

		renderedCount += batch.length;

		loadMoreBtn.hidden = renderedCount >= filteredItems.length;
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

		const venueName = resolveVenueName(item.venueId, venueLookup);
		if (venueName) {
			const venueEl = document.createElement('span');
			venueEl.className = 'boardTileSub';
			venueEl.textContent = `at ${venueName}`;
			tile.appendChild(venueEl);
		}

		if (item.submittedBy) {
			const caption = document.createElement('span');
			caption.className = 'boardTileSub';
			caption.textContent = `from ${item.submittedBy}`;
			tile.appendChild(caption);
		}

		tile.addEventListener('click', () => openModal(item));

		return tile;
	}

	// --- Load More button ---------------------------------------------------

	loadMoreBtn.addEventListener('click', () => {
		loadingMsg.hidden = false;
		renderNextBatch();
		loadingMsg.hidden = true;
	});

	// --- Filter chips -------------------------------------------------------

	function buildBoardFilterChips() {
		// Only offer chips for venues that actually have at least one board
		// post — a venue existing in venues.json with zero submissions
		// shouldn't show up as a filter option with no possible results.
		const venueIdsWithItems = new Set(items.map((item) => item.venueId));
		const venues = Object.values(venueLookup).filter((v) => venueIdsWithItems.has(v.id));

		const nameWrap = document.getElementById('boardVenueFilters');
		const typeWrap = document.getElementById('boardTypeFilters');
		const areaWrap = document.getElementById('boardAreaFilters');

		const sortedVenues = [...venues].sort((a, b) =>
			sortableName(a.name).localeCompare(sortableName(b.name))
		);
		nameWrap.innerHTML = sortedVenues.map((v) => `
			<button type="button" class="chip ${selectedVenueIds.has(v.id) ? 'active' : ''}" data-filter="name" data-value="${v.id}">${v.name}</button>
		`).join('');

		// Type/area options are derived from that same has-items venue
		// subset, so e.g. a "Festival" chip won't appear if no festival
		// venue has any posts yet, even if other festival venues exist.
		const types = [...new Set(venues.map((v) => v.type).filter(Boolean))].sort();
		typeWrap.innerHTML = types.map((t) => `
			<button type="button" class="chip ${selectedTypes.has(t) ? 'active' : ''}" data-filter="type" data-value="${t}">${TYPE_LABELS[t] || t}</button>
		`).join('');

		const areas = [...new Set(venues.map((v) => v.area).filter(Boolean))].sort();
		areaWrap.innerHTML = areas.map((a) => `
			<button type="button" class="chip ${selectedAreas.has(a) ? 'active' : ''}" data-filter="area" data-value="${a}">${a}</button>
		`).join('');

		[nameWrap, typeWrap, areaWrap].forEach((wrap) => {
			wrap.querySelectorAll('.chip').forEach((chip) => {
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

	function collapseChipRow(wrap, groupKey) {
		wrap.querySelectorAll('.chip-show-all').forEach((el) => el.remove());
		const chips = [...wrap.querySelectorAll('.chip')];
		chips.forEach((c) => (c.style.display = ''));

		if (chips.length === 0) return;

		const lineOneTop = chips[0].offsetTop;
		const lineTwoStart = chips.findIndex((c) => c.offsetTop !== lineOneTop);
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
			chips.slice(lineThreeStart).forEach((c) => (c.style.display = 'none'));
			toggleBtn.textContent = 'Show All';
			toggleBtn.addEventListener('click', () => {
				expandedGroups[groupKey] = true;
				collapseChipRow(wrap, groupKey);
			});
		}

		wrap.appendChild(toggleBtn);
	}

	function renderActiveFilters() {
		const wrapper = document.getElementById('boardActiveFiltersWrapper');
		const chipsWrap = document.getElementById('boardActiveFilters');
		const active = [];

		selectedVenueIds.forEach((id) => {
			active.push({ group: 'name', value: id, label: venueLookup?.[id]?.name ?? id });
		});
		selectedTypes.forEach((t) => {
			active.push({ group: 'type', value: t, label: TYPE_LABELS[t] || t });
		});
		selectedAreas.forEach((a) => {
			active.push({ group: 'area', value: a, label: a });
		});

		if (active.length === 0) {
			wrapper.style.display = 'none';
			chipsWrap.innerHTML = '';
			return;
		}

		wrapper.style.display = 'flex';
		chipsWrap.innerHTML = active.map((f) => `
			<button type="button" class="chip active-chip" data-group="${f.group}" data-value="${f.value}">${f.label} <span class="chip-remove">&times;</span></button>
		`).join('') + `<button type="button" class="chip chip-reset" id="boardResetAllFilters">Reset</button>`;

		chipsWrap.querySelectorAll('.active-chip').forEach((chip) => {
			chip.addEventListener('click', () => {
				const { group, value } = chip.dataset;
				const set = group === 'name' ? selectedVenueIds : group === 'type' ? selectedTypes : selectedAreas;
				set.delete(value);
				refreshFilterUI();
			});
		});

		document.getElementById('boardResetAllFilters').addEventListener('click', () => {
			selectedVenueIds.clear();
			selectedTypes.clear();
			selectedAreas.clear();
			refreshFilterUI();
		});
	}

	// --- Modal --------------------------------------------------------------

	function openModal(item) {
		modalMedia.innerHTML = '';

		if (item.type === 'video') {
			const video = document.createElement('video');
			video.src = item.src;
			video.controls = true;
			video.autoplay = true;
			video.volume = 0.5;
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
		if (e.key !== 'Escape') return;
		if (!modal.hidden) closeModal();
		if (submitModal && !submitModal.hidden) closeSubmitModal();
	});

	// --- Submit media modal --------------------------------------------------

	const submitModal = document.getElementById('boardSubmitModal');
	const submitTrigger = document.getElementById('boardSubmitTrigger');

	function openSubmitModal() {
		submitModal.hidden = false;
		document.body.classList.add('boardModalOpen');
	}

	function closeSubmitModal() {
		submitModal.hidden = true;
		document.body.classList.remove('boardModalOpen');
	}

	if (submitModal && submitTrigger) {
		submitTrigger.addEventListener('click', (e) => {
			e.preventDefault(); // no-op today since the anchor has no href, but guards against future navigation if one's added
			openSubmitModal();
		});

		// The trigger is an <a> without an href, which browsers don't make
		// keyboard-focusable or Enter/Space-activatable by default the way
		// a real link or button is — so both are added explicitly here.
		submitTrigger.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				openSubmitModal();
			}
		});

		submitModal.addEventListener('click', (e) => {
			if (e.target.closest('[data-boardsubmitclose]')) closeSubmitModal();
		});
	}

	// --- Search + filter toggle wiring --------------------------------------

	searchInput.addEventListener('input', function () {
		currentSearch = this.value;
		searchWrapper.classList.toggle('hasValue', currentSearch.trim() !== '');
		applyFilters();
	});

	searchInput.addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			this.blur(); // dismisses the mobile keyboard
		}
	});

	document.getElementById('boardSearchGo').addEventListener('click', () => applyFilters());
	document.getElementById('boardSearchReset').addEventListener('click', resetSearch);

	filterToggle.addEventListener('click', function () {
		const isOpen = filterPanel.style.display !== 'none';
		filterPanel.style.display = isOpen ? 'none' : 'flex';
		this.classList.toggle('active', !isOpen);
		if (!isOpen) buildBoardFilterChips(); // re-measure now that the panel has real layout
	});

	// --- Init -----------------------------------------------------------------

	document.addEventListener('DOMContentLoaded', loadMedia);
})();
