/*
 * js/profile.js — the /u/ profile page (crwdsrfr.com/u/?username)
 *
 * Needs (loaded before this file): crwd-core.js, nav.js, crwd-ui.js, anthem.js.
 *
 * Reads everything public from the `public_profiles` view, which already applies
 * each person's show/hide settings and blocks. The edit dialog works from the
 * signed-in owner's full row (CrwdCore.profile).
 *
 * Anything a user typed is inserted with textContent, never innerHTML.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const ui = window.CrwdUI;

	const DATA = { events: '/data/events.json', acts: '/data/acts.json', venues: '/data/venues.json' };
	const LIMITS = { displayName: 40, status: 140, bio: 300, area: 40, linkLabel: 40, links: 3, message: 2000, reportDetails: 1000,
		// About tab extras (the database checks the same limits)
		bwf: 300, artist: 80, prompts: 5, prompt: 100, answer: 500, history: 500, historyActs: 200, historyVenue: 80 };
	const REPORT_REASONS = [
		['spam', 'Spam or fake account'],
		['harassment', 'Harassment or bullying'],
		['hate', 'Hate speech'],
		['impersonation', 'Pretending to be someone else'],
		['inappropriate', 'Inappropriate content'],
		['other', 'Something else']
	];

	const $ = function (id) { return document.getElementById(id); };
	const els = {
		state: $('profileState'), stateText: $('profileStateText'), stateActions: $('profileStateActions'),
		hero: $('profileHero'), content: $('profileContent'),
		avatar: $('profileAvatar'), displayName: $('profileDisplayName'), username: $('profileUsername'),
		edit: $('profileEdit'), hype: $('profileHype'), hypeLabel: $('profileHypeLabel'), newPost: $('profileNewPost'),
		more: $('profileMore'), moreButton: $('profileMoreButton'), moreMenu: $('profileMoreMenu'),
		anthem: $('profileAnthem'), blurb: $('profileBlurb'), stats: $('profileStats'), links: $('profileLinks'),
		tabPosts: $('profileTabPosts'), tabHyped: $('profileTabHyped'), tabAbout: $('profileTabAbout'),
		panelPosts: $('profilePanelPosts'), panelHyped: $('profilePanelHyped'), panelAbout: $('profilePanelAbout'),
		posts: $('profilePosts'), hyped: $('profileHyped'), aboutTab: $('profileAboutTab')
	};

	// Current page state
	let viewed = null;        // row from public_profiles
	let isOwner = false;
	let following = false;
	let followBusy = false;
	let posts = null;         // loaded once per profile
	let hypes = null;         // loaded the first time the Hyped tab opens
	let postsFilter = 'all';  // 'all' | 'board' | 'profile'
	let hypedFilter = 'event';// 'event' | 'act' | 'venue'
	let loadedForUser;        // which signed-in user the page was rendered for
	const jsonCache = {};

	// ------------------------------------------------------------------
	// Small helpers
	// ------------------------------------------------------------------

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function at(username) {
		return '@' + username;
	}

	// The username in the URL: /u/?kevin (anything after & is ignored)
	function usernameFromUrl() {
		const raw = window.location.search.replace(/^\?/, '').split('&')[0];
		try { return decodeURIComponent(raw).trim().toLowerCase(); } catch (e) { return ''; }
	}

	function publicUrl(bucket, path) {
		return path ? core.sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : null;
	}

	function loadJson(key) {
		if (!jsonCache[key]) {
			jsonCache[key] = fetch(DATA[key]).then(function (res) {
				if (!res.ok) throw new Error(DATA[key] + ' ' + res.status);
				return res.json();
			}).catch(function (err) {
				console.warn('[profile] could not load', DATA[key], err);
				delete jsonCache[key]; // let a later attempt retry
				return null;
			});
		}
		return jsonCache[key];
	}

	// 'YYYY-MM-DD' → { month: 'Oct', day: 31, label: 'Sat, Oct 31, 2026' }
	// Split the string directly; never round-trip calendar dates through UTC.
	function showDate(dateStr) {
		const parts = String(dateStr || '').split('-').map(Number);
		if (parts.length !== 3 || !parts[1]) return null;
		const d = new Date(parts[0], parts[1] - 1, parts[2]);
		return {
			month: d.toLocaleDateString('en-US', { month: 'short' }),
			day: parts[2],
			label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
		};
	}

	function todayStr() {
		const d = new Date();
		return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
	}

	// Timestamps (created_at etc.) are real moments in time, so Date is right here
	function monthYear(iso) {
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
	}

	function postDate(iso) {
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	function plural(n, word) {
		return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's');
	}

	// ------------------------------------------------------------------
	// Page states (loading / not found / blocked / errors)
	// ------------------------------------------------------------------

	function showState(text, actions) {
		els.hero.hidden = true;
		els.content.hidden = true;
		els.state.hidden = false;
		els.stateText.textContent = text;
		els.stateActions.replaceChildren();
		(actions || []).forEach(function (a) {
			const b = el(a.href ? 'a' : 'button', 'profileButton', a.label);
			if (a.href) b.href = a.href; else { b.type = 'button'; b.addEventListener('click', a.onClick); }
			els.stateActions.appendChild(b);
		});
	}

	function showBlocked(entry) {
		document.title = 'Blocked | CRWD SRFR';
		showState('You blocked ' + at(entry.username) + '. You won\'t see each other\'s profiles, posts or comments.', [{
			label: 'Unblock',
			onClick: async function () {
				this.disabled = true;
				const { error } = await core.sb.from('blocks').delete().eq('blocked_id', entry.user_id);
				if (error) { this.disabled = false; alert(core.friendlyError(error).message); return; }
				load();
			}
		}]);
	}

	function showPrivate(row) {
		document.title = at(row.username) + ' | CRWD SRFR';
		const name = at(row.username);
		if (row.profile_visibility === 'members' && !core.user) {
			showState(name + ' only shares their profile with CRWD SRFR members. Sign in to see it.',
				[{ label: 'Sign In', onClick: function () { ui.openAuth('signin'); } }]);
		} else if (row.profile_visibility === 'connections') {
			showState(name + ' only shares their profile with people they\'re chatting with.');
		} else {
			showState(name + '\'s profile is private.');
		}
	}

	// ------------------------------------------------------------------
	// Loading
	// ------------------------------------------------------------------

	// quiet: refresh in place (after saving edits) without flashing the loading message
	async function load(quiet) {
		loadedForUser = core.user ? core.user.id : null;
		closeMoreMenu();
		posts = null;
		hypes = null;

		if (!core.enabled) {
			showState('Profiles are unavailable right now. Please try again in a bit.');
			return;
		}

		const username = usernameFromUrl();

		// /u/ with no name: signed-in people go to their own profile
		if (!username) {
			if (core.profile && !core.needsUsername()) { window.location.replace(core.profileUrl(core.profile.username)); return; }
			showState('Sign in to see your profile.', core.user ? [] : [{ label: 'Sign In', onClick: function () { ui.openAuth('signin'); } }]);
			return;
		}

		if (!quiet) showState('Loading profile…');
		const { data: row, error } = await core.sb.from('public_profiles').select('*').eq('username', username).maybeSingle();
		if (error) {
			console.error('[profile]', error);
			showState('We couldn\'t load this profile. Please try again in a bit.');
			return;
		}

		if (!row) {
			// Hidden because I blocked them? Offer Unblock instead of "not found".
			if (core.user) {
				const { data: blocked } = await core.sb.rpc('my_blocked_users');
				const entry = (blocked || []).find(function (b) { return b.username === username; });
				if (entry) { showBlocked(entry); return; }
			}
			document.title = 'Profile not found | CRWD SRFR';
			showState('We couldn\'t find ' + at(username) + '.', [{ label: 'Back to the Calendar', href: '/' }]);
			return;
		}

		viewed = row;
		isOwner = !!(core.user && core.user.id === row.id);

		// Hidden by their Profile Visibility setting (Settings → Privacy)
		if (!isOwner && row.profile_visible === false) { showPrivate(row); return; }

		following = false;
		if (core.user && !isOwner) {
			const { data } = await core.sb.from('follows').select('followee_id')
				.eq('follower_id', core.user.id).eq('followee_id', row.id).maybeSingle();
			following = !!data;
		}

		render();
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	function render() {
		const v = viewed;
		document.title = at(v.username) + ' | CRWD SRFR';
		els.state.hidden = true;
		els.hero.hidden = false;
		els.content.hidden = false;

		// Hero background (pro only; the view returns null otherwise)
		const heroUrl = publicUrl('profile-heroes', v.hero_path);
		els.hero.classList.toggle('hasImage', !!heroUrl);
		els.hero.style.backgroundImage = heroUrl ? 'url("' + heroUrl.replace(/"/g, '%22') + '")' : '';

		// Avatar
		els.avatar.replaceChildren();
		const avatarUrl = core.avatarUrl(v.avatar_path);
		if (avatarUrl) {
			const img = el('img'); img.src = avatarUrl; img.alt = '';
			els.avatar.appendChild(img);
			els.avatar.classList.remove('isEmpty');
		} else {
			els.avatar.appendChild(el('span', 'icon profileAvatarIcon'));
			els.avatar.classList.add('isEmpty');
		}

		// Names: display name (if set and shown) on top, @username below.
		// Without one, the username becomes the headline.
		els.displayName.hidden = false;
		if (v.display_name) {
			els.displayName.textContent = v.display_name;
			els.username.textContent = at(v.username);
			els.username.hidden = false;
		} else {
			els.displayName.textContent = at(v.username);
			els.username.hidden = true;
		}
		// Max badge goes after the @username, wherever it is
		if (v.max_badge) (v.display_name ? els.username : els.displayName).appendChild(ui.maxBadge());

		// Actions
		els.edit.hidden = !isOwner;
		els.newPost.hidden = !isOwner || !window.CrwdComposer;
		els.hype.hidden = isOwner;
		els.more.hidden = isOwner;
		renderMessageOption(v.accepts_requests !== false);
		renderHypeButton();

		// Anthem card (renderAnthemCard hides the box when there's no valid link)
		renderAnthemCard(els.anthem, v.anthem_url, v.anthem_title);
		els.hero.classList.toggle('hasAnthem', !els.anthem.hidden);

		renderAbout();
		renderAboutTab();
		selectTab('posts');
		loadPosts();
	}

	// Message stays in the menu, greyed out with a note, when they've turned message requests off
	// (Settings → Privacy). aria-disabled (not disabled) keeps it focusable and its hover text working.
	function renderMessageOption(allowed) {
		const b = els.moreMenu.querySelector('[data-action="message"]');
		const old = b.querySelector('.profileMoreNote');
		if (old) old.remove();
		b.classList.toggle('isDisabled', !allowed);
		if (allowed) {
			b.removeAttribute('aria-disabled');
			b.removeAttribute('aria-label');
			b.removeAttribute('title');
			b.removeAttribute('aria-describedby');
		} else {
			b.setAttribute('aria-disabled', 'true');
			b.setAttribute('aria-label', 'Message'); // the note is read as its description, not part of the name
			b.title = 'User does not allow message requests';
			const note = el('span', 'profileMoreNote', 'User does not allow message requests');
			note.id = 'profileMessageNote';
			b.appendChild(note);
			b.setAttribute('aria-describedby', note.id);
		}
	}

	function renderHypeButton() {
		els.hypeLabel.textContent = following ? 'Hyped' : 'Hype';
		els.hype.classList.toggle('isActive', following);
		els.hype.setAttribute('aria-pressed', following ? 'true' : 'false');
		els.hype.setAttribute('aria-label', (following ? 'Stop hyping ' : 'Hype ') + at(viewed.username));
	}

	function renderAbout() {
		const v = viewed;

		// Blurb (the "status" column; null when empty or hidden). Visitors see nothing when it's empty.
		els.blurb.classList.toggle('isEmpty', !v.status);
		els.blurb.textContent = v.status || (isOwner ? 'Add a blurb so people know what you\'re into.' : '');
		els.blurb.hidden = !v.status && !isOwner;

		// Facts: area, established, hype count
		els.stats.replaceChildren();
		function stat(label, value, note) {
			const row = el('div', 'profileStat');
			row.appendChild(el('dt', null, label));
			const dd = el('dd', null, value);
			if (note) dd.appendChild(el('span', 'profileStatNote', note));
			row.appendChild(dd);
			els.stats.appendChild(row);
		}
		if (v.area) stat('Area', v.area);
		if (v.joined_at) stat('Established', monthYear(v.joined_at));
		if (v.follower_count != null) {
			// Owners always get their count back; flag it when it's hidden from everyone else
			const hiddenForOthers = isOwner && core.profile && core.profile.show_follower_count === false;
			stat('Hypes', Number(v.follower_count).toLocaleString(), hiddenForOthers ? 'Only you can see this' : null);
		}
		els.stats.hidden = !els.stats.children.length;

		// Links
		els.links.replaceChildren();
		(Array.isArray(v.links) ? v.links : []).slice(0, LIMITS.links).forEach(function (link) {
			if (!link || !/^https:\/\//.test(link.url || '')) return;
			const li = el('li');
			const a = el('a', 'profileLink', link.label || link.url);
			a.href = link.url;
			a.target = '_blank';
			a.rel = 'noopener nofollow ugc';
			li.appendChild(a);
			els.links.appendChild(li);
		});
		els.links.hidden = !els.links.children.length;
	}

	// ------------------------------------------------------------------
	// About tab: Bio, Best/Worst/First, Top 5 Artists, custom prompts, Show History
	// Everything here is optional; a section only shows when it has something in it.
	// ------------------------------------------------------------------

	// Show History, newest first; entries without a date go last (in the order they were added)
	function sortHistory(list) {
		return list.slice().sort(function (a, b) {
			if (a.date && b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
			return a.date ? -1 : b.date ? 1 : 0;
		});
	}

	// 'YYYY-MM-DD' → 'Oct 14, 2026' (split directly; never through UTC)
	function historyDate(dateStr) {
		const d = showDate(dateStr);
		if (!d) return '';
		const parts = String(dateStr).split('-').map(Number);
		return d.month + ' ' + parts[2] + ', ' + parts[0];
	}

	function renderAboutTab() {
		const v = viewed;
		const a = v.about && typeof v.about === 'object' ? v.about : {};
		const box = els.aboutTab;
		box.replaceChildren();

		function block(title) {
			const section = el('section', 'profileAboutBlock');
			section.appendChild(el('h2', 'profileAboutHeading', title));
			box.appendChild(section);
			return section;
		}

		if (v.bio) block('Bio').appendChild(el('p', 'profileAboutText', v.bio));

		if (a.bwf) block('Best, Worst, First').appendChild(el('p', 'profileAboutText', a.bwf));

		// Ranks keep their numbers even when one is left blank
		const top = (Array.isArray(a.top_artists) ? a.top_artists : []).map(function (name, i) {
			return { rank: i + 1, name: String(name || '').trim() };
		}).filter(function (x) { return x.name; });
		if (top.length) {
			const ol = el('ol', 'profileTopArtists');
			top.forEach(function (x) {
				const li = el('li');
				li.value = x.rank;
				li.append(el('span', 'profileTopRank', String(x.rank)), el('span', null, x.name));
				ol.appendChild(li);
			});
			block('Top 5 Artists').appendChild(ol);
		}

		(Array.isArray(a.prompts) ? a.prompts : []).forEach(function (p) {
			if (p && p.prompt && p.answer) block(p.prompt).appendChild(el('p', 'profileAboutText', p.answer));
		});

		const shows = sortHistory((Array.isArray(a.history) ? a.history : []).filter(function (h) { return h && h.acts; }));
		if (shows.length) {
			const ul = el('ul', 'profileHistory');
			shows.forEach(function (h) {
				const li = el('li', 'profileHistoryItem');
				li.appendChild(el('span', 'profileHistoryActs', h.acts));
				const meta = [historyDate(h.date), h.venue].filter(Boolean).join(' · ');
				if (meta) li.appendChild(el('span', 'profileHistoryMeta', meta));
				ul.appendChild(li);
			});
			block('Show History (' + shows.length.toLocaleString() + ')').appendChild(ul);
		}

		if (!box.children.length) {
			emptyMessage(box, isOwner
				? 'Nothing here yet. Use Edit Profile to add a bio, your best, worst and first shows, top 5 artists and more.'
				: at(v.username) + ' hasn\'t added anything here yet.');
		}
	}

	// ------------------------------------------------------------------
	// Tabs + filters
	// ------------------------------------------------------------------

	const TABS = ['posts', 'hyped', 'about'];
	function tabParts(name) {
		return name === 'posts' ? [els.tabPosts, els.panelPosts] : name === 'hyped' ? [els.tabHyped, els.panelHyped] : [els.tabAbout, els.panelAbout];
	}

	function selectTab(name) {
		TABS.forEach(function (t) {
			const parts = tabParts(t), on = t === name;
			parts[0].setAttribute('aria-selected', on ? 'true' : 'false');
			parts[0].tabIndex = on ? 0 : -1;
			parts[1].hidden = !on;
		});
		if (name === 'hyped' && hypes === null) loadHypes();
	}

	function setFilter(group, attr, value) {
		group.querySelectorAll('.toggle-button').forEach(function (b) {
			const on = b.dataset[attr] === value;
			b.classList.toggle('active', on);
			b.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
	}

	function emptyMessage(container, text) {
		container.replaceChildren(el(container.tagName === 'UL' ? 'li' : 'p', 'profileEmpty', text));
	}

	// ------------------------------------------------------------------
	// Posts tab
	// ------------------------------------------------------------------

	async function loadPosts() {
		const forProfile = viewed.id;
		emptyMessage(els.posts, 'Loading posts…');

		// Database rules decide what's visible: everyone sees approved board posts,
		// approved profile posts if the owner shows them, and owners see all of their own.
		const { data, error } = await core.sb.from('posts')
			.select('id, legacy_id, author_id, destination, post_type, title, opener, media, closer, hero, venue_id, show_date, act_ids, act_names, credit, status, created_at')
			.eq('author_id', forProfile)
			.order('created_at', { ascending: false })
			.limit(60);
		if (!viewed || viewed.id !== forProfile) return; // navigated away meanwhile
		if (error) { console.error('[profile]', error); emptyMessage(els.posts, 'Posts couldn\'t load right now.'); return; }

		posts = data || [];
		// Hype + comment counts, and which ones I've hyped
		const stats = await window.CrwdSocial.loadStats('post', posts.map(function (p) { return p.id; }));
		if (!viewed || viewed.id !== forProfile) return;
		posts.forEach(function (p) { p.stats = stats[p.id]; });
		renderPosts();
	}

	function renderPosts() {
		if (posts === null) return;
		const list = posts.filter(function (p) { return postsFilter === 'all' || p.destination === postsFilter; });

		if (!list.length) {
			let msg;
			if (postsFilter === 'profile' && !isOwner && viewed.posts_visible === false) msg = at(viewed.username) + ' keeps their profile posts private.';
			else if (isOwner) msg = postsFilter === 'board' ? 'You haven\'t posted to the Board yet.' : postsFilter === 'profile' ? 'You haven\'t posted to your profile yet.' : 'You haven\'t posted yet.';
			else msg = at(viewed.username) + ' hasn\'t posted ' + (postsFilter === 'board' ? 'to the Board ' : postsFilter === 'profile' ? 'to their profile ' : '') + 'yet.';
			emptyMessage(els.posts, msg);
			return;
		}

		closePostMenu();
		els.posts.replaceChildren();
		list.forEach(function (p) { els.posts.appendChild(postCard(p)); });
		showLinkedPost();
	}

	// The posts currently listed (the All / Board / Profile filter applies)
	function listedPosts() {
		return (posts || []).filter(function (p) { return postsFilter === 'all' || p.destination === postsFilter; });
	}

	// ------------------------------------------------------------------
	// Full post in a modal — the same one the Board uses (js/crwd-post.js)
	// ------------------------------------------------------------------

	// Venues, acts and genres for the post's Show Details; loaded the first time a post opens
	let postContext = null;
	function loadPostContext() {
		if (!postContext) {
			const bm = window.BoardMedia;
			postContext = Promise.all([bm.fetchVenueLookup(), bm.fetchActsList(), bm.fetchGenreMeta()])
				.then(function (r) { return { venueLookup: r[0], actsList: r[1], genreMeta: r[2] }; });
		}
		return postContext;
	}

	async function openPost(p) {
		if (!window.CrwdPost || !window.BoardMedia) return;
		const ctx = await loadPostContext();
		const list = listedPosts();
		const author = { username: viewed.username, avatar_path: viewed.avatar_path, max_badge: viewed.max_badge };
		const items = list.map(function (row) {
			return window.BoardMedia.withActs(window.BoardMedia.toItem(row, author), ctx.actsList);
		});
		closePostMenu();
		window.CrwdPost.open({
			items: items,
			index: Math.max(0, list.indexOf(p)),
			context: { venueLookup: ctx.venueLookup, genreMeta: ctx.genreMeta },
			getStats: function (id) { const row = posts.find(function (x) { return x.id === id; }); return row && row.stats; },
			onStatsChange: function (id, next) {
				const row = posts.find(function (x) { return x.id === id; });
				if (!row) return;
				row.stats = next;
				const card = document.getElementById('post-' + id);
				if (card) renderPostFoot(card, row);
			},
			hashFor: function (item) { return '#post-' + item.id; },
			shareUrl: function (item) { return postLink(item); }
		});
	}

	// ------------------------------------------------------------------
	// Post kebab menu: Share / Delete (author) or Share / Report (everyone else)
	// ------------------------------------------------------------------

	let openPostMenu = null; // { button, menu } of the menu that's open, if any

	function postMenu(p) {
		const wrap = el('div', 'profilePostMore');
		const button = el('button', 'profilePostMoreButton');
		button.type = 'button';
		button.setAttribute('aria-label', 'Post options');
		button.setAttribute('aria-haspopup', 'true');
		button.setAttribute('aria-expanded', 'false');
		button.appendChild(el('span', 'icon iconKebab'));
		const menu = el('ul', 'profileMoreMenu profilePostMenu');
		menu.hidden = true;

		function item(label, onClick, danger) {
			const li = el('li');
			const b = el('button', 'profileMoreItem' + (danger ? ' isDanger' : ''), label);
			b.type = 'button';
			b.addEventListener('click', function () { closePostMenu(); onClick(); });
			li.appendChild(b);
			menu.appendChild(li);
		}
		// Only approved posts are visible to others, so only they get a link worth sharing
		if (p.status === 'approved') item('Share Post', function () { sharePost(p, button); });
		if (isOwner) item('Delete Post', function () { openDeletePostDialog(p); }, true);
		else item('Report Post', function () { if (ui.requireSignIn()) openReportDialog(p); }, true);

		button.addEventListener('click', function (e) {
			const wasOpen = openPostMenu && openPostMenu.menu === menu;
			closePostMenu();
			closeMoreMenu();
			if (wasOpen) return;
			menu.hidden = false;
			button.setAttribute('aria-expanded', 'true');
			button.classList.add('open');
			openPostMenu = { button: button, menu: menu };
			if (e.detail === 0) menu.querySelector('button').focus({ preventScroll: true }); // keyboard users
		});

		wrap.append(button, menu);
		return wrap;
	}

	function closePostMenu(returnFocus) {
		if (!openPostMenu) return;
		const m = openPostMenu;
		openPostMenu = null;
		m.menu.hidden = true;
		m.button.setAttribute('aria-expanded', 'false');
		m.button.classList.remove('open');
		if (returnFocus) m.button.focus({ preventScroll: true });
	}

	function postLink(p) {
		return window.location.origin + core.profileUrl(viewed.username) + '#post-' + p.id;
	}

	// Phones get the system share sheet; everything else copies the link
	async function sharePost(p, anchor) {
		const url = postLink(p);
		if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
			try { await navigator.share({ title: 'Post by ' + at(viewed.username) + ' on CRWD SRFR', url: url }); } catch (e) { /* closed the sheet */ }
			return;
		}
		let copied = false;
		try { await navigator.clipboard.writeText(url); copied = true; } catch (e) { /* not allowed */ }
		if (!copied) { window.prompt('Copy this link:', url); return; }
		flashNote(anchor, 'Link copied');
	}

	// Small "Link copied" bubble under a button
	function flashNote(anchor, text) {
		const note = el('span', 'profilePostNote', text);
		note.setAttribute('role', 'status');
		anchor.parentNode.appendChild(note);
		setTimeout(function () { note.classList.add('isLeaving'); }, 1400);
		setTimeout(function () { note.remove(); }, 1800);
	}

	function openDeletePostDialog(p) {
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Delete this <em>post</em>?'));
			body.appendChild(kit.el('p', 'crwdModalText', 'It will be removed from your profile' + (p.destination === 'board' ? ' and the Board' : '') + ', along with its hypes and comments. This can\'t be undone.'));
			const err = kit.errorBox();
			const btn = kit.el('button', 'crwdButton isDanger', 'Delete post');
			btn.type = 'button';
			const cancel = kit.el('p', 'crwdModalSwitch');
			const cancelBtn = kit.el('button', 'crwdLinkButton', 'Keep it');
			cancelBtn.type = 'button';
			cancelBtn.setAttribute('data-autofocus', ''); // the safe choice gets focus
			cancelBtn.addEventListener('click', kit.close);
			cancel.appendChild(cancelBtn);
			body.append(err, btn, cancel);

			btn.addEventListener('click', async function () {
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Deleting…');
				const { error } = await core.sb.from('posts').delete().eq('id', p.id);
				if (error) { kit.setBusy(btn, false, 'Delete post'); kit.showError(err, core.friendlyError(error).message); return; }
				// Clean up the post's images (best effort; the post itself is already gone)
				// (only uploaded files: "/board/…" ones belong to the site)
				const files = (p.media || []).concat(p.hero ? [p.hero] : [])
					.flatMap(function (m) { return [m.src, m.thumb]; })
					.filter(function (src) { return src && src.charAt(0) !== '/'; });
				if (files.length) core.sb.storage.from('post-media').remove(files);
				posts = posts.filter(function (x) { return x.id !== p.id; });
				renderPosts();
				kit.close();
			});
		});
	}

	// A shared link (/u/?name#post-<id>) opens that post once it's on the page
	let linkedPostShown = false;
	function showLinkedPost() {
		if (linkedPostShown) return;
		const m = /^#post-([\w-]+)$/.exec(window.location.hash);
		if (!m) { linkedPostShown = true; return; }
		const card = document.getElementById('post-' + m[1]);
		if (!card) return;
		linkedPostShown = true;
		card.classList.add('isLinked');
		card.scrollIntoView({ block: 'center' });
		const p = posts.find(function (x) { return x.id === m[1]; });
		if (p) openPost(p);
	}

	function postCard(p) {
		const card = el('article', 'profilePost');

		const head = el('div', 'profilePostHead');
		const author = el('a', 'profilePostUser', at(viewed.username));
		author.href = core.profileUrl(viewed.username);
		if (viewed.max_badge) author.appendChild(ui.maxBadge());
		head.appendChild(author);

		// Right side: date, where it was posted (icon), then the post's menu
		const where = el('span', 'profilePostWhere');
		const time = el('time', 'profilePostDate', postDate(p.created_at));
		time.dateTime = p.created_at;
		const onBoard = p.destination === 'board';
		const icon = el('span', 'icon profilePostPlace ' + (onBoard ? 'iconBoard' : 'iconProfile'));
		icon.setAttribute('role', 'img');
		icon.setAttribute('aria-label', onBoard ? 'Board Post' : 'Profile Post');
		icon.title = onBoard ? 'Board Post' : 'Profile Post';
		where.append(time, icon, postMenu(p));
		head.appendChild(where);
		card.id = 'post-' + p.id; // so a shared link can jump straight to it
		card.appendChild(head);

		// Title opens the full post; so does clicking anywhere else on the card
		const title = el('button', 'profilePostTitle', p.title);
		title.type = 'button';
		card.appendChild(title);
		if (p.opener) card.appendChild(el('p', 'profilePostBody', p.opener));

		// Up to 4 pictures: the cover first, then the post's photos/videos
		const pictures = (p.hero ? [p.hero] : []).concat(p.media || [])
			.map(function (m) { return m.thumb || (m.type === 'video' ? null : m.src); })
			.filter(Boolean)
			.slice(0, 4);
		if (pictures.length) {
			const grid = el('div', 'profilePostMedia');
			grid.dataset.count = String(pictures.length);
			pictures.forEach(function (src) {
				const img = el('img');
				img.src = src.charAt(0) === '/' ? src : publicUrl('post-media', src);
				img.alt = '';
				img.loading = 'lazy';
				grid.appendChild(img);
			});
			card.appendChild(grid);
		}

		card.appendChild(el('div', 'profilePostFoot'));
		renderPostFoot(card, p);

		card.addEventListener('click', function (e) {
			// The name link and the ⋮ menu do their own thing
			if (e.target.closest('a, .profilePostMore')) return;
			openPost(p);
		});
		return card;
	}

	// Bottom row: hype + comment counts (display only, open the post to use them),
	// or — for a post only its author can see — its review status
	function renderPostFoot(card, p) {
		const foot = card.querySelector('.profilePostFoot');
		foot.replaceChildren();
		if (p.status === 'pending') { foot.appendChild(el('span', 'profileBadge isPending', 'Pending review')); return; }
		if (p.status === 'rejected') { foot.appendChild(el('span', 'profileBadge isRejected', 'Not approved')); return; }
		const s = p.stats || { hypes: 0, comments: 0 };
		[[s.hypes, 'iconHype', 'hype'], [s.comments, 'iconComment', 'comment']].forEach(function (c) {
			if (!(c[0] > 0)) return;
			const badge = el('span', 'profilePostCount');
			badge.setAttribute('aria-label', c[0] + ' ' + c[2] + (c[0] === 1 ? '' : 's'));
			const icon = el('span', 'icon ' + c[1]);
			icon.setAttribute('aria-hidden', 'true');
			badge.append(icon, Number(c[0]).toLocaleString());
			foot.appendChild(badge);
		});
	}

	// ------------------------------------------------------------------
	// Hyped tab
	// ------------------------------------------------------------------

	async function loadHypes() {
		const forProfile = viewed.id;
		emptyMessage(els.hyped, 'Loading…');
		const { data, error } = await core.sb.rpc('get_profile_hypes', { profile_id: forProfile });
		if (!viewed || viewed.id !== forProfile) return;
		if (error) { console.error('[profile]', error); hypes = null; emptyMessage(els.hyped, 'Hypes couldn\'t load right now.'); return; }
		hypes = data || [];
		renderHyped();
	}

	// Which Hyped lists this visitor can see (owners always see all three)
	function visibleHypeKinds() {
		const flags = { event: 'hyped_shows_visible', act: 'hyped_acts_visible', venue: 'hyped_venues_visible' };
		return ['event', 'act', 'venue'].filter(function (kind) { return isOwner || viewed[flags[kind]] !== false; });
	}

	async function renderHyped() {
		if (hypes === null) return;
		const nouns = { event: 'shows', act: 'acts', venue: 'venues' };

		// Hidden lists lose their filter button; if the current one is hidden, jump to the first shown
		const kinds = visibleHypeKinds();
		const filter = els.panelHyped.querySelector('.profileFilter');
		filter.querySelectorAll('[data-hyped]').forEach(function (b) { b.hidden = kinds.indexOf(b.dataset.hyped) === -1; });
		filter.hidden = kinds.length === 0;
		if (!kinds.length) {
			emptyMessage(els.hyped, at(viewed.username) + ' keeps their hypes private.');
			return;
		}
		if (kinds.indexOf(hypedFilter) === -1) {
			hypedFilter = kinds[0];
			setFilter(filter, 'hyped', hypedFilter);
		}
		const kind = hypedFilter;

		const ids = hypes.filter(function (h) { return h.kind === kind; }).map(function (h) { return h.item_id; });
		if (!ids.length) {
			emptyMessage(els.hyped, isOwner
				? 'You haven\'t hyped any ' + nouns[kind] + ' yet.'
				: at(viewed.username) + ' hasn\'t hyped any ' + nouns[kind] + ' yet.');
			return;
		}

		emptyMessage(els.hyped, 'Loading…');
		const items = kind === 'event' ? await hypedShows(ids) : kind === 'act' ? await hypedActs(ids) : await hypedVenues(ids);
		if (hypedFilter !== kind) return; // filter changed while loading

		els.hyped.replaceChildren();
		items.forEach(function (item) { els.hyped.appendChild(item); });
	}

	function hypedRow(opts) {
		const li = el('li', 'profileHypedItem' + (opts.past ? ' isPast' : '') + (opts.missing ? ' isMissing' : ''));
		const inner = el(opts.href ? 'a' : 'div', 'profileHypedLink');
		if (opts.href) {
			inner.href = opts.href;
			if (opts.external) { inner.target = '_blank'; inner.rel = 'noopener'; }
		}
		if (opts.date) {
			const badge = el('span', 'profileHypedDate');
			badge.appendChild(el('span', 'profileHypedMonth', opts.date.month));
			badge.appendChild(el('span', 'profileHypedDay', String(opts.date.day)));
			inner.appendChild(badge);
		}
		const text = el('span', 'profileHypedText');
		text.appendChild(el('span', 'profileHypedTitle', opts.title));
		if (opts.meta) text.appendChild(el('span', 'profileHypedMeta', opts.meta));
		inner.appendChild(text);
		li.appendChild(inner);
		return li;
	}

	async function hypedShows(ids) {
		const data = await loadJson('events');
		const events = (data && data.events) || [];
		const venues = (data && data.venues) || {};
		const byId = {};
		events.forEach(function (e) { byId[e.id] = e; });
		const today = todayStr();

		const found = ids.map(function (id) { return byId[id]; }).filter(Boolean);
		// Upcoming soonest first, then past shows most recent first
		const upcoming = found.filter(function (e) { return e.date >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
		const past = found.filter(function (e) { return e.date < today; }).sort(function (a, b) { return a.date > b.date ? -1 : 1; });

		const rows = upcoming.concat(past).map(function (e) {
			const venue = venues[e.venueId];
			const d = showDate(e.date);
			return hypedRow({
				title: e.title,
				meta: [venue && venue.name, d && d.label].filter(Boolean).join(' · ') + (e.date < today ? ' · Past' : ''),
				date: d,
				href: '/?show=' + encodeURIComponent(e.id), // opens the calendar on that day, scrolled to the show
				external: false,
				past: e.date < today
			});
		});
		const missing = ids.length - found.length;
		if (missing) rows.push(hypedRow({ title: plural(missing, 'older show') + ' no longer listed', missing: true }));
		return rows;
	}

	async function hypedActs(ids) {
		const data = await loadJson('acts') || {};
		const list = Array.isArray(data) ? data : Object.keys(data).map(function (k) { return Object.assign({ id: k }, data[k]); });
		const byId = {};
		list.forEach(function (a) { byId[a.id || a.slug] = a; });

		const rows = ids.map(function (id) { return byId[id]; }).filter(Boolean)
			.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })
			.map(function (a) {
				return hypedRow({ title: a.name, href: '/acts/#' + encodeURIComponent(a.id || a.slug) });
			});
		const missing = ids.filter(function (id) { return !byId[id]; }).length;
		if (missing) rows.push(hypedRow({ title: plural(missing, 'act') + ' no longer listed', missing: true }));
		return rows;
	}

	async function hypedVenues(ids) {
		const data = await loadJson('venues') || [];
		const byId = {};
		(Array.isArray(data) ? data : Object.values(data)).forEach(function (v) { byId[v.id] = v; });

		const rows = ids.map(function (id) { return byId[id]; }).filter(Boolean)
			.sort(function (a, b) { return String(a.name).replace(/^the\s+/i, '').localeCompare(String(b.name).replace(/^the\s+/i, '')); })
			.map(function (v) {
				return hypedRow({ title: v.name, meta: v.area || null, href: '/venues/' + encodeURIComponent(v.id) + '/' });
			});
		const missing = ids.filter(function (id) { return !byId[id]; }).length;
		if (missing) rows.push(hypedRow({ title: plural(missing, 'venue') + ' no longer listed', missing: true }));
		return rows;
	}

	// ------------------------------------------------------------------
	// Hype (follow) button
	// ------------------------------------------------------------------

	async function toggleHype() {
		if (!ui.requireSignIn() || followBusy || !viewed) return;
		followBusy = true;
		const was = following;
		following = !was;
		if (viewed.follower_count != null) viewed.follower_count = Number(viewed.follower_count) + (following ? 1 : -1);
		renderHypeButton();
		renderAbout();

		const q = was
			? core.sb.from('follows').delete().eq('follower_id', core.user.id).eq('followee_id', viewed.id)
			: core.sb.from('follows').insert({ followee_id: viewed.id });
		const { error } = await q;
		followBusy = false;

		if (error && error.code !== '23505') { // 23505 = already hyped, which is the state we wanted
			following = was;
			if (viewed.follower_count != null) viewed.follower_count = Number(viewed.follower_count) + (was ? 1 : -1);
			renderHypeButton();
			renderAbout();
			alert(core.friendlyError(error).message);
		}
	}

	// ------------------------------------------------------------------
	// Kebab menu: Message, Block, Report
	// ------------------------------------------------------------------

	function openMoreMenu(focusFirst) {
		els.moreMenu.hidden = false;
		els.moreButton.setAttribute('aria-expanded', 'true');
		els.moreButton.classList.add('open');
		if (focusFirst) els.moreMenu.querySelector('button').focus({ preventScroll: true });
	}

	function closeMoreMenu(returnFocus) {
		if (els.moreMenu.hidden) return;
		els.moreMenu.hidden = true;
		els.moreButton.setAttribute('aria-expanded', 'false');
		els.moreButton.classList.remove('open');
		if (returnFocus) els.moreButton.focus({ preventScroll: true });
	}

	function runAction(action) {
		closeMoreMenu();
		if (!ui.requireSignIn() || !viewed) return;
		if (action === 'message') openMessageDialog();
		if (action === 'block') openBlockDialog();
		if (action === 'report') openReportDialog();
	}

	// A paragraph mixing static copy with the username, safely
	function textWithUser(kit, before, username, after) {
		const p = kit.el('p', 'crwdModalText', before);
		p.appendChild(kit.el('strong', null, at(username)));
		if (after) p.append(after);
		return p;
	}

	function textArea(kit, opts) {
		const wrap = kit.el('label', 'crwdField');
		wrap.appendChild(kit.el('span', 'crwdLabel', opts.label));
		const ta = document.createElement('textarea');
		ta.name = opts.name;
		ta.maxLength = opts.max;
		if (opts.placeholder) ta.placeholder = opts.placeholder;
		if (opts.value) ta.value = opts.value;
		wrap.appendChild(ta);
		const counter = kit.el('span', 'crwdCounter');
		function update() {
			counter.textContent = ta.value.length + ' / ' + opts.max;
			counter.dataset.state = ta.value.length > opts.max ? 'over' : '';
		}
		ta.addEventListener('input', update);
		update();
		wrap.appendChild(counter);
		return { wrap: wrap, input: ta };
	}

	function doneView(body, kit, titleHtml, noticeText, extra) {
		body.replaceChildren();
		body.appendChild(kit.title(titleHtml));
		body.appendChild(kit.el('p', 'crwdNotice', noticeText));
		if (extra) body.appendChild(extra);
		const close = kit.el('button', 'crwdButton', 'Done');
		close.type = 'button';
		close.style.marginTop = '20px';
		close.addEventListener('click', kit.close);
		body.appendChild(close);
		close.focus({ preventScroll: true });
	}

	function openMessageDialog() {
		const target = viewed;
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Send a <em>message</em>'));
			body.appendChild(textWithUser(kit, 'Your first message goes to ', target.username, ' as a request. You can keep chatting once they accept.'));
			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;
			const msg = textArea(kit, { label: 'Message', name: 'message', max: LIMITS.message });
			const err = kit.errorBox();
			const btn = kit.submitButton('Send request');
			form.append(msg.wrap, err, btn);
			body.appendChild(form);

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const text = msg.input.value.trim();
				if (!text) { kit.showError(err, 'Write a message first.'); msg.input.focus(); return; }
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Sending…');
				const { data: convId, error } = await core.sb.rpc('start_conversation', { other_user: target.id, first_message: text });
				if (error) { kit.setBusy(btn, false, 'Send request'); kit.showError(err, core.friendlyError(error).message); return; }
				const link = kit.el('p', 'crwdModalSwitch');
				const a = kit.el('a', null, 'View conversation'); a.href = '/messages/?c=' + encodeURIComponent(convId);
				link.appendChild(a);
				doneView(body, kit, 'Request <em>sent</em>', 'Sent to ' + at(target.username) + '. You can keep chatting once they accept.', link);
			});
		});
	}

	function openBlockDialog() {
		const target = viewed;
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Block this <em>user</em>?'));
			body.appendChild(textWithUser(kit, 'You and ', target.username,
				' won\'t be able to see each other\'s profiles, posts or comments, or send each other messages. Any hypes between you are removed. They aren\'t notified.'));
			const err = kit.errorBox();
			const btn = kit.el('button', 'crwdButton', 'Block');
			btn.type = 'button';
			const cancel = kit.el('p', 'crwdModalSwitch');
			const cancelBtn = kit.el('button', 'crwdLinkButton', 'Cancel');
			cancelBtn.type = 'button';
			cancelBtn.addEventListener('click', kit.close);
			cancel.appendChild(cancelBtn);
			body.append(err, btn, cancel);

			btn.addEventListener('click', async function () {
				kit.setBusy(btn, true, 'Blocking…');
				const { error } = await core.sb.from('blocks').insert({ blocked_id: target.id });
				if (error && error.code !== '23505') { kit.setBusy(btn, false, 'Block'); kit.showError(err, core.friendlyError(error).message); return; }
				kit.close();
				showBlocked({ user_id: target.id, username: target.username });
			});
		});
	}

	// post: report that post instead of the person
	function openReportDialog(post) {
		const target = viewed;
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title(post ? 'Report this <em>post</em>' : 'Report this <em>user</em>'));
			body.appendChild(textWithUser(kit, 'Reports go to the CRWD SRFR team for review. ', target.username, ' won\'t see who reported them.'));

			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;
			const choices = kit.el('fieldset', 'crwdChoices');
			const legend = kit.el('legend', 'crwdLabel', 'What\'s going on?');
			legend.style.marginBottom = '8px';
			choices.appendChild(legend);
			REPORT_REASONS.forEach(function (r) {
				const label = kit.el('label', 'crwdChoice');
				const input = document.createElement('input');
				input.type = 'radio';
				input.name = 'reason';
				input.value = r[0];
				label.append(input, r[1]);
				choices.appendChild(label);
			});
			const details = textArea(kit, { label: 'Anything else we should know? (optional)', name: 'details', max: LIMITS.reportDetails });
			const err = kit.errorBox();
			const btn = kit.submitButton('Send report');
			form.append(choices, details.wrap, err, btn);
			body.appendChild(form);

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const picked = form.querySelector('input[name=reason]:checked');
				if (!picked) { kit.showError(err, 'Choose what\'s going on.'); return; }
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Sending…');
				const { error } = await core.sb.from('reports').insert({
					target_type: post ? 'post' : 'user',
					target_id: post ? post.id : target.id,
					reason: picked.value,
					details: details.input.value.trim() || null
				});
				if (error) { kit.setBusy(btn, false, 'Send report'); kit.showError(err, core.friendlyError(error).message); return; }

				const also = kit.el('p', 'crwdModalSwitch');
				const blockBtn = kit.el('button', 'crwdLinkButton', 'Also block ' + at(target.username));
				blockBtn.type = 'button';
				blockBtn.addEventListener('click', openBlockDialog);
				also.appendChild(blockBtn);
				doneView(body, kit, 'Thanks for <em>reporting</em>', 'We\'ll take a look. Reports help keep CRWD SRFR a good place to be.', also);
			});
		});
	}

	// ------------------------------------------------------------------
	// Edit Profile
	// ------------------------------------------------------------------

	// Resizes an image file in the browser before upload, so big phone photos fit
	// the storage limits. square: center-crop to a square (avatars).
	function loadImage(file) {
		return new Promise(function (resolve, reject) {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
			img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file isn\'t an image we can use. Try a JPG, PNG or WebP.')); };
			img.src = url;
		});
	}

	async function resizeImage(file, opts) {
		const img = await loadImage(file);
		let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight, dw, dh;
		if (opts.square) {
			const side = Math.min(sw, sh);
			sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
			dw = dh = Math.min(opts.max, side);
		} else {
			const scale = Math.min(1, opts.max / sw);
			dw = Math.round(sw * scale); dh = Math.round(sh * scale);
		}
		const canvas = document.createElement('canvas');
		canvas.width = dw; canvas.height = dh;
		canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
		function toBlob(type) { return new Promise(function (r) { canvas.toBlob(r, type, 0.85); }); }
		let blob = await toBlob('image/webp');
		if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg'); // older Safari can't encode WebP
		return blob;
	}

	async function uploadImage(bucket, prefix, blob) {
		const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
		const path = core.user.id + '/' + prefix + '-' + Date.now() + '.' + ext; // new name each time, so caches never show the old one
		const { error } = await core.sb.storage.from(bucket).upload(path, blob, { contentType: blob.type, upsert: false });
		if (error) throw new Error('The image couldn\'t upload. Please try again.');
		return path;
	}

	// "Show … on my profile" checkbox
	function checkbox(kit, label, checked) {
		const wrap = kit.el('label', 'profileCheck');
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = checked !== false;
		wrap.append(input, kit.el('span', null, label));
		return { wrap: wrap, input: input };
	}

	// A setting that isn't built yet: shown, but can't be changed
	function comingSoonCheckbox(kit, label) {
		const box = checkbox(kit, label, false);
		box.input.disabled = true;
		box.wrap.classList.add('isComingSoon');
		box.wrap.append(kit.el('span', 'crwdProBadge', 'MAX'), kit.el('span', 'profileComingSoon', 'Coming soon'));
		return box;
	}

	function checkboxList(kit, boxes) {
		const list = kit.el('div', 'profileCheckList');
		boxes.forEach(function (b) { list.appendChild(b.wrap); });
		return list;
	}

	// Adds the yellow MAX badge after a field's label
	function markPro(kit, wrap) {
		wrap.querySelector('.crwdLabel').append(' ', kit.el('span', 'crwdProBadge', 'MAX'));
	}

	// Small ✕ / ↑ / ↓ buttons — same look as the New Post form's shot tools (crwd-composer.css)
	function toolButton(kit, kind, ariaLabel) {
		const b = kit.el('button', 'composerMediaTool' + (kind === 'remove' ? ' isDanger' : ''));
		b.type = 'button';
		b.dataset.action = kind;
		b.setAttribute('aria-label', ariaLabel);
		b.appendChild(kit.el('span', kind === 'remove' ? 'composerRemove' : 'composerArrow ' + (kind === 'up' ? 'isUp' : 'isDown')));
		return b;
	}

	function addButton(kit, label) {
		const b = kit.el('button', 'crwdSmallButton profileAddButton', label);
		b.type = 'button';
		return b;
	}

	function setDisabled(button, off) {
		button.disabled = off;
		button.classList.toggle('isDisabled', off);
	}

	// Links: "Links" label + hint, an "Add Link" button, then the added rows (Link + Label + ✕). Up to 3.
	function linksEditor(kit, existing) {
		const wrap = kit.el('div', 'crwdField profileLinkFields');
		wrap.append(kit.el('span', 'crwdLabel', 'Links'), kit.el('span', 'crwdHint', 'Add external links to your profile - up to three.'));
		const list = kit.el('div', 'profileLinkRows');
		const add = addButton(kit, 'Add Link');
		wrap.append(add, list);
		const rows = [];

		function update() {
			setDisabled(add, rows.length >= LIMITS.links);
			rows.forEach(function (r, i) {
				r.urlLabel.textContent = 'Link ' + (i + 1);
				r.remove.setAttribute('aria-label', 'Remove link ' + (i + 1));
			});
		}

		function addRow(link, focus) {
			const row = kit.el('div', 'profileLinkRow');
			const url = kit.field({ label: 'Link', name: 'link_url', type: 'url', value: link.url || '', placeholder: 'https://...' });
			const label = kit.field({ label: 'Label', name: 'link_label', maxLength: LIMITS.linkLabel, value: link.label || '', placeholder: 'Title for Link' });
			const remove = toolButton(kit, 'remove', 'Remove link');
			row.append(url.wrap, label.wrap, remove);
			const r = { url: url.input, label: label.input, urlLabel: url.wrap.querySelector('.crwdLabel'), remove: remove };
			remove.addEventListener('click', function () {
				const i = rows.indexOf(r);
				rows.splice(i, 1);
				row.remove();
				update();
				const next = rows[i] || rows[i - 1];
				(next ? next.url : add).focus();
			});
			rows.push(r);
			list.appendChild(row);
			update();
			if (focus) url.input.focus();
		}

		(Array.isArray(existing) ? existing : []).slice(0, LIMITS.links).forEach(function (l) { addRow(l, false); });
		add.addEventListener('click', function () { if (rows.length < LIMITS.links) addRow({}, true); });
		update();
		return { wrap: wrap, rows: rows };
	}

	// Custom prompts: "Add Prompt" adds a Prompt + Answer pair below it; pairs can be moved or removed
	function promptsEditor(kit, existing) {
		const wrap = kit.el('div', 'crwdField profilePrompts');
		wrap.appendChild(kit.el('span', 'crwdLabel', 'Custom Prompts'));
		wrap.appendChild(kit.el('span', 'crwdHint', 'Write your own question and answer it. Up to ' + LIMITS.prompts + '.'));
		const list = kit.el('ol', 'profilePromptList');
		const add = addButton(kit, 'Add Prompt');
		wrap.append(add, list);

		let nextId = 1;
		const items = (Array.isArray(existing) ? existing : []).slice(0, LIMITS.prompts).map(function (p) {
			return { id: nextId++, prompt: String((p && p.prompt) || ''), answer: String((p && p.answer) || '') };
		});

		function render(focusId, focusAction) {
			list.replaceChildren();
			items.forEach(function (item, i) {
				const n = i + 1;
				const li = kit.el('li', 'profilePromptItem');
				li.dataset.id = item.id;
				const fields = kit.el('div', 'profilePromptFields');
				const prompt = kit.field({ label: 'Prompt ' + n, name: 'prompt', maxLength: LIMITS.prompt, value: item.prompt, placeholder: 'e.g. Go-to spot before a show?' });
				prompt.input.dataset.action = 'prompt';
				prompt.input.addEventListener('input', function () { item.prompt = prompt.input.value; });
				const answer = textArea(kit, { label: 'Answer', name: 'answer', max: LIMITS.answer, value: item.answer });
				answer.input.rows = 2;
				answer.input.dataset.action = 'answer';
				answer.input.setAttribute('aria-label', 'Answer to prompt ' + n);
				answer.input.addEventListener('input', function () { item.answer = answer.input.value; });
				fields.append(prompt.wrap, answer.wrap);

				const tools = kit.el('div', 'composerMediaTools');
				const up = toolButton(kit, 'up', 'Move prompt ' + n + ' up');
				const down = toolButton(kit, 'down', 'Move prompt ' + n + ' down');
				const remove = toolButton(kit, 'remove', 'Remove prompt ' + n);
				up.disabled = i === 0;
				down.disabled = i === items.length - 1;
				tools.append(up, down, remove);

				li.append(fields, tools);
				list.appendChild(li);
			});
			list.hidden = !items.length;
			setDisabled(add, items.length >= LIMITS.prompts);

			// Keep the keyboard on the same item after a move/remove/add
			if (focusId != null) {
				const li = list.querySelector('[data-id="' + focusId + '"]');
				let target = li && li.querySelector('[data-action="' + focusAction + '"]:not(:disabled)');
				if (!target && li) target = li.querySelector('button[data-action]:not(:disabled)'); // e.g. moved to the top: ↑ is off, so ↓
				(target || add).focus();
			}
		}

		list.addEventListener('click', function (e) {
			const b = e.target.closest('button[data-action]');
			if (!b) return;
			const id = Number(b.closest('.profilePromptItem').dataset.id);
			const i = items.findIndex(function (x) { return x.id === id; });
			if (b.dataset.action === 'up' && i > 0) { items.splice(i - 1, 0, items.splice(i, 1)[0]); render(id, 'up'); }
			else if (b.dataset.action === 'down' && i < items.length - 1) { items.splice(i + 1, 0, items.splice(i, 1)[0]); render(id, 'down'); }
			else if (b.dataset.action === 'remove') {
				items.splice(i, 1);
				const next = items[i] || items[i - 1];
				render(next ? next.id : null, 'remove');
				if (!next) add.focus();
			}
		});
		add.addEventListener('click', function () {
			if (items.length >= LIMITS.prompts) return;
			const item = { id: nextId++, prompt: '', answer: '' };
			items.push(item);
			render(item.id, 'prompt');
		});
		render();
		return { wrap: wrap, items: items };
	}

	// Show History: Act(s) / Date / Venue + "Add to History"; entries list underneath, newest first
	function historyEditor(kit, existing) {
		const wrap = kit.el('div', 'crwdField profileHistoryEditor');
		wrap.appendChild(kit.el('span', 'crwdLabel', 'Show History'));
		wrap.appendChild(kit.el('span', 'crwdHint', 'Any show you\'ve been to. It doesn\'t need to be on CRWD SRFR.'));

		const fields = kit.el('div', 'profileHistoryFields');
		const acts = kit.field({ label: 'Act(s)', name: 'history_acts', maxLength: LIMITS.historyActs, placeholder: 'Who played?' });
		const date = kit.field({ label: 'Date', name: 'history_date', type: 'date' });
		date.input.classList.add('profileDateInput');
		const venue = kit.field({ label: 'Venue', name: 'history_venue', maxLength: LIMITS.historyVenue, placeholder: 'Where?' });
		// Act(s) on its own line, then Date + Venue side by side
		acts.wrap.classList.add('profileHistoryActsField');
		fields.append(acts.wrap, date.wrap, venue.wrap);
		const add = addButton(kit, 'Add to History');
		const problem = kit.el('span', 'profileHistoryProblem'); // "Add the act(s) first."
		problem.setAttribute('role', 'alert');
		const count = kit.el('span', 'crwdHint profileHistoryCount'); // "10 Shows" / "No shows added yet"
		count.setAttribute('role', 'status');
		const list = kit.el('ul', 'profileHistoryEditList');
		wrap.append(fields, add, problem, count, list);

		const entries = (Array.isArray(existing) ? existing : []).filter(function (h) { return h && h.acts; }).map(function (h) {
			const e = { acts: String(h.acts) };
			if (h.venue) e.venue = String(h.venue);
			if (h.date) e.date = String(h.date);
			return e;
		});

		function render() {
			list.replaceChildren();
			sortHistory(entries).forEach(function (h) {
				const li = kit.el('li', 'profileHistoryEditItem');
				const text = kit.el('span', 'profileHistoryEditText');
				text.appendChild(kit.el('span', 'profileHistoryActs', h.acts));
				const meta = [historyDate(h.date), h.venue].filter(Boolean).join(' · ');
				if (meta) text.appendChild(kit.el('span', 'profileHistoryMeta', meta));
				const remove = toolButton(kit, 'remove', 'Remove ' + h.acts + (h.date ? ', ' + historyDate(h.date) : '') + ' from your history');
				remove.addEventListener('click', function () {
					entries.splice(entries.indexOf(h), 1);
					render();
					acts.input.focus();
				});
				li.append(text, remove);
				list.appendChild(li);
			});
			list.hidden = !entries.length;
			setDisabled(add, entries.length >= LIMITS.history);
			count.textContent = entries.length ? plural(entries.length, 'Show') : 'No shows added yet';
		}

		// Adds what's in the fields; returns false (with a note) when Act(s) is empty
		function commit() {
			const a = acts.input.value.trim();
			if (!a) return false;
			if (entries.length >= LIMITS.history) { problem.textContent = 'That\'s the most shows your history can hold.'; return false; }
			const e = { acts: a };
			if (venue.input.value.trim()) e.venue = venue.input.value.trim();
			if (date.input.value) e.date = date.input.value; // already YYYY-MM-DD
			entries.push(e);
			acts.input.value = venue.input.value = date.input.value = '';
			problem.textContent = '';
			render();
			return true;
		}

		add.addEventListener('click', function () {
			if (!acts.input.value.trim()) { problem.textContent = 'Add the act(s) first.'; acts.input.focus(); return; }
			commit();
			acts.input.focus();
		});
		acts.input.addEventListener('input', function () { if (acts.input.value.trim()) problem.textContent = ''; });
		// Enter in these fields adds the show instead of saving the whole form
		[acts.input, date.input, venue.input].forEach(function (input) {
			input.addEventListener('keydown', function (e) {
				if (e.key !== 'Enter') return;
				e.preventDefault();
				add.click();
			});
		});
		render();
		return { wrap: wrap, entries: entries, commit: commit };
	}

	function imagePicker(kit, opts) {
		// opts: { label, currentUrl, shape: 'circle' | 'wide', disabled, hint }
		// Label, then the thumbnail, then Upload/Change + Remove underneath it
		const wrap = kit.el('div', 'crwdField profileImagePicker');
		wrap.appendChild(kit.el('span', 'crwdLabel', opts.label));
		const preview = kit.el('div', 'profileImagePreview is' + (opts.shape === 'wide' ? 'Wide' : 'Circle'));
		const row = kit.el('div', 'profileImagePickerRow');
		const pick = kit.el('label', 'crwdSmallButton', opts.currentUrl ? 'Change' : 'Upload');
		const file = document.createElement('input');
		file.type = 'file';
		file.accept = 'image/jpeg,image/png,image/webp';
		file.disabled = !!opts.disabled;
		pick.appendChild(file);
		const remove = kit.el('button', 'crwdLinkButton', 'Remove');
		remove.type = 'button';
		row.append(pick, remove);
		wrap.append(preview, row);
		if (opts.hint) wrap.appendChild(kit.el('span', 'crwdHint', opts.hint));
		if (opts.disabled) { pick.classList.add('isDisabled'); remove.hidden = true; }

		const state = { file: null, removed: false };
		function show(url) {
			preview.replaceChildren();
			if (url) { const img = kit.el('img'); img.src = url; img.alt = ''; preview.appendChild(img); }
			remove.hidden = !url || !!opts.disabled;
			pick.firstChild.textContent = url ? 'Change' : 'Upload';
		}
		show(opts.currentUrl);
		file.addEventListener('change', function () {
			if (!file.files[0]) return;
			state.file = file.files[0];
			state.removed = false;
			show(URL.createObjectURL(state.file));
		});
		remove.addEventListener('click', function () {
			state.file = null;
			state.removed = true;
			file.value = '';
			show(null);
		});
		return { wrap: wrap, state: state };
	}

	async function openEditDialog() {
		const me = core.profile;
		if (!me) return;
		const isPro = !!viewed.is_pro;

		// Area suggestions: the same areas as the calendar's Area filter
		const venues = await loadJson('venues');
		const areas = Array.from(new Set((Array.isArray(venues) ? venues : []).map(function (v) { return v.area; }).filter(Boolean))).sort();

		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Edit <em>profile</em>'));
			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;

			const proOnly = isPro ? null : 'Available with Max.';

			// --- Profile (same order as the page: pictures, name, anthem, blurb, facts, links)
			form.appendChild(kit.el('h3', 'crwdSection', 'Profile'));
			const avatar = imagePicker(kit, { label: 'Profile picture', currentUrl: core.avatarUrl(me.avatar_path), shape: 'circle' });
			const hero = imagePicker(kit, { label: 'Header image', currentUrl: publicUrl('profile-heroes', me.hero_path), shape: 'wide',
				disabled: !isPro, hint: proOnly });
			markPro(kit, hero.wrap);
			// Profile picture + header image side by side
			const pictures = kit.el('div', 'profileImagePickers');
			pictures.append(avatar.wrap, hero.wrap);
			// Placeholder for a future Max setting (not saved yet)
			const customColors = comingSoonCheckbox(kit, 'Use custom colors on my profile');
			const colorsList = checkboxList(kit, [customColors]);
			colorsList.appendChild(kit.el('span', 'crwdHint profileCheckHint', 'Shows the custom site colors from your Max settings to visitors on your profile.'));
			const dname = kit.field({ label: 'Display Name', name: 'display_name', maxLength: LIMITS.displayName,
				value: me.display_name || '', placeholder: 'Optional', hint: 'For your profile only - everywhere else uses @' + me.username + '.' });

			const parts = (me.anthem_title || '').split(/\s+[—–-]\s+/);
			const anthemLink = kit.field({ label: 'Anthem (Link)', name: 'anthem_url', type: 'url', value: me.anthem_url || '',
				placeholder: 'Link from Spotify, YouTube, SoundCloud or Apple Music' });
			const anthemRow = kit.el('div', 'crwdFieldRow profileAnthemRow'); // Song + Artist, equal widths
			const song = kit.field({ label: 'Anthem Title', name: 'anthem_song', maxLength: 60, value: parts[0] || '' });
			const artist = kit.field({ label: 'Artist', name: 'anthem_artist', maxLength: 37, value: parts.slice(1).join(' — ') });
			anthemRow.append(song.wrap, artist.wrap);

			// Blurb (saved in the "status" column) — shows at the top of the panel beside the tabs
			// A text box like Bio, so line breaks can be typed
			const blurb = textArea(kit, { label: 'Blurb', name: 'status', max: LIMITS.status,
				value: me.status || '', placeholder: 'What\'re you up to?' });

			const areaField = kit.field({ label: 'Area', name: 'area', maxLength: LIMITS.area,
				value: me.area || '', hint: 'Pick from our areas, or add your own.' });
			if (areas.length) {
				const list = document.createElement('datalist');
				list.id = 'profileAreas';
				areas.forEach(function (a) { const o = document.createElement('option'); o.value = a; list.appendChild(o); });
				areaField.wrap.appendChild(list);
				areaField.input.setAttribute('list', 'profileAreas');
			}

			const linksField = linksEditor(kit, me.links);
			const linkRows = linksField.rows; // live list: rows come and go with Add Link / ✕

			const showArea = checkbox(kit, 'Share your Area on your profile', me.show_area);
			const showJoined = checkbox(kit, 'Share when you joined (Est. ' + monthYear(me.created_at) + ') on your profile', me.show_joined);
			const showCount = checkbox(kit, 'Share your hype count on your profile', me.show_follower_count);

			// Divider (same line as the section headings, without a title) between the anthem and the side-panel fields
			const divider = kit.el('div', 'crwdSection profileSectionDivider');
			divider.setAttribute('role', 'separator');
			form.append(pictures, colorsList, dname.wrap, anthemLink.wrap, anthemRow, divider, blurb.wrap,
				areaField.wrap, checkboxList(kit, [showArea, showJoined, showCount]), linksField.wrap);

			// --- Posts
			form.appendChild(kit.el('h3', 'crwdSection', 'Posts'));
			const showPosts = checkbox(kit, 'Share your post history on your profile', me.show_posts);
			const postsList = checkboxList(kit, [showPosts]);
			postsList.appendChild(kit.el('span', 'crwdHint profileCheckHint', 'Any approved Board posts will still show up there.'));
			form.append(postsList);

			// --- Hypes
			form.appendChild(kit.el('h3', 'crwdSection', 'Hypes'));
			const showHypedShows = checkbox(kit, 'Share shows you\'ve hyped on your profile', me.show_hyped_shows);
			const showHypedActs = checkbox(kit, 'Share acts you\'ve hyped on your profile', me.show_hyped_acts);
			const showHypedVenues = checkbox(kit, 'Share venues you\'ve hyped on your profile', me.show_hyped_venues);
			form.append(checkboxList(kit, [showHypedShows, showHypedActs, showHypedVenues]));

			// --- About (the About tab: bio, best/worst/first, top 5, prompts, show history) — all optional
			const aboutHead = kit.el('h3', 'crwdSection', 'About');
			aboutHead.appendChild(kit.el('span', 'profileOptional', '(optional)'));
			form.appendChild(aboutHead);
			const about = me.about && typeof me.about === 'object' ? me.about : {};
			const bio = textArea(kit, { label: 'Bio', name: 'bio', max: LIMITS.bio, value: me.bio || '',
				placeholder: 'A short blurb about yourself, what you\'re all about, etc.' });

			const bwf = textArea(kit, { label: 'Best, Worst, First', name: 'about_bwf', max: LIMITS.bwf, value: about.bwf || '',
				placeholder: 'Your best show, your worst, and your first.' });

			const topWrap = kit.el('div', 'crwdField profileTopFields');
			topWrap.appendChild(kit.el('span', 'crwdLabel', 'Top 5 Artists'));
			const topList = kit.el('ol', 'profileTopInputs');
			const topInputs = [];
			for (let i = 0; i < 5; i++) {
				const li = kit.el('li');
				const input = document.createElement('input');
				input.type = 'text';
				input.name = 'top_artist_' + (i + 1);
				input.maxLength = LIMITS.artist;
				input.value = (Array.isArray(about.top_artists) && about.top_artists[i]) || '';
				input.setAttribute('aria-label', 'Number ' + (i + 1) + ' artist');
				li.append(kit.el('span', 'profileTopRank', String(i + 1)), input);
				topList.appendChild(li);
				topInputs.push(input);
			}
			topWrap.appendChild(topList);

			const prompts = promptsEditor(kit, about.prompts);
			const historyField = historyEditor(kit, about.history);
			form.append(bio.wrap, bwf.wrap, topWrap, prompts.wrap, historyField.wrap);

			// Save (and any error) stay pinned to the bottom of the modal while the form scrolls
			const err = kit.errorBox();
			const btn = kit.submitButton('Save');
			const footer = kit.el('div', 'profileEditFooter');
			footer.append(err, btn);
			form.append(footer);
			body.appendChild(form);

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				kit.showError(err, '');

				const patch = {
					display_name: dname.input.value.trim() || null,
					status: blurb.input.value.trim() || null, // "Blurb" on the site
					bio: bio.input.value.trim() || null,
					area: areaField.input.value.trim() || null,
					show_area: showArea.input.checked,
					show_joined: showJoined.input.checked,
					show_follower_count: showCount.input.checked,
					show_posts: showPosts.input.checked,
					show_hyped_shows: showHypedShows.input.checked,
					show_hyped_acts: showHypedActs.input.checked,
					show_hyped_venues: showHypedVenues.input.checked
				};
				if (patch.bio && patch.bio.length > LIMITS.bio) { kit.showError(err, 'Your bio can be up to ' + LIMITS.bio + ' characters.'); bio.input.focus(); return; }

				// Anthem + links (open to everyone)
				const link = anthemLink.input.value.trim();
				if (link && !anthemEmbed(link)) {
					kit.showError(err, 'That anthem link isn\'t one we can play. Use a song link from Spotify, YouTube, SoundCloud or Apple Music.');
					anthemLink.input.focus();
					return;
				}
				const s = song.input.value.trim(), a = artist.input.value.trim();
				patch.anthem_url = link || null;
				patch.anthem_title = link ? ([s, a].filter(Boolean).join(' — ') || null) : null;

				const links = [];
				for (const r of linkRows) {
					const label = r.label.value.trim();
					let url = r.url.value.trim();
					if (!label && !url) continue;
					if (!label || !url) { kit.showError(err, 'Each link needs both a label and a URL.'); (label ? r.url : r.label).focus(); return; }
					if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url; // "instagram.com/me" → https://instagram.com/me
					let ok = false;
					try { ok = new URL(url).protocol === 'https:'; } catch (ex) { ok = false; }
					if (!ok) { kit.showError(err, 'Links need to be full https:// web addresses.'); r.url.focus(); return; }
					links.push({ label: label, url: url });
				}
				patch.links = links;

				// About tab extras: only what's filled in gets saved
				const aboutPatch = {};
				if (bwf.input.value.trim()) aboutPatch.bwf = bwf.input.value.trim();
				const topArtists = topInputs.map(function (input) { return input.value.trim(); });
				while (topArtists.length && !topArtists[topArtists.length - 1]) topArtists.pop(); // blanks in between keep their rank
				if (topArtists.length) aboutPatch.top_artists = topArtists;
				const promptList = [];
				for (const item of prompts.items) {
					const q = item.prompt.trim(), ans = item.answer.trim();
					if (!q && !ans) continue;
					if (!q || !ans) {
						kit.showError(err, 'Each prompt needs both a prompt and an answer.');
						const li = prompts.wrap.querySelector('[data-id="' + item.id + '"]');
						if (li) li.querySelector(q ? 'textarea' : 'input').focus();
						return;
					}
					promptList.push({ prompt: q, answer: ans });
				}
				if (promptList.length) aboutPatch.prompts = promptList;
				historyField.commit(); // a show typed in but not added yet still counts
				if (historyField.entries.length) aboutPatch.history = sortHistory(historyField.entries);
				patch.about = aboutPatch;

				kit.setBusy(btn, true, 'Saving…');
				const oldAvatar = me.avatar_path, oldHero = me.hero_path;
				try {
					if (avatar.state.file) {
						patch.avatar_path = await uploadImage('avatars', 'avatar', await resizeImage(avatar.state.file, { square: true, max: 512 }));
					} else if (avatar.state.removed) {
						patch.avatar_path = null;
					}
					if (isPro && hero.state.file) {
						patch.hero_path = await uploadImage('profile-heroes', 'hero', await resizeImage(hero.state.file, { max: 1920 }));
					} else if (isPro && hero.state.removed) {
						patch.hero_path = null;
					}

					await core.updateProfile(patch);
				} catch (ex) {
					kit.setBusy(btn, false, 'Save');
					kit.showError(err, ex.message);
					return;
				}

				// Clean up replaced images (best effort; a leftover file is harmless)
				if ('avatar_path' in patch && oldAvatar && oldAvatar !== patch.avatar_path) core.sb.storage.from('avatars').remove([oldAvatar]);
				if ('hero_path' in patch && oldHero && oldHero !== patch.hero_path) core.sb.storage.from('profile-heroes').remove([oldHero]);

				kit.close();
				load(true);
			});
		}, { size: 'wide' });
	}

	// ------------------------------------------------------------------
	// Wiring
	// ------------------------------------------------------------------

	els.edit.addEventListener('click', openEditDialog);
	els.newPost.addEventListener('click', function () {
		window.CrwdComposer.open({
			destination: 'profile',
			// The new post starts as pending: show everything so it's in the list
			onPosted: function () {
				postsFilter = 'all';
				setFilter(els.panelPosts.querySelector('.profileFilter'), 'posts', postsFilter);
				loadPosts();
			}
		});
	});
	els.hype.addEventListener('click', toggleHype);

	els.moreButton.addEventListener('click', function (e) {
		closePostMenu();
		if (els.moreMenu.hidden) openMoreMenu(e.detail === 0); else closeMoreMenu();
	});
	els.moreMenu.addEventListener('click', function (e) {
		const b = e.target.closest('[data-action]');
		if (b && b.getAttribute('aria-disabled') !== 'true') runAction(b.dataset.action);
	});
	document.addEventListener('click', function (e) {
		if (!els.more.contains(e.target)) closeMoreMenu();
		if (openPostMenu && !openPostMenu.button.parentNode.contains(e.target)) closePostMenu();
	});
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && !els.moreMenu.hidden) closeMoreMenu(true);
		if (e.key === 'Escape' && openPostMenu) closePostMenu(true);
	});

	TABS.forEach(function (name, i) {
		const tab = tabParts(name)[0];
		tab.addEventListener('click', function () { selectTab(name); });
		// Left/right arrows move between the tabs (wrapping around)
		tab.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
			selectTab(next);
			tabParts(next)[0].focus();
		});
	});

	els.panelPosts.querySelector('.profileFilter').addEventListener('click', function (e) {
		const b = e.target.closest('[data-posts]');
		if (!b) return;
		postsFilter = b.dataset.posts;
		setFilter(this, 'posts', postsFilter);
		renderPosts();
	});
	els.panelHyped.querySelector('.profileFilter').addEventListener('click', function (e) {
		const b = e.target.closest('[data-hyped]');
		if (!b) return;
		hypedFilter = b.dataset.hyped;
		setFilter(this, 'hyped', hypedFilter);
		renderHyped();
	});

	if (!core || !core.enabled) {
		showState('Profiles are unavailable right now. Please try again in a bit.');
		return;
	}

	core.ready.then(load);
	// Signing in or out changes what this page should show (own profile, hype state)
	core.onChange(function (state) {
		const id = state.user ? state.user.id : null;
		if (loadedForUser !== undefined && id !== loadedForUser) load();
	});
})();
