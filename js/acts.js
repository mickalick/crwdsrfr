// acts.js
// Data layer + grid/jump-nav/modal rendering for /acts/ — the acts directory page.
//
// Data sources:
//   /data/acts.json   — object keyed by slug, each act:
//     { name, aliases[], genres[], links[{label,value}], exclude ('yes'|'no') }
//   /data/events.json — { venues: {id: venue}, events: [...] } (same shape events.js consumes)
//   /data/genres.json — { [genre]: { label, color } } (same file events.js consumes, for
//     genreLabel()/genreColor() parity with the calendar's chip colors)
//   data/board-media.json — via window.BoardMedia (exposed by board.js, loaded before this
//     file on this page). board.js no-ops its own grid/modal rendering when #boardGrid isn't
//     present, so loading it here only exposes fetchBoardMedia/resolveVenueName/etc.
//
// Acts with exclude: "yes" are catch-all/generic entries (booking placeholders like
// "Event" or "Comedy") and are never listed here.
//
// Matching acts to events/board media: neither events.json nor board-media.json carry an
// actId — events only have free-text performers[].name / title, and board posts only have
// a free-text title. So an act "matches" an event/post when the act's name or one of its
// aliases appears as a whole word in that text (case-insensitive). Short names (<=3 chars)
// are matched by exact equality only, not substring, to avoid noisy false positives.

(function () {
	const ACTS_URL = '/data/acts.json';
	const EVENTS_URL = '/data/events.json';
	const GENRES_URL = '/data/genres.json';

	const JUMP_GROUPS = ['0-9', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

	// Display label for a group — used by both the jump nav chip and its
	// matching section heading so the two always stay in sync. The group
	// key itself stays "0-9" everywhere else (anchors, actsByGroup, etc).
	function groupLabel(group) {
		return group === '0-9' ? '#' : group;
	}
	const MEDIA_PREVIEW_LIMIT = 5;
	const MAX_UPCOMING_EVENTS = 8;
	const FILTER_STORAGE_KEY = 'crwdsrfr_acts_filters';

	let genreMeta = {}; // populated from data/genres.json, same as events.js

	// All non-excluded acts, keyed by slug, sorted — populated once by loadActs()
	// and never mutated afterward. Filtering/search work off this master map;
	// they only ever narrow which slugs get grouped/rendered, never the
	// act objects themselves (so the modal always has the full act to show,
	// even though its tile only renders when the act passes the current filter).
	let allActsBySlug = {};
	let allActSlugsSorted = [];

	let currentSearch = '';
	const selectedGenres = new Set();
	let onlyLocal = false;
	const expandedGroups = { genre: false };

	// --- Filter persistence --------------------------------------------------
	// Selected filters persist across visits; the search term itself does not
	// — same split events.js/board.js use for their own filters vs. search.

	function saveFiltersToStorage() {
		try {
			localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ genres: [...selectedGenres], local: onlyLocal }));
		} catch (e) {
			// localStorage unavailable — filters simply won't persist this session
		}
	}

	function loadFiltersFromStorage() {
		try {
			const raw = localStorage.getItem(FILTER_STORAGE_KEY);
			if (!raw) return;
			const parsed = JSON.parse(raw);
			(parsed.genres || []).forEach(g => selectedGenres.add(g));
			onlyLocal = Boolean(parsed.local);
		} catch (e) {
			// Corrupt or missing data — just start with no filters
		}
	}

	function actMatchesGenreFilters(act) {
		if (selectedGenres.size === 0) return true;
		return (act.genres || []).some(g => selectedGenres.has(g));
	}

	function actMatchesLocalFilter(act) {
		if (!onlyLocal) return true;
		return String(act.local).toLowerCase() === 'yes';
	}

	function actMatchesSearch(act, term) {
		if (term === '') return true;
		const needle = term.toLowerCase();
		if (act.name.toLowerCase().includes(needle)) return true;
		return (act.aliases || []).some(a => a.toLowerCase().includes(needle));
	}

	// --- Genre label/color (mirrors events.js exactly, for chip parity) -----

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

	// --- Sorting / grouping --------------------------------------------------

	function sortableName(name) {
		return String(name || '').replace(/^the\s+/i, '');
	}

	// Strips diacritics so "Gemütlichkeit" / "Bräts" bucket under G / B rather
	// than falling through to the 0-9 catch-all.
	function stripDiacritics(str) {
		return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	}

	function jumpGroupFor(name) {
		const first = stripDiacritics(sortableName(name)).trim().charAt(0).toUpperCase();
		return /^[A-Z]$/.test(first) ? first : '0-9';
	}

	// --- Act <-> event / board-media matching --------------------------------

	function normalize(str) {
		return String(str || '').trim().toLowerCase();
	}

	function escapeRegex(str) {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	function actNeedles(act) {
		return [act.name, ...(act.aliases || [])]
			.map(normalize)
			.filter(Boolean);
	}

	function textMatchesNeedle(text, needle) {
		if (!text) return false;
		const normalizedText = normalize(text);
		if (needle.length <= 3) return normalizedText === needle;
		return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(text);
	}

	function actMatchesEvent(needles, event) {
		const performerNames = (event.performers || []).map(p => normalize(p.name));
		return needles.some(needle => {
			if (performerNames.includes(needle)) return true;
			return textMatchesNeedle(event.title, needle);
		});
	}

	function actMatchesMediaItem(needles, item) {
		return needles.some(needle => textMatchesNeedle(item.title, needle));
	}

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

	function formatEventDate(dateStr) {
		const [y, m, d] = dateStr.split('-').map(Number);
		return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
	}

	function upcomingEventsForAct(act, eventsData) {
		if (!eventsData) return [];
		const needles = actNeedles(act);
		const todayStr = toLocalDateStr(new Date());

		return eventsData.events
			.filter(e => e.date >= todayStr && actMatchesEvent(needles, e))
			.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
			.slice(0, MAX_UPCOMING_EVENTS);
	}

	async function mediaPreviewForAct(act) {
		if (!window.BoardMedia) return [];
		try {
			const items = await window.BoardMedia.fetchBoardMedia();
			const needles = actNeedles(act);
			return items.filter(item => actMatchesMediaItem(needles, item)).slice(0, MEDIA_PREVIEW_LIMIT);
		} catch (e) {
			console.warn('acts.js: could not load board media', e);
			return [];
		}
	}

	// --- Rendering: jump nav --------------------------------------------------

	function renderJumpNav(actsByGroup) {
		const nav = document.getElementById('actsJumpNav');
		nav.innerHTML = JUMP_GROUPS.map(group => {
			const label = groupLabel(group);
			const hasActs = (actsByGroup[group] || []).length > 0;
			return hasActs
				? `<a class="jumpChip" href="#actsGroup-${encodeURIComponent(group)}">${label}</a>`
				: `<span class="jumpChip jumpChip-disabled" aria-disabled="true">${label}</span>`;
		}).join('');
	}

	// --- Rendering: act list ---------------------------------------------------

	function actTileHtml(slug, act) {
		return `
			<button type="button" class="actTile" data-slug="${slug}">
				<span class="actTileName">${act.name}</span>
				<span class="actGenres">${genreChipsHtml(act.genres)}</span>
			</button>`;
	}

	// actsByGroup holds only the slugs currently passing search/filter; the
	// act objects themselves always come from the master allActsBySlug map.
	function renderActsList(actsByGroup) {
		const container = document.getElementById('actsList');
		container.innerHTML = '';

		JUMP_GROUPS.forEach(group => {
			const groupActs = actsByGroup[group];
			if (!groupActs || groupActs.length === 0) return;

			const section = document.createElement('div');
			section.className = 'actsGroup';
			section.innerHTML = `
				<div class="actsAnchor" id="actsGroup-${encodeURIComponent(group)}"></div>
				<h2 class="dateSeparator">${groupLabel(group)}</h2>
				<div class="actsGrid">
					${groupActs.map(slug => actTileHtml(slug, allActsBySlug[slug])).join('')}
				</div>
				<p class="actsBackToTop"><a aria-label="Back to top of page" href="#top"><small>Back to Top</small></a></p>`;
			container.appendChild(section);
		});

		container.querySelectorAll('.actTile').forEach(tile => {
			tile.addEventListener('click', () => openActModal(allActsBySlug[tile.dataset.slug]));
		});
	}

	// --- Search + filter application ------------------------------------------

	function updateSubHead() {
		const subHeadEl = document.getElementById('actsSubHead');
		const term = currentSearch.trim();
		subHeadEl.textContent = term === ''
			? 'All Acts:'
			: `All Acts including "${term}":`;
	}

	function groupFilteredActs() {
		const term = currentSearch.trim();
		const actsByGroup = {};
		JUMP_GROUPS.forEach(g => (actsByGroup[g] = []));

		allActSlugsSorted.forEach(slug => {
			const act = allActsBySlug[slug];
			if (!actMatchesSearch(act, term)) return;
			if (!actMatchesGenreFilters(act)) return;
			if (!actMatchesLocalFilter(act)) return;
			actsByGroup[jumpGroupFor(act.name)].push(slug);
		});

		return actsByGroup;
	}

	function applyFilters() {
		updateSubHead();

		const actsByGroup = groupFilteredActs();
		const totalMatches = Object.values(actsByGroup).reduce((n, list) => n + list.length, 0);

		const container = document.getElementById('actsList');
		const emptyMsg = document.getElementById('actsEmpty');

		$(container).fadeTo(150, 0, function () {
			renderJumpNav(actsByGroup);
			renderActsList(actsByGroup);
			emptyMsg.hidden = totalMatches > 0;
			$(container).fadeTo(150, 1);
		});
	}

	function resetSearch() {
		const input = document.getElementById('actsSearch');
		input.value = '';
		currentSearch = '';
		document.getElementById('actsSearchWrapper').classList.remove('hasValue');
		applyFilters();
		input.focus();
	}

	function refreshFilterUI() {
		saveFiltersToStorage();
		buildActsFilterChips();
		renderActiveFilters();
		applyFilters();
	}

	// --- Filter chips -----------------------------------------------------

	// Only offers chips for genres actually used by at least one (non-excluded)
	// act — same reasoning board.js uses for its own venue filter options.
	function buildActsFilterChips() {
		const genreWrap = document.getElementById('actsGenreFilters');
		const genres = [...new Set(Object.values(allActsBySlug).flatMap(a => a.genres || []))].sort();

		genreWrap.innerHTML = genres.map(g => `
			<button type="button" class="chip ${selectedGenres.has(g) ? 'active' : ''}" data-value="${g}" style="--genre-color: ${genreColor(g)}">${genreLabel(g)}</button>
		`).join('');

		genreWrap.querySelectorAll('.chip').forEach(chip => {
			chip.addEventListener('click', () => {
				const value = chip.dataset.value;
				if (selectedGenres.has(value)) selectedGenres.delete(value); else selectedGenres.add(value);
				refreshFilterUI();
			});
		});

		collapseChipRow(genreWrap, 'genre');
	}

	// Mirrors board.js's collapseChipRow exactly: collapses a chip row down to
	// two lines with a "Show All" toggle once it would otherwise wrap further,
	// re-measuring only once the panel has real layout (called after it's shown).
	function collapseChipRow(wrap, groupKey) {
		wrap.querySelectorAll('.chip-show-all').forEach(el => el.remove());
		const chips = [...wrap.querySelectorAll('.chip')];
		chips.forEach(c => (c.style.display = ''));

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
			chips.slice(lineThreeStart).forEach(c => (c.style.display = 'none'));
			toggleBtn.textContent = 'Show All';
			toggleBtn.addEventListener('click', () => {
				expandedGroups[groupKey] = true;
				collapseChipRow(wrap, groupKey);
			});
		}

		wrap.appendChild(toggleBtn);
	}

	function renderActiveFilters() {
		const wrapper = document.getElementById('actsActiveFiltersWrapper');
		const chipsWrap = document.getElementById('actsActiveFilters');

		if (selectedGenres.size === 0 && !onlyLocal) {
			wrapper.style.display = 'none';
			chipsWrap.innerHTML = '';
			return;
		}

		const genreChips = [...selectedGenres].map(g => `
			<button type="button" class="chip active-chip" data-value="${g}">${genreLabel(g)} <span class="chip-remove">&times;</span></button>
		`).join('');

		const localChip = onlyLocal
			? `<button type="button" class="chip active-chip" data-local="true">Local Only <span class="chip-remove">&times;</span></button>`
			: '';

		wrapper.style.display = 'flex';
		chipsWrap.innerHTML = genreChips + localChip + `<button type="button" class="chip chip-reset" id="actsResetAllFilters">Reset</button>`;

		chipsWrap.querySelectorAll('.active-chip').forEach(chip => {
			chip.addEventListener('click', () => {
				if (chip.dataset.local) {
					onlyLocal = false;
					document.getElementById('actsLocalFilter').checked = false;
				} else {
					selectedGenres.delete(chip.dataset.value);
				}
				refreshFilterUI();
			});
		});

		document.getElementById('actsResetAllFilters').addEventListener('click', () => {
			selectedGenres.clear();
			onlyLocal = false;
			document.getElementById('actsLocalFilter').checked = false;
			refreshFilterUI();
		});
	}

	// --- Modal -----------------------------------------------------------------

	const modal = document.getElementById('actModal');
	const modalTitle = document.getElementById('actModalTitle');
	const modalGenres = document.getElementById('actModalGenres');
	const modalLinks = document.getElementById('actModalLinks');
	const modalEventsSection = document.getElementById('actModalEventsSection');
	const modalEventsList = document.getElementById('actModalEvents');
	const modalMediaSection = document.getElementById('actModalMediaSection');
	const modalMediaGrid = document.getElementById('actModalMedia');

	let eventsData = null;
	let venueLookup = {};

	function linksHtml(links) {
		if (!links || links.length === 0) return '';
		return links.map(link => `
			<a class="actLink" href="${link.value}" target="_blank" rel="noopener">${link.label}</a>
		`).join('<span class="actLinkSep"> · </span>');
	}

	function eventItemHtml(event) {
		const venue = eventsData?.venues?.[event.venueId];
		const venueName = venue?.name || '';
		const venueHtml = venueName
			? `<a href="/venues/${event.venueId}/">${venueName}</a>`
			: '';
		const timeDisplay = formatTime(event.time);
		const titleLink = event.eventUrl || venue?.eventsUrl || null;
		const titleHtml = titleLink
			? `<a href="${titleLink}" target="_blank" rel="noopener">${event.title}</a>`
			: event.title;

		return `
			<li class="actModalEvent">
				<span class="actModalEventTitle">${titleHtml} :</span>
				<span class="actModalEventDate">${formatEventDate(event.date)}${timeDisplay ? ' · ' + timeDisplay : ''}</span>
				<span class="actModalEventVenue">${venueHtml}</span>
			</li>`;
	}

	function mediaThumbHtml(item) {
		const venueName = window.BoardMedia?.resolveVenueName(item.venueId, venueLookup) || '';
		return `
			<a class="actModalMediaThumb" href="/board/#top" title="${item.title}${venueName ? ' — ' + venueName : ''}">
				<img src="/board/${item.thumbnail}" alt="${item.title}" loading="lazy">
				${item.type === 'video' ? '<span class="actModalMediaPlay"></span>' : ''}
			</a>`;
	}

	async function openActModal(act) {
		if (!act) return;

		modalTitle.textContent = act.name;
		modalGenres.innerHTML = genreChipsHtml(act.genres);
		modalLinks.innerHTML = linksHtml(act.links);

		// Both modal sections are always shown now (not just when they have
		// content) — an empty-state message fills in instead of hiding the
		// section, so the modal's shape stays consistent act to act.
		const upcoming = upcomingEventsForAct(act, eventsData);
		modalEventsList.innerHTML = upcoming.length > 0
			? upcoming.map(eventItemHtml).join('')
			: '<li class="actModalEmptyMsg">No upcoming shows.</li>';
		modalEventsSection.hidden = false;

		// Media loads async — show the section with a loading message first,
		// then fill it in once it resolves rather than delaying the whole
		// modal on it.
		modalMediaSection.hidden = false;
		modalMediaGrid.innerHTML = '<p class="actModalEmptyMsg">Loading media…</p>';

		modal.hidden = false;
		document.body.classList.add('boardModalOpen');

		const mediaItems = await mediaPreviewForAct(act);
		modalMediaGrid.innerHTML = mediaItems.length > 0
			? mediaItems.map(mediaThumbHtml).join('')
			: '<p class="actModalEmptyMsg">No media yet.</p>';
	}

	function closeActModal() {
		modal.hidden = true;
		document.body.classList.remove('boardModalOpen');
	}

	modal.addEventListener('click', (e) => {
		if (e.target.closest('[data-actclose]')) closeActModal();
	});

	document.addEventListener('keydown', (e) => {
		if (!modal.hidden && e.key === 'Escape') closeActModal();
	});

	// --- Init --------------------------------------------------------------

	async function loadActs() {
		const loadingMsg = document.getElementById('actsLoading');
		const emptyMsg = document.getElementById('actsEmpty');

		try {
			const [actsRes, eventsRes, genresRes] = await Promise.all([
				fetch(ACTS_URL, { cache: 'no-store' }),
				fetch(EVENTS_URL, { cache: 'no-store' }),
				fetch(GENRES_URL, { cache: 'no-store' }),
			]);

			const actsData = await actsRes.json();
			eventsData = await eventsRes.json();
			try {
				genreMeta = await genresRes.json();
			} catch (e) {
				genreMeta = {};
			}

			if (window.BoardMedia) {
				venueLookup = await window.BoardMedia.fetchVenueLookup();
			}

			allActsBySlug = {};
			allActSlugsSorted = Object.entries(actsData)
				.filter(([, act]) => String(act.exclude).toLowerCase() !== 'yes')
				.sort(([, a], [, b]) => sortableName(a.name).localeCompare(sortableName(b.name)))
				.map(([slug, act]) => {
					allActsBySlug[slug] = act;
					return slug;
				});

			loadingMsg.hidden = true;

			if (allActSlugsSorted.length === 0) {
				emptyMsg.hidden = false;
				return;
			}

			loadFiltersFromStorage();
			document.getElementById('actsLocalFilter').checked = onlyLocal;
			buildActsFilterChips();
			renderActiveFilters();
			applyFilters();
		} catch (err) {
			console.error('acts.js: failed to load acts', err);
			loadingMsg.textContent = "Couldn't load the acts list — try refreshing.";
		}
	}

	// --- Search + filter toggle wiring --------------------------------------

	document.addEventListener('DOMContentLoaded', function () {
		const searchInput = document.getElementById('actsSearch');
		const searchWrapper = document.getElementById('actsSearchWrapper');

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

		document.getElementById('actsSearchGo').addEventListener('click', () => applyFilters());
		document.getElementById('actsSearchReset').addEventListener('click', resetSearch);

		document.getElementById('actsFilterToggle').addEventListener('click', function () {
			const panel = document.getElementById('actsFilters');
			const isOpen = panel.style.display !== 'none';
			panel.style.display = isOpen ? 'none' : 'flex';
			this.classList.toggle('active', !isOpen);
			if (!isOpen) buildActsFilterChips(); // re-measure now that the panel has real layout
		});

		document.getElementById('actsLocalFilter').addEventListener('change', function () {
			onlyLocal = this.checked;
			refreshFilterUI();
		});

		// The site-wide smooth-scroll handler in <head> binds directly to
		// `$("a")` at DOMContentLoaded — it only catches links that already
		// exist in the DOM at that moment. The jump nav chips and each
		// group's "Back to Top" link are injected later by applyFilters(),
		// so they'd otherwise fall back to an instant native anchor jump.
		// This delegates the exact same animation from a static ancestor
		// (#actsContent/#actsSpace, both present at load time) so it still
		// catches those links no matter when they're added or re-rendered.
		$('#actsContent, #actsSpace').on('click', '#actsJumpNav a, .actsBackToTop a', function (event) {
			event.preventDefault();
			const hash = this.hash;
			$('html, body').animate({
				scrollTop: $(hash).offset().top
			}, 650, function () {
				window.location.hash = hash;
			});
		});

		loadActs();
	});
})();
