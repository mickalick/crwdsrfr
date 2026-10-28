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
   ========================================================================== */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const BM = window.BoardMedia;
	const byId = (id) => document.getElementById(id);

	const POST_COLUMNS = 'id, legacy_id, author_id, destination, status, post_type, title, opener, media, closer, hero, '
		+ 'venue_id, show_date, act_ids, act_names, credit, created_at, reviewed_at';
	const REVIEWED_LIMIT = 20;

	const TYPE_LABEL = { shot: 'Shot', gallery: 'Gallery', discussion: 'Discussion' };
	const DEST_LABEL = { board: 'Board', profile: 'Profile only' };
	const REASON_LABEL = {
		spam: 'Spam', harassment: 'Harassment', hate: 'Hate', impersonation: 'Impersonation',
		inappropriate: 'Inappropriate', other: 'Other'
	};
	const TARGET_LABEL = { post: 'Post', comment: 'Comment', user: 'Profile', message: 'Message' };
	const REPORT_STATUS_LABEL = { open: 'Open', reviewed: 'Reviewed', actioned: 'Action taken', dismissed: 'Dismissed' };

	const ui = {
		gate: byId('adminGate'),
		gateText: byId('adminGateText'),
		gateSignIn: byId('adminGateSignIn'),
		app: byId('adminApp'),
		refresh: byId('adminRefresh'),
		status: byId('adminStatus'),
		tabs: { posts: byId('adminTabPosts'), reports: byId('adminTabReports') },
		panels: { posts: byId('adminPanelPosts'), reports: byId('adminPanelReports') },
		postsCount: byId('adminPostsCount'),
		reportsCount: byId('adminReportsCount'),
		pending: byId('adminPending'),
		pendingEmpty: byId('adminPendingEmpty'),
		reviewed: byId('adminReviewed'),
		reviewedEmpty: byId('adminReviewedEmpty'),
		reportFilter: byId('adminReportFilter'),
		reportList: byId('adminReportList'),
		reportsEmpty: byId('adminReportsEmpty')
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

	function button(label, className, onClick) {
		const b = el('button', 'adminButton' + (className ? ' ' + className : ''), label);
		b.type = 'button';
		b.addEventListener('click', onClick);
		return b;
	}

	function say(text) {
		ui.status.textContent = text || '';
	}

	function postedAt(ts) {
		return BM ? BM.formatPostedAt(ts) : new Date(ts).toLocaleString();
	}

	function friendly(error) {
		return core.friendlyError ? core.friendlyError(error).message : (error.message || 'Something went wrong.');
	}

	function setCount(node, n) {
		node.textContent = n ? String(n) : '';
		node.hidden = !n;
	}

	// Where a post lives on the site
	function postUrl(id, destination, username) {
		if (destination === 'profile' && username) return core.profileUrl(username);
		return '/board/#' + encodeURIComponent(id);
	}

	// ---------------------------------------------------------------------------
	// Access: signed out → sign in; not an admin → explain; admin → load
	// ---------------------------------------------------------------------------
	function showGate(text, offerSignIn) {
		ui.gate.hidden = false;
		ui.app.hidden = true;
		ui.refresh.hidden = true;
		ui.gateText.textContent = text;
		ui.gateSignIn.hidden = !offerSignIn;
	}

	ui.gateSignIn.addEventListener('click', () => {
		if (window.CrwdUI) window.CrwdUI.openAuth('signin');
	});

	function onAccountChange() {
		if (!core.user) {
			started = false;
			showGate('Sign in with an admin account to use this page.', true);
			return;
		}
		if (!core.isAdmin) {
			started = false;
			showGate('This page is only for CRWD SRFR admins.', false);
			return;
		}
		ui.gate.hidden = true;
		ui.app.hidden = false;
		ui.refresh.hidden = false;
		if (!started) {
			started = true;
			loadAll();
		}
	}

	// ---------------------------------------------------------------------------
	// Tabs
	// ---------------------------------------------------------------------------
	function selectTab(name, focus) {
		Object.keys(ui.tabs).forEach((key) => {
			const on = key === name;
			ui.tabs[key].setAttribute('aria-selected', on ? 'true' : 'false');
			ui.tabs[key].tabIndex = on ? 0 : -1;
			ui.tabs[key].classList.toggle('active', on);
			ui.panels[key].hidden = !on;
		});
		if (focus) ui.tabs[name].focus();
		try { sessionStorage.setItem('crwd-admin-tab', name); } catch (e) {}
	}

	ui.tabs.posts.addEventListener('click', () => selectTab('posts'));
	ui.tabs.reports.addEventListener('click', () => selectTab('reports'));
	// Left/right arrows move between tabs
	Object.values(ui.tabs).forEach((tab) => {
		tab.addEventListener('keydown', (e) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
			e.preventDefault();
			selectTab(tab === ui.tabs.posts ? 'reports' : 'posts', true);
		});
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
		ui.refresh.disabled = true;
		await Promise.all([loadPosts(), loadReports()]);
		ui.refresh.disabled = false;
	}

	ui.refresh.addEventListener('click', loadAll);

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
		ui.pending.replaceChildren(el('p', 'adminEmpty', 'Loading…'));
		ui.pendingEmpty.hidden = true;
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
			ui.pending.replaceChildren(el('p', 'adminError', 'Couldn\'t load posts: ' + friendly(pending.error || reviewed.error)));
			return;
		}

		pendingItems = await toItems(pending.data);
		reviewedItems = await toItems(reviewed.data);
		renderPosts();
	}

	async function loadReports() {
		ui.reportList.replaceChildren(el('p', 'adminEmpty', 'Loading…'));
		ui.reportsEmpty.hidden = true;

		const { data, error } = await core.sb.rpc('admin_reports', { open_only: reportsOpenOnly });
		if (error) {
			ui.reportList.replaceChildren(el('p', 'adminError', 'Couldn\'t load reports: ' + friendly(error)));
			return;
		}
		reports = data || [];
		renderReports();
		refreshOpenReportCount();
	}

	// The tab badge always counts OPEN reports, even while "All" is showing
	async function refreshOpenReportCount() {
		if (reportsOpenOnly) { setCount(ui.reportsCount, reports.length); return; }
		const { data } = await core.sb.rpc('admin_reports', { open_only: true });
		setCount(ui.reportsCount, (data || []).length);
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

		const bodyEl = el('div', 'adminCardBody');
		bodyEl.appendChild(el('h3', 'adminCardTitle', item.title));

		const meta = [
			item.author ? '@' + item.author.username : 'a former member',
			DEST_LABEL[item.destination] || item.destination,
			TYPE_LABEL[item.postType] || item.postType,
			mediaSummary(item)
		].filter(Boolean).join(' · ');
		bodyEl.appendChild(el('p', 'adminMeta', meta));

		const when = item.status === 'pending'
			? 'Submitted ' + postedAt(item.createdAt)
			: (item.status === 'approved' ? 'Approved ' : 'Rejected ') + postedAt(item.reviewedAt);
		bodyEl.appendChild(el('p', 'adminMeta adminMetaTime', when));

		if (item.opener) bodyEl.appendChild(el('p', 'adminExcerpt', item.opener));

		const actions = el('div', 'adminActions');
		const err = el('p', 'adminError');
		err.setAttribute('role', 'alert');
		err.hidden = true;

		actions.appendChild(button('Preview', 'adminButtonGhost', () => preview(item, list)));

		if (item.status === 'pending') {
			actions.appendChild(button('Approve', 'adminButtonGo', (e) => decide(item, 'approved', e.currentTarget, err)));
			actions.appendChild(button('Reject', 'adminButtonStop', (e) => decide(item, 'rejected', e.currentTarget, err)));
		} else {
			const pill = el('span', 'adminPill adminPill-' + item.status, item.status === 'approved' ? 'Approved' : 'Rejected');
			bodyEl.insertBefore(pill, bodyEl.firstChild);
			if (item.status === 'approved') {
				const view = el('a', 'adminButton adminButtonGhost', 'View on site');
				view.href = postUrl(item.id, item.destination, item.author && item.author.username);
				actions.appendChild(view);
				actions.appendChild(button('Reject instead', 'adminButtonStop', (e) => decide(item, 'rejected', e.currentTarget, err)));
			} else {
				actions.appendChild(button('Approve instead', 'adminButtonGo', (e) => decide(item, 'approved', e.currentTarget, err)));
			}
		}

		bodyEl.append(actions, err);
		card.appendChild(bodyEl);
		return card;
	}

	function renderPosts() {
		ui.pending.replaceChildren(...pendingItems.map((item) => postCard(item, pendingItems)));
		ui.pendingEmpty.hidden = pendingItems.length > 0;
		ui.reviewed.replaceChildren(...reviewedItems.map((item) => postCard(item, reviewedItems)));
		ui.reviewedEmpty.hidden = reviewedItems.length > 0;
		setCount(ui.postsCount, pendingItems.length);
	}

	async function decide(item, decision, btn, err) {
		const card = btn.closest('.adminCard');
		card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
		err.hidden = true;

		const { error } = await core.sb.rpc('moderate_post', { post: item.id, decision });
		if (error) {
			card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
			err.textContent = friendly(error);
			err.hidden = false;
			return;
		}

		// Move it into "Recently reviewed" (newest first)
		pendingItems = pendingItems.filter((i) => i.id !== item.id);
		reviewedItems = reviewedItems.filter((i) => i.id !== item.id);
		item.status = decision;
		item.reviewedAt = new Date().toISOString();
		reviewedItems.unshift(item);
		reviewedItems = reviewedItems.slice(0, REVIEWED_LIMIT);
		renderPosts();
		say((decision === 'approved' ? 'Approved' : 'Rejected') + ' “' + item.title + '”.');

		// Keep keyboard users in the queue: focus the next pending post
		const next = ui.pending.querySelector('.adminThumb');
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
			if (item.opener) body.appendChild(el('p', 'adminPreviewText', item.opener));
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
			if (item.closer) body.appendChild(el('p', 'adminPreviewText', item.closer));
		}, { size: 'wide' });
	}

	// ---------------------------------------------------------------------------
	// Reports
	// ---------------------------------------------------------------------------
	ui.reportFilter.addEventListener('click', (e) => {
		const b = e.target.closest('[data-reports]');
		if (!b) return;
		reportsOpenOnly = b.dataset.reports === 'open';
		ui.reportFilter.querySelectorAll('[data-reports]').forEach((x) => {
			const on = x === b;
			x.classList.toggle('active', on);
			x.setAttribute('aria-pressed', on ? 'true' : 'false');
		});
		loadReports();
	});

	function targetBox(r) {
		const box = el('div', 'adminTarget');
		const who = r.target_username ? '@' + r.target_username : 'a former member';

		if (!r.target_exists) {
			box.appendChild(el('p', 'adminMeta', TARGET_LABEL[r.target_type] + ' already deleted.'));
			return box;
		}

		if (r.target_type === 'post') {
			box.appendChild(el('p', 'adminTargetTitle', r.target_title));
			box.appendChild(el('p', 'adminMeta', 'Post by ' + who));
			const a = el('a', 'adminLink', 'Open post');
			a.href = postUrl(r.target_post_id, r.target_post_destination, r.target_username);
			a.target = '_blank';
			box.appendChild(a);
		} else if (r.target_type === 'comment') {
			box.appendChild(el('blockquote', 'adminQuote', r.target_body));
			const where = r.target_post_id ? 'on a post' : (r.target_event_id ? 'on a show' : '');
			box.appendChild(el('p', 'adminMeta', 'Comment by ' + who + (where ? ' ' + where : '')));
			if (r.target_post_id) {
				const a = el('a', 'adminLink', 'Open post');
				a.href = postUrl(r.target_post_id, r.target_post_destination, null);
				a.target = '_blank';
				box.appendChild(a);
			}
		} else if (r.target_type === 'message') {
			box.appendChild(el('blockquote', 'adminQuote', r.target_body));
			box.appendChild(el('p', 'adminMeta', 'Message from ' + who + ' (shown because it was reported)'));
		} else {
			box.appendChild(el('p', 'adminTargetTitle', who));
			if (r.target_username) {
				const a = el('a', 'adminLink', 'Open profile');
				a.href = core.profileUrl(r.target_username);
				a.target = '_blank';
				box.appendChild(a);
			}
		}
		return box;
	}

	function reportCard(r) {
		const card = el('article', 'adminCard adminReport');
		const bodyEl = el('div', 'adminCardBody');

		const top = el('div', 'adminReportTop');
		top.appendChild(el('span', 'adminPill adminPill-reason', REASON_LABEL[r.reason] || r.reason));
		top.appendChild(el('span', 'adminReportType', TARGET_LABEL[r.target_type] || r.target_type));
		if (r.status !== 'open') top.appendChild(el('span', 'adminPill adminPill-' + r.status, REPORT_STATUS_LABEL[r.status]));
		bodyEl.appendChild(top);

		bodyEl.appendChild(el('p', 'adminMeta adminMetaTime',
			'Reported by ' + (r.reporter_username ? '@' + r.reporter_username : 'a former member') + ' · ' + postedAt(r.created_at)));
		if (r.details) bodyEl.appendChild(el('p', 'adminDetails', '“' + r.details + '”'));
		bodyEl.appendChild(targetBox(r));

		const actions = el('div', 'adminActions');
		const err = el('p', 'adminError');
		err.setAttribute('role', 'alert');
		err.hidden = true;

		if (r.target_exists && r.target_type === 'post') {
			actions.appendChild(button('Remove post', 'adminButtonStop', () => confirmRemove(r, 'posts', 'post', err)));
		}
		if (r.target_exists && r.target_type === 'comment') {
			actions.appendChild(button('Delete comment', 'adminButtonStop', () => confirmRemove(r, 'comments', 'comment', err)));
		}
		if (r.status === 'open') {
			actions.appendChild(button('Mark reviewed', 'adminButtonGhost', (e) => setReportStatus(r, 'reviewed', e.currentTarget, err)));
			actions.appendChild(button('Dismiss', 'adminButtonGhost', (e) => setReportStatus(r, 'dismissed', e.currentTarget, err)));
		} else {
			actions.appendChild(button('Reopen', 'adminButtonGhost', (e) => setReportStatus(r, 'open', e.currentTarget, err)));
		}

		bodyEl.append(actions, err);
		card.appendChild(bodyEl);
		return card;
	}

	function renderReports() {
		ui.reportList.replaceChildren(...reports.map(reportCard));
		ui.reportsEmpty.hidden = reports.length > 0;
		ui.reportsEmpty.textContent = reportsOpenOnly ? 'No open reports.' : 'No reports yet.';
	}

	async function setReportStatus(r, status, btn, err) {
		if (btn) btn.disabled = true;
		err.hidden = true;
		const { error } = await core.sb.from('reports').update({ status }).eq('id', r.id);
		if (error) {
			if (btn) btn.disabled = false;
			err.textContent = friendly(error);
			err.hidden = false;
			return false;
		}
		r.status = status;
		if (reportsOpenOnly && status !== 'open') reports = reports.filter((x) => x.id !== r.id);
		renderReports();
		refreshOpenReportCount();
		say('Report marked ' + REPORT_STATUS_LABEL[status].toLowerCase() + '.');
		return true;
	}

	// Remove the reported post or comment (asks first), then mark the report "action taken"
	function confirmRemove(r, table, noun, cardErr) {
		window.CrwdUI.openDialog((body, kit) => {
			body.appendChild(kit.title('Remove this <em>' + noun + '</em>?'));
			body.appendChild(el('p', 'crwdModalText', noun === 'post'
				? 'The post and its photos, comments and hypes are deleted for everyone. This can\'t be undone.'
				: 'The comment is deleted for everyone. This can\'t be undone.'));
			const form = el('form', 'crwdForm');
			form.noValidate = true;
			const err = kit.errorBox();
			const go = kit.submitButton('Remove ' + noun);
			const cancel = el('button', 'crwdButton crwdButtonSecondary', 'Cancel');
			cancel.type = 'button';
			cancel.addEventListener('click', kit.close);
			form.append(err, go, cancel);
			body.appendChild(form);

			form.addEventListener('submit', async (e) => {
				e.preventDefault();
				kit.setBusy(go, true, 'Removing…');
				const { error } = await core.sb.from(table).delete().eq('id', r.target_id);
				if (error) {
					kit.setBusy(go, false, 'Remove ' + noun);
					kit.showError(err, friendly(error));
					return;
				}
				kit.close();
				r.target_exists = false;
				await setReportStatus(r, 'actioned', null, cardErr);
				say('Removed the ' + noun + ' and marked the report “action taken”.');
				if (noun === 'post') loadPosts(); // it may have been in the lists
			});
		});
	}

	// ---------------------------------------------------------------------------
	// Start
	// ---------------------------------------------------------------------------
	if (!core || !core.enabled) {
		showGate('Accounts aren\'t available right now, so the admin tools can\'t load.', false);
		return;
	}

	let savedTab = 'posts';
	try { savedTab = sessionStorage.getItem('crwd-admin-tab') === 'reports' ? 'reports' : 'posts'; } catch (e) {}
	selectTab(savedTab);

	core.ready.then(() => {
		onAccountChange();
		core.onChange(onAccountChange);
	});
})();
