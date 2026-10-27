/*
 * js/crwd-social.js — Hype and comment buttons, and the comments modal.
 *
 * Types: 'post' and 'event' (hype + comments), 'act' and 'venue' (hype only).
 *
 * Load after crwd-ui.js (deferred), before the page script:
 *   supabase-js → crwd-core.js → nav.js → crwd-ui.js → crwd-social.js → page script
 *
 *   CrwdSocial.loadStats(type, ids)  → Promise<{ [id]: { hypes, comments, hyped } }>
 *   CrwdSocial.reactions(opts)       → <div> with a hype button and a comment button
 *       opts: { type, id, hypes, comments, hyped, title, ownerId }
 *         title   — short text shown at the top of the comments modal (optional)
 *         ownerId — the post author's id: they may remove comments on their post (optional)
 *   CrwdSocial.hypeButton(opts)      → just the hype button
 *       opts: { type, id, hypes, hyped, large, onChange({ hypes, hyped }) }
 *   CrwdSocial.loadAllHypeCounts(kind) → Promise<{ [id]: count }> for every hyped act/venue/show
 *   CrwdSocial.openComments(opts)    → opens the comments modal on its own
 *   CrwdSocial.commentsPanel(el, opts) → the same comments list + composer, inline in `el`
 *       opts: { type, id, ownerId, onCountChange(n) }
 *   CrwdSocial.commentButton(opts)   → comment-count button; opts: { count, label, onClick }
 *   CrwdSocial.openReport(target)    → report dialog; target: { type: 'post' | 'comment', id, who }
 *
 * Counts are public; who hyped is not shown here.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const ui = window.CrwdUI;
	const MAX_COMMENT = 1000;
	const MAX_REPORT = 1000;
	const REPORT_REASONS = [
		['spam', 'Spam'],
		['harassment', 'Harassment or bullying'],
		['hate', 'Hate speech'],
		['inappropriate', 'Inappropriate content'],
		['other', 'Something else']
	];

	// How each kind of thing is stored
	const TYPES = {
		post: {
			noun: 'post',
			hypeInsert: function (id) { return core.sb.from('post_hypes').insert({ post_id: id }); },
			hypeDelete: function (id) { return core.sb.from('post_hypes').delete().eq('user_id', core.user.id).eq('post_id', id); },
			commentKey: 'post_id'
		},
		event: itemType('event', 'show', 'event_id'),
		act: itemType('act', 'act', null),       // hype only
		venue: itemType('venue', 'venue', null)  // hype only
	};

	// Shows, acts and venues all live in item_hypes, told apart by kind
	function itemType(kind, noun, commentKey) {
		return {
			noun: noun,
			kind: kind,
			hypeInsert: function (id) { return core.sb.from('item_hypes').insert({ kind: kind, item_id: id }); },
			hypeDelete: function (id) { return core.sb.from('item_hypes').delete().eq('user_id', core.user.id).eq('kind', kind).eq('item_id', id); },
			commentKey: commentKey
		};
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	const compact = (window.Intl && Intl.NumberFormat) ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
	function shortCount(n) {
		n = Number(n) || 0;
		return n >= 1000 && compact ? compact.format(n) : String(n);
	}
	function plural(n, word) {
		return Number(n).toLocaleString() + ' ' + word + (Number(n) === 1 ? '' : 's');
	}

	function friendly(error) {
		return core.friendlyError ? core.friendlyError(error).message : 'Something went wrong. Please try again.';
	}

	// How long ago a comment was posted:
	// Just now · 5 mins ago · 1 hr ago · 3 days ago · 2 months ago · 1 year ago
	function ago(iso) {
		const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
		const unit = function (n, word, words) { return n + ' ' + (n === 1 ? word : words) + ' ago'; };
		if (secs < 60) return 'Just now';
		const mins = Math.floor(secs / 60);
		if (mins < 60) return unit(mins, 'min', 'mins');
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return unit(hrs, 'hr', 'hrs');
		const days = Math.floor(hrs / 24);
		if (days <= 31) return unit(days, 'day', 'days');
		if (days < 365) return unit(Math.min(11, Math.max(1, Math.floor(days / 30.44))), 'month', 'months');
		return unit(Math.max(1, Math.floor(days / 365)), 'year', 'years');
	}

	// ------------------------------------------------------------------
	// Counts + whether I've hyped each one
	// ------------------------------------------------------------------

	// Big lists (a week of shows) are asked for in chunks so request URLs stay short
	const CHUNK = 100;

	async function loadStats(type, ids) {
		const out = {};
		ids.forEach(function (id) { out[id] = { hypes: 0, comments: 0, hyped: false }; });
		if (!ids.length || !core.enabled) return out;

		const chunks = [];
		for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
		await Promise.all(chunks.map(function (part) { return loadChunk(type, part, out); }));
		return out;
	}

	async function loadChunk(type, ids, out) {
		let statsQ, commentsQ = null, mineQ = null;
		if (type === 'post') {
			statsQ = core.sb.from('post_stats').select('post_id, hype_count, comment_count').in('post_id', ids);
			if (core.user) mineQ = core.sb.from('post_hypes').select('post_id').eq('user_id', core.user.id).in('post_id', ids);
		} else {
			statsQ = core.sb.from('item_stats').select('item_id, hype_count').eq('kind', type).in('item_id', ids);
			if (type === 'event') commentsQ = core.sb.from('event_comment_stats').select('event_id, comment_count').in('event_id', ids);
			if (core.user) mineQ = core.sb.from('item_hypes').select('item_id').eq('user_id', core.user.id).eq('kind', type).in('item_id', ids);
		}

		const results = await Promise.all([statsQ, commentsQ, mineQ]);
		const stats = results[0], comments = results[1], mine = results[2];

		((stats && stats.data) || []).forEach(function (s) {
			const id = s.post_id || s.item_id;
			if (!out[id]) return;
			out[id].hypes = Number(s.hype_count) || 0;
			if (s.comment_count != null) out[id].comments = Number(s.comment_count) || 0;
		});
		((comments && comments.data) || []).forEach(function (c) {
			if (out[c.event_id]) out[c.event_id].comments = Number(c.comment_count) || 0;
		});
		((mine && mine.data) || []).forEach(function (m) {
			const id = m.post_id || m.item_id;
			if (out[id]) out[id].hyped = true;
		});
	}

	// ------------------------------------------------------------------
	// Buttons
	// ------------------------------------------------------------------

	// Zero shows just the icon; the number appears from 1 up
	function setCount(c, n) {
		c.count.textContent = n > 0 ? shortCount(n) : '';
		c.button.classList.toggle('isEmpty', !(n > 0));
	}

	function chip(iconClass, label) {
		const b = el('button', 'crwdChip');
		b.type = 'button';
		b.appendChild(el('span', 'icon ' + iconClass));
		const count = el('span', 'crwdChipCount');
		b.appendChild(count);
		b.setAttribute('aria-label', label);
		return { button: b, count: count };
	}

	// Every hype count of one kind ('event' | 'act' | 'venue') that's above zero,
	// as { id: count }. One request, for pages that show counts on many tiles.
	async function loadAllHypeCounts(kind) {
		const out = {};
		if (!core.enabled) return out;
		const { data, error } = await core.sb.from('item_stats').select('item_id, hype_count').eq('kind', kind);
		if (error) { console.warn('[social]', error); return out; }
		(data || []).forEach(function (r) { if (Number(r.hype_count) > 0) out[r.item_id] = Number(r.hype_count); });
		return out;
	}

	// The hype button on its own.
	//   opts: { type, id, hypes, hyped, large, onChange(state) }
	//   large — the bigger version (act/venue modals)
	//   onChange — called with { hypes, hyped } after each click, e.g. to update a tile
	function hypeButton(opts) {
		const kind = TYPES[opts.type];
		const state = { hypes: Number(opts.hypes) || 0, hyped: !!opts.hyped };
		const hype = chip('iconHype', '');
		hype.button.classList.add('crwdChipHype');
		if (opts.large) hype.button.classList.add('crwdChipLarge');
		let busy = false;
		function drawHype() {
			setCount(hype, state.hypes);
			hype.button.classList.toggle('isActive', state.hyped);
			hype.button.setAttribute('aria-pressed', state.hyped ? 'true' : 'false');
			hype.button.setAttribute('aria-label', (state.hyped ? 'Remove your hype' : 'Hype this ' + kind.noun) + ' (' + plural(state.hypes, 'hype') + ')');
		}
		function changed() {
			drawHype();
			if (opts.onChange) opts.onChange({ hypes: state.hypes, hyped: state.hyped });
		}
		hype.button.addEventListener('click', async function () {
			if (!ui.requireSignIn() || busy) return;
			busy = true;
			const was = state.hyped;
			state.hyped = !was;
			state.hypes += was ? -1 : 1;
			changed();
			hype.button.classList.toggle('isPopping', !was);
			const { error } = await (was ? kind.hypeDelete(opts.id) : kind.hypeInsert(opts.id));
			busy = false;
			if (error && error.code !== '23505') { // 23505 = already hyped, which is what we wanted
				state.hyped = was;
				state.hypes += was ? 1 : -1;
				changed();
				alert(friendly(error));
			}
		});
		hype.button.addEventListener('animationend', function () { hype.button.classList.remove('isPopping'); });
		drawHype();
		return hype.button;
	}

	function reactions(opts) {
		const state = { comments: Number(opts.comments) || 0 };
		const wrap = el('div', 'crwdReactions');
		const hype = hypeButton({ type: opts.type, id: opts.id, hypes: opts.hypes, hyped: opts.hyped });

		// Comments
		const talk = chip('iconComment', '');
		talk.button.classList.add('crwdChipComment');
		function drawTalk() {
			setCount(talk, state.comments);
			talk.button.setAttribute('aria-label', plural(state.comments, 'comment') + ' — open comments');
		}
		talk.button.addEventListener('click', function () {
			openComments({
				type: opts.type, id: opts.id, title: opts.title, ownerId: opts.ownerId,
				onCountChange: function (n) { state.comments = n; drawTalk(); }
			});
		});
		drawTalk();

		wrap.append(hype, talk.button);
		return wrap;
	}

	// ------------------------------------------------------------------
	// Form pieces (same markup as the account modals in crwd-ui.js, so they
	// look the same in a modal or inline on a page)
	// ------------------------------------------------------------------

	const form = {
		title: function (html) { const h = el('h2', 'crwdModalTitle'); h.id = 'crwdModalTitle'; h.innerHTML = html; return h; }, // static copy only
		errorBox: function () { const p = el('p', 'crwdFormError'); p.setAttribute('role', 'alert'); p.hidden = true; return p; },
		showError: function (box, msg) { box.textContent = msg || ''; box.hidden = !msg; },
		submitButton: function (label) { const b = el('button', 'crwdButton', label); b.type = 'submit'; return b; },
		setBusy: function (b, busy, label) { b.disabled = busy; b.textContent = label; }
	};

	// ------------------------------------------------------------------
	// Comments list + composer
	// Used inside the comments modal (shows, profile posts) and inline under
	// a post (the Board). Oldest first, COMMENTS_PAGE at a time with a
	// "Load more" button for the rest.
	//   hooks.heading         — title + count at the top (the modal)
	//   hooks.collapsedComposer — the comment box stays behind an "Add a comment"
	//                           button, and closes again after posting (the Board)
	//   hooks.onReport(c)     — how reporting a comment opens
	// ------------------------------------------------------------------

	const COMMENTS_PAGE = 20;

	function commentsView(opts, hooks) {
		const kind = TYPES[opts.type];
		let comments = null;  // loaded so far, oldest first: [{ id, author_id, body, created_at, edited_at, author }]
		let total = 0;        // how many there are in all
		let hasMore = false;  // older pages loaded, newer ones still to come
		let loadingMore = false;
		let justPosted = [];  // posted while newer pages weren't loaded yet: shown at the very end

		const view = el('div', 'crwdCommentsView');
		let totalEl = null;
		if (hooks.heading) {
			const head = el('div', 'crwdCommentsHead');
			const h = form.title('Comments');
			h.tabIndex = -1;
			h.setAttribute('data-autofocus', ''); // start at the top, not in the text box (no surprise keyboard on phones)
			head.appendChild(h);
			totalEl = el('span', 'crwdCommentsTotal');
			head.appendChild(totalEl);
			view.appendChild(head);
			if (opts.title) view.appendChild(el('p', 'crwdCommentsContext', opts.title));
		}

		const list = el('ul', 'crwdComments');
		list.setAttribute('aria-live', 'polite');
		view.appendChild(list);

		const moreBtn = el('button', 'crwdCommentsMore', 'Load more comments');
		moreBtn.type = 'button';
		moreBtn.hidden = true;
		moreBtn.addEventListener('click', loadMore);
		view.appendChild(moreBtn);

		const after = el('ul', 'crwdComments crwdCommentsJustPosted'); // see justPosted
		view.appendChild(after);

		view.appendChild(composerArea());

		function shownCount() { return (comments ? comments.length : 0) + justPosted.length; }

		function drawTotal() {
			if (comments === null || comments === false) return;
			if (totalEl) totalEl.textContent = String(total);
			if (opts.onCountChange) opts.onCountChange(total);
		}

		function drawList() {
			list.replaceChildren();
			after.replaceChildren();
			moreBtn.hidden = true;
			if (comments === null) { list.appendChild(el('li', 'crwdCommentsEmpty', 'Loading comments…')); return; }
			if (comments === false) { list.appendChild(el('li', 'crwdCommentsEmpty', 'Comments couldn\'t load right now.')); return; }
			if (!shownCount()) {
				list.appendChild(el('li', 'crwdCommentsEmpty', core.user ? 'No comments yet. Start the conversation.' : 'No comments yet.'));
				return;
			}
			comments.forEach(function (c) { list.appendChild(commentItem(c)); });
			justPosted.forEach(function (c) { after.appendChild(commentItem(c)); });
			moreBtn.hidden = !hasMore;
			moreBtn.disabled = loadingMore;
			moreBtn.textContent = loadingMore ? 'Loading…' : 'Load more comments (' + Math.max(total - shownCount(), 0) + ')';
		}

		function commentItem(c) {
			const li = el('li', 'crwdComment');
			const avatar = el('span', 'crwdCommentAvatar');
			const src = c.author && c.author.avatar_path ? core.avatarUrl(c.author.avatar_path) : null;
			if (src) {
				const img = el('img');
				img.src = src; img.alt = ''; img.loading = 'lazy';
				avatar.appendChild(img);
			} else {
				avatar.appendChild(el('span', 'icon crwdCommentAvatarIcon'));
			}
			li.appendChild(avatar);

			const main = el('div', 'crwdCommentMain');
			const meta = el('div', 'crwdCommentMeta');
			if (c.author) {
				const who = el('a', 'crwdCommentUser', '@' + c.author.username);
				who.href = core.profileUrl(c.author.username);
				if (c.author.max_badge && ui && typeof ui.maxBadge === 'function') who.appendChild(ui.maxBadge());
				meta.appendChild(who);
			} else {
				meta.appendChild(el('span', 'crwdCommentUser', 'Former member'));
			}
			const time = el('time', 'crwdCommentTime', ago(c.created_at) + (c.edited_at ? ' · edited' : ''));
			time.dateTime = c.created_at;
			time.title = new Date(c.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
			meta.appendChild(time);
			main.appendChild(meta);
			main.appendChild(el('p', 'crwdCommentBody', c.body));

			// Actions: remove your own (or any on your post); report anyone else's
			const me = core.user && core.user.id;
			const actions = el('div', 'crwdCommentActions');
			if (me && (c.author_id === me || opts.ownerId === me)) {
				const del = el('button', 'crwdCommentAction', c.author_id === me ? 'Delete' : 'Remove');
				del.type = 'button';
				del.addEventListener('click', function () { confirmDelete(c, actions); });
				actions.appendChild(del);
			}
			if (c.author_id !== me) {
				const rep = el('button', 'crwdCommentAction', 'Report');
				rep.type = 'button';
				rep.addEventListener('click', function () {
					if (!ui.requireSignIn()) return;
					hooks.onReport(c);
				});
				actions.appendChild(rep);
			}
			main.appendChild(actions);
			li.appendChild(main);
			return li;
		}

		function confirmDelete(c, actions) {
			const saved = Array.from(actions.childNodes);
			actions.replaceChildren();
			actions.appendChild(el('span', 'crwdCommentConfirm', 'Delete this comment?'));
			const yes = el('button', 'crwdCommentAction isDanger', 'Delete');
			yes.type = 'button';
			const no = el('button', 'crwdCommentAction', 'Cancel');
			no.type = 'button';
			actions.append(yes, no);
			no.focus({ preventScroll: true });
			no.addEventListener('click', function () { actions.replaceChildren.apply(actions, saved); });
			yes.addEventListener('click', async function () {
				yes.disabled = no.disabled = true;
				const { error } = await core.sb.from('comments').delete().eq('id', c.id);
				if (error) {
					actions.replaceChildren.apply(actions, saved);
					alert(friendly(error));
					return;
				}
				comments = comments.filter(function (x) { return x.id !== c.id; });
				justPosted = justPosted.filter(function (x) { return x.id !== c.id; });
				total = Math.max(total - 1, 0);
				drawList(); drawTotal();
			});
		}

		// The comment box, either always open (modal) or behind an "Add a comment" button (Board)
		function composerArea() {
			const area = el('div', 'crwdCommentComposer');

			if (!hooks.collapsedComposer) {
				area.appendChild(core.user ? composer() : signInPrompt());
				return area;
			}

			const toggle = el('button', 'crwdCommentsAdd', 'Add a comment');
			toggle.type = 'button';
			toggle.setAttribute('aria-expanded', 'false');
			let box = null;

			function setOpen(open) {
				if (open && !core.user) { ui.requireSignIn(); return; }
				if (open && !box) {
					box = composer(function () { setOpen(false); });
					box.id = 'crwdComposer-' + opts.id;
					toggle.setAttribute('aria-controls', box.id);
					area.appendChild(box);
				}
				if (box) box.hidden = !open;
				toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
				toggle.classList.toggle('isOpen', open);
				toggle.textContent = open ? 'Cancel' : 'Add a comment';
				if (open) {
					const ta = box.querySelector('textarea');
					ta.focus({ preventScroll: true });
					box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				}
			}

			toggle.addEventListener('click', function () { setOpen(!box || box.hidden); });
			area.appendChild(toggle);
			return area;
		}

		function signInPrompt() {
			const box = el('div', 'crwdCommentSignIn');
			box.appendChild(el('p', null, 'Sign in to join the conversation.'));
			const b = el('button', 'crwdButton', 'Sign in');
			b.type = 'button';
			b.addEventListener('click', function () { ui.openAuth('signin'); });
			box.appendChild(b);
			return box;
		}

		// afterPost: called once a comment is posted (the Board closes the box)
		function composer(afterPost) {
			const f = el('form', 'crwdForm crwdCommentForm');
			f.noValidate = true;
			const wrap = el('label', 'crwdField');
			wrap.appendChild(el('span', 'crwdLabel', 'Add a comment'));
			const ta = document.createElement('textarea');
			ta.name = 'comment';
			ta.maxLength = MAX_COMMENT;
			ta.rows = 3;
			ta.placeholder = 'Say something nice…';
			wrap.appendChild(ta);
			const counter = el('span', 'crwdCounter');
			function count() { counter.textContent = ta.value.length + ' / ' + MAX_COMMENT; }
			ta.addEventListener('input', count);
			count();
			wrap.appendChild(counter);
			const err = form.errorBox();
			const btn = form.submitButton('Post comment');
			f.append(wrap, err, btn);

			// Ctrl/Cmd + Enter posts
			ta.addEventListener('keydown', function (e) {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); f.requestSubmit ? f.requestSubmit() : btn.click(); }
			});

			f.addEventListener('submit', async function (e) {
				e.preventDefault();
				const text = ta.value.trim();
				if (!text) { form.showError(err, 'Write something first.'); ta.focus(); return; }
				if (text.length > MAX_COMMENT) { form.showError(err, 'Comments can be up to ' + MAX_COMMENT + ' characters.'); return; }
				form.showError(err, '');
				form.setBusy(btn, true, 'Posting…');
				const row = { body: text };
				row[kind.commentKey] = opts.id;
				const { data, error } = await core.sb.from('comments').insert(row).select('id, author_id, body, created_at, edited_at').single();
				form.setBusy(btn, false, 'Post comment');
				if (error) { form.showError(err, friendly(error)); return; }
				data.author = { username: core.profile ? core.profile.username : '', avatar_path: core.profile ? core.profile.avatar_path : null };
				// Newest goes last. If newer pages aren't loaded yet, it waits below "Load more".
				if (hasMore) justPosted.push(data); else comments = (comments || []).concat([data]);
				total += 1;
				ta.value = ''; count();
				drawList(); drawTotal();
				const mine = (justPosted.length ? after : list).lastElementChild;
				if (afterPost) afterPost();
				if (mine) mine.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
				if (!afterPost) ta.focus({ preventScroll: true });
			});
			return f;
		}

		async function fetchPage(from) {
			const { data, error, count } = await core.sb.from('comments')
				.select('id, author_id, body, created_at, edited_at', { count: 'exact' })
				.eq(kind.commentKey, opts.id)
				.order('created_at', { ascending: true })
				.range(from, from + COMMENTS_PAGE - 1);
			if (error) throw error;

			// Usernames + pictures (blocked people are already left out by the database)
			const ids = Array.from(new Set(data.map(function (c) { return c.author_id; })));
			const people = {};
			if (ids.length) {
				const { data: profiles } = await core.sb.from('public_profiles').select('id, username, avatar_path, max_badge').in('id', ids);
				(profiles || []).forEach(function (p) { people[p.id] = p; });
			}
			return { rows: data.map(function (c) { c.author = people[c.author_id] || null; return c; }), count: count };
		}

		function settlePage(page) {
			if (typeof page.count === 'number') total = page.count;
			hasMore = comments.length < total - justPosted.length;
			// Everything older is loaded now: the ones posted meanwhile join the end of the list
			if (!hasMore && justPosted.length) {
				const have = new Set(comments.map(function (c) { return c.id; }));
				comments = comments.concat(justPosted.filter(function (c) { return !have.has(c.id); }));
				justPosted = [];
			}
		}

		async function loadFirst() {
			try {
				const page = await fetchPage(0);
				comments = page.rows;
				settlePage(page);
			} catch (error) {
				console.error('[social]', error);
				comments = false;
			}
			drawList(); drawTotal();
		}

		async function loadMore() {
			if (loadingMore || !hasMore) return;
			loadingMore = true;
			drawList();
			try {
				const page = await fetchPage(comments.length);
				const posted = new Set(justPosted.map(function (c) { return c.id; }));
				comments = comments.concat(page.rows.filter(function (c) { return !posted.has(c.id); }));
				settlePage(page);
				if (!page.rows.length) hasMore = false;
			} catch (error) {
				console.error('[social]', error);
			}
			loadingMore = false;
			drawList(); drawTotal();
		}

		drawList();
		view.redraw = function () { drawList(); drawTotal(); };
		loadFirst();
		return view;
	}

	// ------------------------------------------------------------------
	// Report form (a comment or a post)
	//   target: { type: 'comment' | 'post', id, who }  — who: '@name' shown in the copy
	//   done(body): called after it's sent, to show what comes next
	// ------------------------------------------------------------------

	function reportForm(body, target, done) {
		body.replaceChildren();
		body.appendChild(form.title('Report <em>' + (target.type === 'post' ? 'post' : 'comment') + '</em>'));
		body.appendChild(el('p', 'crwdModalText', 'Reports go to the CRWD SRFR team. ' + (target.who || 'They') + ' won\'t see who reported them.'));

		const f = el('form', 'crwdForm');
		f.noValidate = true;
		const choices = el('fieldset', 'crwdChoices');
		choices.appendChild(el('legend', 'crwdLabel', 'What\'s going on?'));
		REPORT_REASONS.forEach(function (r) {
			const label = el('label', 'crwdChoice');
			const input = document.createElement('input');
			input.type = 'radio'; input.name = 'reason'; input.value = r[0];
			label.append(input, r[1]);
			choices.appendChild(label);
		});
		const wrap = el('label', 'crwdField');
		wrap.appendChild(el('span', 'crwdLabel', 'Anything else we should know? (optional)'));
		const details = document.createElement('textarea');
		details.maxLength = MAX_REPORT;
		wrap.appendChild(details);
		const err = form.errorBox();
		const btn = form.submitButton('Send report');
		f.append(choices, wrap, err, btn);
		body.appendChild(f);
		const first = f.querySelector('input');
		if (first) first.focus({ preventScroll: true });

		f.addEventListener('submit', async function (e) {
			e.preventDefault();
			const picked = f.querySelector('input[name=reason]:checked');
			if (!picked) { form.showError(err, 'Choose what\'s going on.'); return; }
			form.showError(err, '');
			form.setBusy(btn, true, 'Sending…');
			const { error } = await core.sb.from('reports').insert({
				target_type: target.type, target_id: target.id, reason: picked.value,
				details: details.value.trim() || null
			});
			if (error) { form.setBusy(btn, false, 'Send report'); form.showError(err, friendly(error)); return; }
			body.replaceChildren();
			body.appendChild(form.title('Thanks for <em>reporting</em>'));
			body.appendChild(el('p', 'crwdNotice', 'We\'ll take a look. Reports help keep CRWD SRFR a good place to be.'));
			done(body);
		});
	}

	// Report in its own dialog (from a post's menu, or a comment shown inline)
	function openReport(target) {
		if (!ui.requireSignIn()) return;
		ui.openDialog(function (body, kit) {
			reportForm(body, target, function () {
				const close = el('button', 'crwdButton', 'Done');
				close.type = 'button';
				close.style.marginTop = '20px';
				close.addEventListener('click', kit.close);
				body.appendChild(close);
				close.focus({ preventScroll: true });
			});
		});
	}

	function whoOf(c) { return c.author ? '@' + c.author.username : null; }

	// ------------------------------------------------------------------
	// Comments modal (shows on the calendar, posts on profiles)
	// ------------------------------------------------------------------

	function openComments(opts) {
		ui.openDialog(function (body) {
			let view = null; // kept so "Back to comments" returns to the same list

			function showList() {
				body.replaceChildren(view);
				view.redraw();
			}

			function backLine() {
				const p = el('p', 'crwdModalSwitch');
				const b = el('button', 'crwdLinkButton', '← Back to comments');
				b.type = 'button';
				b.addEventListener('click', showList);
				p.appendChild(b);
				return p;
			}

			view = commentsView(opts, {
				heading: true,
				// Same as on Board posts: the comment box opens from an "Add a comment" button
				collapsedComposer: true,
				onReport: function (c) {
					reportForm(body, { type: 'comment', id: c.id, who: whoOf(c) }, function () {
						const back = backLine();
						body.appendChild(back);
						back.querySelector('button').focus({ preventScroll: true });
					});
					body.appendChild(backLine());
				}
			});
			body.appendChild(view);
		}, { size: 'wide', centered: true });
	}

	// A comment-count button that does whatever you pass (e.g. show comments inline).
	// Returns the button; button.setCount(n) updates it.
	function commentButton(opts) {
		const c = chip('iconComment', '');
		c.button.classList.add('crwdChipComment');
		c.button.setCount = function (n) {
			setCount(c, n);
			c.button.setAttribute('aria-label', plural(n, 'comment') + (opts.label ? ' — ' + opts.label : ''));
		};
		c.button.setCount(Number(opts.count) || 0);
		if (opts.onClick) c.button.addEventListener('click', opts.onClick);
		return c.button;
	}

	// Comments shown inline in a page (the Board's post modal): fills `container`
	function commentsPanel(container, opts) {
		container.classList.add('crwdInline'); // picks up the modal form styles
		container.replaceChildren(commentsView(opts, {
			heading: false,
			collapsedComposer: true,
			onReport: function (c) { openReport({ type: 'comment', id: c.id, who: whoOf(c) }); }
		}));
	}

	window.CrwdSocial = {
		loadStats: loadStats,
		loadAllHypeCounts: loadAllHypeCounts,
		reactions: reactions,
		hypeButton: hypeButton,
		openComments: openComments,
		commentsPanel: commentsPanel,
		commentButton: commentButton,
		openReport: openReport
	};
})();
