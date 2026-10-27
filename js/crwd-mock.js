/*
 * js/crwd-mock.js — LOCAL TESTING ONLY. A pretend Supabase that lives in your browser.
 *
 * On localhost / 127.0.0.1 it replaces supabase-js with an in-browser fake, so every
 * account feature can be tried without a Supabase project or a real account.
 * On any other host (crwdsrfr.com) it does nothing at all.
 *
 * Load it right after the supabase-js script and before crwd-core.js:
 *   supabase-js (CDN) → /js/crwd-mock.js → /js/crwd-core.js → /js/nav.js → /js/crwd-ui.js → page script
 *
 * A small "MOCK" bar in the bottom-left corner lets you:
 *   - switch who you're signed in as (or Guest)
 *   - turn Max (the paid tier) on/off for the signed-in account
 *   - "click" the magic link after signing in or registering (the mock inbox), or read the emailed code
 *   - reset the test data, or switch to the real Supabase project
 *
 * Everything you change (profile edits, hypes, blocks, uploads) is saved in this browser's
 * localStorage, so it survives reloads until you press Reset.
 */
(function () {
	'use strict';

	const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname);
	if (!LOCAL) return;

	const KEY = { db: 'crwdMock.db', session: 'crwdMock.session', inbox: 'crwdMock.inbox', off: 'crwdMock.off', collapsed: 'crwdMock.collapsed' };
	const store = {
		get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
		set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
		del(k) { try { localStorage.removeItem(k); } catch (e) {} }
	};

	const OFF = store.get(KEY.off) === '1';
	let bar = null;
	document.addEventListener('DOMContentLoaded', function () { drawBar(); });
	if (OFF) { console.info('[crwd-mock] off — using the real Supabase project'); return; }

	console.info('[crwd-mock] ON — using pretend data stored in this browser (see the MOCK bar, bottom-left)');

	// ------------------------------------------------------------------
	// Test data
	// ------------------------------------------------------------------

	const OWNER = 'u-owner', FAN = 'u-fan', QUIET = 'u-quiet', BLOCKED = 'u-blocked', CRWD = 'u-crwd';

	function profileRow(fields) {
		return Object.assign({
			username: null, display_name: null, avatar_path: null, hero_path: null,
			status: null, bio: null, area: null, anthem_url: null, anthem_title: null, links: [], about: {},
			show_display_name: true, show_status: true, show_anthem: true, show_about: true,
			show_area: true, show_joined: true, show_follower_count: true,
			show_posts: true, show_hyped_shows: true, show_hyped_acts: true, show_hyped_venues: true,
			profile_visibility: 'everyone', message_requests: 'everyone',
			email_message_requests: true, email_new_messages: true, email_weekly_roundup: false, email_ripples: true,
			show_max_badge: true, username_changed_at: null,
			created_at: new Date().toISOString()
		}, fields);
	}

	// Board + profile posts in the current format (see the posts table in the schema)
	function seedPosts() {
		function post(fields) {
			return Object.assign({
				post_type: 'discussion', opener: null, closer: null, media: [], hero: null,
				venue_id: null, show_date: null, act_ids: [], credit: null, legacy_id: null,
				status: 'approved', edited_at: null
			}, fields);
		}
		return [
			// Imported from board-media.json (by @crwdsrfr)
			post({ id: 'b1', author_id: CRWD, destination: 'board', post_type: 'shot', title: 'Oso Oso',
				media: [{ src: CRWD + '/oso-oso.jpg', type: 'photo' }], venue_id: 'grog-shop', show_date: '2026-10-14',
				act_ids: ['oso-oso'], credit: 'Photos by Sam', legacy_id: 'oso-oso-grog-2026-10-14', created_at: '2026-10-14T16:00:00Z' }),
			post({ id: 'b2', author_id: CRWD, destination: 'board', post_type: 'gallery', title: 'Linda Lindas at the Beachland',
				opener: 'A packed Ballroom on a Tuesday.\n\nHere are the best moments.',
				hero: { src: CRWD + '/ll-hero.jpg', type: 'photo' },
				media: [
					{ src: CRWD + '/ll-1.jpg', type: 'photo', caption: 'Opening with Oso Oso' },
					{ src: CRWD + '/ll-2.jpg', type: 'photo', cover: true },
					{ src: CRWD + '/ll-3.mp4', type: 'video', thumb: CRWD + '/ll-3.jpg', caption: 'The encore' }
				],
				closer: 'See you next time.', venue_id: 'beachland-ballroom', show_date: '2026-10-07',
				act_ids: ['the-linda-lindas', 'oso-oso'], credit: 'Photos by Kevin', created_at: '2026-10-07T16:00:00Z' }),
			post({ id: 'b3', author_id: CRWD, destination: 'board', post_type: 'shot', title: 'Mastodon at the Agora',
				media: [{ src: CRWD + '/mastodon.mp4', type: 'video', thumb: CRWD + '/mastodon.jpg' }],
				venue_id: 'the-agora', show_date: '2026-09-20', created_at: '2026-09-20T16:00:00Z' }),
			// Members' posts
			post({ id: 'p1', author_id: OWNER, destination: 'board', title: 'Oso Oso absolutely ripped last night',
				opener: 'Front row the whole set. Who else was there?', act_ids: ['oso-oso'], venue_id: 'grog-shop',
				show_date: '2026-10-14', created_at: '2026-10-15T02:00:00Z' }),
			post({ id: 'p2', author_id: OWNER, destination: 'profile', title: 'Linda Lindas plans?', opener: 'Who else is going to Linda Lindas?', created_at: '2026-10-13T20:00:00Z' }),
			post({ id: 'p3', author_id: OWNER, destination: 'board', title: 'Waiting for approval', opener: 'Only I can see this one until it\'s approved.', status: 'pending', created_at: '2026-10-16T20:00:00Z' }),
			post({ id: 'p4', author_id: OWNER, destination: 'profile', title: 'Rejected post', opener: 'This one was rejected.', status: 'rejected', created_at: '2026-10-11T20:00:00Z' }),
			post({ id: 'p5', author_id: QUIET, destination: 'profile', title: 'Hidden profile post', opener: 'Profile post (hidden from visitors).', created_at: '2026-10-10T20:00:00Z' }),
			post({ id: 'p6', author_id: QUIET, destination: 'board', title: 'Board posts stay visible', opener: 'Board posts stay visible even with posts hidden.', created_at: '2026-10-09T20:00:00Z' })
		];
	}

	// Messages: an accepted conversation with something new, a request to me, and one I sent.
	// conversations: { id, requester_id, members, status, created_at, responded_at, reads: {uid: time}, left: {uid: time} }
	function minsAgo(n) { return new Date(Date.now() - n * 60000).toISOString(); }
	function seedConversations() {
		return [
			{ id: 'conv-fan', requester_id: FAN, members: [FAN, OWNER], status: 'accepted', created_at: minsAgo(4400), responded_at: minsAgo(4300),
				reads: { 'u-fan': minsAgo(20), 'u-owner': minsAgo(1500) }, left: {} },
			{ id: 'conv-quiet', requester_id: QUIET, members: [QUIET, OWNER], status: 'pending', created_at: minsAgo(130), responded_at: null,
				reads: { 'u-quiet': minsAgo(130) }, left: {} },
			{ id: 'conv-crwd', requester_id: OWNER, members: [OWNER, CRWD], status: 'pending', created_at: minsAgo(1500), responded_at: null,
				reads: { 'u-owner': minsAgo(1500) }, left: {} }
		];
	}
	function seedMessages() {
		return [
			{ id: 'm1', conversation_id: 'conv-fan', sender_id: FAN, body: 'Saw you up front at Oso Oso. That set was unreal!', created_at: minsAgo(4400) },
			{ id: 'm2', conversation_id: 'conv-fan', sender_id: OWNER, body: 'Right?! Best show I\'ve seen this year.', created_at: minsAgo(4290) },
			{ id: 'm3', conversation_id: 'conv-fan', sender_id: FAN, body: 'Are you going to Linda Lindas at the Beachland?', created_at: minsAgo(4280) },
			{ id: 'm4', conversation_id: 'conv-fan', sender_id: OWNER, body: 'Already have tickets.', created_at: minsAgo(1500) },
			{ id: 'm5', conversation_id: 'conv-fan', sender_id: FAN, body: 'Nice, see you there. Meet at the bar after?', created_at: minsAgo(20) },
			{ id: 'm6', conversation_id: 'conv-quiet', sender_id: QUIET, body: 'Hey! Do you know if the Grog Shop show is all ages?', created_at: minsAgo(130) },
			{ id: 'm7', conversation_id: 'conv-crwd', sender_id: OWNER, body: 'Hi! Could I send in some photos for the Board?', created_at: minsAgo(1500) }
		];
	}

	// Lineup → Ripples: updates about my posts (see update-lineup.sql)
	function seedRipples() {
		return [
			{ id: 'r-hype-p1', user_id: OWNER, kind: 'post_hype', post_id: 'p1', event_id: null, target: 'p1', actor_ids: [QUIET, FAN], actor_count: 2, created_at: minsAgo(600), updated_at: minsAgo(45) },
			{ id: 'r-cmt-p1', user_id: OWNER, kind: 'post_comment', post_id: 'p1', event_id: null, target: 'p1', actor_ids: [QUIET, FAN], actor_count: 2, created_at: minsAgo(700), updated_at: minsAgo(90) },
			{ id: 'r-cmt-p2', user_id: OWNER, kind: 'post_comment', post_id: 'p2', event_id: null, target: 'p2', actor_ids: [FAN], actor_count: 1, created_at: minsAgo(3000), updated_at: minsAgo(3000) }
		];
	}

	function seed() {
		return {
			users: [
				{ id: OWNER, email: 'kevin@test.local' },
				{ id: FAN, email: 'fan@test.local' },
				{ id: QUIET, email: 'quiet@test.local' },
				{ id: BLOCKED, email: 'blocked@test.local' },
				{ id: CRWD, email: 'hello@test.local' }
			],
			profiles: [
				profileRow({ id: OWNER, username: 'grogshopregular', display_name: 'Kevin M',
					status: 'Counting down to Linda Lindas at the Beachland',
					bio: 'Front row at the Grog Shop most Fridays.\nAlways down for a basement show.',
					area: 'Ohio City',
					about: {
						bwf: 'Best: Oso Oso at the Grog Shop, everyone singing every word.\nFirst: Warped Tour 2004',
						top_artists: ['Oso Oso', 'The Linda Lindas', '', 'Pinegrove'],
						prompts: [{ prompt: 'Go-to spot before a show?', answer: 'Happy Dog for tots.' }],
						history: [
							{ acts: 'Oso Oso, Pinegrove', venue: 'Grog Shop', date: '2026-10-14' },
							{ acts: 'The Linda Lindas', venue: 'Beachland Ballroom', date: '2025-06-02' },
							{ acts: 'Some basement show' }
						]
					},
					anthem_url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', anthem_title: 'Never Gonna Give You Up — Rick Astley',
					links: [{ label: 'Instagram', url: 'https://instagram.com/crwdsrfr' }, { label: 'Bandcamp', url: 'https://bandcamp.com' }],
					created_at: '2026-03-12T15:00:00Z' }),
				profileRow({ id: FAN, username: 'beachlandfan', created_at: '2026-10-01T15:00:00Z' }),
				// Every privacy toggle off — use this to check what visitors see
				profileRow({ id: QUIET, username: 'quietlistener', display_name: 'Hidden Name', status: 'Hidden status',
					bio: 'Hidden bio', area: 'Tremont',
					show_display_name: false, show_status: false, show_about: false, show_area: false,
					show_joined: false, show_follower_count: false, show_posts: false,
					show_hyped_shows: false, show_hyped_acts: false, show_hyped_venues: false,
					created_at: '2026-06-01T15:00:00Z' }),
				profileRow({ id: BLOCKED, username: 'blocked_one', created_at: '2026-09-01T00:00:00Z' }),
				// The official account that imported Board posts belong to
				profileRow({ id: CRWD, username: 'crwdsrfr', display_name: 'CRWD SRFR', created_at: '2026-01-01T00:00:00Z' })
			],
			pro: { [OWNER]: true },
			admins: [OWNER],
			follows: [
				{ follower_id: FAN, followee_id: OWNER, created_at: '2026-10-02T00:00:00Z' },
				{ follower_id: QUIET, followee_id: OWNER, created_at: '2026-10-03T00:00:00Z' },
				{ follower_id: OWNER, followee_id: QUIET, created_at: '2026-10-03T00:00:00Z' },
				{ follower_id: OWNER, followee_id: FAN, created_at: '2026-10-04T00:00:00Z' },
				{ follower_id: OWNER, followee_id: CRWD, created_at: '2026-10-04T00:00:00Z' }
			],
			blocks: [{ blocker_id: OWNER, blocked_id: BLOCKED, created_at: '2026-10-15T00:00:00Z' }],
			posts: seedPosts(),
			post_hypes: [{ post_id: 'p1', user_id: FAN }, { post_id: 'p1', user_id: QUIET }, { post_id: 'p2', user_id: FAN }],
			comments: [
				{ id: 'c1', post_id: 'p1', author_id: FAN, body: 'So good! That last song had the whole room shouting.', created_at: '2026-10-15T03:10:00Z' },
				{ id: 'c2', post_id: 'p1', author_id: QUIET, body: 'Wish I had gone.\nNext time for sure.', created_at: '2026-10-15T09:40:00Z' },
				{ id: 'c3', post_id: 'p1', author_id: OWNER, body: 'They play again in the spring!', created_at: '2026-10-15T12:00:00Z', edited_at: '2026-10-15T12:05:00Z' },
				{ id: 'c4', post_id: 'p1', author_id: BLOCKED, body: 'Comment from someone grogshopregular blocked', created_at: '2026-10-15T13:00:00Z' },
				// Comments on shows ('@upcoming:N' → a real show id from events.json)
				{ id: 'c5', post_id: null, event_id: '@upcoming:0', author_id: FAN, body: 'Who else is going? Meet at the bar after.', created_at: '2026-10-16T18:00:00Z' },
				{ id: 'c6', post_id: null, event_id: '@upcoming:0', author_id: OWNER, body: 'Count me in!', created_at: '2026-10-16T19:30:00Z' }
			],
			// '@upcoming:N' / '@past:N' are swapped for real show ids from /data/events.json on first use
			item_hypes: [
				{ user_id: OWNER, kind: 'event', item_id: '@upcoming:0', created_at: '2026-10-10T00:00:00Z' },
				{ user_id: OWNER, kind: 'event', item_id: '@upcoming:5', created_at: '2026-10-10T00:00:00Z' },
				{ user_id: OWNER, kind: 'event', item_id: '@upcoming:12', created_at: '2026-10-10T00:00:00Z' },
				{ user_id: OWNER, kind: 'event', item_id: '@past:0', created_at: '2026-10-10T00:00:00Z' },
				{ user_id: OWNER, kind: 'event', item_id: 'show-that-was-removed', created_at: '2026-10-10T00:00:00Z' },
				{ user_id: OWNER, kind: 'act', item_id: 'oso-oso', created_at: '2026-10-11T00:00:00Z' },
				{ user_id: OWNER, kind: 'act', item_id: 'the-linda-lindas', created_at: '2026-10-11T00:00:00Z' },
				{ user_id: OWNER, kind: 'venue', item_id: 'grog-shop', created_at: '2026-10-11T00:00:00Z' },
				{ user_id: OWNER, kind: 'venue', item_id: 'beachland-ballroom', created_at: '2026-10-11T00:00:00Z' },
				{ user_id: QUIET, kind: 'venue', item_id: 'grog-shop', created_at: '2026-10-11T00:00:00Z' },
				{ user_id: FAN, kind: 'event', item_id: '@upcoming:0', created_at: '2026-10-12T00:00:00Z' },
				{ user_id: QUIET, kind: 'event', item_id: '@upcoming:0', created_at: '2026-10-12T00:00:00Z' },
				{ user_id: FAN, kind: 'event', item_id: '@upcoming:5', created_at: '2026-10-12T00:00:00Z' },
				// Recent act/venue hypes by @beachlandfan (shows up in grogshopregular's Waves)
				{ user_id: FAN, kind: 'act', item_id: 'the-linda-lindas', created_at: minsAgo(300) },
				{ user_id: FAN, kind: 'act', item_id: 'oso-oso', created_at: minsAgo(290) },
				{ user_id: FAN, kind: 'venue', item_id: 'happy-dog', created_at: minsAgo(2000) }
			],
			conversations: seedConversations(),
			messages: seedMessages(),
			ripples: seedRipples(),
			ripple_mutes: [],
			reports: [],
			files: {} // 'bucket/path' → data: URL of uploaded images
		};
	}

	let db;
	try { db = JSON.parse(store.get(KEY.db)) || null; } catch (e) { db = null; }
	if (!db || !db.profiles) db = seed();
	// Test data saved before the official account and the new post format: add/replace them
	(function upgradeSavedData() {
		const fresh = seed();
		fresh.users.forEach(function (u) { if (!db.users.some(function (x) { return x.id === u.id; })) db.users.push(u); });
		fresh.profiles.forEach(function (p) { if (!db.profiles.some(function (x) { return x.id === p.id; })) db.profiles.push(p); });
		if (db.posts.some(function (p) { return !p.post_type; })) db.posts = fresh.posts;
		// Saved before the Messages page: add the sample conversations once
		if (!db.messagesSeeded) {
			if (!db.conversations.length) { db.conversations = fresh.conversations; db.messages = fresh.messages; }
			db.messagesSeeded = true;
		}
		db.conversations.forEach(function (c) { c.reads = c.reads || {}; c.left = c.left || {}; if (!('responded_at' in c)) c.responded_at = null; });
		// Saved before the Lineup page: sample ripples, and people for Waves
		if (!db.lineupSeeded) {
			db.ripples = db.ripples && db.ripples.length ? db.ripples : fresh.ripples;
			db.ripple_mutes = db.ripple_mutes || [];
			fresh.follows.forEach(function (f) {
				if (!db.follows.some(function (x) { return x.follower_id === f.follower_id && x.followee_id === f.followee_id; })) db.follows.push(f);
			});
			fresh.item_hypes.filter(function (h) { return h.user_id === FAN && h.kind !== 'event'; }).forEach(function (h) {
				if (!db.item_hypes.some(function (x) { return x.user_id === h.user_id && x.kind === h.kind && x.item_id === h.item_id; })) db.item_hypes.push(h);
			});
			db.lineupSeeded = true;
		}
	})();
	// Test data saved before "Neighborhood" became "Area"
	db.profiles.forEach(function (p) {
		// ...and before the Settings page
		const defaults = profileRow({});
		['profile_visibility', 'message_requests', 'email_message_requests', 'email_new_messages', 'email_weekly_roundup', 'email_ripples', 'show_max_badge', 'username_changed_at']
			.forEach(function (k) { if (!(k in p)) p[k] = defaults[k]; });
		if ('neighborhood' in p) { p.area = p.neighborhood; delete p.neighborhood; }
		if ('show_neighborhood' in p) { p.show_area = p.show_neighborhood; delete p.show_neighborhood; }
		// ...and before show_hypes was split into one switch per Hyped list
		if ('show_hypes' in p) {
			p.show_hyped_shows = p.show_hyped_acts = p.show_hyped_venues = p.show_hypes;
			delete p.show_hypes;
		}
	});

	function save() {
		if (!store.set(KEY.db, JSON.stringify(db))) {
			// Usually means big uploads filled localStorage: keep going, just without the images
			console.warn('[crwd-mock] localStorage is full — dropping saved images');
			db.files = {};
			store.set(KEY.db, JSON.stringify(db));
		}
	}

	let me = store.get(KEY.session);
	if (me && !db.users.some(function (u) { return u.id === me; })) { me = null; store.del(KEY.session); }

	// ------------------------------------------------------------------
	// Rules (a simplified copy of what the real database enforces)
	// ------------------------------------------------------------------

	const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
	const RESERVED = ['admin', 'administrator', 'mod', 'moderator', 'support', 'help', 'staff', 'team',
		'crwdsrfr', 'crwd_srfr', 'crowdsurfer', 'official', 'root', 'system', 'null',
		'settings', 'messages', 'board', 'featured', 'events', 'acts', 'venues', 'u'];
	const isReserved = function (n) { return RESERVED.indexOf(n) !== -1 || /^user_/.test(n); };
	const rule = function (message) { return { code: 'P0001', message: message }; };
	const clone = function (v) { return JSON.parse(JSON.stringify(v)); };
	const wait = function (v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 120 + Math.random() * 180); }); };
	const uid = function (prefix) { return prefix + '-' + Math.random().toString(16).slice(2, 14); };

	function blockedBetween(a, b) {
		return !!a && db.blocks.some(function (x) {
			return (x.blocker_id === a && x.blocked_id === b) || (x.blocker_id === b && x.blocked_id === a);
		});
	}
	function isPro(id) { return !!db.pro[id]; }

	// private.add_ripple: add to (or start) the recipient's card for this target + kind
	function addRipple(recipient, kind, postId, eventId, actor) {
		if (!recipient || !actor || recipient === actor || blockedBetween(recipient, actor)) return;
		const target = postId || eventId;
		if (db.ripple_mutes.some(function (m) { return m.user_id === recipient && m.kind === kind && m.target === target; })) return;
		const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
		db.ripples = db.ripples.filter(function (r) { return !(r.user_id === recipient && r.updated_at < cutoff); });
		const now = new Date().toISOString();
		const r = db.ripples.find(function (x) { return x.user_id === recipient && x.kind === kind && x.target === target; });
		if (r) {
			r.actor_ids = [actor].concat(r.actor_ids.filter(function (a) { return a !== actor; })).slice(0, 3);
			r.actor_count += 1;
			r.updated_at = now;
		} else {
			db.ripples.push({ id: uid('rip'), user_id: recipient, kind: kind, post_id: postId || null, event_id: eventId || null, target: target,
				actor_ids: [actor], actor_count: 1, created_at: now, updated_at: now });
		}
	}
	// The ripple triggers on post_hypes / comments
	function afterInsert(table, row) {
		if (table === 'post_hypes') {
			const post = db.posts.find(function (p) { return p.id === row.post_id; });
			if (post) addRipple(post.author_id, 'post_hype', post.id, null, row.user_id);
		}
		if (table === 'comments' && row.post_id) {
			const post = db.posts.find(function (p) { return p.id === row.post_id; });
			const author = post && post.author_id;
			addRipple(author, 'post_comment', row.post_id, null, row.author_id);
			uniq(db.comments.filter(function (c) { return c.post_id === row.post_id && c.id !== row.id; }).map(function (c) { return c.author_id; }))
				.filter(function (a) { return a !== row.author_id && a !== author; })
				.forEach(function (a) { addRipple(a, 'commented_post', row.post_id, null, row.author_id); });
		}
		if (table === 'comments' && row.event_id) {
			uniq(db.comments.filter(function (c) { return c.event_id === row.event_id && c.id !== row.id; }).map(function (c) { return c.author_id; }))
				.filter(function (a) { return a !== row.author_id; })
				.forEach(function (a) { addRipple(a, 'event_comment', null, row.event_id, row.author_id); });
		}
	}
	function uniq(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
	// The my_ripples view
	function myRipples() {
		if (!me) return [];
		const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
		return db.ripples.filter(function (r) {
			return r.user_id === me && r.updated_at > cutoff
				&& !db.ripple_mutes.some(function (m) { return m.user_id === me && m.kind === r.kind && m.target === r.target; });
		}).map(function (r) {
			const post = r.post_id && db.posts.find(function (p) { return p.id === r.post_id; });
			const author = post && db.profiles.find(function (p) { return p.id === post.author_id; });
			return {
				id: r.id, kind: r.kind, post_id: r.post_id, event_id: r.event_id, actor_count: r.actor_count,
				created_at: r.created_at, updated_at: r.updated_at,
				actor_usernames: r.actor_ids.filter(function (a) { return !blockedBetween(me, a); }).map(function (a) {
					const p = db.profiles.find(function (x) { return x.id === a; }); return p ? p.username : null;
				}).filter(Boolean),
				post_title: post ? post.title : null, post_destination: post ? post.destination : null,
				post_author_username: author ? author.username : null
			};
		});
	}

	// Still in a conversation (not left)
	function activeIn(c, id) { return c.members.indexOf(id) !== -1 && !c.left[id]; }
	function otherIn(c, id) { return c.members.find(function (m) { return m !== id; }); }
	// private.can_send: accepted, nobody left, no block
	function canSend(c) {
		return !!me && activeIn(c, me) && c.status === 'accepted' && !Object.keys(c.left).length && !blockedBetween(me, otherIn(c, me));
	}
	// The my_conversations view
	function myConversations() {
		if (!me) return [];
		return db.conversations.filter(function (c) { return activeIn(c, me) && !blockedBetween(me, otherIn(c, me)); }).map(function (c) {
			const other = otherIn(c, me);
			const iRequested = c.requester_id === me;
			const quiet = c.status === 'declined' && iRequested;
			const msgs = db.messages.filter(function (m) { return m.conversation_id === c.id; });
			const lastMsg = msgs.reduce(function (a, m) { return !a || m.created_at > a ? m.created_at : a; }, null);
			const responded = quiet ? null : (c.responded_at || null);
			const otherLeft = c.left[other] || null;
			const read = c.reads[me] || '';
			const p = db.profiles.find(function (x) { return x.id === other; });
			return {
				conversation_id: c.id, other_user_id: other, i_requested: iRequested,
				status: quiet ? 'pending' : c.status,
				last_read_at: c.reads[me] || null, last_message_at: lastMsg, created_at: c.created_at,
				other_username: p ? p.username : null,
				responded_at: responded, other_left_at: otherLeft,
				updated_at: [c.created_at, responded, otherLeft, lastMsg].filter(Boolean).sort().pop(),
				unread: msgs.some(function (m) { return m.sender_id === other && m.created_at > read; })
					|| (iRequested && c.status === 'accepted' && (c.responded_at || '') > read)
					|| (!!otherLeft && otherLeft > read)
			};
		});
	}

	// Settings → Privacy → Profile visibility (private.can_view_profile in the schema)
	function canView(owner) {
		if (owner === me) return true;
		const p = db.profiles.find(function (x) { return x.id === owner; });
		if (!p) return false;
		switch (p.profile_visibility || 'everyone') {
			case 'everyone': return true;
			case 'members': return !!me;
			case 'connections': return !!me && db.conversations.some(function (c) {
				return c.status === 'accepted' && activeIn(c, me) && activeIn(c, owner);
			});
			default: return false;
		}
	}

	// public_profiles view: privacy toggles + profile visibility applied, blocked people removed
	function publicProfiles() {
		return db.profiles.filter(function (p) { return !blockedBetween(me, p.id); }).map(function (p) {
			const pro = isPro(p.id);
			const ok = canView(p.id);
			const show = function (flag, value) { return ok && flag ? value : null; };
			return {
				id: p.id, username: p.username,
				display_name: show(p.show_display_name, p.display_name),
				status: show(p.show_status, p.status),
				avatar_path: show(true, p.avatar_path),
				hero_path: show(pro, p.hero_path),
				is_pro: ok && pro,
				anthem_url: show(p.show_anthem, p.anthem_url),
				anthem_title: show(p.show_anthem, p.anthem_title),
				bio: show(p.show_about, p.bio),
				about: show(p.show_about, p.about || {}),
				links: show(p.show_about, p.links),
				area: show(p.show_area, p.area),
				joined_at: show(p.show_joined, p.created_at),
				follower_count: show(p.show_follower_count || p.id === me,
					db.follows.filter(function (f) { return f.followee_id === p.id; }).length),
				posts_visible: ok && p.show_posts,
				hyped_shows_visible: ok && p.show_hyped_shows,
				hyped_acts_visible: ok && p.show_hyped_acts,
				hyped_venues_visible: ok && p.show_hyped_venues,
				profile_visible: ok,
				profile_visibility: p.profile_visibility || 'everyone',
				accepts_requests: (p.message_requests || 'everyone') === 'everyone',
				max_badge: pro && p.show_max_badge !== false
			};
		});
	}

	function visiblePosts() {
		return db.posts.filter(function (p) {
			if (p.author_id === me) return true;
			if (blockedBetween(me, p.author_id)) return false;
			const author = db.profiles.find(function (x) { return x.id === p.author_id; });
			return p.status === 'approved' && (p.destination === 'board' || (author && author.show_posts && canView(author.id)));
		});
	}

	function postStats() {
		return db.posts.map(function (p) {
			return {
				post_id: p.id,
				hype_count: db.post_hypes.filter(function (h) { return h.post_id === p.id; }).length,
				comment_count: db.comments.filter(function (c) { return c.post_id === p.id; }).length
			};
		});
	}

	// May add username_changed_at to the patch (like the validate_profile trigger)
	function validateProfile(row, patch) {
		if ('username_changed_at' in patch) return { code: '42501', message: 'permission denied for table profiles' };
		const next = Object.assign({}, row, patch);
		if ('username' in patch && patch.username !== row.username) {
			if (!USERNAME_RE.test(next.username || '')) return rule('Usernames are 3–24 lowercase letters, numbers or underscores');
			if (isReserved(next.username)) return rule('That username isn\'t available');
			if (db.profiles.some(function (p) { return p.id !== row.id && p.username === next.username; })) return { code: '23505', message: 'duplicate key value violates unique constraint "profiles_username_key"' };
			// One change every 30 days; replacing a placeholder (user_…) is free
			if (!/^user_[0-9a-f]{12}$/.test(row.username)) {
				const last = row.username_changed_at ? new Date(row.username_changed_at).getTime() : 0;
				if (last > Date.now() - 30 * 86400000) {
					return rule('You can change your username again on ' + new Date(last + 30 * 86400000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
				}
				patch.username_changed_at = new Date().toISOString();
			}
		}
		if (['profile_visibility'].some(function (k) { return k in patch; }) && ['everyone', 'members', 'connections', 'nobody'].indexOf(patch.profile_visibility) === -1) return { code: '23514', message: 'profile_visibility_valid' };
		if ('message_requests' in patch && ['everyone', 'nobody'].indexOf(patch.message_requests) === -1) return { code: '23514', message: 'message_requests_valid' };
		if (!isPro(row.id)) {
			if ('hero_path' in patch && patch.hero_path) return rule('Custom header images are a Max feature');
			if (patch.email_weekly_roundup && !row.email_weekly_roundup) return rule('The weekly roundup is a Max feature');
		}
		const len = function (v) { return v == null ? 0 : String(v).length; };
		if (next.display_name != null && (len(next.display_name) < 1 || len(next.display_name) > 40)) return { code: '23514', message: 'display_name length' };
		if (len(next.status) > 140 || len(next.bio) > 300 || len(next.area) > 40) return { code: '23514', message: 'text too long' };
		const links = next.links || [];
		if (links.length > 3) return { code: '23514', message: 'too many links' };
		if (links.some(function (l) { return !l || !l.label || l.label.length > 40 || !/^https:\/\/\S+$/.test(l.url || ''); })) {
			return rule('Each link needs a label (1–40 characters) and an https:// URL');
		}
		if (next.anthem_url && !/^https:\/\/([a-z0-9-]+\.)*(spotify\.com|youtube\.com|youtu\.be|soundcloud\.com|apple\.com)\//i.test(next.anthem_url)) {
			return { code: '23514', message: 'anthem host' };
		}
		return null;
	}

	// Who may read/write each table directly (row-level security, simplified)
	function readable(table) {
		switch (table) {
			case 'public_profiles': return publicProfiles();
			case 'posts': return visiblePosts();
			case 'post_stats': return postStats();
			case 'profiles': return db.profiles.filter(function (r) { return r.id === me; });
			case 'follows': return db.follows.filter(function (r) { return r.follower_id === me; });
			case 'blocks': return db.blocks.filter(function (r) { return r.blocker_id === me; });
			case 'item_hypes': return db.item_hypes.filter(function (r) { return r.user_id === me; });
			case 'post_hypes': return db.post_hypes.filter(function (r) {
				const post = db.posts.find(function (p) { return p.id === r.post_id; });
				return r.user_id === me || (post && post.author_id === me);
			});
			case 'comments': return db.comments.filter(function (c) {
				if (c.author_id === me) return true;
				if (blockedBetween(me, c.author_id)) return false;
				return c.event_id != null || visiblePosts().some(function (p) { return p.id === c.post_id; });
			});
			case 'item_stats': {
				const counts = {};
				db.item_hypes.forEach(function (h) { const k = h.kind + '|' + h.item_id; counts[k] = (counts[k] || 0) + 1; });
				return Object.keys(counts).map(function (k) { const parts = k.split('|'); return { kind: parts[0], item_id: parts[1], hype_count: counts[k] }; });
			}
			case 'event_comment_stats': {
				const counts = {};
				db.comments.forEach(function (c) { if (c.event_id != null) counts[c.event_id] = (counts[c.event_id] || 0) + 1; });
				return Object.keys(counts).map(function (k) { return { event_id: k, comment_count: counts[k] }; });
			}
			case 'entitlements': return me ? [{ user_id: me, tier: isPro(me) ? 'pro' : 'free', pro_until: null }] : [];
			case 'my_conversations': return myConversations();
			case 'my_ripples': return myRipples();
			case 'ripples': return db.ripples.filter(function (r) { return r.user_id === me; });
			case 'ripple_mutes': return db.ripple_mutes.filter(function (r) { return r.user_id === me; });
			case 'conversation_members': {
				const rows = [];
				db.conversations.filter(function (c) { return me && activeIn(c, me); }).forEach(function (c) {
					c.members.forEach(function (u) { rows.push({ conversation_id: c.id, user_id: u, last_read_at: c.reads[u] || null, left_at: c.left[u] || null }); });
				});
				return rows;
			}
			case 'messages': return db.messages.filter(function (m) {
				const c = db.conversations.find(function (x) { return x.id === m.conversation_id; });
				return c && me && activeIn(c, me);
			});
			default: return db[table] || [];
		}
	}

	function insertRow(table, row, inserted) {
		if (!me) return { code: '42501', message: 'new row violates row-level security policy' };
		row = Object.assign({ created_at: new Date().toISOString() }, row);
		switch (table) {
			case 'follows':
				row.follower_id = me;
				if (row.followee_id === me) return { code: '23514', message: 'no_self_follow' };
				if (db.follows.some(function (f) { return f.follower_id === me && f.followee_id === row.followee_id; })) return { code: '23505', message: 'duplicate key' };
				break;
			case 'blocks':
				row.blocker_id = me;
				if (db.blocks.some(function (b) { return b.blocker_id === me && b.blocked_id === row.blocked_id; })) return { code: '23505', message: 'duplicate key' };
				// Blocking removes follows both ways
				db.follows = db.follows.filter(function (f) {
					return !((f.follower_id === me && f.followee_id === row.blocked_id) || (f.followee_id === me && f.follower_id === row.blocked_id));
				});
				break;
			case 'item_hypes':
				row.user_id = me;
				if (db.item_hypes.some(function (h) { return h.user_id === me && h.kind === row.kind && h.item_id === row.item_id; })) return { code: '23505', message: 'duplicate key' };
				break;
			case 'post_hypes': {
				row.user_id = me;
				const post = visiblePosts().find(function (p) { return p.id === row.post_id; });
				if (!post || post.status !== 'approved') return { code: '42501', message: 'new row violates row-level security policy' };
				if (db.post_hypes.some(function (h) { return h.user_id === me && h.post_id === row.post_id; })) return { code: '23505', message: 'duplicate key' };
				break;
			}
			case 'reports':
				row.reporter_id = me; row.id = uid('r');
				break;
			case 'posts': {
				row.author_id = me; row.id = uid('p'); row.status = 'pending'; row.media = row.media || [];
				row = Object.assign({ opener: null, closer: null, hero: null, venue_id: null, show_date: null, act_ids: [], act_names: [], credit: null, legacy_id: null }, row);
				// Same shape rules as the database (posts constraints + prepare_new_post)
				const n = row.media.length;
				const title = String(row.title || '').trim();
				if (['board', 'profile'].indexOf(row.destination) === -1) return { code: '23514', message: 'destination' };
				if (title.length < 1 || title.length > 120) return { code: '23514', message: 'title_length' };
				if (n > 10 && db.admins.indexOf(me) === -1) return { code: 'P0001', message: 'too_many_media' };
				if (row.media.some(function (m) { return ['photo', 'video'].indexOf(m.type) === -1 || String(m.src).indexOf(me + '/') !== 0 || (m.thumb && String(m.thumb).indexOf(me + '/') !== 0) || String(m.caption || '').length > 1000; })) return { code: '23514', message: 'media_valid' };
				if (row.hero && (['photo', 'video'].indexOf(row.hero.type) === -1 || String(row.hero.src).indexOf(me + '/') !== 0)) return { code: '23514', message: 'hero_valid' };
				const shapeOk = (row.post_type === 'shot' && n === 1 && !row.hero) || (row.post_type === 'gallery' && n >= 2)
					|| (row.post_type === 'discussion' && n === 0 && !row.hero && String(row.opener || '').trim().length > 0);
				if (!shapeOk) return { code: '23514', message: 'post_shape' };
				if ((row.act_ids || []).length > 10) return { code: '23514', message: 'act_ids_valid' };
				row.act_names = row.act_names || [];
				if (row.act_names.length + row.act_ids.length > 10 || row.act_names.some(function (n) { const t = String(n || '').trim(); return t.length < 1 || t.length > 80; })) return { code: '23514', message: 'act_names_valid' };
				break;
			}
			case 'comments': {
				row.author_id = me; row.id = uid('c'); row.edited_at = null;
				const len = String(row.body || '').length;
				if (len < 1 || len > 1000) return { code: '23514', message: 'comment_length' };
				if ((row.post_id == null) === (row.event_id == null)) return { code: '23514', message: 'one_target' };
				const post = row.post_id && visiblePosts().find(function (p) { return p.id === row.post_id; });
				if (row.post_id && (!post || post.status !== 'approved')) return { code: '42501', message: 'new row violates row-level security policy' };
				break;
			}
			case 'ripple_mutes':
				row.user_id = me;
				if (['post_hype', 'post_comment', 'commented_post', 'event_comment'].indexOf(row.kind) === -1 || !row.target) return { code: '23514', message: 'ripple_mutes_kind_check' };
				if (db.ripple_mutes.some(function (m) { return m.user_id === me && m.kind === row.kind && m.target === row.target; })) return { code: '23505', message: 'duplicate key' };
				break;
			case 'messages': {
				row.sender_id = me; row.id = uid('m'); row.created_at = new Date().toISOString();
				const len = String(row.body || '').length;
				if (len < 1 || len > 2000) return { code: '23514', message: 'message_length' };
				const conv = db.conversations.find(function (c) { return c.id === row.conversation_id; });
				if (!conv || !canSend(conv)) return { code: '42501', message: 'new row violates row-level security policy for table "messages"' };
				break;
			}
			default:
				return { code: '42501', message: 'permission denied for table ' + table };
		}
		(db[table] = db[table] || []).push(row);
		afterInsert(table, row);
		if (inserted) inserted.push(row);
		return null;
	}

	// ------------------------------------------------------------------
	// Query builder (the parts of supabase-js the site uses)
	// ------------------------------------------------------------------

	function from(table) {
		let op = 'select', payload = null, wantRows = false, limit = null, single = null, wantCount = false;
		const filters = [], orders = [];

		const q = {
			select: function (cols, o) { if (op !== 'select') wantRows = true; if (o && o.count) wantCount = true; return q; },
			insert: function (row) { op = 'insert'; payload = row; return q; },
			update: function (row) { op = 'update'; payload = row; return q; },
			upsert: function (row) { op = 'insert'; payload = row; return q; },
			delete: function () { op = 'delete'; return q; },
			eq: function (c, v) { filters.push(function (r) { return r[c] === v; }); return q; },
			neq: function (c, v) { filters.push(function (r) { return r[c] !== v; }); return q; },
			lt: function (c, v) { filters.push(function (r) { return r[c] < v; }); return q; },
			gte: function (c, v) { filters.push(function (r) { return r[c] >= v; }); return q; },
			lte: function (c, v) { filters.push(function (r) { return r[c] <= v; }); return q; },
			overlaps: function (c, vs) { filters.push(function (r) { return (r[c] || []).some(function (x) { return vs.indexOf(x) !== -1; }); }); return q; },
			gt: function (c, v) { filters.push(function (r) { return r[c] > v; }); return q; },
			in: function (c, vs) { filters.push(function (r) { return vs.indexOf(r[c]) !== -1; }); return q; },
			is: function (c, v) { filters.push(function (r) { return (r[c] == null ? null : r[c]) === v; }); return q; },
			ilike: function (c, pattern) {
				const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
				filters.push(function (r) { return re.test(r[c] || ''); }); return q;
			},
			order: function (c, o) { orders.push([c, o && o.ascending === false ? -1 : 1]); return q; },
			limit: function (n) { limit = n; return q; },
			range: function (a, b) { limit = [a, b]; return q; },
			single: function () { single = 'single'; return q; },
			maybeSingle: function () { single = 'maybe'; return q; },
			then: function (res, rej) {
				return wait()
					.then(function () { return /^(item_hypes|item_stats|comments|event_comment_stats)$/.test(table) ? resolveEventSeeds() : null; })
					.then(run).then(res, rej);
			}
		};

		function run() {
			let error = null, data = null;

			if (op === 'insert') {
				const rows = Array.isArray(payload) ? payload : [payload];
				const inserted = [];
				for (let i = 0; i < rows.length && !error; i++) error = insertRow(table, rows[i], inserted);
				if (error) return { data: null, error: error };
				save();
				if (!wantRows && !single) return { data: null, error: null };
				data = clone(inserted);
				return single ? { data: data[0] || null, error: null } : { data: data, error: null };
			}

			let rows = readable(table).filter(function (r) { return filters.every(function (f) { return f(r); }); });

			if (op === 'delete') {
				if (!me) return { data: null, error: null };
				const admin = db.admins.indexOf(me) !== -1;
				const kill = rows.filter(function (r) {
					if (table === 'comments') {
						const post = db.posts.find(function (p) { return p.id === r.post_id; });
						return admin || r.author_id === me || (post && post.author_id === me);
					}
					if (table === 'posts') return admin || r.author_id === me;
					return true;
				});
				db[table] = (db[table] || []).filter(function (r) { return kill.indexOf(r) === -1; });
				if (table === 'posts') db.ripples = db.ripples.filter(function (r) { return !kill.some(function (p) { return p.id === r.post_id; }); });
				save();
				return { data: null, error: null };
			}

			if (op === 'update') {
				if (table === 'conversation_members') {
					if (Object.keys(payload).some(function (k) { return k !== 'last_read_at'; })) return { data: null, error: { code: '42501', message: 'permission denied for table conversation_members' } };
					rows.filter(function (r) { return r.user_id === me; }).forEach(function (r) {
						const c = db.conversations.find(function (x) { return x.id === r.conversation_id; });
						c.reads[me] = payload.last_read_at;
						r.last_read_at = payload.last_read_at;
					});
					save();
					return { data: wantRows ? clone(rows.filter(function (r) { return r.user_id === me; })) : null, error: null };
				}
				if (table !== 'profiles' && table !== 'posts') return { data: null, error: { code: '42501', message: 'permission denied' } };
				for (let i = 0; i < rows.length && !error; i++) {
					if (table === 'profiles') error = validateProfile(rows[i], payload);
					if (table === 'posts' && rows[i].author_id !== me) error = { code: '42501', message: 'permission denied' };
				}
				if (error) return { data: null, error: error };
				rows.forEach(function (r) {
					Object.assign(r, clone(payload));
					if (table === 'posts' && ['title', 'opener', 'closer', 'media', 'hero', 'post_type', 'venue_id', 'show_date', 'act_ids', 'credit'].some(function (k) { return k in payload; })) { r.status = 'pending'; r.edited_at = new Date().toISOString(); }
				});
				save();
				if (!wantRows && !single) return { data: null, error: null };
			}

			orders.slice().reverse().forEach(function (o) {
				rows = rows.slice().sort(function (a, b) { return (a[o[0]] < b[o[0]] ? -1 : a[o[0]] > b[o[0]] ? 1 : 0) * o[1]; });
			});
			const count = rows.length; // { count: 'exact' }: the total before paging
			if (Array.isArray(limit)) rows = rows.slice(limit[0], limit[1] + 1);
			else if (limit != null) rows = rows.slice(0, limit);
			data = clone(rows);

			if (single === 'single') {
				if (data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
				return { data: data[0], error: null };
			}
			if (single === 'maybe') return { data: data[0] || null, error: null };
			return wantCount ? { data: data, error: null, count: count } : { data: data, error: null };
		}
		return q;
	}

	// ------------------------------------------------------------------
	// RPC functions
	// ------------------------------------------------------------------

	let eventSeedsDone = false;
	async function resolveEventSeeds() {
		const isSeed = function (v) { return typeof v === 'string' && v.charAt(0) === '@'; };
		if (eventSeedsDone || !(db.item_hypes.some(function (h) { return isSeed(h.item_id); }) || db.comments.some(function (c) { return isSeed(c.event_id); }))) { eventSeedsDone = true; return; }
		eventSeedsDone = true;
		let events = [];
		try { const res = await fetch('/data/events.json'); events = (await res.json()).events || []; } catch (e) { /* leave as missing */ }
		const d = new Date();
		const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		const upcoming = events.filter(function (e) { return e.date >= today; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
		const past = events.filter(function (e) { return e.date < today; }).sort(function (a, b) { return a.date > b.date ? -1 : 1; });
		function resolve(v) {
			const m = /^@(upcoming|past):(\d+)$/.exec(v || '');
			if (!m) return v;
			const pick = (m[1] === 'upcoming' ? upcoming : past)[Number(m[2])];
			return pick ? pick.id : null;
		}
		db.item_hypes = db.item_hypes.filter(function (h) { h.item_id = resolve(h.item_id); return !!h.item_id; });
		db.comments = db.comments.filter(function (c) { if (c.event_id) c.event_id = resolve(c.event_id); return c.event_id !== null; });
		save();
	}

	async function rpc(name, args) {
		args = args || {};
		await wait();
		const ok = function (data) { return { data: data, error: null }; };
		const signedIn = function () { return me ? null : { data: null, error: { code: '42501', message: 'permission denied for function ' + name } }; };

		switch (name) {
			case 'username_available': {
				const n = String(args.name || '').toLowerCase();
				return ok(USERNAME_RE.test(n) && !isReserved(n) && !db.profiles.some(function (p) { return p.username === n; }));
			}
			case 'get_profile_hypes': {
				await resolveEventSeeds();
				const owner = db.profiles.find(function (p) { return p.id === args.profile_id; });
				if (!owner) return ok([]);
				const shown = { event: owner.show_hyped_shows, act: owner.show_hyped_acts, venue: owner.show_hyped_venues };
				const mine = owner.id === me;
				if (!mine && (blockedBetween(me, owner.id) || !canView(owner.id))) return ok([]);
				return ok(clone(db.item_hypes.filter(function (h) { return h.user_id === owner.id && (mine || shown[h.kind]); })
					.map(function (h) { return { kind: h.kind, item_id: h.item_id, created_at: h.created_at }; })));
			}
			case 'my_blocked_users': {
				const e = signedIn(); if (e) return e;
				return ok(db.blocks.filter(function (b) { return b.blocker_id === me; }).map(function (b) {
					const p = db.profiles.find(function (x) { return x.id === b.blocked_id; });
					return { user_id: b.blocked_id, username: p ? p.username : '?', blocked_at: b.created_at };
				}));
			}
			case 'start_conversation': {
				if (!me) return { data: null, error: rule('Sign in to send messages') };
				const other = args.other_user, text = String(args.first_message || '').trim();
				if (other === me) return { data: null, error: rule('You cannot message yourself') };
				if (!db.profiles.some(function (p) { return p.id === other; }) || blockedBetween(me, other)) return { data: null, error: rule('User not found') };
				if (text.length < 1 || text.length > 2000) return { data: null, error: rule('Message must be 1–2000 characters') };
				// A conversation either person left doesn't count: a new request starts a fresh one
				const existing = db.conversations.find(function (c) {
					return activeIn(c, me) && activeIn(c, other);
				});
				if (existing && existing.status !== 'accepted' && existing.requester_id === me) return { data: null, error: rule('Your message request is waiting for a reply') };
				const target = db.profiles.find(function (p) { return p.id === other; });
				if (!existing && target.message_requests === 'nobody') return { data: null, error: rule('This member isn\'t accepting message requests') };
				const conv = existing || { id: uid('conv'), requester_id: me, members: [me, other], status: 'pending', created_at: new Date().toISOString(), responded_at: null, reads: {}, left: {} };
				if (!existing) db.conversations.push(conv);
				else if (existing.status !== 'accepted') { existing.status = 'accepted'; existing.responded_at = new Date().toISOString(); } // messaging back accepts
				db.messages.push({ id: uid('m'), conversation_id: conv.id, sender_id: me, body: text, created_at: new Date().toISOString() });
				save();
				return ok(conv.id);
			}
			case 'respond_to_request': {
				const conv = db.conversations.find(function (c) { return c.id === args.conversation && c.status === 'pending' && c.requester_id !== me && activeIn(c, me); });
				if (!conv) return { data: null, error: rule('No pending request to respond to') };
				conv.status = args.accept ? 'accepted' : 'declined';
				conv.responded_at = new Date().toISOString();
				save();
				return ok(null);
			}
			case 'cancel_request': {
				const e = signedIn(); if (e) return e;
				const conv = db.conversations.find(function (c) { return c.id === args.conversation && c.requester_id === me && c.status !== 'accepted'; });
				if (!conv) return { data: null, error: rule('No request to cancel') };
				db.conversations = db.conversations.filter(function (c) { return c !== conv; });
				db.messages = db.messages.filter(function (m) { return m.conversation_id !== conv.id; });
				save();
				return ok(null);
			}
			case 'leave_conversation': {
				const e = signedIn(); if (e) return e;
				const conv = db.conversations.find(function (c) { return c.id === args.conversation && c.status === 'accepted' && activeIn(c, me); });
				if (!conv) return { data: null, error: rule('No conversation to leave') };
				conv.left[me] = new Date().toISOString();
				if (conv.members.every(function (m) { return conv.left[m]; })) {
					db.conversations = db.conversations.filter(function (c) { return c !== conv; });
					db.messages = db.messages.filter(function (m) { return m.conversation_id !== conv.id; });
				}
				save();
				return ok(null);
			}
			case 'followed_hypes': {
				const e = signedIn(); if (e) return e;
				const since = args.since || '';
				const following = db.follows.filter(function (f) { return f.follower_id === me; }).map(function (f) { return f.followee_id; });
				return ok(db.item_hypes.filter(function (h) {
					if (following.indexOf(h.user_id) === -1 || (h.kind !== 'act' && h.kind !== 'venue') || h.created_at < since) return false;
					const p = db.profiles.find(function (x) { return x.id === h.user_id; });
					return p && canView(p.id) && !blockedBetween(me, p.id) && (h.kind === 'act' ? p.show_hyped_acts : p.show_hyped_venues);
				}).sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 500).map(function (h) {
					return { user_id: h.user_id, username: db.profiles.find(function (x) { return x.id === h.user_id; }).username, kind: h.kind, item_id: h.item_id, created_at: h.created_at };
				}));
			}
			case 'export_my_data': {
				const e = signedIn(); if (e) return e;
				const user = db.users.find(function (u) { return u.id === me; });
				const name = function (id) { const p = db.profiles.find(function (x) { return x.id === id; }); return p ? p.username : null; };
				const strip = function (o, keys) { const c = clone(o); keys.forEach(function (k) { delete c[k]; }); return c; };
				return ok({
					exported_at: new Date().toISOString(),
					account: { email: user.email, created_at: user.created_at || null },
					profile: clone(db.profiles.find(function (p) { return p.id === me; })),
					membership: isPro(me) ? { tier: 'pro', max_until: null } : null,
					posts: db.posts.filter(function (p) { return p.author_id === me; }).map(function (p) { return strip(p, ['author_id']); }),
					comments: db.comments.filter(function (c) { return c.author_id === me; }).map(function (c) { return { post_id: c.post_id || null, event_id: c.event_id || null, body: c.body, created_at: c.created_at, edited_at: c.edited_at || null }; }),
					hyped: db.item_hypes.filter(function (h) { return h.user_id === me; }).map(function (h) { return { kind: h.kind, id: h.item_id, created_at: h.created_at }; }),
					hyped_posts: db.post_hypes.filter(function (h) { return h.user_id === me; }).map(function (h) { return { post_id: h.post_id, created_at: h.created_at || null }; }),
					hyped_members: db.follows.filter(function (f) { return f.follower_id === me; }).map(function (f) { return { username: name(f.followee_id), created_at: f.created_at }; }),
					blocked: db.blocks.filter(function (b) { return b.blocker_id === me; }).map(function (b) { return { username: name(b.blocked_id), created_at: b.created_at }; }),
					conversations: db.conversations.filter(function (c) { return c.members.indexOf(me) !== -1; }).map(function (c) {
						return { with: name(c.members.find(function (m) { return m !== me; })), status: c.status, started_by_me: c.requester_id === me, created_at: c.created_at,
							messages: db.messages.filter(function (m) { return m.conversation_id === c.id; }).map(function (m) { return { from: m.sender_id === me ? 'me' : 'them', body: m.body, created_at: m.created_at }; }) };
					}),
					reports: db.reports.filter(function (r) { return r.reporter_id === me; }).map(function (r) { return strip(r, ['reporter_id', 'id']); })
				});
			}
			case 'moderate_post': {
				if (db.admins.indexOf(me) === -1) return { data: null, error: rule('Not allowed') };
				if (['approved', 'rejected'].indexOf(args.decision) === -1) return { data: null, error: rule('Decision must be approved or rejected') };
				const post = db.posts.find(function (p) { return p.id === args.post; });
				if (!post) return { data: null, error: rule('Post not found') };
				post.status = args.decision; post.reviewed_at = new Date().toISOString();
				save();
				return ok(null);
			}
			default:
				return { data: null, error: { code: 'PGRST202', message: 'Mock has no function named ' + name } };
		}
	}

	// ------------------------------------------------------------------
	// Storage (uploads are kept as data: URLs so they display after reload)
	// ------------------------------------------------------------------

	const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#333"/><text x="200" y="210" fill="#888" font-family="sans-serif" font-size="28" text-anchor="middle">mock image</text></svg>');

	// A colored stand-in image labelled with the file name, so test pictures are easy to tell apart
	function placeholderFor(path) {
		let hash = 0;
		for (let i = 0; i < path.length; i++) hash = (hash * 31 + path.charCodeAt(i)) >>> 0;
		const name = String(path).split('/').pop().replace(/[<>&"']/g, '');
		return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="hsl(' + (hash % 360) + ',35%,28%)"/><text x="400" y="315" fill="#fff" font-family="sans-serif" font-size="40" text-anchor="middle">' + name + '</text></svg>');
	}

	function storageBucket(bucket) {
		return {
			getPublicUrl: function (path) {
				return { data: { publicUrl: db.files[bucket + '/' + path] || placeholderFor(path) } };
			},
			upload: async function (path, blob) {
				if (!me || path.split('/')[0] !== me) return { data: null, error: { statusCode: '403', message: 'new row violates row-level security policy' } };
				const limits = { avatars: 2, 'profile-heroes': 5, 'post-media': 50 };
				if (blob.size > (limits[bucket] || 10) * 1024 * 1024) return { data: null, error: { statusCode: '413', message: 'The object exceeded the maximum allowed size' } };
				if (bucket === 'profile-heroes' && !isPro(me)) return { data: null, error: { statusCode: '403', message: 'new row violates row-level security policy' } };
				const dataUrl = await new Promise(function (resolve) {
					const reader = new FileReader();
					reader.onload = function () { resolve(reader.result); };
					reader.onerror = function () { resolve(PLACEHOLDER_IMG); };
					reader.readAsDataURL(blob);
				});
				db.files[bucket + '/' + path] = dataUrl;
				save();
				return { data: { path: path }, error: null };
			},
			remove: async function (paths) {
				(paths || []).forEach(function (p) { if (p.split('/')[0] === me) delete db.files[bucket + '/' + p]; });
				save();
				return { data: null, error: null };
			}
		};
	}

	// ------------------------------------------------------------------
	// Auth (magic links go to the mock inbox in the MOCK bar)
	// ------------------------------------------------------------------

	const authListeners = [];
	let freshSignInAt = 0; // last time a code was entered (the delete-account function needs a recent one)
	function sessionFor(id) {
		const u = db.users.find(function (x) { return x.id === id; });
		return u ? { access_token: 'mock', user: { id: u.id, email: u.email, new_email: u.new_email || undefined, email_confirmed_at: u.created_at || '2026-01-01T00:00:00Z' } } : null;
	}
	function emitAuth(event) {
		const session = sessionFor(me);
		authListeners.forEach(function (cb) { setTimeout(function () { cb(event, session); }, 0); });
	}

	const auth = {
		onAuthStateChange: function (cb) {
			authListeners.push(cb);
			setTimeout(function () { cb('INITIAL_SESSION', sessionFor(me)); }, 40);
			return { data: { subscription: { unsubscribe: function () { const i = authListeners.indexOf(cb); if (i !== -1) authListeners.splice(i, 1); } } } };
		},
		getSession: async function () { return { data: { session: sessionFor(me) }, error: null }; },
		getUser: async function () { const s = sessionFor(me); return { data: { user: s && s.user }, error: null }; },
		signInWithOtp: async function (params) {
			await wait();
			const email = String(params.email || '').trim().toLowerCase();
			const opts = params.options || {};
			if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: { code: 'email_address_invalid', message: 'Email address is invalid' } };
			if (email.indexOf('ratelimit') === 0) return { error: { code: 'over_email_send_rate_limit', status: 429, message: 'For security purposes, you can only request this after 60 seconds.' } };
			const existing = db.users.find(function (u) { return u.email === email; });
			if (!existing && opts.shouldCreateUser === false) return { error: { code: 'otp_disabled', message: 'Signups not allowed for otp' } };
			// Real Supabase sends an email (a link, plus a code if the template has {{ .Token }});
			// the mock puts both in the MOCK bar instead
			const code = String(Math.floor(100000 + Math.random() * 900000));
			store.set(KEY.inbox, JSON.stringify({ email: email, code: code, username: (opts.data && opts.data.username) || null, redirect: opts.emailRedirectTo || window.location.href }));
			refreshBar();
			return { data: {}, error: null };
		},
		// Entering the emailed code signs that account in (fresh)
		verifyOtp: async function (params) {
			await wait();
			let mail;
			try { mail = JSON.parse(store.get(KEY.inbox)); } catch (e) { mail = null; }
			const email = String(params.email || '').trim().toLowerCase();
			if (!mail || mail.email !== email || mail.code !== String(params.token || '')) {
				return { data: null, error: { code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' } };
			}
			const user = db.users.find(function (u) { return u.email === email; });
			if (!user) return { data: null, error: { code: 'otp_expired', status: 403, message: 'Token has expired or is invalid' } };
			store.del(KEY.inbox);
			me = user.id; store.set(KEY.session, me);
			freshSignInAt = Date.now();
			emitAuth('SIGNED_IN');
			refreshBar();
			return { data: { session: sessionFor(me), user: sessionFor(me).user }, error: null };
		},
		signOut: async function () {
			me = null; store.del(KEY.session);
			emitAuth('SIGNED_OUT');
			refreshBar();
			return { error: null };
		},
		updateUser: async function (attrs) {
			if (!me) return { data: null, error: { message: 'Not signed in' } };
			if (attrs.email) {
				const email = attrs.email.toLowerCase();
				if (db.users.some(function (u) { return u.email === email && u.id !== me; })) return { data: null, error: { code: 'email_exists', status: 422, message: 'A user with this email address has already been registered' } };
				// Secure email change: confirmation link lands in the mock inbox (one click stands in for both emails)
				db.users.find(function (u) { return u.id === me; }).new_email = email;
				save();
				store.set(KEY.inbox, JSON.stringify({ email: email, changeEmailFor: me, redirect: window.location.href }));
				refreshBar();
				emitAuth('USER_UPDATED');
			}
			return { data: { user: sessionFor(me).user }, error: null };
		}
	};

	// What "clicking the link in the email" does
	function openMagicLink() {
		let mail;
		try { mail = JSON.parse(store.get(KEY.inbox)); } catch (e) { mail = null; }
		if (!mail) return;
		store.del(KEY.inbox);

		if (mail.changeEmailFor) {
			const u = db.users.find(function (x) { return x.id === mail.changeEmailFor; });
			if (u) { u.email = mail.email; delete u.new_email; }
			save();
			window.location.href = mail.redirect.split('#')[0];
			return;
		}

		let user = db.users.find(function (u) { return u.email === mail.email; });
		if (!user) {
			// New account: same as handle_new_user in the schema — use the chosen username if it's
			// still valid and free, otherwise a placeholder that the site asks them to replace
			user = { id: uid('u'), email: mail.email, created_at: new Date().toISOString() };
			const wanted = String(mail.username || '').toLowerCase();
			const usable = USERNAME_RE.test(wanted) && !isReserved(wanted) && !db.profiles.some(function (p) { return p.username === wanted; });
			db.users.push(user);
			db.profiles.push(profileRow({ id: user.id, username: usable ? wanted : 'user_' + Math.random().toString(16).slice(2, 14).padEnd(12, '0') }));
			save();
		}
		store.set(KEY.session, user.id);
		window.location.href = mail.redirect.split('#')[0];
	}

	// Edge Functions (only delete-account so far — see supabase/functions/delete-account)
	const functions = {
		invoke: async function (name) {
			await wait();
			if (name !== 'delete-account') return { data: null, error: { message: 'Mock has no function named ' + name } };
			if (!me) return { data: null, error: { message: 'Not signed in', context: { status: 401 } } };
			if (Date.now() - freshSignInAt > 10 * 60 * 1000) return { data: null, error: { message: 'Sign in again with a code first', context: { status: 403 } } };
			// Same as deleting the auth user: everything that belongs to them goes (on delete cascade)
			const gone = me;
			const convs = db.conversations.filter(function (c) { return c.members.indexOf(gone) !== -1; }).map(function (c) { return c.id; });
			const posts = db.posts.filter(function (p) { return p.author_id === gone; }).map(function (p) { return p.id; });
			db.users = db.users.filter(function (u) { return u.id !== gone; });
			db.profiles = db.profiles.filter(function (p) { return p.id !== gone; });
			db.posts = db.posts.filter(function (p) { return p.author_id !== gone; });
			db.post_hypes = db.post_hypes.filter(function (h) { return h.user_id !== gone && posts.indexOf(h.post_id) === -1; });
			db.comments = db.comments.filter(function (c) { return c.author_id !== gone && posts.indexOf(c.post_id) === -1; });
			db.item_hypes = db.item_hypes.filter(function (h) { return h.user_id !== gone; });
			db.follows = db.follows.filter(function (f) { return f.follower_id !== gone && f.followee_id !== gone; });
			db.blocks = db.blocks.filter(function (b) { return b.blocker_id !== gone && b.blocked_id !== gone; });
			db.conversations = db.conversations.filter(function (c) { return convs.indexOf(c.id) === -1; });
			db.messages = db.messages.filter(function (m) { return convs.indexOf(m.conversation_id) === -1; });
			db.reports.forEach(function (r) { if (r.reporter_id === gone) r.reporter_id = null; });
			delete db.pro[gone];
			db.admins = db.admins.filter(function (a) { return a !== gone; });
			Object.keys(db.files).forEach(function (k) { if (k.split('/')[1] === gone) delete db.files[k]; });
			save();
			return { data: { deleted: true }, error: null };
		}
	};

	window.supabase = {
		createClient: function () {
			return { auth: auth, from: from, rpc: rpc, functions: functions, storage: { from: storageBucket }, channel: function () {
				const ch = { on: function () { return ch; }, subscribe: function () { return ch; }, unsubscribe: function () {} };
				return ch;
			}, removeChannel: function () {} };
		},
		__mock: true
	};

	// For poking at the data from the browser console: CrwdMock.db, CrwdMock.reset()
	window.CrwdMock = { get db() { return db; }, save: save, reset: reset, openMagicLink: openMagicLink };

	function reset() {
		store.del(KEY.db); store.del(KEY.session); store.del(KEY.inbox);
		window.location.reload();
	}

	// ------------------------------------------------------------------
	// MOCK bar
	// ------------------------------------------------------------------

	function refreshBar() { if (bar) drawBar(); }

	function drawBar() {
		if (!document.body) return;
		if (!bar) {
			bar = document.createElement('div');
			bar.id = 'crwdMockBar';
			bar.setAttribute('role', 'region');
			bar.setAttribute('aria-label', 'Local test controls');
			const css = document.createElement('style');
			css.textContent =
				'#crwdMockBar{position:fixed;left:12px;bottom:12px;z-index:2147483000;display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:calc(100vw - 24px);' +
				'padding:8px 10px;background:#111;border:1px solid #f5d400;border-radius:9px;color:#fff;font:12px/1.3 "Space Mono",ui-monospace,monospace;box-shadow:0 4px 18px rgba(0,0,0,.5);transition:none}' +
				'#crwdMockBar *{transition:none;font:inherit;box-sizing:border-box;margin:0;width:auto;height:auto;min-height:0;letter-spacing:normal;text-transform:none}' +
				'#crwdMockBar input[type=checkbox]{width:14px;height:14px;accent-color:#f5d400}' +
				'#crwdMockBar .mTag{background:#f5d400;color:#111;font-weight:700;padding:2px 6px;border-radius:5px;border:0;cursor:pointer}' +
				'#crwdMockBar select,#crwdMockBar button.mBtn{background:#333;color:#fff;border:1px solid #555;border-radius:6px;padding:3px 6px;cursor:pointer}' +
				'#crwdMockBar button.mBtn:hover{border-color:#fff}' +
				'#crwdMockBar .mMail{background:#4ad6c4;color:#111;border-color:#4ad6c4;font-weight:700;animation:crwdMockPulse 1.2s ease-in-out infinite}' +
				'#crwdMockBar label{display:flex;align-items:center;gap:4px;cursor:pointer}' +
				'#crwdMockBar.isCollapsed > :not(.mTag){display:none}' +
				'#crwdMockBar.isOff{border-color:#555}#crwdMockBar.isOff .mTag{background:#555;color:#fff}' +
				'@keyframes crwdMockPulse{50%{opacity:.6}}';
			document.head.appendChild(css);
			document.body.appendChild(bar);
		}
		bar.replaceChildren();
		bar.className = (store.get(KEY.collapsed) === '1' ? 'isCollapsed ' : '') + (OFF ? 'isOff' : '');

		const tag = document.createElement('button');
		tag.type = 'button';
		tag.className = 'mTag';
		tag.textContent = OFF ? 'REAL' : 'MOCK';
		tag.title = 'Show/hide test controls';
		tag.addEventListener('click', function () {
			store.set(KEY.collapsed, store.get(KEY.collapsed) === '1' ? '0' : '1');
			drawBar();
		});
		bar.appendChild(tag);

		if (OFF) {
			bar.appendChild(text('Using the real Supabase project'));
			bar.appendChild(button('Use mock data', function () { store.del(KEY.off); window.location.reload(); }));
			return;
		}

		// Signed in as…
		const who = document.createElement('select');
		who.setAttribute('aria-label', 'Signed in as');
		who.appendChild(new Option('Guest (signed out)', ''));
		db.profiles.forEach(function (p) {
			const tags = [isPro(p.id) ? 'Max' : null, db.admins.indexOf(p.id) !== -1 ? 'admin' : null].filter(Boolean);
			who.appendChild(new Option('@' + p.username + (tags.length ? ' (' + tags.join(', ') + ')' : ''), p.id));
		});
		who.value = me || '';
		who.addEventListener('change', function () {
			if (who.value) store.set(KEY.session, who.value); else store.del(KEY.session);
			window.location.reload();
		});
		bar.appendChild(who);

		// Max on/off for whoever is signed in
		if (me) {
			const pro = document.createElement('label');
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.checked = isPro(me);
			box.addEventListener('change', function () {
				db.pro[me] = box.checked; save(); window.location.reload();
			});
			pro.appendChild(box);
			pro.appendChild(document.createTextNode('Max'));
			bar.appendChild(pro);
		}

		// Mock inbox
		let mail = null;
		try { mail = JSON.parse(store.get(KEY.inbox)); } catch (e) {}
		if (mail) {
			const b = button('📬 Open link sent to ' + mail.email, openMagicLink);
			b.classList.add('mMail');
			bar.appendChild(b);
			if (mail.code) {
				const c = text('Code: ' + mail.code);
				c.className = 'mCode';
				bar.appendChild(c);
			}
		}

		bar.appendChild(button('Reset data', function () {
			if (window.confirm('Reset all mock data and sign out?')) reset();
		}));
		bar.appendChild(button('Use real Supabase', function () { store.set(KEY.off, '1'); window.location.reload(); }));
	}

	function button(label, onClick) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'mBtn';
		b.textContent = label;
		b.addEventListener('click', onClick);
		return b;
	}
	function text(t) { const s = document.createElement('span'); s.textContent = t; return s; }
})();
