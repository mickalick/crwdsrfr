/*
 * js/lineup.js — the Lineup page (/lineup/).
 *
 *   Ripples           show/hide list: updates about your posts and comments (my_ripples).
 *                     Clear, mute (with Undo), Clear All; opening one clears it.
 *   Hyped & Upcoming  show/hide list: shows you've hyped that haven't happened yet, soonest first,
 *                     with the same hype + comment buttons as the calendar.
 *   Waves             what's new with the acts, venues and SRFRs (members) you've hyped in the
 *                     last WAVE_DAYS days: newly added shows, Board posts tagged with them, your
 *                     SRFRs' posts, and the acts/venues they hyped. Search (act, venue, username) +
 *                     Acts / Venues / SRFRs checkboxes (saved in this browser; the search isn't).
 *
 * Only undismissed ripples count as "new" (the dot on Lineup in the header menu).
 *
 * Needs crwd-core.js + crwd-ui.js (+ crwd-social.js for the hype/comment buttons).
 * Styles: /css/lineup.css. User text is inserted with textContent, never innerHTML.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const ui = window.CrwdUI;

	const $ = function (id) { return document.getElementById(id); };
	const els = {
		state: $('lineupState'), stateText: $('lineupStateText'), stateActions: $('lineupStateActions'),
		sections: $('lineupSections'), ripples: $('lineupRipples'), upcoming: $('lineupUpcoming'), waves: $('lineupWaves')
	};

	const PREVIEW = 5;     // ripples / upcoming shows before "Show All"
	const WAVE_PAGE = 10;  // waves per "Load More"
	const WAVE_DAYS = 60;  // how far back Waves look

	let builtFor = null;

	// ------------------------------------------------------------------
	// Small helpers
	// ------------------------------------------------------------------

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function at(username) { return '@' + username; }

	function ago(iso) {
		const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		const unit = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's') + ' ago'; };
		if (secs < 60) return 'Just now';
		const mins = Math.floor(secs / 60);
		if (mins < 60) return unit(mins, 'min');
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return unit(hrs, 'hr');
		const days = Math.floor(hrs / 24);
		if (days < 7) return unit(days, 'day');
		if (days < 35) return unit(Math.floor(days / 7), 'wk');
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	function timeEl(iso, className) {
		const t = el('time', className || null);
		t.dateTime = iso;
		t.textContent = ago(iso);
		t.title = new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
		return t;
	}

	// YYYY-MM-DD in local time — never through Date/UTC for show dates
	function todayStr() {
		const d = new Date();
		return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
	}

	function showDate(dateStr) {
		const parts = String(dateStr || '').split('-').map(Number);
		if (parts.length !== 3 || !parts[1]) return null;
		const d = new Date(parts[0], parts[1] - 1, parts[2]);
		return {
			month: d.toLocaleDateString('en-US', { month: 'short' }),
			day: parts[2],
			label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
		};
	}

	// "a", "a and b", "a, b and c"
	function listJoin(items) {
		if (items.length <= 1) return items.join('');
		return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
	}

	// A line of text with some bold parts and links:
	//   'plain'  |  { b: 'bold' }  |  { b: 'bold', href }  (a bold link)  |  { user: 'username' } (blue @username → profile)
	function richLine(className, parts) {
		const p = el('span', className);
		parts.forEach(function (part) {
			if (part == null) return;
			if (typeof part === 'string') { p.append(part); return; }
			if (part.user) {
				const a = el('a', 'lnUser', at(part.user));
				a.href = core.profileUrl(part.user);
				p.appendChild(a);
				return;
			}
			if (part.href) {
				const a = el('a', 'lnItemLink');
				a.href = part.href;
				a.appendChild(el('strong', null, part.b));
				p.appendChild(a);
				return;
			}
			p.appendChild(el('strong', null, part.b));
		});
		return p;
	}

	// "the-linda-lindas" → "The Linda Lindas", for an act/venue missing from the data files
	function fromSlug(id) {
		return String(id || '').split('-').filter(Boolean).map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
	}

	function showState(text, actions) {
		els.sections.hidden = true;
		els.state.hidden = false;
		els.stateText.textContent = text;
		els.stateActions.replaceChildren();
		(actions || []).forEach(function (a) {
			const b = el(a.href ? 'a' : 'button', 'lineupButton', a.label);
			if (a.href) b.href = a.href; else { b.type = 'button'; b.addEventListener('click', a.onClick); }
			els.stateActions.appendChild(b);
		});
	}

	function linkButton(label, extraClass) {
		const b = el('button', 'lineupLinkButton' + (extraClass ? ' ' + extraClass : ''), label);
		b.type = 'button';
		return b;
	}

	function refreshHeaderDot() {
		if (ui && typeof ui.refreshUnread === 'function') ui.refreshUnread();
	}

	// ---------- shared data (loaded once per page) ----------
	const jsonCache = {};
	function loadJson(name) {
		if (!jsonCache[name]) {
			jsonCache[name] = fetch('/data/' + name + '.json', { cache: 'no-store' })
				.then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
				.catch(function (e) { console.warn('[lineup] could not load ' + name + '.json', e); return null; });
		}
		return jsonCache[name];
	}

	async function catalog() {
		const [events, acts] = await Promise.all([loadJson('events'), loadJson('acts')]);
		const actList = !acts ? [] : Array.isArray(acts) ? acts : Object.keys(acts).map(function (k) { return Object.assign({ id: k }, acts[k]); });
		const actsById = {};
		actList.forEach(function (a) { actsById[a.id || a.slug] = a; });
		const eventList = (events && events.events) || [];
		const eventsById = {};
		eventList.forEach(function (e) { eventsById[e.id] = e; });
		return { events: eventList, eventsById: eventsById, venues: (events && events.venues) || {}, actsById: actsById };
	}

	// Same rule as the Acts page: a performer named exactly like the act (or an alias),
	// or the act's name as a whole word in the show title (short names: exact only)
	function actNeedles(act) {
		return [act.name].concat(act.aliases || []).map(function (s) { return String(s || '').trim().toLowerCase(); }).filter(Boolean);
	}
	function actPlaysEvent(needles, event) {
		const performers = (event.performers || []).map(function (p) { return String(p.name || '').trim().toLowerCase(); });
		return needles.some(function (n) {
			if (performers.indexOf(n) !== -1) return true;
			if (n.length <= 3) return String(event.title || '').trim().toLowerCase() === n;
			return new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(event.title || '');
		});
	}

	function postUrl(post, authorUsername) {
		return post.destination === 'board'
			? '/board/#' + encodeURIComponent(post.id)
			: core.profileUrl(authorUsername) + '#post-' + encodeURIComponent(post.id);
	}
	function showUrl(eventId) { return '/?show=' + encodeURIComponent(eventId); }
	function actUrl(id) { return '/acts/#' + encodeURIComponent(id); }
	function venueUrl(id) { return '/venues/' + encodeURIComponent(id) + '/'; }

	// ------------------------------------------------------------------
	// Show/hide section (same behavior as Messages: closed when empty)
	// ------------------------------------------------------------------

	// Heading icon (artwork set in lineup.css: .lnHeadIcon[data-icon=…])
	function headIcon(name) {
		const i = el('span', 'icon lnHeadIcon');
		i.dataset.icon = name;
		i.setAttribute('aria-hidden', 'true');
		return i;
	}

	function accordion(mount, key, title, icon, hint) {
		mount.replaceChildren();
		const toggle = el('button', 'lnSectionToggle');
		toggle.type = 'button';
		toggle.id = 'lnToggle-' + key;
		toggle.setAttribute('aria-expanded', 'false');
		toggle.setAttribute('aria-controls', 'lnSection-' + key);
		const label = el('span', 'lnSectionTitle', title);
		toggle.append(headIcon(icon), label, el('span', 'lnChevron'));
		const body = el('div', 'lnSectionBody');
		body.id = 'lnSection-' + key;
		body.hidden = true;
		if (hint) {
			// First thing in the show/hide area, so it's hidden when the section is closed
			const note = el('p', 'lnNote lnSectionHint', hint);
			note.id = 'lnHint-' + key;
			body.appendChild(note);
		}
		mount.append(toggle, body);
		toggle.addEventListener('click', function () { api.setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
		const api = {
			toggle: toggle, body: body,
			setCount: function (n) { label.textContent = title + (n == null ? '' : ' (' + n + ')'); },
			setOpen: function (open) { toggle.setAttribute('aria-expanded', open ? 'true' : 'false'); body.hidden = !open; }
		};
		return api;
	}

	// First PREVIEW items, then a Show All / Show Less link. draw() redraws with the current list.
	function collapsible(list, items, render, moreBtn) {
		let expanded = false;
		function draw() {
			list.replaceChildren();
			const shown = expanded ? items() : items().slice(0, PREVIEW);
			shown.forEach(function (x) { list.appendChild(render(x)); });
			const extra = items().length - PREVIEW;
			moreBtn.hidden = extra <= 0;
			moreBtn.textContent = expanded ? 'Show Less' : 'Show All (' + items().length + ')';
			moreBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
		}
		moreBtn.addEventListener('click', function () {
			expanded = !expanded;
			draw();
			if (expanded) {
				const first = list.children[PREVIEW];
				const target = first && first.querySelector('a');
				if (target) target.focus();
			} else moreBtn.focus();
		});
		return { draw: draw, get expanded() { return expanded; } };
	}

	// ------------------------------------------------------------------
	// Ripples
	// ------------------------------------------------------------------

	const MUTE_LABEL = {
		post_hype: 'Mute hype ripples for this post',
		post_comment: 'Mute comment ripples for this post',
		commented_post: 'Mute new comment ripples for this post',
		event_comment: 'Mute comment ripples for this show'
	};

	async function renderRipples(cat) {
		const sec = accordion(els.ripples, 'ripples', 'Ripples', 'ripple', 'Updates from your posts and activity.');
		const { data, error } = await core.sb.from('my_ripples').select('*').order('updated_at', { ascending: false });
		if (error) {
			console.error('[lineup]', error);
			sec.body.appendChild(el('p', 'lnNote', 'Your ripples couldn\'t load right now.'));
			sec.setOpen(true);
			return;
		}
		let ripples = data || [];

		const top = el('div', 'lnRippleTop');
		const dismissAll = linkButton('', 'isDanger lnClearAll');
		const clearAllIcon = el('span', 'icon lnClearAllIcon');
		clearAllIcon.setAttribute('aria-hidden', 'true');
		dismissAll.append(clearAllIcon, el('span', '', 'Clear All'));
		top.appendChild(dismissAll);
		const list = el('ul', 'lnCards');
		const more = linkButton('Show All', 'lnShowMore');
		const status = el('p', 'lnNote lnStatus');
		status.setAttribute('role', 'status');
		sec.body.append(top, list, more, status);

		const view = collapsible(list, function () { return ripples; }, rippleCard, more);
		function redraw() {
			sec.setCount(ripples.length);
			top.hidden = !ripples.length;
			view.draw();
			if (!ripples.length) list.appendChild(el('li', 'lnEmpty', 'You\'re all caught up.'));
		}

		function remove(r) {
			ripples = ripples.filter(function (x) { return x.id !== r.id; });
			redraw();
			refreshHeaderDot();
		}

		async function dismiss(r) {
			const { error: e } = await core.sb.from('ripples').delete().eq('id', r.id);
			if (e) { status.textContent = 'That couldn\'t be cleared. Please try again.'; return false; }
			return true;
		}

		dismissAll.addEventListener('click', async function () {
			dismissAll.disabled = true;
			const { error: e } = await core.sb.from('ripples').delete().eq('user_id', core.user.id);
			dismissAll.disabled = false;
			if (e) { status.textContent = 'Your ripples couldn\'t be cleared. Please try again.'; return; }
			ripples = [];
			redraw();
			sec.toggle.focus();
			refreshHeaderDot();
		});

		// Dot | icon + line (usernames link to profiles) + the post/show title (links to it) + time | Clear, Mute
		function rippleCard(r) {
			const li = el('li', 'lnCard lnRipple');
			const what = describeRipple(r, cat);
			li.appendChild(el('span', 'lnDot')); // new (every ripple here is uncleared)
			const main = el('div', 'lnRippleMain');
			main.appendChild(el('span', 'icon lnRippleIcon ' + (r.kind === 'post_hype' ? 'iconHype' : 'iconComment')));
			const text = el('div', 'lnCardText');
			text.appendChild(what.line);
			const link = el('a', 'lnCardTitle lnRefTitle lnRippleLink', what.title);
			link.href = what.href;
			text.append(link, timeEl(r.updated_at, 'lnCardMeta'));
			main.appendChild(text);
			li.appendChild(main);

			// Opening it clears it (new-tab clicks clear in the background)
			link.addEventListener('click', async function (e) {
				if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) { dismiss(r).then(function (ok) { if (ok) remove(r); }); return; }
				e.preventDefault();
				await Promise.race([dismiss(r), new Promise(function (res) { setTimeout(res, 1500); })]);
				window.location.href = what.href;
			});

			// Clicking anywhere else on the card (not a username, button, or selected text) opens the post too
			li.addEventListener('click', function (e) {
				if (e.target.closest('a, button')) return;
				const sel = window.getSelection();
				if (sel && !sel.isCollapsed && li.contains(sel.anchorNode)) return;
				link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey }));
			});

			// Clear + Mute buttons (round, like the hype and comment buttons)
			const actions = el('div', 'lnActions');
			const dismissBtn = actionButton('clear', 'Clear');
			dismissBtn.classList.add('isClear');
			const muteBtn = actionButton('mute', MUTE_LABEL[r.kind]);
			dismissBtn.addEventListener('click', async function () {
				dismissBtn.disabled = true;
				if (await dismiss(r)) { status.textContent = 'Ripple cleared.'; remove(r); focusAfter(); }
				else dismissBtn.disabled = false;
			});
			muteBtn.classList.add('isClear');
			muteBtn.addEventListener('click', function () { mute(r, li); });
			actions.append(muteBtn, dismissBtn); // Clear on the far right
			li.appendChild(actions);
			return li;
		}

		function actionButton(icon, label) {
			const b = el('button', 'lnAction');
			b.type = 'button';
			b.setAttribute('aria-label', label);
			b.title = label;
			const i = el('span', 'icon lnActionIcon');
			i.dataset.icon = icon;
			i.setAttribute('aria-hidden', 'true');
			b.appendChild(i);
			return b;
		}

		function focusAfter() {
			const target = list.querySelector('.lnRippleLink') || sec.toggle;
			target.focus();
		}

		// Mute: hide it (the view leaves muted ones out) and offer Undo right there
		async function mute(r, li) {
			const target = r.post_id || r.event_id;
			const { error: e } = await core.sb.from('ripple_mutes').insert({ kind: r.kind, target: target });
			if (e && e.code !== '23505') { status.textContent = core.friendlyError(e).message; return; }
			const note = el('li', 'lnMuted');
			note.append('Muted. ');
			const undo = linkButton('Undo');
			note.appendChild(undo);
			li.replaceWith(note);
			undo.focus();
			ripples = ripples.filter(function (x) { return x.id !== r.id; });
			sec.setCount(ripples.length);
			refreshHeaderDot();
			undo.addEventListener('click', async function () {
				undo.disabled = true;
				const { error: e2 } = await core.sb.from('ripple_mutes').delete().eq('kind', r.kind).eq('target', target);
				if (e2) { undo.disabled = false; status.textContent = 'That couldn\'t be undone. Please try again.'; return; }
				ripples = ripples.concat([r]).sort(function (a, b) { return a.updated_at < b.updated_at ? 1 : -1; });
				redraw();
				status.textContent = 'Unmuted.';
				const back = list.querySelector('.lnRippleLink');
				if (back) back.focus();
				refreshHeaderDot();
			});
		}

		redraw();
		sec.setOpen(ripples.length > 0);
	}

	// "@a and @b hyped your post" + the post's title + where it links
	function describeRipple(r, cat) {
		const names = r.actor_usernames || [];
		const others = Math.max(0, r.actor_count - names.length);
		const who = function () {
			if (!names.length) return [{ b: r.actor_count === 1 ? 'Someone' : r.actor_count + ' people' }];
			const parts = names.map(function (n) { return { user: n }; }); // blue, links to their profile
			const out = [];
			parts.forEach(function (p, i) {
				if (i > 0) out.push(i === parts.length - 1 && !others ? ' and ' : ', ');
				out.push(p);
			});
			if (r.kind === 'post_hype' && others) out.push(' and ' + others + ' other' + (others === 1 ? '' : 's'));
			return out;
		};
		const n = r.actor_count;
		let line;
		if (r.kind === 'post_hype') line = who().concat([' hyped your post']);
		else if (r.kind === 'post_comment') line = who().concat([' commented on your post' + (n > 1 ? ' (' + n + ' new comments)' : '')]);
		else if (r.kind === 'commented_post') line = who().concat([' commented on a post you commented on' + (n > 1 ? ' (' + n + ' new)' : '')]);
		else line = who().concat([' commented on a show you commented on' + (n > 1 ? ' (' + n + ' new)' : '')]);

		if (r.event_id) {
			const ev = cat.eventsById[r.event_id];
			return { line: richLine('lnCardLine', line), title: ev ? ev.title : 'A show that\'s no longer listed', href: showUrl(r.event_id) };
		}
		return {
			line: richLine('lnCardLine', line),
			title: r.post_title || 'A post',
			href: postUrl({ id: r.post_id, destination: r.post_destination }, r.post_author_username)
		};
	}

	// ------------------------------------------------------------------
	// Hyped & Upcoming
	// ------------------------------------------------------------------

	async function renderUpcoming(cat) {
		const sec = accordion(els.upcoming, 'upcoming', 'Hyped & Upcoming', 'hype', 'All of your hyped shows coming up.');
		const { data, error } = await core.sb.from('item_hypes').select('item_id').eq('kind', 'event');
		if (error) {
			console.error('[lineup]', error);
			sec.body.appendChild(el('p', 'lnNote', 'Your hyped shows couldn\'t load right now.'));
			sec.setOpen(true);
			return;
		}
		const today = todayStr();
		const shows = (data || []).map(function (h) { return cat.eventsById[h.item_id]; })
			.filter(function (e) { return e && e.date >= today; })
			.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.time || '') < String(b.time || '') ? -1 : 1; });

		// Hype + comment counts, like the calendar (if crwd-social.js is on the page)
		let stats = {};
		if (window.CrwdSocial && shows.length) {
			try { stats = await window.CrwdSocial.loadStats('event', shows.map(function (e) { return e.id; })); } catch (e) { stats = {}; }
		}

		const list = el('ul', 'lnCards lnShows');
		const more = linkButton('Show All', 'lnShowMore');
		sec.body.append(list, more);
		const view = collapsible(list, function () { return shows; }, function (e) {
			const li = el('li', 'lnShow');
			const link = el('a', 'lnShowLink');
			link.href = showUrl(e.id);
			const d = showDate(e.date);
			if (d) {
				const badge = el('span', 'lnShowDate');
				badge.append(el('span', 'lnShowMonth', d.month), el('span', 'lnShowDay', String(d.day)));
				link.appendChild(badge);
			}
			const text = el('span', 'lnCardText');
			text.appendChild(el('span', 'lnCardTitle', e.title));
			const venue = cat.venues[e.venueId];
			text.appendChild(el('span', 'lnCardMeta', [venue && venue.name, d && d.label].filter(Boolean).join(' · ')));
			link.appendChild(text);
			li.appendChild(link);
			if (window.CrwdSocial) {
				const s = stats[e.id] || {};
				const actions = window.CrwdSocial.reactions({ type: 'event', id: e.id, hypes: s.hypes || 0, comments: s.comments || 0, hyped: s.hyped !== false, title: e.title });
				actions.classList.add('lnShowActions');
				li.appendChild(actions);
			}
			return li;
		}, more);
		sec.setCount(shows.length);
		view.draw();
		if (!shows.length) list.appendChild(el('li', 'lnEmpty', 'No upcoming shows hyped yet. Hype shows on the calendar to see them here.'));
		sec.setOpen(shows.length > 0);
	}

	// ------------------------------------------------------------------
	// Waves
	// ------------------------------------------------------------------

	// Each wave: { key, time, cats: { act?, venue?, srfr? } (the line for each), href, post?, terms }
	// terms: the act names, venue names and usernames the Waves search looks through
	async function collectWaves(cat) {
		const me = core.user.id;
		const since = new Date(Date.now() - WAVE_DAYS * 86400000).toISOString();
		const today = todayStr();

		const [mine, follows, followed] = await Promise.all([
			core.sb.from('item_hypes').select('kind, item_id').in('kind', ['act', 'venue']),
			core.sb.from('follows').select('followee_id').eq('follower_id', me),
			core.sb.rpc('followed_hypes', { since: since })
		]);
		if (mine.error || follows.error || followed.error) throw (mine.error || follows.error || followed.error);

		const hypedActs = (mine.data || []).filter(function (h) { return h.kind === 'act'; }).map(function (h) { return h.item_id; });
		const hypedVenues = (mine.data || []).filter(function (h) { return h.kind === 'venue'; }).map(function (h) { return h.item_id; });
		const srfrIds = (follows.data || []).map(function (f) { return f.followee_id; });
		const actName = function (id) { const a = cat.actsById[id]; return a && a.name ? a.name : fromSlug(id); };
		const venueName = function (id) { const v = cat.venues[id]; return v && v.name ? v.name : fromSlug(id); };

		const waves = {};
		function wave(key, time, extra) {
			if (!waves[key]) waves[key] = Object.assign({ key: key, time: time, cats: {}, terms: [] }, extra || {});
			return waves[key];
		}

		// 1. Newly added shows (events.json addedAt) by hyped acts / at hyped venues, not yet happened
		const actNeedleList = hypedActs.map(function (id) { const a = cat.actsById[id]; return a ? { id: id, needles: actNeedles(a) } : null; }).filter(Boolean);
		cat.events.forEach(function (e) {
			if (!e.addedAt || e.addedAt < since || e.date < today) return;
			const venue = venueName(e.venueId);
			const d = showDate(e.date);
			const when = d ? d.label : e.date;
			const act = actNeedleList.find(function (a) { return actPlaysEvent(a.needles, e); });
			const atVenue = hypedVenues.indexOf(e.venueId) !== -1;
			if (!act && !atVenue) return;
			const w = wave('show:' + e.id, e.addedAt, { href: showUrl(e.id), show: { title: e.title, meta: [venue, when].join(' · ') } });
			// (the show's title, venue and date are in the box under this line)
			if (act) w.cats.act = ['New show added for ', { b: actName(act.id), href: actUrl(act.id) }];
			if (atVenue) w.cats.venue = ['New show added at ', { b: venue, href: venueUrl(e.venueId) }];
			// Searchable: the venue, the hyped act, and everyone on the bill
			w.terms.push(venue);
			if (act) w.terms.push(actName(act.id));
			(e.performers || []).forEach(function (p) { if (p && p.name) w.terms.push(p.name); });
		});

		// 2. Posts: Board posts tagged with your acts/venues, and your SRFRs' posts
		const COLS = 'id, author_id, destination, title, opener, media, hero, act_ids, venue_id, created_at';
		const queries = [];
		if (hypedActs.length) queries.push(core.sb.from('posts').select(COLS).eq('destination', 'board').eq('status', 'approved').gte('created_at', since).overlaps('act_ids', hypedActs).limit(200));
		if (hypedVenues.length) queries.push(core.sb.from('posts').select(COLS).eq('destination', 'board').eq('status', 'approved').gte('created_at', since).in('venue_id', hypedVenues).limit(200));
		if (srfrIds.length) queries.push(core.sb.from('posts').select(COLS).eq('status', 'approved').gte('created_at', since).in('author_id', srfrIds).limit(200));
		const results = await Promise.all(queries);
		const posts = {};
		results.forEach(function (r) {
			if (r.error) throw r.error;
			(r.data || []).forEach(function (p) { if (p.author_id !== me) posts[p.id] = p; });
		});

		// Usernames (and Max badges) for post authors + SRFRs
		const peopleIds = Array.from(new Set(Object.keys(posts).map(function (id) { return posts[id].author_id; }).concat(srfrIds)));
		const people = {};
		if (peopleIds.length) {
			const { data } = await core.sb.from('public_profiles').select('id, username, max_badge').in('id', peopleIds);
			(data || []).forEach(function (p) { people[p.id] = p; });
		}

		Object.keys(posts).forEach(function (id) {
			const p = posts[id];
			const author = people[p.author_id];
			if (!author) return;
			const w = wave('post:' + p.id, p.created_at, { href: postUrl(p, author.username), post: p, author: author });
			const taggedActs = (p.act_ids || []).filter(function (a) { return hypedActs.indexOf(a) !== -1; });
			if (p.destination === 'board' && taggedActs.length) {
				w.cats.act = ['New Board post tagged '];
				taggedActs.forEach(function (a, i) {
					if (i) w.cats.act.push(i === taggedActs.length - 1 ? ' and ' : ', ');
					w.cats.act.push({ b: actName(a), href: actUrl(a) });
				});
			}
			if (p.destination === 'board' && hypedVenues.indexOf(p.venue_id) !== -1) w.cats.venue = ['New Board post at ', { b: venueName(p.venue_id), href: venueUrl(p.venue_id) }];
			if (srfrIds.indexOf(p.author_id) !== -1) w.cats.srfr = [{ user: author.username }, p.destination === 'board' ? ' posted to the Board' : ' posted on their profile'];
			// Searchable: the author ("by @…" on the preview), tagged acts, and the venue
			w.terms.push(author.username);
			(p.act_ids || []).forEach(function (a) { w.terms.push(actName(a)); });
			if (p.venue_id) w.terms.push(venueName(p.venue_id));
		});

		// 3. What your SRFRs hyped — grouped per person, per kind, per day
		(followed.data || []).forEach(function (h) {
			const day = new Date(h.created_at).toDateString();
			const w = wave('hype:' + h.user_id + ':' + h.kind + ':' + day, h.created_at, { hypes: [], kind: h.kind, username: h.username });
			w.hypes.push(h.item_id);
			if (!w.terms.length) w.terms.push(h.username);
			w.terms.push(h.kind === 'act' ? actName(h.item_id) : venueName(h.item_id));
			const items = w.hypes.map(function (id) {
				return h.kind === 'act' ? { b: actName(id), href: actUrl(id) } : { b: venueName(id), href: venueUrl(id) };
			});
			const noun = h.kind === 'act' ? (items.length === 1 ? 'act' : 'acts') : (items.length === 1 ? 'venue' : 'venues');
			const line = [{ user: h.username }, items.length === 1 ? ' hyped ' : ' hyped ' + items.length + ' ' + noun + ': '];
			items.forEach(function (it, i) {
				if (i) line.push(i === items.length - 1 ? ' and ' : ', ');
				line.push(it);
			});
			w.cats.srfr = line;
			if (h.created_at > w.time) w.time = h.created_at;
		});

		return Object.keys(waves).map(function (k) {
			const w = waves[k];
			w.search = w.terms.join('\n').toLowerCase(); // one string to look through
			return w;
		})
			.sort(function (a, b) { return a.time < b.time ? 1 : a.time > b.time ? -1 : 0; });
	}

	// Waves filter: one checkbox per kind of wave. Saved in this browser, like the calendar's filters.
	const FILTERS = [['act', 'Acts', 'acts'], ['venue', 'Venues', 'venues'], ['srfr', 'SRFRs', 'SRFRs']];
	const WAVE_FILTER_KEY = 'crwdsrfr_lineup_wave_filters';
	const ALL_KINDS = FILTERS.map(function (f) { return f[0]; });

	function loadWaveFilters() {
		try {
			const parsed = JSON.parse(localStorage.getItem(WAVE_FILTER_KEY));
			if (parsed && Array.isArray(parsed.kinds)) {
				return new Set(parsed.kinds.filter(function (k) { return ALL_KINDS.indexOf(k) !== -1; }));
			}
		} catch (e) {
			// Nothing saved, or localStorage unavailable: everything's checked
		}
		return new Set(ALL_KINDS);
	}

	function saveWaveFilters(kinds) {
		try {
			localStorage.setItem(WAVE_FILTER_KEY, JSON.stringify({ kinds: ALL_KINDS.filter(function (k) { return kinds.has(k); }) }));
		} catch (e) {
			// localStorage unavailable: the filters simply won't persist this session
		}
	}

	// "Nothing new from the acts and venues you've hyped…" for whichever boxes are checked
	function emptyText(kinds, query) {
		const names = FILTERS.filter(function (f) { return kinds.has(f[0]); }).map(function (f) { return f[2]; });
		if (!names.length) return 'Check Acts, Venues or SRFRs to see your waves.';
		if (query) return 'No waves match "' + query + '".';
		const list = names.length === 1 ? names[0]
			: names.slice(0, -1).join(', ') + (names.length > 2 ? ',' : '') + ' and ' + names[names.length - 1];
		return 'Nothing new from the ' + list + ' you\'ve hyped in the last ' + WAVE_DAYS + ' days.';
	}

	async function renderWaves(cat) {
		const mount = els.waves;
		mount.replaceChildren();
		const wavesHead = el('h2', 'lnWavesTitle');
		wavesHead.id = 'lnWavesTop';
		wavesHead.tabIndex = -1; // so the end-of-feed icon can move focus back up here
		wavesHead.append(headIcon('waves'), 'Waves');
		mount.appendChild(wavesHead);
		mount.appendChild(el('p', 'lnNote', 'The latest from your hyped Acts, Venues and SRFRs. Displays up to ' + WAVE_DAYS + ' days of activity.'));
		// Search: act names, venue names and usernames (resets each visit, like the Board's)
		const search = el('div', 'lnSearch');
		const searchInput = el('input', 'lnSearchInput');
		searchInput.type = 'text';
		searchInput.id = 'lnWaveSearch';
		searchInput.placeholder = 'Search by act, venue, or SRFR';
		searchInput.setAttribute('aria-label', 'Search waves by act, venue, or SRFR');
		searchInput.autocomplete = 'off';
		const searchIcon = el('span', 'icon lnSearchIcon');
		searchIcon.setAttribute('aria-hidden', 'true');
		const searchClear = el('button', 'lnSearchClear');
		searchClear.type = 'button';
		searchClear.setAttribute('aria-label', 'Clear search');
		const clearIcon = el('span', 'icon lnSearchClearIcon');
		clearIcon.setAttribute('aria-hidden', 'true');
		searchClear.appendChild(clearIcon);
		search.append(searchInput, searchIcon, searchClear);
		const filterBar = el('div', 'lnFilter');
		filterBar.setAttribute('role', 'group');
		filterBar.setAttribute('aria-label', 'Show waves from');
		const list = el('ul', 'lnWaves');
		list.setAttribute('aria-live', 'polite');
		list.setAttribute('aria-busy', 'true');
		const more = el('button', 'lineupButton lnLoadMore', 'Load More');
		more.type = 'button';
		more.hidden = true;
		mount.append(search, filterBar, list, more);
		list.appendChild(el('li', 'lnEmpty', 'Loading waves…'));

		const kinds = loadWaveFilters();
		let query = '';
		let shown = WAVE_PAGE;
		let all = [];
		FILTERS.forEach(function (f) {
			const row = el('label', 'lnFilterCheck');
			const box = el('input');
			box.type = 'checkbox';
			box.value = f[0];
			box.checked = kinds.has(f[0]);
			box.addEventListener('change', function () {
				if (box.checked) kinds.add(f[0]); else kinds.delete(f[0]);
				saveWaveFilters(kinds);
				shown = WAVE_PAGE;
				draw();
			});
			row.append(box, el('span', '', f[1]));
			filterBar.appendChild(row);
		});

		function setQuery(value) {
			query = value.trim();
			search.classList.toggle('hasValue', query !== '');
			shown = WAVE_PAGE;
			draw();
		}
		searchInput.addEventListener('input', function () { setQuery(searchInput.value); });
		searchInput.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); searchInput.value = ''; setQuery(''); }
		});
		searchClear.addEventListener('click', function () {
			searchInput.value = '';
			setQuery('');
			searchInput.focus();
		});

		// A wave can be about more than one kind (an SRFR's post tagging a hyped act): it shows if any of them is checked.
		// The search matches any of its act names, venue names or usernames ("@" optional).
		function matching() {
			const q = query.toLowerCase().replace(/^@/, '');
			return all.filter(function (w) {
				if (!ALL_KINDS.some(function (k) { return kinds.has(k) && w.cats[k]; })) return false;
				return !q || w.search.indexOf(q) !== -1;
			});
		}

		function draw(focusFrom) {
			const items = matching();
			list.replaceChildren();
			if (!items.length) list.appendChild(el('li', 'lnEmpty', emptyText(kinds, query)));
			items.slice(0, shown).forEach(function (w) { list.appendChild(waveCard(w)); });
			more.hidden = items.length <= shown;
			if (items.length && items.length <= shown) list.appendChild(wavesEnd());
			if (focusFrom != null) {
				const next = list.children[focusFrom];
				const target = next && next.querySelector('a');
				// (the first link in the wave: a username, act, venue, or the post/show)
				if (target) target.focus();
			}
		}

		// After the last wave (once there's nothing left to Load More)
		function wavesEnd() {
			const li = el('li', 'lnWavesEnd');
			// The icon takes you back to the top of Waves
			const top = el('button', 'lnWavesTopButton');
			top.type = 'button';
			top.setAttribute('aria-label', 'Back to the top of Waves');
			top.title = 'Back to top';
			top.appendChild(headIcon('waves'));
			top.addEventListener('click', function () {
				const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
				wavesHead.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
				wavesHead.focus({ preventScroll: true });
			});
			li.append(el('p', 'lnNote', 'You\'ve reached shore. Check back soon for more waves.'), top);
			return li;
		}

		function waveCard(w) {
			// Same order as before: the SRFR's line first, then the act's, then the venue's (whichever are checked)
			const line = ['srfr', 'act', 'venue'].filter(function (k) { return kinds.has(k) && w.cats[k]; }).map(function (k) { return w.cats[k]; })[0];
			// The line has its own links (usernames, acts, venues); the post or show under it is a link too
			const li = el('li', 'lnWave');
			const head = el('div', 'lnWaveHead');
			head.append(richLine('lnCardLine', line), timeEl(w.time, 'lnCardMeta'));
			li.appendChild(head);
			if (w.post) {
				const a = el('a', 'lnPreviewLink');
				a.href = w.href;
				a.appendChild(postPreview(w.post, w.author));
				li.appendChild(a);
			}
			if (w.show) {
				const a = el('a', 'lnWaveShow');
				a.href = w.href;
				a.append(el('span', 'lnCardTitle', w.show.title), el('span', 'lnCardMeta', w.show.meta));
				li.appendChild(a);
			}
			return li;
		}

		more.addEventListener('click', function () {
			const from = shown;
			shown += WAVE_PAGE;
			draw(from);
		});

		try {
			all = await collectWaves(cat);
		} catch (e) {
			console.error('[lineup] waves', e);
			list.replaceChildren(el('li', 'lnEmpty', 'Waves couldn\'t load right now. Please try again in a bit.'));
			list.setAttribute('aria-busy', 'false');
			return;
		}
		list.setAttribute('aria-busy', 'false');
		draw();
	}

	// Small Board-tile-like preview: picture (if any), title, a line of the opening, author
	function postPreview(p, author) {
		const box = el('span', 'lnPreview');
		const pic = previewImage(p);
		if (pic) {
			const img = el('img', 'lnPreviewImg');
			img.src = pic;
			img.alt = '';
			img.loading = 'lazy';
			box.appendChild(img);
		}
		const text = el('span', 'lnPreviewText');
		text.appendChild(el('span', 'lnCardTitle lnRefTitle', p.title));
		if (p.opener) text.appendChild(el('span', 'lnPreviewExcerpt', p.opener));
		const by = el('span', 'lnCardMeta lnPreviewBy', 'by ' + at(author.username));
		if (author.max_badge && ui && typeof ui.maxBadge === 'function') by.appendChild(ui.maxBadge());
		text.appendChild(by);
		box.appendChild(text);
		return box;
	}

	function previewImage(p) {
		const m = p.hero || (p.media || []).find(function (x) { return x.cover; }) || (p.media || [])[0];
		if (!m) return null;
		const src = m.type === 'video' ? m.thumb : m.src;
		if (!src) return null;
		if (src.charAt(0) === '/') return src; // the site's own Board files
		return core.sb.storage.from('post-media').getPublicUrl(src).data.publicUrl;
	}

	// ------------------------------------------------------------------
	// Start
	// ------------------------------------------------------------------

	async function build() {
		showState('Loading your Lineup…');
		const cat = await catalog();
		els.state.hidden = true;
		els.sections.hidden = false;
		await Promise.all([renderRipples(cat), renderUpcoming(cat)]);
		renderWaves(cat);
	}

	// Keep "5 mins ago" current
	setInterval(function () {
		document.querySelectorAll('.lineupSections time').forEach(function (t) { t.textContent = ago(t.dateTime); });
	}, 60000);

	if (!core || !core.enabled) {
		showState('Your Lineup is unavailable right now. Please try again in a bit.');
		return;
	}

	core.onChange(function (state) {
		if (!state.user) {
			builtFor = null;
			showState('Sign in to see your Lineup.', [{ label: 'Sign In', onClick: function () { ui.openAuth('signin'); } }]);
			return;
		}
		if (state.user.id !== builtFor) {
			builtFor = state.user.id;
			build();
		}
	});
})();
