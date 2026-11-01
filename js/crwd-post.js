/*
 * js/crwd-post.js — the full-post modal, shared by the Board and profile pages.
 *
 * Top to bottom: cover photo · title · "by username on … at …" · credit · hype + comment
 * buttons · opening · media with captions · closing · Show Details (acts + genres, venue,
 * show date) · footer (hype, comments, ⋮) · comments (when opened). Arrow keys and swipes
 * move between posts; the close button stays pinned while the post scrolls.
 *
 * The hype and comment buttons appear twice, under the title and in the footer. Either hype
 * button hypes the post (they stay in step). The footer's comment button opens and closes
 * the comments; the top one opens them and jumps down to them.
 *
 * Needs board.js (window.BoardMedia, for dates/venue names) and crwd-social.js,
 * and board.css for the styles. Load after crwd-social.js:
 *   … crwd-ui.js → crwd-social.js → board.js → crwd-post.js → page script
 *
 *   CrwdPost.open({
 *     items, index,                      // the list prev/next moves through, and where to start
 *     context: { venueLookup, genreMeta },
 *     getStats(id) → { hypes, comments, hyped },
 *     onStatsChange(id, stats),          // e.g. update the tile's counts
 *     hashFor(item) → '#…',              // what the address bar shows while it's open
 *     shareUrl(item) → 'https://…',      // what Share Post copies
 *     onClose()
 *   })
 *   CrwdPost.refresh()  — redraw the open post's buttons (e.g. after signing in or out)
 *   CrwdPost.isOpen()
 *
 * Posts that aren't approved yet (only their author sees them) show their status
 * in place of the hype and comment buttons.
 */
(function () {
	'use strict';

	const STATUS_LABELS = { pending: 'Pending review', rejected: 'Not approved' };

	let modal = null; // built on first open
	let els = {};
	let opts = null;
	let index = -1;
	let commentButtons = []; // the open post's two comment buttons (top + footer)
	let commentsView = null; // the comments panel, while it's open
	let jumpPending = false; // the top comment button was used before the comments finished loading

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function socialReady() {
		return !!(window.CrwdSocial && window.CrwdCore && window.CrwdCore.enabled);
	}

	function media() { return window.BoardMedia; }

	// ---------- Markup (same classes the Board has always used; styled by board.css) ----------

	function build() {
		modal = el('div', 'boardModal');
		modal.id = 'postModal';
		modal.hidden = true;
		modal.innerHTML = `
			<div class="boardModalBackdrop" data-postclose></div>
			<div class="boardModalContent" role="dialog" aria-modal="true" aria-labelledby="postModalTitle">
				<button type="button" class="boardModalClose" data-postclose aria-label="Close"><span class="boardIconClose"></span></button>
				<div class="boardModalHero" data-el="hero" hidden></div>
				<!-- A div, not <header>: the page's scroll script restyles every <header> -->
				<div class="boardModalHead">
					<h2 id="postModalTitle" data-el="title"></h2>
					<p class="boardModalBy" data-el="by"></p>
					<p class="boardModalCredit" data-el="credit" hidden></p>
				</div>
				<div class="boardModalActions boardModalTopActions" data-el="topActions" hidden>
					<span data-el="hypeTop"></span>
					<span data-el="commentTop"></span>
				</div>
				<div class="boardModalBody" data-el="body"></div>
				<section class="boardModalShow" data-el="show" aria-labelledby="postModalShowTitle" hidden>
					<h3 class="boardModalShowTitle" id="postModalShowTitle">In This Post</h3>
					<dl class="boardModalDetails" data-el="details"></dl>
				</section>
				<div class="boardModalFooter">
					<div class="boardModalActions">
						<span data-el="hype"></span>
						<span data-el="commentSlot"></span>
						<span class="boardModalStatus" data-el="status" hidden></span>
					</div>
					<div class="boardModalMore" data-el="more">
						<button type="button" class="boardModalMoreButton" data-el="moreButton" aria-label="Post options" aria-haspopup="true" aria-expanded="false" aria-controls="postModalMenu">
							<span class="icon iconKebab" aria-hidden="true"></span>
						</button>
						<ul id="postModalMenu" class="boardModalMoreMenu" data-el="menu" hidden>
							<li><button type="button" class="boardModalMoreItem" data-el="share" data-action="share">Share Post</button></li>
							<li><button type="button" class="boardModalMoreItem isDanger" data-el="report" data-action="report">Report Post</button></li>
						</ul>
						<span class="boardModalNote" role="status" data-el="note" hidden></span>
					</div>
				</div>
				<div class="boardModalComments" id="postModalComments" data-el="comments" hidden></div>
			</div>`;
		modal.querySelectorAll('[data-el]').forEach((node) => { els[node.dataset.el] = node; });
		els.scroller = modal.querySelector('.boardModalContent');
		document.body.appendChild(modal);
		wire();
	}

	// ---------- Rendering ----------

	function genreChip(genre) {
		const meta = (opts.context.genreMeta || {})[genre] || {};
		const label = meta.label || genre.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
		let color = meta.color;
		if (!color) {
			let hash = 0;
			for (let i = 0; i < genre.length; i++) hash = (hash * 31 + genre.charCodeAt(i)) >>> 0;
			color = `hsl(${hash % 360}, 65%, 60%)`;
		}
		const chip = el('span', 'genre-chip', label);
		chip.style.setProperty('--genre-color', color);
		return chip;
	}

	function buildMediaEl(m, autoplay) {
		if (m.type === 'video') {
			const video = el('video');
			video.src = m.url;
			if (m.thumbnail) video.poster = m.thumbnail;
			video.controls = true;
			video.playsInline = true;
			video.volume = 0.5;
			video.autoplay = !!autoplay;
			return video;
		}
		const img = el('img');
		img.src = m.url;
		img.alt = m.caption || '';
		img.loading = 'lazy';
		return img;
	}

	function textBlock(className, text) {
		const block = el('div', className);
		String(text).split(/\n{2,}/).forEach((para) => block.appendChild(el('p', null, para)));
		return block;
	}

	function detailRow(label, content) {
		const row = el('div', 'boardModalDetail');
		row.appendChild(el('dt', null, label));
		const dd = el('dd');
		dd.append(...[].concat(content));
		row.appendChild(dd);
		return row;
	}

	function renderDetails(item) {
		els.details.replaceChildren();
		const acts = item.acts || [];

		if (acts.length) {
			const list = el('ul', 'boardModalActs');
			acts.forEach((act) => {
				const li = el('li', 'boardModalAct');
				// Acts on the Acts page link there; typed-in ones are just the name
				const name = el(act.slug ? 'a' : 'span', 'boardModalActName', act.name);
				if (act.slug) name.href = '/acts/#' + encodeURIComponent(act.slug);
				li.appendChild(name);
				if ((act.genres || []).length) {
					const chips = el('span', 'boardModalGenres');
					act.genres.forEach((g) => chips.appendChild(genreChip(g)));
					li.appendChild(chips);
				}
				list.appendChild(li);
			});
			els.details.appendChild(detailRow(acts.length === 1 ? 'Act' : 'Acts', list));
		}

		if (item.venueId) {
			const venue = el('a', null, media().resolveVenueName(item.venueId, opts.context.venueLookup || {}));
			venue.href = '/venues/' + encodeURIComponent(item.venueId) + '/';
			els.details.appendChild(detailRow('Venue', venue));
		}

		if (item.date) els.details.appendChild(detailRow('Date', media().formatDateDisplay(item.date)));

		// "Show Details" is optional on every post: hidden when nothing is tagged
		els.show.hidden = els.details.childElementCount === 0;
	}

	function isApproved(item) {
		return !item.status || item.status === 'approved';
	}

	function isMine(item) {
		return !!(window.CrwdCore && CrwdCore.user && CrwdCore.user.id === item.authorId);
	}

	// Hype + comment buttons, under the title and in the footer — or, for a post still
	// waiting on review, its status (footer only)
	function renderFooter(item) {
		const s = opts.getStats(item.id) || { hypes: 0, comments: 0, hyped: false };
		els.hype.replaceChildren();
		els.commentSlot.replaceChildren();
		els.hypeTop.replaceChildren();
		els.commentTop.replaceChildren();
		commentButtons = [];

		const approved = isApproved(item);
		els.status.hidden = approved;
		els.status.textContent = approved ? '' : (STATUS_LABELS[item.status] || item.status);
		els.status.className = 'boardModalStatus profileBadge ' + (item.status === 'rejected' ? 'isRejected' : 'isPending');

		// Menu: Share (approved posts are the only ones others can see), Report (not your own)
		els.share.hidden = !approved;
		els.report.hidden = isMine(item);
		els.more.hidden = els.share.hidden && els.report.hidden;

		els.topActions.hidden = !approved || !socialReady();
		if (!approved || !socialReady()) return;

		// Two hype buttons for one post: clicking either updates both, and the shared
		// lock keeps a quick tap on each from sending two requests at once
		const hypeButtons = [];
		const lock = { busy: false };
		function hypeButton() {
			const button = CrwdSocial.hypeButton({
				type: 'post',
				id: item.id,
				hypes: s.hypes,
				hyped: s.hyped,
				lock: lock,
				onChange: (state) => {
					hypeButtons.forEach((other) => { if (other !== button) other.setState(state); });
					const next = { ...(opts.getStats(item.id) || { comments: 0 }), hypes: state.hypes, hyped: state.hyped };
					opts.onStatsChange(item.id, next);
				}
			});
			hypeButtons.push(button);
			return button;
		}
		els.hypeTop.appendChild(hypeButton());
		els.hype.appendChild(hypeButton());

		// Top: opens the comments and jumps to them. Footer: opens/closes them in place.
		function commentButton(jump) {
			const button = CrwdSocial.commentButton({
				count: s.comments,
				label: jump ? 'go to comments' : 'show comments',
				onClick: () => (jump ? jumpToComments(item) : toggleComments(item))
			});
			button.setAttribute('aria-controls', 'postModalComments');
			commentButtons.push(button);
			return button;
		}
		els.commentTop.appendChild(commentButton(true));
		els.commentSlot.appendChild(commentButton(false));
		markCommentButtons();
	}

	// Both comment buttons show whether the comments are open
	function markCommentButtons() {
		const open = !els.comments.hidden;
		commentButtons.forEach((button) => {
			button.setAttribute('aria-expanded', open ? 'true' : 'false');
			button.classList.toggle('isOpen', open);
		});
	}

	// Comments open underneath the footer, inside the post
	function openComments(item) {
		if (!els.comments.hidden) return;
		const s = opts.getStats(item.id) || { comments: 0 };
		els.comments.hidden = false;
		commentsView = CrwdSocial.commentsPanel(els.comments, {
			type: 'post',
			id: item.id,
			ownerId: item.authorId, // the author can remove comments on their post
			count: s.comments,      // shown in "Comments (n)" right away
			onCountChange: (n) => {
				const next = { ...(opts.getStats(item.id) || { hypes: 0, hyped: false }), comments: n };
				opts.onStatsChange(item.id, next);
				commentButtons.forEach((button) => button.setCount(n));
				// First page is in: the post is tall enough now to scroll the comments right to the top
				if (jumpPending) {
					jumpPending = false;
					els.comments.scrollIntoView({ block: 'start', behavior: 'smooth' });
				}
			}
		});
		markCommentButtons();
	}

	function closeComments() {
		jumpPending = false;
		els.comments.hidden = true;
		els.comments.replaceChildren();
		commentsView = null;
		markCommentButtons();
	}

	// Footer button
	function toggleComments(item) {
		if (els.comments.hidden) {
			openComments(item);
			els.comments.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		} else {
			closeComments();
		}
	}

	// Top button: open (if needed), scroll the comments to the top of the post, and move
	// keyboard focus to the "Comments (n)" heading so Tab carries on from there
	function jumpToComments(item) {
		// Just opened: "Loading comments…" is short, so scroll again once they're in (onCountChange)
		jumpPending = els.comments.hidden;
		openComments(item);
		els.comments.scrollIntoView({ block: 'start', behavior: 'smooth' });
		if (commentsView && commentsView.heading) commentsView.heading.focus({ preventScroll: true });
	}

	function pauseVideos() {
		modal.querySelectorAll('video').forEach((v) => v.pause());
	}

	function setHash(hash) {
		try {
			history.replaceState(null, '', location.pathname + location.search + (hash || ''));
		} catch (e) {
			// history API unavailable in some embedding contexts — non-fatal
		}
	}

	function render() {
		const item = opts.items[index];
		pauseVideos();
		closeMenu();
		setHash(opts.hashFor ? opts.hashFor(item) : '#' + encodeURIComponent(item.id));

		els.hero.replaceChildren();
		els.hero.hidden = !item.hero;
		if (item.hero) els.hero.appendChild(buildMediaEl(item.hero, false));

		els.title.textContent = item.title;

		els.by.replaceChildren('by ');
		if (item.author) {
			const who = el('a', 'boardModalByName', item.author.username);
			who.href = window.CrwdCore && CrwdCore.profileUrl ? CrwdCore.profileUrl(item.author.username) : '/u/?' + encodeURIComponent(item.author.username);
			els.by.appendChild(who);
			// After the link, not inside it, so it doesn't pick up the link's hover underline
			if (item.author.max_badge && window.CrwdUI) els.by.appendChild(CrwdUI.maxBadge());
		} else {
			els.by.append('a former member');
		}
		if (item.createdAt) els.by.append(' on ' + media().formatPostedAt(item.createdAt));

		// e.g. "Photos by Sam" on imported posts
		els.credit.textContent = item.credit || '';
		els.credit.hidden = !item.credit;

		els.body.replaceChildren();
		if (item.opener) els.body.appendChild(textBlock('boardModalText boardModalOpener', item.opener));
		item.media.forEach((m) => {
			const figure = el('figure', 'boardModalFigure');
			// A single shot gets its video playing right away
			figure.appendChild(buildMediaEl(m, item.postType === 'shot'));
			if (m.caption) figure.appendChild(el('figcaption', 'boardModalStreamCaption', m.caption));
			els.body.appendChild(figure);
		});
		if (item.closer) els.body.appendChild(textBlock('boardModalText boardModalCloser', item.closer));

		renderDetails(item);

		closeComments();
		renderFooter(item);

		els.scroller.scrollTop = 0;
	}

	function show(newIndex) {
		if (!opts || newIndex < 0 || newIndex >= opts.items.length) return;
		index = newIndex;
		render();
	}

	// ---------- Open / close ----------

	function open(options) {
		if (!modal) build();
		opts = options;
		index = Math.max(0, options.index || 0);
		render();
		modal.hidden = false;
		document.body.classList.add('boardModalOpen');
	}

	function close() {
		if (!modal || modal.hidden) return;
		modal.hidden = true;
		document.body.classList.remove('boardModalOpen');
		closeMenu();
		pauseVideos();
		setHash('');
		els.hero.replaceChildren();
		els.body.replaceChildren();
		els.comments.replaceChildren();
		commentsView = null;
		commentButtons = [];
		const done = opts && opts.onClose;
		opts = null;
		index = -1;
		if (done) done();
	}

	function refresh() {
		if (modal && !modal.hidden && opts) renderFooter(opts.items[index]);
	}

	// ---------- Menu (⋮): Share Post, Report Post ----------

	function openMenu(focusFirst) {
		els.menu.hidden = false;
		els.moreButton.setAttribute('aria-expanded', 'true');
		els.moreButton.classList.add('open');
		if (focusFirst) els.menu.querySelector('button:not([hidden])').focus({ preventScroll: true });
	}

	function closeMenu(returnFocus) {
		if (!els.menu || els.menu.hidden) return;
		els.menu.hidden = true;
		els.moreButton.setAttribute('aria-expanded', 'false');
		els.moreButton.classList.remove('open');
		if (returnFocus) els.moreButton.focus({ preventScroll: true });
	}

	let noteTimer = null;
	function flashNote(text) {
		clearTimeout(noteTimer);
		els.note.textContent = text;
		els.note.hidden = false;
		noteTimer = setTimeout(() => { els.note.hidden = true; }, 1800);
	}

	// Phones get the system share sheet; everything else copies the link
	async function sharePost() {
		const item = opts.items[index];
		const url = opts.shareUrl ? opts.shareUrl(item) : location.origin + location.pathname + '#' + encodeURIComponent(item.id);

		if (navigator.share && window.matchMedia('(pointer: coarse)').matches) {
			try { await navigator.share({ title: item.title || 'CRWD SRFR', url: url }); } catch (e) { /* closed the sheet */ }
			return;
		}
		try {
			await navigator.clipboard.writeText(url);
			flashNote('Link copied');
		} catch (e) {
			flashNote("Copy the link from your browser's address bar");
		}
	}

	// ---------- Events ----------

	function wire() {
		modal.addEventListener('click', (e) => {
			if (e.target.closest('[data-postclose]')) close();
		});

		els.moreButton.addEventListener('click', (e) => {
			if (els.menu.hidden) openMenu(e.detail === 0); else closeMenu();
		});

		document.addEventListener('click', (e) => {
			if (!els.menu.hidden && !e.target.closest('.boardModalMore')) closeMenu();
		});

		els.menu.addEventListener('click', (e) => {
			const action = e.target.closest('[data-action]');
			if (!action || !opts) return;
			closeMenu();
			const item = opts.items[index];
			if (action.dataset.action === 'share') sharePost();
			if (action.dataset.action === 'report' && socialReady()) {
				CrwdSocial.openReport({ type: 'post', id: item.id, who: item.author ? '@' + item.author.username : null });
			}
		});

		// Capture phase so this runs before the sign-in dialog's own Escape handler closes it
		window.addEventListener('keydown', (e) => {
			if (modal.hidden) return;
			// The sign-in / report dialog sits on top of the post: let it handle its own keys
			if (document.documentElement.classList.contains('crwdModalOpen')) return;
			if (e.key === 'Escape') {
				if (!els.menu.hidden) closeMenu(true); else close();
				return;
			}
			// Arrow keys page between posts, except while typing a comment
			const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
			if (!typing && e.key === 'ArrowLeft') show(index - 1);
			if (!typing && e.key === 'ArrowRight') show(index + 1);
		}, true);

		// Swipe left/right for the next/previous post. Swipes that start on a video or the
		// comment box are left alone, so scrubbing a video or selecting text doesn't change posts.
		let swipe = null;
		els.scroller.addEventListener('touchstart', (e) => {
			if (e.touches.length !== 1 || e.target.closest('video, input, textarea, select')) { swipe = null; return; }
			swipe = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
		}, { passive: true });
		els.scroller.addEventListener('touchend', (e) => {
			if (!swipe) return;
			const dx = e.changedTouches[0].clientX - swipe.x;
			const dy = e.changedTouches[0].clientY - swipe.y;
			const quick = Date.now() - swipe.t < 600;
			swipe = null;
			// Clearly sideways (not a scroll) and far enough to be on purpose
			if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
			show(index + (dx < 0 ? 1 : -1));
		}, { passive: true });
	}

	window.CrwdPost = {
		open: open,
		close: close,
		refresh: refresh,
		isOpen: function () { return !!(modal && !modal.hidden); }
	};
})();
