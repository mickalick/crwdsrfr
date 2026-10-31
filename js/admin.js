/* ==========================================================================
   js/admin.js — CRWD SRFR admin page (/admin/)
     Posts:   approve / reject pending posts, preview them in the real post modal,
              change your mind on recently reviewed ones
     Reports: open reports with what they're about; remove the post/comment,
              dismiss, or mark reviewed

   Needs (loaded before this file): supabase-js, crwd-core.js, nav.js, crwd-ui.js,
   board.js (data helpers), and crwd-post.js for previews (falls back to a simple
   preview without it).

   Only admins get anything back: the database checks every read and action
   (moderate_post, admin_reports, the delete/update policies). This page just
   hides itself from everyone else.

   Looks and works like the Settings & Privacy page: same tabs (#reports in the
   address), section headings, buttons, checkboxes and status lines.
   ========================================================================== */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const BM = window.BoardMedia;
	const byId = (id) => document.getElementById(id);

	const POST_COLUMNS = 'id, legacy_id, author_id, destination, status, post_type, title, opener, media, closer, hero, '
		+ 'venue_id, show_date, act_ids, act_names, credit, created_at, reviewed_at';
	const REVIEWED_LIMIT = 20;

	const TABS = ['posts', 'reports'];
	const TYPE_LABEL = { shot: 'Shot', gallery: 'Gallery', discussion: 'Discussion' };
	const DEST_LABEL = { board: 'Board', profile: 'Profile only' };
	const REASON_LABEL = {
		spam: 'Spam', harassment: 'Harassment', hate: 'Hate', impersonation: 'Impersonation',
		inappropriate: 'Inappropriate', other: 'Other'
	};
	const TARGET_LABEL = { post: 'Post', comment: 'Comment', user: 'Profile', message: 'Message' };
	const REPORT_STATUS_LABEL = { open: 'Open', reviewed: 'Reviewed', actioned: 'Action Taken', dismissed: 'Dismissed' };

	const els = {
		state: byId('adminState'),
		stateText: byId('adminStateText'),
		stateActions: byId('adminStateActions'),
		content: byId('adminContent'),
		refresh: byId('adminRefresh'),
		status: byId('adminStatus'),
		tabs: { posts: byId('adminTabPosts'), reports: byId('adminTabReports') },
		panels: { posts: byId('adminPanelPosts'), reports: byId('adminPanelReports') },
		pending: byId('adminPending'),
		reviewed: byId('adminReviewed'),
		reportsHeading: byId('adminReportsHeading'),
		showClosed: byId('adminShowClosed'),
		reportList: byId('adminReportList')
	};

	let context = null;          // { venueLookup, genreMeta, actsList } for previews
	let pendingItems = [];
	let reviewedItems = [];
	let reports = [];
	let reportsOpenOnly = true;
	let started = false;

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function at(username) { return username ? '@' + username : 'a former member'; }

	// Outlined button (yellow; isDanger = red), same as Settings
	function button(label, extraClass, onClick) {
		const b = el('button', 'adminButton' + (extraClass ? ' ' + extraClass : ''), label);
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	// Blue text link / button (Preview, View on Site, Open Post)
	function linkButton(label, onClick) {
		const b = el('button', 'adminLinkButton', label);
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	function link(label, href, newTab) {
		const a = el('a', 'adminLinkButton', label);
		a.href = href;
		if (newTab) { a.target = '_blank'; a.rel = 'noopener'; }
		return a;
	}

	// Space Mono line under the tabs: what just happened (blue), or what went wrong (red)
	function say(text, bad) {
		els.status.textContent = text || '';
		els.status.dataset.state = bad ? 'bad' : 'good';
	}

	// Error line inside a card
	function cardError() {
		const p = el('p', 'adminStatus adminCardError');
		p.dataset.state = 'bad';
		p.setAttribute('role', 'alert');
		return p;
	}

	function emptyNote(text) {
		return el('p', 'adminNote adminEmpty', text);
	}

	function postedAt(ts) {
		return BM ? BM.formatPostedAt(ts) : new Date(ts).toLocaleString();
	}

	function friendly(error) {
		return core.friendlyError ? core.friendlyError(error).message : (error.message || 'Something went wrong.');
	}

	// "Posts (3)" — like the Lineup's section counts. Nothing waiting: just "Posts".
	function setCount(name, n) {
		els.tabs[name].textContent = (name === 'posts' ? 'Posts' : 'Reports') + (n ? ' (' + n + ')' : '');
	}

	// Where a post lives on the site
	function postUrl(id, destination, username) {
		if (destination === 'profile' && username) return core.profileUrl(username);
		return '/board/#' + encodeURIComponent(id);
	}

	// ---------------------------------------------------------------------------
	// Page states: signed out → sign in; not an admin → explain; admin → load
	// ---------------------------------------------------------------------------
	function showState(text, actions) {
		els.content.hidden = true;
		els.state.hidden = false;
		els.stateText.textContent = text;
		els.stateActions.replaceChildren();
		(actions || []).forEach((a) => {
			const b = el(a.href ? 'a' : 'button', 'adminButton', a.label);
			if (a.href) b.href = a.href; else { b.type = 'button'; b.addEventListener('click', a.onClick); }
			els.stateActions.appendChild(b);
		});
	}

	function onAccountChange() {
		if (!core.user) {
			started = false;
			showState('Sign in with an admin account to use this page.', [
				{ label: 'Sign In', onClick: () => { if (window.CrwdUI) window.CrwdUI.openAuth('signin'); } }
			]);
			return;
		}
		if (!core.isAdmin) {
			started = false;
			showState('This page is only for CRWD SRFR admins.', [{ label: 'Go to the Calendar', href: '/' }]);
			return;
		}
		els.state.hidden = true;
		els.content.hidden = false;
		selectTab(window.location.hash.replace('#', ''));
		if (!started) {
			started = true;
			loadAll();
		}
	}

	// ---------------------------------------------------------------------------
	// Tabs (Posts is the page's address; Reports is #reports)
	// ---------------------------------------------------------------------------
	function selectTab(name, focus) {
		if (TABS.indexOf(name) === -1) name = 'posts';
		TABS.forEach((t) => {
			const on = t === name;
			els.tabs[t].setAttribute('aria-selected', on ? 'true' : 'false');
			els.tabs[t].tabIndex = on ? 0 : -1;
			els.panels[t].hidden = !on;
		});
		if (focus) els.tabs[name].focus();
		const hash = name === 'posts' ? '' : '#' + name;
		if (window.location.hash !== hash) history.replaceState(null, '', window.location.pathname + window.location.search + hash);
	}

	TABS.forEach((name) => {
		const tab = els.tabs[name];
		tab.addEventListener('click', () => selectTab(name));
		tab.addEventListener('keydown', (e) => {
			const i = TABS.indexOf(name);
			let next = null;
			if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
			if (e.key === 'ArrowLeft') next = TABS[(i - 1 + TABS.length) % TABS.length];
			if (e.key === 'Home') next = TABS[0];
			if (e.key === 'End') next = TABS[TABS.length - 1];
			if (next) { e.preventDefault(); selectTab(next, true); }
		});
	});

	window.addEventListener('hashchange', () => {
		if (!els.content.hidden) selectTab(window.location.hash.replace('#', ''));
	});

	// ---------------------------------------------------------------------------
	// Loading
	// ---------------------------------------------------------------------------
	async function loadContext() {
		if (context || !BM) return;
		const [venueLookup, genreMeta, actsList] = await Promise.all([
			BM.fetchVenueLookup(), BM.fetchGenreMeta(), BM.fetchActsList()
		]);
		context = { venueLookup, genreMeta, actsList };
	}

	async function loadAll() {
		say('');
		els.refresh.disabled = true;
		els.refresh.textContent = 'Refreshing…';
		await Promise.all([loadPosts(), loadReports()]);
		els.refresh.disabled = false;
		els.refresh.textContent = 'Refresh';
	}

	els.refresh.addEventListener('click', loadAll);

	// Board-style items (what the post modal expects), plus destination/status/author
	async function toItems(rows) {
		const ids = [...new Set(rows.map((r) => r.author_id))];
		const people = {};
		if (ids.length) {
			const { data } = await core.sb.from('public_profiles').select('id, username, avatar_path, max_badge').in('id', ids);
			(data || []).forEach((p) => { people[p.id] = p; });
		}
		return rows.map((row) => {
			const author = people[row.author_id] || null;
			let item = BM ? BM.toItem(row, author) : { id: row.id, title: row.title, media: [], author };
			if (BM && context) item = BM.withActs(item, context.actsList);
			item.destination = row.destination;
			item.status = row.status;
			item.createdAt = row.created_at;
			item.reviewedAt = row.reviewed_at;
			return item;
		});
	}

	async function loadPosts() {
		els.pending.replaceChildren(emptyNote('Loading posts…'));
		els.reviewed.replaceChildren();
		await loadContext();

		const [pending, reviewed] = await Promise.all([
			core.sb.from('posts').select(POST_COLUMNS)
				.eq('status', 'pending')
				.order('created_at', { ascending: true })   // oldest first: first in, first reviewed
				.limit(200),
			core.sb.from('posts').select(POST_COLUMNS)
				.neq('status', 'pending')
				.not('reviewed_at', 'is', null)
				.is('legacy_id', null)                      // leave out the board-media.json import
				.order('reviewed_at', { ascending: false })
				.limit(REVIEWED_LIMIT)
		]);

		if (pending.error || reviewed.error) {
			els.pending.replaceChildren(errorNote('Posts couldn\'t load: ' + friendly(pending.error || reviewed.error)));
			return;
		}

		pendingItems = await toItems(pending.data);
		reviewedItems = await toItems(reviewed.data);
		renderPosts();
	}

	async function loadReports() {
		els.reportList.replaceChildren(emptyNote('Loading reports…'));

		const { data, error } = await core.sb.rpc('admin_reports', { open_only: reportsOpenOnly });
		if (error) {
			els.reportList.replaceChildren(errorNote('Reports couldn\'t load: ' + friendly(error)));
			return;
		}
		reports = data || [];
		renderReports();
		refreshOpenReportCount();
	}

	function errorNote(text) {
		const p = emptyNote(text);
		p.classList.add('isBad');
		return p;
	}

	// The tab always counts OPEN reports, even while closed ones are showing
	async function refreshOpenReportCount() {
		if (reportsOpenOnly) { setCount('reports', reports.length); return; }
		const { data } = await core.sb.rpc('admin_reports', { open_only: true });
		setCount('reports', (data || []).length);
	}

	// ---------------------------------------------------------------------------
	// Posts
	// ---------------------------------------------------------------------------
	function mediaSummary(item) {
		const media = item.media || [];
		const photos = media.filter((m) => m.type === 'photo').length;
		const videos = media.filter((m) => m.type === 'video').length;
		const parts = [];
		if (photos) parts.push(photos + (photos === 1 ? ' photo' : ' photos'));
		if (videos) parts.push(videos + (videos === 1 ? ' video' : ' videos'));
		return parts.join(', ');
	}

	function tag(text, kind) {
		return el('span', 'adminTag' + (kind ? ' is' + kind : ''), text);
	}

	function postCard(item, list) {
		const card = el('article', 'adminCard');
		card.dataset.postId = item.id;

		// Thumbnail (opens the preview)
		const thumb = el('button', 'adminThumb');
		thumb.type = 'button';
		thumb.setAttribute('aria-label', 'Preview ' + item.title);
		const cover = BM ? BM.getCoverMedia(item) : null;
		if (cover && cover.thumbnail) {
			const img = el('img');
			img.src = cover.thumbnail;
			img.alt = '';
			img.loading = 'lazy';
			thumb.appendChild(img);
		} else {
			thumb.appendChild(el('span', 'adminThumbLabel', TYPE_LABEL[item.postType] || 'Post'));
		}
		if (cover && cover.type === 'video') thumb.appendChild(el('span', 'adminThumbPlay'));
		thumb.addEventListener('click', () => preview(item, list));
		card.appendChild(thumb);

		const body = el('div', 'adminCardBody');
		if (item.status !== 'pending') {
			const tags = el('div', 'adminTags');
			tags.appendChild(item.status === 'approved' ? tag('Approved', 'Good') : tag('Rejected', 'Bad'));
			body.appendChild(tags);
		}
		body.appendChild(el('h3', 'adminCardTitle', item.title));

		body.appendChild(el('p', 'adminCardMeta', [
			at(item.author && item.author.username),
			DEST_LABEL[item.destination] || item.destination,
			TYPE_LABEL[item.postType] || item.postType,
			mediaSummary(item)
		].filter(Boolean).join(' · ')));

		body.appendChild(el('p', 'adminCardMeta', item.status === 'pending'
			? 'Submitted ' + postedAt(item.createdAt)
			: (item.status === 'approved' ? 'Approved ' : 'Rejected ') + postedAt(item.reviewedAt)));

		if (item.opener) body.appendChild(el('p', 'adminExcerpt', item.opener));

		const actions = el('div', 'adminActions');
		const err = cardError();

		if (item.status === 'pending') {
			actions.appendChild(button('Approve', '', (e) => decide(item, 'approved', e.currentTarget, err)));
			actions.appendChild(button('Reject', 'isDanger', (e) => decide(item, 'rejected', e.currentTarget, err)));
		} else if (item.status === 'approved') {
			actions.appendChild(button('Reject Instead', 'isDanger', (e) => decide(item, 'rejected', e.currentTarget, err)));
		} else {
			actions.appendChild(button('Approve Instead', '', (e) => decide(item, 'approved', e.currentTarget, err)));
		}
		actions.appendChild(linkButton('Preview', () => preview(item, list)));
		if (item.status === 'approved') {
			actions.appendChild(link('View on Site', postUrl(item.id, item.destination, item.author && item.author.username)));
		}

		body.append(actions, err);
		card.appendChild(body);
		return card;
	}

	function renderPosts() {
		els.pending.replaceChildren(...pendingItems.map((item) => postCard(item, pendingItems)));
		if (!pendingItems.length) els.pending.appendChild(emptyNote('All caught up. Nothing is waiting for review.'));
		els.reviewed.replaceChildren(...reviewedItems.map((item) => postCard(item, reviewedItems)));
		if (!reviewedItems.length) els.reviewed.appendChild(emptyNote('Nothing reviewed yet.'));
		setCount('posts', pendingItems.length);
	}

	async function decide(item, decision, btn, err) {
		const card = btn.closest('.adminCard');
		card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
		err.textContent = '';

		const { error } = await core.sb.rpc('moderate_post', { post: item.id, decision });
		if (error) {
			card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
			err.textContent = friendly(error);
			return;
		}

		// Move it into "Recently Reviewed" (newest first)
		pendingItems = pendingItems.filter((i) => i.id !== item.id);
		reviewedItems = reviewedItems.filter((i) => i.id !== item.id);
		item.status = decision;
		item.reviewedAt = new Date().toISOString();
		reviewedItems.unshift(item);
		reviewedItems = reviewedItems.slice(0, REVIEWED_LIMIT);
		renderPosts();
		say((decision === 'approved' ? 'Approved' : 'Rejected') + ' “' + item.title + '”');

		// Keep keyboard users in the queue: focus the next pending post
		const next = els.pending.querySelector('.adminThumb');
		if (next) next.focus({ preventScroll: true });
	}

	// The real post modal (what members will see), or a simple fallback
	function preview(item, list) {
		if (window.CrwdPost && context) {
			window.CrwdPost.open({
				items: list,
				index: Math.max(0, list.indexOf(item)),
				context: { venueLookup: context.venueLookup, genreMeta: context.genreMeta },
				getStats: () => ({ hypes: 0, comments: 0, hyped: false }),
				onStatsChange: () => {},
				hashFor: () => '',
				shareUrl: (post) => location.origin + postUrl(post.id, post.destination, post.author && post.author.username)
			});
			return;
		}
		simplePreview(item);
	}

	function simplePreview(item) {
		if (!window.CrwdUI) return;
		window.CrwdUI.openDialog((body, kit) => {
			body.appendChild(kit.title('Preview'));
			body.appendChild(el('h3', 'adminPreviewTitle', item.title));
			if (item.opener) body.appendChild(el('p', 'crwdModalText adminPreviewText', item.opener));
			const grid = el('div', 'adminPreviewMedia');
			(item.media || []).forEach((m) => {
				const fig = el('figure');
				if (m.type === 'video') {
					const v = el('video');
					v.src = m.url;
					v.controls = true;
					v.preload = 'metadata';
					if (m.thumbnail) v.poster = m.thumbnail;
					fig.appendChild(v);
				} else {
					const img = el('img');
					img.src = m.url;
					img.alt = m.caption || '';
					img.loading = 'lazy';
					fig.appendChild(img);
				}
				if (m.caption) fig.appendChild(el('figcaption', null, m.caption));
				grid.appendChild(fig);
			});
			body.appendChild(grid);
			if (item.closer) body.appendChild(el('p', 'crwdModalText adminPreviewText', item.closer));
		}, { size: 'wide' });
	}

	// ---------------------------------------------------------------------------
	// Reports
	// ---------------------------------------------------------------------------
	els.showClosed.addEventListener('change', () => {
		reportsOpenOnly = !els.showClosed.checked;
		els.reportsHeading.textContent = reportsOpenOnly ? 'Open Reports' : 'All Reports';
		loadReports();
	});

	// What was reported, in a box with a blue edge (like a show in the Lineup's Waves)
	function targetBox(r) {
		const box = el('div', 'adminTarget');
		const who = at(r.target_username);

		if (!r.target_exists) {
			box.appendChild(el('p', 'adminCardMeta', TARGET_LABEL[r.target_type] + ' already deleted'));
			return box;
		}

		if (r.target_type === 'post') {
			box.appendChild(el('p', 'adminTargetTitle', r.target_title));
			box.appendChild(el('p', 'adminCardMeta', 'Post by ' + who));
			box.appendChild(link('Open Post', postUrl(r.target_post_id, r.target_post_destination, r.target_username), true));
		} else if (r.target_type === 'comment') {
			box.appendChild(el('p', 'adminQuote', r.target_body));
			const where = r.target_post_id ? 'on a post' : (r.target_event_id ? 'on a show' : '');
			box.appendChild(el('p', 'adminCardMeta', 'Comment by ' + who + (where ? ' ' + where : '')));
			if (r.target_post_id) box.appendChild(link('Open Post', postUrl(r.target_post_id, r.target_post_destination, null), true));
		} else if (r.target_type === 'message') {
			box.appendChild(el('p', 'adminQuote', r.target_body));
			box.appendChild(el('p', 'adminCardMeta', 'Message from ' + who + ' (shown because it was reported)'));
		} else {
			box.appendChild(el('p', 'adminTargetTitle', who));
			if (r.target_username) box.appendChild(link('Open Profile', core.profileUrl(r.target_username), true));
		}
		return box;
	}

	function reportCard(r) {
		const card = el('article', 'adminCard adminReport');
		const body = el('div', 'adminCardBody');

		const tags = el('div', 'adminTags');
		tags.appendChild(tag(REASON_LABEL[r.reason] || r.reason, 'Reason'));
		if (r.status !== 'open') tags.appendChild(tag(REPORT_STATUS_LABEL[r.status], r.status === 'actioned' ? 'Good' : ''));
		body.appendChild(tags);

		body.appendChild(el('h3', 'adminCardTitle', TARGET_LABEL[r.target_type] || r.target_type));
		body.appendChild(el('p', 'adminCardMeta', 'Reported by ' + at(r.reporter_username) + ' · ' + postedAt(r.created_at)));
		if (r.details) body.appendChild(el('p', 'adminExcerpt adminDetails', '“' + r.details + '”'));
		body.appendChild(targetBox(r));

		const actions = el('div', 'adminActions');
		const err = cardError();

		if (r.target_exists && r.target_type === 'post') {
			actions.appendChild(button('Remove Post', 'isDanger', () => confirmRemove(r, 'posts', 'post', err)));
		}
		if (r.target_exists && r.target_type === 'comment') {
			actions.appendChild(button('Remove Comment', 'isDanger', () => confirmRemove(r, 'comments', 'comment', err)));
		}
		if (r.status === 'open') {
			actions.appendChild(button('Mark Reviewed', '', (e) => setReportStatus(r, 'reviewed', e.currentTarget, err)));
			actions.appendChild(button('Dismiss', '', (e) => setReportStatus(r, 'dismissed', e.currentTarget, err)));
		} else {
			actions.appendChild(button('Reopen', '', (e) => setReportStatus(r, 'open', e.currentTarget, err)));
		}

		body.append(actions, err);
		card.appendChild(body);
		return card;
	}

	function renderReports() {
		els.reportList.replaceChildren(...reports.map(reportCard));
		if (!reports.length) els.reportList.appendChild(emptyNote(reportsOpenOnly ? 'No open reports. All caught up.' : 'No reports yet.'));
	}

	async function setReportStatus(r, status, btn, err) {
		if (btn) btn.disabled = true;
		err.textContent = '';
		const { error } = await core.sb.from('reports').update({ status }).eq('id', r.id);
		if (error) {
			if (btn) btn.disabled = false;
			err.textContent = friendly(error);
			return false;
		}
		r.status = status;
		if (reportsOpenOnly && status !== 'open') reports = reports.filter((x) => x.id !== r.id);
		renderReports();
		refreshOpenReportCount();
		say('Report marked ' + REPORT_STATUS_LABEL[status].toLowerCase());
		return true;
	}

	// Remove the reported post or comment (asks first, like Delete Post on a profile),
	// then mark the report "action taken"
	function confirmRemove(r, table, noun, cardErr) {
		window.CrwdUI.openDialog((body, kit) => {
			body.appendChild(kit.title('Remove this <em>' + noun + '</em>?'));
			body.appendChild(kit.el('p', 'crwdModalText', noun === 'post'
				? 'The post and its photos, comments and hypes are deleted for everyone. This can\'t be undone.'
				: 'The comment is deleted for everyone. This can\'t be undone.'));
			const err = kit.errorBox();
			const label = 'Remove ' + noun.charAt(0).toUpperCase() + noun.slice(1);
			const go = kit.el('button', 'crwdButton isDanger', label);
			go.type = 'button';
			const keep = kit.el('p', 'crwdModalSwitch');
			const keepBtn = kit.el('button', 'crwdLinkButton', 'Keep it');
			keepBtn.type = 'button';
			keepBtn.setAttribute('data-autofocus', ''); // the safe choice gets focus
			keepBtn.addEventListener('click', kit.close);
			keep.appendChild(keepBtn);
			body.append(err, go, keep);

			go.addEventListener('click', async () => {
				kit.showError(err, '');
				kit.setBusy(go, true, 'Removing…');
				const { error } = await core.sb.from(table).delete().eq('id', r.target_id);
				if (error) {
					kit.setBusy(go, false, label);
					kit.showError(err, friendly(error));
					return;
				}
				kit.close();
				r.target_exists = false;
				await setReportStatus(r, 'actioned', null, cardErr);
				say('Removed the ' + noun + ' and marked the report “action taken”');
				if (noun === 'post') loadPosts(); // it may have been in the lists
			});
		});
	}

	// ---------------------------------------------------------------------------
	// Start
	// ---------------------------------------------------------------------------
	if (!core || !core.enabled) {
		showState('Accounts aren\'t available right now, so the admin tools can\'t load.');
		return;
	}

	core.ready.then(() => {
		onAccountChange();
		core.onChange(onAccountChange);
	});
})();
