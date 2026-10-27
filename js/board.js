// board.js
// Data layer + grid/modal/search/filter rendering for the Board.
//
// Data source: approved Board posts in Supabase (public.posts, destination 'board'),
// read through CrwdCore. Every post has a post_type:
//   shot       — one photo or video
//   gallery    — two or more photos/videos (what used to be galleries AND reports)
//   discussion — text only, no media
// and these fields (see the schema for the rules):
//   { id, title, opener?, media: [{ src, type, caption?, thumb?, cover? }], closer?,
//     hero? (cover photo at the top), venue_id?, show_date?, act_ids[], credit?, legacy_id? }
//
// Media `src` is either a file in the post-media storage bucket ("<user id>/…") or one
// of the site's own Board files ("/board/…", for posts imported from board-media.json).
// mediaUrl() turns either into a URL.
//
// Tile image: `hero` when set, else the media entry marked `cover: true`, else the
// first media entry. Discussions have none.
//
// Genres come from the post's tagged acts (act_ids → data/acts.json). Posts with no
// tags fall back to matching the title against act names, like before.
//
// Search + filter behavior mirrors events.js: a search term matches title, venue name,
// username, credit or tagged act; venue/type/area/genre chips union together; selected
// filters persist to localStorage while the search term resets each visit. The Posts
// toggle (All/Shots/Galleries/Discussion) is a separate mutually-exclusive toggle.
//
// The page-agnostic data-layer pieces are exposed on window.BoardMedia (acts.js uses
// them for an act's "From the Board" thumbnails). The grid/modal code below only runs
// when #boardGrid is on the page.

(function () {
	const VENUES_URL = '/data/venues.json';
	const ACTS_URL = '/data/acts.json';
	const GENRES_URL = '/data/genres.json';
	const BATCH_SIZE = 15;
	const FILTER_STORAGE_KEY = 'crwdsrfr_board_filters';
	const POST_COLUMNS = 'id, legacy_id, author_id, post_type, title, opener, media, closer, hero, venue_id, show_date, act_ids, act_names, credit, created_at';

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

	// Post-type toggle (All / Shots / Galleries / Discussion) — mutually exclusive,
	// unlike the venue/genre chip rows which union together.
	const POST_TYPE_LABELS = { all: 'All', shot: 'Shots', gallery: 'Galleries', discussion: 'Discussion' };
	// Singular labels for the tile's "what kind of post is this" line.
	const POST_TYPE_ITEM_LABEL = { shot: 'Shot', gallery: 'Gallery', discussion: 'Discussion' };
	// Sort options in the menu next to the "All Posts by…" heading (first one is the default)
	const SORT_LABELS = { recent: 'Most Recent', hyped: 'Most Hyped', commented: 'Most Commented', oldest: 'Oldest Posted' };

	// --- Date helpers -------------------------------------------------------
	// Show dates are plain "YYYY-MM-DD" strings. Never round-trip these through
	// `new Date()` — that can shift the day depending on the browser's timezone.

	function formatDateDisplay(dateStr) {
		const parts = String(dateStr).split('-');
		if (parts.length !== 3) return dateStr;
		const [year, month, day] = parts.map(Number);
		const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		if (!month || month < 1 || month > 12) return dateStr;
		return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
	}

	// When the post was made: "Oct 14, 2026 at 8:30 PM", in the visitor's own timezone
	function formatPostedAt(timestamp) {
		const d = new Date(timestamp);
		if (isNaN(d)) return '';
		return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
			+ ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
	}

	function sortableName(name) {
		return String(name || '').replace(/^the\s+/i, '');
	}

	// --- Media ----------------------------------------------------------------

	function mediaUrl(src) {
		if (!src) return '';
		if (src.charAt(0) === '/') return src; // the site's own /board/ files
		const core = window.CrwdCore;
		if (!core || !core.enabled) return '';
		return core.sb.storage.from('post-media').getPublicUrl(src).data.publicUrl;
	}

	function prepareMedia(entry) {
		if (!entry || !entry.src) return null;
		const url = mediaUrl(entry.src);
		return {
			type: entry.type === 'video' ? 'video' : 'photo',
			url: url,
			thumbnail: entry.thumb ? mediaUrl(entry.thumb) : (entry.type === 'video' ? '' : url),
			caption: entry.caption || null,
			cover: entry.cover === true
		};
	}

	// The one image that represents a post on its tile (null for discussions)
	function getCoverMedia(item) {
		const pick = item.hero || item.media.find((m) => m.cover) || item.media[0] || null;
		return pick ? { type: pick.type, thumbnail: pick.thumbnail } : null;
	}

	// Every photo/video of a post as its own "unit", for acts.js: an act's page shows
	// the shots that name it in their caption, or (uncaptioned) the shots of posts
	// tagged with that act or titled after it.
	function mediaUnitsForItem(item) {
		const base = {
			postId: item.id,
			postTitle: item.title,
			date: item.date,
			venueId: item.venueId,
			actIds: item.actIds
		};
		// A cover picked from the post's own media is the same file: don't list it twice
		const heroIsExtra = item.hero && !item.media.some((m) => m.url === item.hero.url);
		return (heroIsExtra ? [item.hero] : []).concat(item.media).map((m) => ({
			...base,
			type: m.type,
			thumbnail: m.thumbnail,
			caption: m.caption,
			matchText: m.caption || item.title
		}));
	}

	// --- Venue name lookup ------------------------------------------------
	// data/venues.json is an array of venue objects ({ id, name, type, area, … }).

	function buildVenueLookup(venuesData) {
		const lookup = {};
		(Array.isArray(venuesData) ? venuesData : []).forEach((venue) => {
			if (venue && venue.id) lookup[venue.id] = venue;
		});
		return lookup;
	}

	function resolveVenueName(venueId, venueLookup) {
		if (!venueId) return '';
		const venue = venueLookup && venueLookup[venueId];
		return venue && venue.name ? venue.name : venueId;
	}

	// --- Data fetching (reusable) -------------------------------------------

	function toItem(row, author) {
		return {
			id: row.id,
			legacyId: row.legacy_id || null,
			postType: row.post_type,
			title: row.title,
			opener: row.opener || '',
			closer: row.closer || '',
			media: (row.media || []).map(prepareMedia).filter(Boolean),
			hero: prepareMedia(row.hero),
			venueId: row.venue_id || null,
			date: row.show_date || null,
			actIds: row.act_ids || [],
			actNames: row.act_names || [], // acts typed in that aren't on the Acts page
			credit: row.credit || null,
			authorId: row.author_id,
			status: row.status || 'approved',
			destination: row.destination || 'board',
			author: author || null, // { username, avatar_path } — null if the account is gone
			createdAt: row.created_at
		};
	}

	// Approved Board posts, newest first, with their authors' usernames
	async function fetchBoardMedia() {
		const core = window.CrwdCore;
		if (!core || !core.enabled) throw new Error('Accounts are unavailable, so the Board can\'t load');
		await core.ready;

		const { data, error } = await core.sb.from('posts')
			.select(POST_COLUMNS)
			.eq('destination', 'board')
			.eq('status', 'approved')
			.order('created_at', { ascending: false })
			.limit(1000);
		if (error) throw error;

		const authorIds = [...new Set(data.map((p) => p.author_id))];
		const people = {};
		if (authorIds.length) {
			const { data: profiles } = await core.sb.from('public_profiles').select('id, username, avatar_path, max_badge').in('id', authorIds);
			(profiles || []).forEach((p) => { people[p.id] = p; });
		}
		return data.map((row) => toItem(row, people[row.author_id]));
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

	// Matches the post id, or the old board-media.json id (old /board/#id links)
	function findItemById(list, id) {
		return list.find((item) => item.id === id || item.legacyId === id);
	}

	// --- Acts + genres ---------------------------------------------------------
	// Same "whole word, case-insensitive" rule acts.js uses. Short names (<=3 chars)
	// require exact equality, to avoid noisy false positives (e.g. "DJ").

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

	// Acts named in a title — the fallback for posts with no tagged acts
	function actsForTitle(title, actsList) {
		if (!title || !actsList) return [];
		return actsList.filter((act) => actNeedles(act).some((needle) => textMatchesNeedle(title, needle)));
	}

	function genresForTitle(title, actsList) {
		return [...new Set(actsForTitle(title, actsList).flatMap((act) => act.genres || []))];
	}

	// Adds item.acts (tagged acts, else acts named in the title) and item.genres
	function withActs(item, actsList) {
		const bySlug = Object.fromEntries(actsList.map((act) => [act.slug, act]));
		const tagged = item.actIds.map((slug) => bySlug[slug]).filter(Boolean)
			// Typed-in acts: a name only (no Acts page link, no genres)
			.concat((item.actNames || []).map((name) => ({ name, slug: null, genres: [] })));
		const acts = tagged.length ? tagged : actsForTitle(item.title, actsList);
		return { ...item, acts, genres: [...new Set(acts.flatMap((act) => act.genres || []))] };
	}

	// Non-excluded acts as a list, each with its acts.json key as `slug`
	function fetchActsList() {
		return fetch(ACTS_URL, { cache: 'no-store' })
			.then((res) => {
				if (!res.ok) throw new Error(`Failed to load ${ACTS_URL}: ${res.status}`);
				return res.json();
			})
			.then((data) => Object.entries(data || {})
				.filter(([, act]) => String(act.exclude).toLowerCase() !== 'yes')
				.map(([slug, act]) => ({ ...act, slug })))
			.catch((err) => {
				console.warn('board.js: could not load acts', err);
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

	window.BoardMedia = {
		fetchBoardMedia,
		fetchVenueLookup,
		filterByVenueId,
		findItemById,
		fetchActsList,
		fetchGenreMeta,
		genresForTitle,
		withActs,
		toItem,
		formatDateDisplay,
		formatPostedAt,
		resolveVenueName,
		getCoverMedia,
		mediaUnitsForItem,
		mediaUrl,
	};

	// --- Grid + modal + search/filter rendering (specific to /board/) -------

	const grid = document.getElementById('boardGrid');
	if (!grid) return; // Not on the board page — data layer above is still available.

	const resultsEl = document.getElementById('boardResults');
	const loadMoreBtn = document.getElementById('boardLoadMore');
	const emptyMsg = document.getElementById('boardEmpty');
	const loadingMsg = document.getElementById('boardLoading');
	const endMsg = document.getElementById('boardEnd');

	const searchInput = document.getElementById('boardSearch');
	const searchWrapper = document.getElementById('boardSearchWrapper');
	const filterToggle = document.getElementById('boardFilterToggle');
	const filterPanel = document.getElementById('boardFilters');

	let items = []; // all approved posts, newest first
	let filteredItems = []; // items after search + filters
	let venueLookup = {};
	let genreMeta = {};
	let stats = {}; // post id → { hypes, comments, hyped }
	let renderedCount = 0;
	let loaded = false;

	let currentSearch = '';
	const selectedVenueIds = new Set();
	const selectedTypes = new Set();
	const selectedAreas = new Set();
	const selectedGenres = new Set();
	let selectedPostType = 'all'; // 'all' | 'shot' | 'gallery' | 'discussion'
	let selectedSort = 'recent'; // a key of SORT_LABELS
	const expandedGroups = { name: false, type: false, area: false, genre: false };

	function socialReady() {
		return !!(window.CrwdSocial && window.CrwdCore && window.CrwdCore.enabled);
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

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

	function genreChip(genre) {
		const chip = el('span', 'genre-chip', genreLabel(genre));
		chip.style.setProperty('--genre-color', genreColor(genre));
		return chip;
	}

	// --- Filter persistence ---------------------------------------------

	function saveFiltersToStorage() {
		try {
			const payload = {
				venueIds: [...selectedVenueIds],
				types: [...selectedTypes],
				areas: [...selectedAreas],
				genres: [...selectedGenres],
				postType: selectedPostType,
				sort: selectedSort,
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
			// An old saved 'report' choice isn't a type anymore, so it's ignored here
			if (Object.prototype.hasOwnProperty.call(POST_TYPE_LABELS, parsed.postType)) {
				selectedPostType = parsed.postType;
			}
			if (Object.prototype.hasOwnProperty.call(SORT_LABELS, parsed.sort)) {
				selectedSort = parsed.sort;
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
		const sortLabel = SORT_LABELS[selectedSort];
		subHeadEl.textContent = term === ''
			? `All Posts by ${sortLabel}:`
			: `All Posts including "${term}" by ${sortLabel}:`;
	}

	// Ties (e.g. two posts with 3 hypes) fall back to newest first
	function sortPosts(list) {
		const time = (item) => new Date(item.createdAt).getTime() || 0;
		const count = (item, key) => (stats[item.id] && stats[item.id][key]) || 0;
		const newestFirst = (a, b) => time(b) - time(a);
		const compare = {
			recent: newestFirst,
			oldest: (a, b) => time(a) - time(b),
			hyped: (a, b) => count(b, 'hypes') - count(a, 'hypes') || newestFirst(a, b),
			commented: (a, b) => count(b, 'comments') - count(a, 'comments') || newestFirst(a, b),
		}[selectedSort] || newestFirst;
		return [...list].sort(compare);
	}

	function applyFilters() {
		updateSubHead();

		let filtered = items;

		if (currentSearch.trim() !== '') {
			const term = currentSearch.toLowerCase().trim();
			filtered = filtered.filter((item) => {
				const venue = venueLookup[item.venueId];
				return item.title.toLowerCase().includes(term)
					|| (venue && venue.name && venue.name.toLowerCase().includes(term))
					|| (item.author && item.author.username.includes(term))
					|| (item.credit && item.credit.toLowerCase().includes(term))
					|| item.acts.some((act) => act.name.toLowerCase().includes(term));
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

		filteredItems = sortPosts(filtered);
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

	// --- Sort menu (icon button next to the heading) -------------------------

	const sortButton = document.getElementById('boardSortButton');
	const sortMenu = document.getElementById('boardSortMenu');

	function sortOptions() {
		return [...sortMenu.querySelectorAll('[data-sort]')];
	}

	function markSelectedSort() {
		sortOptions().forEach((option) => {
			option.setAttribute('aria-checked', option.dataset.sort === selectedSort ? 'true' : 'false');
		});
	}

	function openSortMenu() {
		markSelectedSort();
		sortMenu.hidden = false;
		sortButton.classList.add('open');
		sortButton.setAttribute('aria-expanded', 'true');
		const current = sortOptions().find((option) => option.dataset.sort === selectedSort);
		(current || sortOptions()[0]).focus();
	}

	function closeSortMenu(returnFocus) {
		if (sortMenu.hidden) return;
		sortMenu.hidden = true;
		sortButton.classList.remove('open');
		sortButton.setAttribute('aria-expanded', 'false');
		if (returnFocus) sortButton.focus();
	}

	if (sortButton && sortMenu) {
		markSelectedSort();

		sortButton.addEventListener('click', () => {
			if (sortMenu.hidden) openSortMenu(); else closeSortMenu(false);
		});

		sortMenu.addEventListener('click', (e) => {
			const option = e.target.closest('[data-sort]');
			if (!option) return;
			closeSortMenu(true);
			if (option.dataset.sort === selectedSort) return;
			selectedSort = option.dataset.sort;
			markSelectedSort();
			saveFiltersToStorage();
			if (loaded) applyFilters();
		});

		// Up/down moves through the options, Escape/Tab closes
		sortMenu.addEventListener('keydown', (e) => {
			const options = sortOptions();
			const i = options.indexOf(document.activeElement);
			if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
				e.preventDefault();
				const step = e.key === 'ArrowDown' ? 1 : -1;
				options[(i + step + options.length) % options.length].focus();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				closeSortMenu(true);
			} else if (e.key === 'Tab') {
				closeSortMenu(false);
			}
		});

		document.addEventListener('click', (e) => {
			if (!sortMenu.hidden && !e.target.closest('#boardSort')) closeSortMenu(false);
		});
	}

	// --- Tile / row view toggle (far right of the heading row) ----------------
	// Just a class on the grid: switching never re-renders or refetches.

	const VIEW_STORAGE_KEY = 'crwdsrfr_board_view';
	const viewToggle = document.getElementById('boardViewToggle');
	let selectedView = 'tiles'; // 'tiles' | 'rows'
	try { if (localStorage.getItem(VIEW_STORAGE_KEY) === 'rows') selectedView = 'rows'; } catch (e) {}

	function applyView() {
		grid.classList.toggle('isRows', selectedView === 'rows');
		if (!viewToggle) return;
		viewToggle.querySelectorAll('[data-view]').forEach((btn) => {
			const on = btn.dataset.view === selectedView;
			btn.classList.toggle('active', on);
			btn.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
	}

	if (viewToggle) {
		viewToggle.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-view]');
			if (!btn || btn.dataset.view === selectedView) return;
			selectedView = btn.dataset.view;
			try { localStorage.setItem(VIEW_STORAGE_KEY, selectedView); } catch (err) {}
			// Same fade as a search/filter change, so the layout swap isn't jumpy
			$(resultsEl).fadeTo(150, 0, function () {
				applyView();
				$(resultsEl).fadeTo(150, 1);
			});
		});
	}

	applyView();

	// --- Data loading -------------------------------------------------------

	function loadMedia() {
		// "Waxing the board..." until the posts (and their counts) are in
		loadingMsg.hidden = false;
		emptyMsg.hidden = true;

		Promise.all([fetchBoardMedia(), fetchVenueLookup(), fetchActsList(), fetchGenreMeta()])
			.then(async ([posts, lookup, actsList, genres]) => {
				genreMeta = genres;
				venueLookup = lookup;
				// Tagged acts (unknown slugs are skipped), else acts named in the title
				items = posts.map((item) => withActs(item, actsList));

				// Hype + comment counts for every post (and which ones you've hyped)
				if (socialReady()) stats = await CrwdSocial.loadStats('post', items.map((item) => item.id));
				loaded = true;
				loadingMsg.hidden = true;

				loadFiltersFromStorage();
				buildBoardFilterChips();
				renderActiveFilters();
				applyFilters();
				openItemFromHash();
			})
			.catch((err) => {
				console.warn('board.js: could not load posts', err);
				loadingMsg.hidden = true;
				emptyMsg.hidden = false;
				emptyMsg.textContent = 'Could not load the board right now — try again later.';
			});
	}

	// Signing in or out changes which posts you've hyped
	async function refreshStats() {
		if (!loaded || !socialReady()) return;
		stats = await CrwdSocial.loadStats('post', items.map((item) => item.id));
		grid.querySelectorAll('.boardTile').forEach(updateTileCounts);
		if (window.CrwdPost) CrwdPost.refresh();
	}

	// Deep-linking: /board/#<id> opens that post's modal. Old board-media.json ids
	// still work (they're kept as legacy_id). Anything else (e.g. "#top") is ignored.
	function openItemFromHash() {
		const hash = window.location.hash;
		if (!hash || hash.length <= 1) return;

		let id;
		try { id = decodeURIComponent(hash.slice(1)); } catch (e) { return; }
		const item = findItemById(items, id);
		if (!item) return;

		// The modal's prev/next nav is indexed against filteredItems, so if the
		// linked post is hidden by an active search/filter, clear those first.
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
				// Always fade back in, even if something above threw
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

	// Tile: thumbnail (if any), title, "by username", post type, and hype/comment
	// counts (each only when above zero — display only, not buttons)
	function buildTile(item) {
		const tile = document.createElement('button');
		tile.type = 'button';
		tile.className = 'boardTile' + (item.postType === 'discussion' ? ' isDiscussion' : '');
		tile.dataset.postId = item.id;
		tile.setAttribute('aria-label', `Open ${item.title}`);

		const cover = getCoverMedia(item);
		if (cover) {
			const thumbWrap = el('div', 'boardTileThumb');
			if (cover.thumbnail) {
				const img = el('img');
				img.src = cover.thumbnail;
				img.alt = '';
				img.loading = 'lazy';
				thumbWrap.appendChild(img);
			} else {
				thumbWrap.classList.add('boardTileThumb-empty');
			}
			if (cover.type === 'video') {
				const playIcon = el('span', 'boardTilePlayIcon');
				playIcon.setAttribute('aria-hidden', 'true');
				thumbWrap.appendChild(playIcon);
			}
			if (item.postType === 'gallery') {
				const stackBadge = el('span', 'boardTileStackBadge');
				stackBadge.setAttribute('aria-hidden', 'true');
				thumbWrap.appendChild(stackBadge);
			}
			tile.appendChild(thumbWrap);
		}

		const info = el('span', 'boardTileInfo');
		info.appendChild(el('span', 'boardTileCaption', item.title));
		const by = el('span', 'boardTileBy', 'by ' + (item.author ? item.author.username : 'a former member'));
		if (item.author && item.author.max_badge && window.CrwdUI) by.appendChild(CrwdUI.maxBadge());
		info.appendChild(by);
		// Discussions have no picture: a few lines of the opening text fill in instead
		if (item.postType === 'discussion' && item.opener) {
			info.appendChild(el('span', 'boardTileExcerpt', item.opener));
		}

		const foot = el('span', 'boardTileFoot');
		foot.appendChild(el('span', 'boardTilePostType', POST_TYPE_ITEM_LABEL[item.postType] || 'Post'));
		foot.appendChild(el('span', 'boardTileCounts'));
		info.appendChild(foot);
		tile.appendChild(info);
		updateTileCounts(tile);

		tile.addEventListener('click', () => openModal(item));
		return tile;
	}

	function countBadge(iconClass, n, noun) {
		const badge = el('span', 'boardTileCount');
		badge.setAttribute('aria-label', `${n} ${noun}${n === 1 ? '' : 's'}`);
		const icon = el('span', 'icon ' + iconClass);
		icon.setAttribute('aria-hidden', 'true');
		badge.append(icon, n.toLocaleString());
		return badge;
	}

	function updateTileCounts(tile) {
		const s = stats[tile.dataset.postId] || { hypes: 0, comments: 0 };
		const wrap = tile.querySelector('.boardTileCounts');
		wrap.replaceChildren();
		if (s.hypes > 0) wrap.appendChild(countBadge('iconHype', s.hypes, 'hype'));
		if (s.comments > 0) wrap.appendChild(countBadge('iconComment', s.comments, 'comment'));
	}

	function updateTileFor(id) {
		const tile = grid.querySelector(`.boardTile[data-post-id="${CSS.escape(id)}"]`);
		if (tile) updateTileCounts(tile);
	}

	// --- Load More button ---------------------------------------------------

	loadMoreBtn.addEventListener('click', () => {
		loadingMsg.hidden = false;
		renderNextBatch();
		loadingMsg.hidden = true;
	});

	// --- Filter chips -------------------------------------------------------

	function buildBoardFilterChips() {
		// Only offer chips for venues that actually have at least one post
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

		const types = [...new Set(venues.map((v) => v.type).filter(Boolean))].sort();
		typeWrap.innerHTML = types.map((t) => `
			<button type="button" class="chip ${selectedTypes.has(t) ? 'active' : ''}" data-filter="type" data-value="${t}">${TYPE_LABELS[t] || t}</button>
		`).join('');

		const areas = [...new Set(venues.map((v) => v.area).filter(Boolean))].sort();
		areaWrap.innerHTML = areas.map((a) => `
			<button type="button" class="chip ${selectedAreas.has(a) ? 'active' : ''}" data-filter="area" data-value="${a}">${a}</button>
		`).join('');

		const genres = [...new Set(items.flatMap((item) => item.genres || []))].sort();
		genreWrap.innerHTML = genres.map((g) => `
			<button type="button" class="chip ${selectedGenres.has(g) ? 'active' : ''}" data-filter="genre" data-value="${g}" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</button>
		`).join('');

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

	// --- Post modal (js/crwd-post.js, shared with profile pages) --------------

	function openModal(item) {
		CrwdPost.open({
			items: filteredItems,
			index: Math.max(0, filteredItems.indexOf(item)),
			context: { venueLookup, genreMeta },
			getStats: (id) => stats[id],
			onStatsChange: (id, next) => { stats[id] = next; updateTileFor(id); },
			hashFor: (post) => '#' + encodeURIComponent(post.id),
			shareUrl: (post) => location.origin + location.pathname + '#' + encodeURIComponent(post.id)
		});
	}

	// --- New Post (the same form as profile pages: js/crwd-composer.js) -------

	const newPostButton = document.getElementById('boardNewPost');
	if (newPostButton) {
		newPostButton.addEventListener('click', () => {
			// Signed out: this opens sign-in instead. New posts start as pending, so the
			// grid doesn't change; the form's thank-you screen says where it'll show.
			if (window.CrwdComposer) window.CrwdComposer.open({ destination: 'board' });
		});
		// board.js runs before the account scripts; once they've loaded, hide the
		// button if accounts are switched off (it would do nothing)
		document.addEventListener('DOMContentLoaded', () => {
			newPostButton.hidden = !(window.CrwdComposer && window.CrwdCore && window.CrwdCore.enabled);
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

	// Shown straight away: board.js runs before the account scripts, and loadMedia()
	// waits for them, so this covers the whole wait, not just the database request
	loadingMsg.hidden = false;

	document.addEventListener('DOMContentLoaded', () => {
		loadMedia();
		if (socialReady()) {
			let first = true;
			CrwdCore.onChange(() => {
				if (first) { first = false; return; } // the first call is just "ready"
				refreshStats();
			});
		}
	});
})();
