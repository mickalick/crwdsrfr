// board.js
// Data layer + grid/modal/search/filter rendering for the media board.
//
// Data source: data/board-media.json, an array of posts. Every post has a
// postType of 'shot' | 'gallery' | 'report' (older entries with no postType
// are treated as 'shot' for backward compatibility) plus shared fields:
//   { id, postType, title, date ('YYYY-MM-DD'), venueId, submittedBy, thumbnail }
//
// Shape per postType:
//   shot    -> flat media fields on the post itself: { type ('photo'|'video'), src, thumbnail }
//   gallery -> { items: [ { type, src, thumbnail, caption?, cover? }, ... ] }
//   report  -> { hero?: { mediaType, src, thumbnail?, caption? }, blocks: [ { type: 'paragraph', text } | { type: 'media', mediaType, src, thumbnail?, caption?, cover? }, ... ] }
//
// For a gallery, `cover: true` on one entry in `items` marks which shot is
// used as the grid tile's cover image (first item wins if none is flagged).
//
// For a report, the grid tile AND the modal's top hero both come from
// `hero` when it's set — a standalone shot that lives outside `blocks`
// entirely, so it is never automatically duplicated into the body. If you
// want that same shot to also appear in the body text, add it again as its
// own ordinary media block; that's a deliberate second copy, not a mirrored
// reference, so a report can just as easily have a hero shown nowhere else,
// or no hero at all. When `hero` is omitted, the tile falls back to
// whichever block has `"cover": true` (or the first media block, paragraph
// blocks never eligible) for backward compatibility with reports written
// before `hero` existed — but in that fallback case no hero section is
// shown in the modal; it's purely a tile-image fallback. See
// resolveCoverEntry()/getCoverMedia() for the exact resolution logic.
//
// venueId matches an id in data/venues.json (same relationship events.json
// uses for its own venueId field). Display names are resolved via that file
// rather than duplicated as a string on each board entry, so a venue rename
// doesn't require touching every board post.
//
// Genre filter: board-media.json has no genre field of its own. Instead,
// each item's title is matched against data/acts.json (name + aliases,
// case-insensitive whole-word match) — same matching rule acts.js uses in
// the reverse direction (act -> matching board posts). A matched act's
// genres are attached to the item as item.genres before filtering/rendering.
// data/genres.json supplies genreLabel()/genreColor() for chip parity with
// the calendar and acts page. This is title-based, so it works unchanged
// for shots, galleries, and reports alike.
//
// Search + filter behavior mirrors events.js: a search term matches title,
// venue name, or submitter; venue/type/area/genre filter chips union together
// (matching ANY selected filter, not requiring all); selected filters persist
// to localStorage, while the search term itself resets on each visit — same
// split events.js already uses for its own filters vs. currentSearch. The
// Posts filter (All/Shots/Galleries/Reports) is a separate mutually-exclusive
// toggle, like the old Photos/Videos "Shots" toggle it replaces.
//
// The reusable, page-agnostic data-layer pieces (fetching, sorting, filtering
// by venue, date formatting, act/genre matching) are exposed on window.BoardMedia
// so a future venue page can pull "board posts for this venue" without
// duplicating this logic. Only the grid/modal/search/filter rendering below is
// specific to /board/, and is guarded to no-op if #boardGrid isn't present on
// the page.

(function () {
	const BOARD_MEDIA_URL = '../data/board-media.json';
	const VENUES_URL = '../data/venues.json';
	const ACTS_URL = '../data/acts.json';
	const GENRES_URL = '../data/genres.json';
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

	// Post-type toggle (All / Shots / Galleries / Reports) — mutually
	// exclusive, unlike the venue/genre chip rows which union together.
	// Replaces the old Photos/Videos "Shots" format toggle now that a post
	// can contain more than one photo/video (galleries, reports).
	const POST_TYPE_LABELS = { all: 'All', shot: 'Shots', gallery: 'Galleries', report: 'Reports' };
	// Singular labels for the tile's own "what kind of post is this" line.
	const POST_TYPE_ITEM_LABEL = { shot: 'Shot', gallery: 'Gallery', report: 'Report' };

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
	// Every post is normalized (postType defaulted to 'shot') before this
	// runs — see fetchBoardMedia() — so postType is always one of the three
	// known values by the time isValidItem() sees it.

	function isValidItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (!item.title || !item.date) {
			console.warn('board.js: skipping item missing title/date', item);
			return false;
		}

		if (item.postType === 'shot') {
			if (item.type !== 'photo' && item.type !== 'video') {
				console.warn('board.js: skipping shot with unknown type', item);
				return false;
			}
			if (!item.src) {
				console.warn('board.js: skipping shot missing src', item);
				return false;
			}
			return true;
		}

		if (item.postType === 'gallery') {
			if (!Array.isArray(item.items) || item.items.length === 0) {
				console.warn('board.js: skipping gallery with no items', item);
				return false;
			}
			return true;
		}

		if (item.postType === 'report') {
			if (!Array.isArray(item.blocks) || item.blocks.length === 0) {
				console.warn('board.js: skipping report with no blocks', item);
				return false;
			}
			return true;
		}

		console.warn('board.js: skipping item with unknown postType', item);
		return false;
	}

	// Finds the raw cover entry for a gallery/report. Returns null for a
	// shot, which has no separate cover entry — it IS the cover. Kept
	// distinct from getCoverMedia() below because callers that need to
	// actually play/show the cover (e.g. the report hero) need its real
	// `src`, not just the thumbnail getCoverMedia() resolves for the tile.
	//
	// Gallery: whichever entry in `items` has `cover: true`, falling back to
	// the first item if none is flagged (or more than one is, by mistake).
	//
	// Report: `hero` if the post has one — a standalone shot outside
	// `blocks` — otherwise (for reports written before `hero` existed)
	// whichever 'media' block has `cover: true`, or the first media block.
	// That fallback path exists purely so old data still resolves a tile
	// image; renderReportHero() does NOT use this function; it only ever
	// shows `item.hero` directly, so a report without one gets no hero
	// section rather than one being inferred from a body block.
	function resolveCoverEntry(item) {
		if (item.postType === 'gallery') {
			const list = Array.isArray(item.items) ? item.items : [];
			return list.find((i) => i && i.cover === true) || list[0] || null;
		}

		if (item.postType === 'report') {
			if (item.hero) return item.hero;
			const mediaBlocks = (item.blocks || []).filter((b) => b && b.type === 'media');
			return mediaBlocks.find((b) => b.cover === true) || mediaBlocks[0] || null;
		}

		return null;
	}

	// The grid tile and modal both need a single "cover" image/video to
	// represent a post — trivial for a shot (it IS the media); for a
	// gallery/report it's whichever entry resolveCoverEntry() picks out.
	function getCoverMedia(item) {
		if (item.postType === 'gallery') {
			const cover = resolveCoverEntry(item) || {};
			return {
				type: cover.type || 'photo',
				thumbnail: cover.thumbnail || (cover.type === 'photo' ? cover.src : '') || '',
			};
		}

		if (item.postType === 'report') {
			const cover = resolveCoverEntry(item) || {};
			return {
				type: cover.mediaType || 'photo',
				thumbnail: cover.thumbnail || (cover.mediaType === 'photo' ? cover.src : '') || '',
			};
		}

		// shot
		return {
			type: item.type,
			thumbnail: item.thumbnail || (item.type === 'photo' ? item.src : '') || '',
		};
	}

	// Flattens any post into an array of individually-matchable "media
	// units" — one per shot, one per gallery item, one per report hero/media
	// block (paragraph blocks are never units, they have no media). Built
	// for acts.js: a report can mention several acts across its per-shot
	// captions (e.g. opening acts named only in individual block captions),
	// and those need to surface on their own act's /acts/ media preview even
	// though the report's own title only names the headliner.
	//
	// Each unit's `matchText` is its own caption when it has one, falling
	// back to the parent post's title otherwise — so a shot (no captions at
	// all) or an uncaptioned gallery/report block still matches by title,
	// exactly like before this function existed.
	function mediaUnitsForItem(item) {
		const base = {
			postId: item.id,
			postTitle: item.title,
			date: item.date,
			venueId: item.venueId,
		};

		if (item.postType === 'gallery') {
			return (item.items || []).map((entry) => ({
				...base,
				type: entry.type,
				thumbnail: entry.thumbnail || (entry.type === 'photo' ? entry.src : '') || '',
				caption: entry.caption || null,
				matchText: entry.caption || item.title,
			}));
		}

		if (item.postType === 'report') {
			const units = [];
			if (item.hero && item.hero.src) {
				units.push({
					...base,
					type: item.hero.mediaType,
					thumbnail: item.hero.thumbnail || (item.hero.mediaType === 'photo' ? item.hero.src : '') || '',
					caption: item.hero.caption || null,
					matchText: item.hero.caption || item.title,
				});
			}
			(item.blocks || []).forEach((block) => {
				if (!block || block.type !== 'media') return;
				units.push({
					...base,
					type: block.mediaType,
					thumbnail: block.thumbnail || (block.mediaType === 'photo' ? block.src : '') || '',
					caption: block.caption || null,
					matchText: block.caption || item.title,
				});
			});
			return units;
		}

		// shot
		return [{
			...base,
			type: item.type,
			thumbnail: item.thumbnail || (item.type === 'photo' ? item.src : '') || '',
			caption: null,
			matchText: item.title,
		}];
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
				// Older entries predate postType — treat them as plain shots.
				const normalized = list.map((item) => ({ ...item, postType: item.postType || 'shot' }));
				return sortByDateDesc(normalized.filter(isValidItem));
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

	function findItemById(list, id) {
		return list.find((item) => item.id === id);
	}

	// --- Act <-> board-media matching ---------------------------------------
	// Same "whole word, case-insensitive" rule acts.js uses (matching act
	// name/aliases against event/board-media text), just applied here to
	// derive a media item's genres rather than to find matching posts for
	// a given act. Short names (<=3 chars) require exact equality rather
	// than substring, to avoid noisy false positives (e.g. "DJ"). Only the
	// post's title is matched, so this works unchanged for shots, galleries,
	// and reports.

	function normalizeText(str) {
		return String(str || '').trim().toLowerCase();
	}

	function escapeRegex(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	function actNeedles(act) {
		return [act.name, ...(act.aliases || [])].map(normalizeText).filter(Boolean);
	}

	function textMatchesNeedle(text, needle) {
		if (!text) return false;
		const normalizedText = normalizeText(text);
		if (needle.length <= 3) return normalizedText === needle;
		return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(text);
	}

	// Genres for a board-media title, derived by matching it against every
	// (non-excluded) act's name/aliases. Usually resolves to at most one
	// act since board post titles are typically just the act's own name.
	function genresForTitle(title, actsList) {
		if (!title || !actsList || actsList.length === 0) return [];
		const genres = new Set();
		actsList.forEach((act) => {
			if (actNeedles(act).some((needle) => textMatchesNeedle(title, needle))) {
				(act.genres || []).forEach((g) => genres.add(g));
			}
		});
		return [...genres];
	}

	function fetchActsList() {
		return fetch(ACTS_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${ACTS_URL}: ${res.status}`);
				return res.json();
			})
			.then((data) => Object.values(data || {}).filter((act) => String(act.exclude).toLowerCase() !== 'yes'))
			.catch((err) => {
				console.warn('board.js: could not load acts for genre matching', err);
				return [];
			});
	}

	function fetchGenreMeta() {
		return fetch(GENRES_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${GENRES_URL}: ${res.status}`);
				return res.json();
			})
			.catch((err) => {
				console.warn('board.js: could not load genre metadata', err);
				return {};
			});
	}

	// Expose the page-agnostic pieces for reuse (e.g. a future venue page
	// rendering "Board posts from this venue").
	window.BoardMedia = {
		fetchBoardMedia,
		fetchVenueLookup,
		filterByVenueId,
		findItemById,
		fetchActsList,
		fetchGenreMeta,
		genresForTitle,
		sortByDateDesc,
		formatDateDisplay,
		resolveVenueName,
		getCoverMedia,
		mediaUnitsForItem,
	};

	// --- Grid + modal + search/filter rendering (specific to /board/) -------

	const grid = document.getElementById('boardGrid');
	if (!grid) return; // Not on the board page — data layer above is still available.

	const resultsEl = document.getElementById('boardResults');
	const loadMoreBtn = document.getElementById('boardLoadMore');
	const emptyMsg = document.getElementById('boardEmpty');
	const loadingMsg = document.getElementById('boardLoading');
	const endMsg = document.getElementById('boardEnd');

	const modal = document.getElementById('boardModal');
	const modalContent = modal.querySelector('.boardModalContent');
	const modalMediaWrap = document.getElementById('boardModalMedia');
	const modalMediaInner = document.getElementById('boardModalMediaInner');
	const modalContentList = document.getElementById('boardModalContentList');
	const modalReportHero = document.getElementById('boardModalReportHero');
	const modalPrevBtn = document.getElementById('boardModalPrev');
	const modalNextBtn = document.getElementById('boardModalNext');
	const modalTitle = document.getElementById('boardModalTitle');
	const modalGenres = document.getElementById('boardModalGenres');
	const modalSub = document.getElementById('boardModalSub');
	const modalCredit = document.getElementById('boardModalCredit');
	const modalShareBtn = document.getElementById('boardModalShare');

	const searchInput = document.getElementById('boardSearch');
	const searchWrapper = document.getElementById('boardSearchWrapper');
	const filterToggle = document.getElementById('boardFilterToggle');
	const filterPanel = document.getElementById('boardFilters');

	let items = []; // all valid, date-sorted media
	let filteredItems = []; // items after search + filters
	let venueLookup = {};
	let genreMeta = {}; // from data/genres.json, for genreLabel()/genreColor() chip parity
	let renderedCount = 0;
	let modalIndex = -1; // index of the currently open item within filteredItems

	let currentSearch = '';
	const selectedVenueIds = new Set();
	const selectedTypes = new Set();
	const selectedAreas = new Set();
	const selectedGenres = new Set();
	let selectedPostType = 'all'; // 'all' | 'shot' | 'gallery' | 'report' — single value, not a Set
	const expandedGroups = { name: false, type: false, area: false, genre: false };

	// --- Genre label/color (mirrors acts.js/events.js exactly, for chip parity) --

	function titleCase(str) {
		return str
			.split('-')
			.map(word => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	function genreLabel(genre) {
		return genreMeta[genre]?.label || titleCase(genre);
	}

	function genreColor(genre) {
		if (genreMeta[genre]?.color) return genreMeta[genre].color;

		let hash = 0;
		for (let i = 0; i < genre.length; i++) {
			hash = (hash * 31 + genre.charCodeAt(i)) >>> 0;
		}
		const hue = hash % 360;
		return `hsl(${hue}, 65%, 60%)`;
	}

	function genreChipsHtml(genres) {
		if (!genres || genres.length === 0) return '';
		return genres.map(g => `
			<span class="genre-chip" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</span>
		`).join('');
	}

	// --- Filter persistence ---------------------------------------------
	// Selected filters persist across visits; the search term itself does
	// not, matching the same split events.js uses for the calendar page.

	function saveFiltersToStorage() {
		try {
			const payload = {
				venueIds: [...selectedVenueIds],
				types: [...selectedTypes],
				areas: [...selectedAreas],
				genres: [...selectedGenres],
				postType: selectedPostType,
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
			(parsed.genres || []).forEach((g) => selectedGenres.add(g));
			if (Object.prototype.hasOwnProperty.call(POST_TYPE_LABELS, parsed.postType)) {
				selectedPostType = parsed.postType;
			}
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

	function itemMatchesGenreFilters(item) {
		if (selectedGenres.size === 0) return true;
		return (item.genres || []).some((g) => selectedGenres.has(g));
	}

	function itemMatchesPostType(item) {
		return selectedPostType === 'all' || item.postType === selectedPostType;
	}

	// --- Search + filter application -----------------------------------

	function updateSubHead() {
		const subHeadEl = document.getElementById('boardSubHead');
		const term = currentSearch.trim();
		subHeadEl.textContent = term === ''
			? 'All Posts by Most Recent:'
			: `All Posts including "${term}" by Most Recent:`;
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

		if (selectedGenres.size > 0) {
			filtered = filtered.filter(itemMatchesGenreFilters);
		}

		if (selectedPostType !== 'all') {
			filtered = filtered.filter(itemMatchesPostType);
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
		Promise.all([fetchBoardMedia(), fetchVenueLookup(), fetchActsList(), fetchGenreMeta()])
			.then(([mediaItems, lookup, actsList, genres]) => {
				genreMeta = genres;
				items = mediaItems.map((item) => ({
					...item,
					genres: genresForTitle(item.title, actsList),
				}));
				venueLookup = lookup;

				loadFiltersFromStorage();
				buildBoardFilterChips();
				renderActiveFilters();
				applyFilters();
				openItemFromHash();
			})
			.catch((err) => {
				console.warn('board.js: could not load media', err);
				emptyMsg.hidden = false;
				emptyMsg.textContent = 'Could not load the board right now — try again later.';
			});
	}

	// Deep-linking: a URL like /board/#<id> (e.g. linked from a media
	// thumbnail on /acts/) opens straight to that post's modal instead of
	// landing on the plain grid. `id` is the stable field already on every
	// entry in board-media.json. There's no distinguishing prefix on the
	// hash itself — any hash that happens to match a post's id is treated
	// as a deep link, and anything else (e.g. "#top" from the footer's
	// back-to-top link) is simply ignored since findItemById() won't match it.
	function openItemFromHash() {
		const hash = window.location.hash;
		if (!hash || hash.length <= 1) return;

		const id = decodeURIComponent(hash.slice(1));
		const item = findItemById(items, id);
		if (!item) return;

		// The modal's prev/next nav is indexed against filteredItems, so if
		// the linked item is currently hidden by an active search/filter,
		// clear those first — otherwise indexOf(item) comes back -1 and nav
		// state ends up wrong. Whoever followed this link wants to see this
		// specific item, not a filtered subset that happens to exclude it.
		if (!filteredItems.includes(item)) {
			currentSearch = '';
			searchInput.value = '';
			searchWrapper.classList.remove('hasValue');
			selectedVenueIds.clear();
			selectedTypes.clear();
			selectedAreas.clear();
			selectedGenres.clear();
			selectedPostType = 'all';
			saveFiltersToStorage();
			buildBoardFilterChips();
			renderActiveFilters();
			applyFilters();
		}

		openModal(item);
	}

	// --- Grid rendering (rebuilt from scratch on every search/filter change) --
	// Uses the same fadeTo(150, 0) -> rebuild -> fadeTo(150, 1) transition as
	// renderEvents() on the calendar page.

	function resetGrid() {
		$(resultsEl).fadeTo(150, 0, function () {
			try {
				grid.innerHTML = '';
				renderedCount = 0;

				if (filteredItems.length === 0) {
					emptyMsg.hidden = false;
					emptyMsg.textContent = items.length === 0
						? "Hmmm, there's nothing here yet..."
						: 'No results :(';
					loadMoreBtn.hidden = true;
					if (endMsg) endMsg.hidden = true;
				} else {
					emptyMsg.hidden = true;
					renderNextBatch();
				}
			} finally {
				// Always fade back in, even if something above threw —
				// otherwise #boardResults gets stuck at opacity 0 with
				// tiles rendered but invisible.
				$(resultsEl).fadeTo(150, 1);
			}
		});
	}

	function renderNextBatch() {
		const batch = filteredItems.slice(renderedCount, renderedCount + BATCH_SIZE);
		if (batch.length === 0) return;

		const fragment = document.createDocumentFragment();
		batch.forEach((item) => fragment.appendChild(buildTile(item)));
		grid.appendChild(fragment);

		renderedCount += batch.length;

		const allLoaded = renderedCount >= filteredItems.length;
		loadMoreBtn.hidden = allLoaded;
		if (endMsg) endMsg.hidden = !allLoaded;
	}

	function buildTile(item) {
		const tile = document.createElement('button');
		tile.type = 'button';
		tile.className = 'boardTile';
		tile.setAttribute('aria-label', item.title ? `Open ${item.title}` : 'Open media');

		const cover = getCoverMedia(item);

		const thumbWrap = document.createElement('div');
		thumbWrap.className = 'boardTileThumb';

		if (cover.thumbnail) {
			const img = document.createElement('img');
			img.src = cover.thumbnail;
			img.alt = item.title || '';
			img.loading = 'lazy';
			thumbWrap.appendChild(img);
		} else {
			thumbWrap.classList.add('boardTileThumb-empty');
		}

		if (cover.type === 'video') {
			const playIcon = document.createElement('span');
			playIcon.className = 'boardTilePlayIcon';
			playIcon.setAttribute('aria-hidden', 'true');
			thumbWrap.appendChild(playIcon);
		}

		if (item.postType === 'gallery' || item.postType === 'report') {
			const stackBadge = document.createElement('span');
			stackBadge.className = 'boardTileStackBadge';
			stackBadge.setAttribute('aria-hidden', 'true');
			thumbWrap.appendChild(stackBadge);
		}

		tile.appendChild(thumbWrap);

		// Three info lines: title, then venue + date, then the post type —
		// submittedBy is still shown once the post is open in the modal, but
		// no longer takes a line on the tile itself.
		if (item.title) {
			const caption = document.createElement('span');
			caption.className = 'boardTileCaption';
			caption.textContent = item.title;
			tile.appendChild(caption);
		}

		const venueName = resolveVenueName(item.venueId, venueLookup);
		const venueDateParts = [];
		if (venueName) venueDateParts.push(venueName);
		if (item.date) venueDateParts.push(formatDateDisplay(item.date));
		if (venueDateParts.length > 0) {
			const venueEl = document.createElement('span');
			venueEl.className = 'boardTileVenue';
			venueEl.textContent = venueDateParts.join(' · ');
			tile.appendChild(venueEl);
		}

		const typeEl = document.createElement('span');
		typeEl.className = 'boardTilePostType';
		typeEl.textContent = POST_TYPE_ITEM_LABEL[item.postType] || 'Shot';
		tile.appendChild(typeEl);

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
		const genreWrap = document.getElementById('boardGenreFilters');
		const postTypeWrap = document.getElementById('boardPostTypeFilters');

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

		// Genre options are only offered for genres that at least one
		// current board post actually resolved to (via title -> act match) —
		// same "don't show an empty-result filter" rule as venue/type/area.
		const genres = [...new Set(items.flatMap((item) => item.genres || []))].sort();
		genreWrap.innerHTML = genres.map((g) => `
			<button type="button" class="chip ${selectedGenres.has(g) ? 'active' : ''}" data-filter="genre" data-value="${g}" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</button>
		`).join('');

		// Post type (All/Shots/Galleries/Reports) is a mutually-exclusive
		// toggle, not a multi-select chip row like the other four groups —
		// styled like #calendarToggle's Day/Week segmented control on the
		// main calendar page (see .toggle-button rules in board.css) rather
		// than the pill-chip look used for venue/type/area/genre.
		postTypeWrap.innerHTML = Object.keys(POST_TYPE_LABELS).map((p) => `
			<button type="button" class="toggle-button ${selectedPostType === p ? 'active' : ''}" data-post-type="${p}">${POST_TYPE_LABELS[p]}</button>
		`).join('');
		postTypeWrap.querySelectorAll('.toggle-button').forEach((btn) => {
			btn.addEventListener('click', () => {
				selectedPostType = btn.dataset.postType;
				refreshFilterUI();
			});
		});

		[nameWrap, typeWrap, areaWrap, genreWrap].forEach((wrap) => {
			wrap.querySelectorAll('.chip').forEach((chip) => {
				chip.addEventListener('click', () => {
					const { filter, value } = chip.dataset;
					const set = filter === 'name' ? selectedVenueIds
						: filter === 'type' ? selectedTypes
						: filter === 'area' ? selectedAreas
						: selectedGenres;
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
		selectedGenres.forEach((g) => {
			active.push({ group: 'genre', value: g, label: genreLabel(g) });
		});
		if (selectedPostType !== 'all') {
			active.push({ group: 'postType', value: selectedPostType, label: POST_TYPE_LABELS[selectedPostType] });
		}

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
				if (group === 'postType') {
					selectedPostType = 'all';
				} else {
					const set = group === 'name' ? selectedVenueIds
						: group === 'type' ? selectedTypes
						: group === 'area' ? selectedAreas
						: selectedGenres;
					set.delete(value);
				}
				refreshFilterUI();
			});
		});

		document.getElementById('boardResetAllFilters').addEventListener('click', () => {
			selectedVenueIds.clear();
			selectedTypes.clear();
			selectedAreas.clear();
			selectedGenres.clear();
			selectedPostType = 'all';
			refreshFilterUI();
		});
	}

	// --- Modal --------------------------------------------------------------
	// A shot renders exactly like before: single media block on top, info
	// below. A gallery or report instead puts the info (.boardModalMeta)
	// first, followed by a scrollable content area (#boardModalContentList) —
	// a stream of media (+ optional captions) for a gallery, or a mix of
	// paragraph and media blocks for a report. Which layout applies is
	// driven by the .boardModalContent--shot modifier class (see board.css
	// for the order-based reordering of .boardModalMeta vs. the media/content
	// blocks) so no DOM reordering is needed here.

	function pauseAllModalVideos() {
		modalMediaInner.querySelectorAll('video').forEach((v) => v.pause());
		modalContentList.querySelectorAll('video').forEach((v) => v.pause());
		modalReportHero.querySelectorAll('video').forEach((v) => v.pause());
	}

	function buildStreamMediaEl(media) {
		let el;
		if (media.type === 'video') {
			el = document.createElement('video');
			el.src = media.src;
			el.controls = true;
			el.volume = 0.5;
			el.playsInline = true;
		} else {
			el = document.createElement('img');
			el.src = media.src;
			el.alt = media.caption || '';
			el.loading = 'lazy';
		}
		return el;
	}

	function appendStreamCaption(container, caption) {
		if (!caption) return;
		const cap = document.createElement('p');
		cap.className = 'boardModalStreamCaption';
		cap.textContent = caption;
		container.appendChild(cap);
	}

	function renderShotContent(item) {
		modalContentList.hidden = true;
		modalContentList.innerHTML = '';
		modalMediaWrap.hidden = false;
		modalMediaInner.innerHTML = '';

		if (item.type === 'video') {
			const video = document.createElement('video');
			video.src = item.src;
			video.controls = true;
			video.autoplay = true;
			video.volume = 0.5;
			video.playsInline = true;
			modalMediaInner.appendChild(video);
		} else {
			const img = document.createElement('img');
			img.src = item.src;
			img.alt = item.title || '';
			modalMediaInner.appendChild(img);
		}
	}

	function renderGalleryContent(item) {
		modalMediaWrap.hidden = true;
		modalMediaInner.innerHTML = '';
		modalContentList.hidden = false;
		modalContentList.innerHTML = '';

		(item.items || []).forEach((media) => {
			const row = document.createElement('div');
			row.className = 'boardModalStreamItem';
			row.appendChild(buildStreamMediaEl(media));
			appendStreamCaption(row, media.caption);
			modalContentList.appendChild(row);
		});
	}

	function renderReportContent(item) {
		modalMediaWrap.hidden = true;
		modalMediaInner.innerHTML = '';
		modalContentList.hidden = false;
		modalContentList.innerHTML = '';

		(item.blocks || []).forEach((block) => {
			if (!block) return;

			if (block.type === 'paragraph') {
				const p = document.createElement('p');
				p.className = 'boardModalStreamParagraph';
				p.textContent = block.text || '';
				modalContentList.appendChild(p);
				return;
			}

			if (block.type === 'media') {
				const row = document.createElement('div');
				row.className = 'boardModalStreamItem';
				row.appendChild(buildStreamMediaEl({ type: block.mediaType, src: block.src, caption: block.caption }));
				appendStreamCaption(row, block.caption);
				modalContentList.appendChild(row);
			}
		});
	}

	// Shows a report's standalone `hero` shot at the very top of the modal,
	// above the title/venue/date info, when the post has one — independent
	// of `blocks`, so it's never automatically duplicated into the body.
	// If the same shot should also appear in the body text, that's done by
	// adding it again as its own ordinary media block; nothing here keeps
	// the two in sync. Only reports get this treatment; shots and galleries
	// leave modalReportHero hidden.
	function renderReportHero(item) {
		modalReportHero.innerHTML = '';

		// Deliberately reads item.hero directly rather than going through
		// resolveCoverEntry() — a report with no explicit `hero` gets no
		// hero section at all, rather than one inferred from a body block
		// (that fallback exists in resolveCoverEntry() only for the grid
		// tile image, on older reports written before `hero` existed).
		const hero = item.hero;
		if (!hero || !hero.src) {
			modalReportHero.hidden = true;
			return;
		}

		modalReportHero.hidden = false;
		modalReportHero.appendChild(buildStreamMediaEl({ type: hero.mediaType, src: hero.src, caption: hero.caption }));
	}

	// Keeps the address bar in sync with whichever post is open, using the
	// same bare #<id> hash openItemFromHash() already reads on page load —
	// so the URL sitting in the browser bar while a post is open (or after
	// paging prev/next to a different one) is always a valid, shareable
	// link straight to that post. replaceState (not pushState) is used so
	// opening a post or paging between posts doesn't spam the back button
	// with an entry per post.
	function updateUrlForItem(item) {
		try {
			history.replaceState(null, '', `${location.pathname}${location.search}#${encodeURIComponent(item.id)}`);
		} catch (e) {
			// history API unavailable in some embedding contexts — non-fatal
		}
	}

	function clearUrlHash() {
		try {
			history.replaceState(null, '', location.pathname + location.search);
		} catch (e) {
			// non-fatal — see updateUrlForItem()
		}
	}

	function renderModalItem(item) {
		pauseAllModalVideos();
		updateUrlForItem(item);

		const isStream = item.postType === 'gallery' || item.postType === 'report';
		modalContent.classList.toggle('boardModalContent--shot', !isStream);

		modalTitle.textContent = item.title || 'Untitled';
		modalGenres.innerHTML = genreChipsHtml(item.genres);
		modalGenres.style.display = item.genres && item.genres.length > 0 ? 'flex' : 'none';

		const subParts = [];
		const venueName = resolveVenueName(item.venueId, venueLookup);
		if (venueName) subParts.push(venueName);
		if (item.date) subParts.push(formatDateDisplay(item.date));
		modalSub.textContent = subParts.join(' · ');

		modalCredit.textContent = '';
		if (item.submittedBy) {
			modalCredit.append('from ', Object.assign(document.createElement('span'), {
				className: 'boardModalCreditValue',
				textContent: item.submittedBy,
			}));
		}

		if (item.postType === 'gallery') {
			renderGalleryContent(item);
			modalReportHero.hidden = true;
			modalReportHero.innerHTML = '';
		} else if (item.postType === 'report') {
			renderReportHero(item);
			renderReportContent(item);
		} else {
			renderShotContent(item);
			modalReportHero.hidden = true;
			modalReportHero.innerHTML = '';
		}

		updateModalNavState();
	}

	function updateModalNavState() {
		const hasMultiple = filteredItems.length > 1;
		modalPrevBtn.hidden = !hasMultiple;
		modalNextBtn.hidden = !hasMultiple;
		if (hasMultiple) {
			modalPrevBtn.disabled = modalIndex <= 0;
			modalNextBtn.disabled = modalIndex >= filteredItems.length - 1;
		}
	}

	function showModalIndex(newIndex) {
		if (newIndex < 0 || newIndex >= filteredItems.length) return;
		modalIndex = newIndex;
		renderModalItem(filteredItems[modalIndex]);
	}

	function openModal(item) {
		modalIndex = filteredItems.indexOf(item);
		renderModalItem(item);

		modal.hidden = false;
		document.body.classList.add('boardModalOpen');
	}

	function closeModal() {
		modal.hidden = true;
		document.body.classList.remove('boardModalOpen');
		clearUrlHash();

		// Stop any playing video when the modal closes.
		pauseAllModalVideos();
		modalMediaInner.innerHTML = '';
		modalContentList.innerHTML = '';
		modalReportHero.innerHTML = '';
		modalIndex = -1;
	}

	modalPrevBtn.addEventListener('click', () => showModalIndex(modalIndex - 1));
	modalNextBtn.addEventListener('click', () => showModalIndex(modalIndex + 1));

	// Share the currently open post — native share sheet where available
	// (mainly mobile), falling back to copying the #item-<id> link (kept in
	// sync with the address bar by updateUrlForItem()) to the clipboard.
	const SHARE_LABEL_DEFAULT = 'Copy Link';
	let shareFeedbackTimer = null;

	function showShareFeedback(label) {
		if (!modalShareBtn) return;
		clearTimeout(shareFeedbackTimer);
		modalShareBtn.textContent = label;
		shareFeedbackTimer = setTimeout(() => {
			modalShareBtn.textContent = SHARE_LABEL_DEFAULT;
		}, 1800);
	}

	if (modalShareBtn) {
		modalShareBtn.addEventListener('click', async () => {
			const item = filteredItems[modalIndex];
			if (!item) return;
			const url = `${location.origin}${location.pathname}#${encodeURIComponent(item.id)}`;

			if (navigator.share) {
				try {
					await navigator.share({ title: item.title || 'CRWD SRFR Board', url });
				} catch (e) {
					// User cancelled the share sheet — not an error, nothing to do.
				}
				return;
			}

			if (navigator.clipboard && navigator.clipboard.writeText) {
				try {
					await navigator.clipboard.writeText(url);
					showShareFeedback('Copied!');
					return;
				} catch (e) {
					// Clipboard permission denied/unavailable — fall through.
				}
			}

			// Last resort: the URL is already sitting in the address bar
			// (updateUrlForItem keeps it current), so there's nothing more
			// to do here beyond letting the person copy it manually.
			showShareFeedback("Copy from your browser's address bar");
		});
	}

	modal.addEventListener('click', (e) => {
		if (e.target.closest('[data-boardclose]')) closeModal();
	});

	document.addEventListener('keydown', (e) => {
		if (!modal.hidden) {
			if (e.key === 'Escape') closeModal();
			if (e.key === 'ArrowLeft') showModalIndex(modalIndex - 1);
			if (e.key === 'ArrowRight') showModalIndex(modalIndex + 1);
		}
		if (e.key === 'Escape' && submitModal && !submitModal.hidden) closeSubmitModal();
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
