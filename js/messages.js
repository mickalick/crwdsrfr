/*
 * js/messages.js — the Messages page (/messages/).
 *
 *   /messages/          → Requests + Conversations, each a show/hide list of cards
 *   /messages/?c=<id>   → one conversation: status lines, message bubbles, reply box
 *
 * Reads the my_conversations view (one row per conversation, already filtered for
 * blocks, quiet declines and conversations you left) and the messages table.
 * Changes go through the database functions: respond_to_request, cancel_request,
 * leave_conversation (see update-messages.sql).
 *
 * Needs crwd-core.js + crwd-ui.js. Styles: /css/messages.css.
 * Usernames and messages are inserted with textContent, never innerHTML.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const ui = window.CrwdUI;

	const $ = function (id) { return document.getElementById(id); };
	const els = {
		state: $('messagesState'), stateText: $('messagesStateText'), stateActions: $('messagesStateActions'),
		list: $('messagesList'), thread: $('messagesThread')
	};

	const PAGE = 10;            // cards per "Load More"
	const THREAD_PAGE = 50;     // messages per "Load earlier messages"
	const MAX_MESSAGE = 2000;
	const REPORT_REASONS = [
		['spam', 'Spam or fake account'],
		['harassment', 'Harassment or bullying'],
		['hate', 'Hate speech'],
		['impersonation', 'Pretending to be someone else'],
		['inappropriate', 'Inappropriate content'],
		['other', 'Something else']
	];

	let builtFor = null; // user id the page was drawn for

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

	// "Just now", "5 mins ago", "3 hrs ago", "2 days ago", "3 wks ago", then the date
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
		const d = new Date(iso);
		const opts = { month: 'short', day: 'numeric' };
		if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
		return d.toLocaleDateString('en-US', opts);
	}

	// A <time> that keeps itself current (see the timer at the bottom)
	function timeEl(iso, before, className) {
		const t = el('time', className || null);
		t.dateTime = iso;
		t.dataset.ago = before || '';
		t.textContent = (before || '') + ago(iso);
		t.title = new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
		return t;
	}

	function messagesUrl(id) {
		return '/messages/' + (id ? '?c=' + encodeURIComponent(id) : '');
	}

	function showState(text, actions) {
		els.list.hidden = true;
		els.thread.hidden = true;
		els.state.hidden = false;
		els.stateText.textContent = text;
		els.stateActions.replaceChildren();
		(actions || []).forEach(function (a) {
			const b = el(a.href ? 'a' : 'button', 'messagesButton', a.label);
			if (a.href) b.href = a.href; else { b.type = 'button'; b.addEventListener('click', a.onClick); }
			els.stateActions.appendChild(b);
		});
	}

	function button(label, extraClass) {
		const b = el('button', 'messagesButton' + (extraClass ? ' ' + extraClass : ''), label);
		b.type = 'button';
		return b;
	}

	// ------------------------------------------------------------------
	// Kebab menu (cards + conversation header)
	// items: [{ label, onClick } | { label, href } , danger?]
	// ------------------------------------------------------------------

	let openMenu = null;

	function kebab(items, label) {
		const wrap = el('div', 'msgMore');
		const btn = el('button', 'msgMoreButton');
		btn.type = 'button';
		btn.setAttribute('aria-label', label);
		btn.setAttribute('aria-haspopup', 'true');
		btn.setAttribute('aria-expanded', 'false');
		btn.appendChild(el('span', 'icon msgKebabIcon'));
		const menu = el('ul', 'msgMoreMenu');
		menu.hidden = true;
		items.forEach(function (it) {
			const li = el('li');
			const item = el(it.href ? 'a' : 'button', 'msgMoreItem' + (it.danger ? ' isDanger' : ''), it.label);
			if (it.href) item.href = it.href;
			else {
				item.type = 'button';
				item.addEventListener('click', function () { closeMenus(); it.onClick(); });
			}
			li.appendChild(item);
			menu.appendChild(li);
		});
		wrap.append(btn, menu);

		const api = {
			open: function (focusFirst) {
				closeMenus();
				menu.hidden = false;
				btn.setAttribute('aria-expanded', 'true');
				btn.classList.add('open');
				openMenu = api;
				if (focusFirst) menu.querySelector('a, button').focus();
			},
			close: function (returnFocus) {
				menu.hidden = true;
				btn.setAttribute('aria-expanded', 'false');
				btn.classList.remove('open');
				if (openMenu === api) openMenu = null;
				if (returnFocus) btn.focus();
			},
			wrap: wrap
		};
		btn.addEventListener('click', function (e) {
			e.preventDefault();
			e.stopPropagation();
			if (menu.hidden) api.open(e.detail === 0); else api.close();
		});
		// Up/down arrows move through the items
		menu.addEventListener('keydown', function (e) {
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
			e.preventDefault();
			const all = Array.prototype.slice.call(menu.querySelectorAll('a, button'));
			const i = all.indexOf(document.activeElement);
			all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length].focus();
		});
		return api;
	}

	function closeMenus(returnFocus) {
		if (openMenu) openMenu.close(returnFocus);
	}

	document.addEventListener('click', function (e) {
		if (openMenu && !openMenu.wrap.contains(e.target)) closeMenus();
	});
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape' && openMenu) closeMenus(true);
	});

	// ------------------------------------------------------------------
	// Actions shared by the cards and the conversation page.
	// Each one confirms first; done() runs after it worked.
	// ------------------------------------------------------------------

	// "Are you sure?" dialog. run() returns an error message, or nothing when it worked.
	function confirmDialog(opts) {
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title(opts.title));
			const p = kit.el('p', 'crwdModalText', opts.before);
			p.appendChild(kit.el('strong', null, at(opts.username)));
			p.append(opts.after);
			body.appendChild(p);
			const err = kit.errorBox();
			const btn = kit.el('button', 'crwdButton' + (opts.danger ? ' isDanger' : ''), opts.confirm);
			btn.type = 'button';
			const keep = kit.el('p', 'crwdModalSwitch');
			const keepBtn = kit.el('button', 'crwdLinkButton', opts.keep || 'Never mind');
			keepBtn.type = 'button';
			keepBtn.addEventListener('click', kit.close);
			keep.appendChild(keepBtn);
			body.append(err, btn, keep);
			btn.addEventListener('click', async function () {
				kit.setBusy(btn, true, opts.busy);
				const problem = await opts.run();
				if (problem) { kit.setBusy(btn, false, opts.confirm); kit.showError(err, problem); return; }
				kit.close();
				opts.done();
			});
		});
	}

	async function rpc(name, args) {
		const { error } = await core.sb.rpc(name, args);
		return error ? core.friendlyError(error).message : null;
	}

	function cancelRequest(conv, done) {
		confirmDialog({
			title: 'Cancel this <em>request</em>?', username: conv.other_username,
			before: 'Your request to ', after: ' and its message will be deleted. To reach them again, you\'d need to send a new request.',
			confirm: 'Cancel Request', busy: 'Cancelling…', keep: 'Keep my request', danger: true,
			run: function () { return rpc('cancel_request', { conversation: conv.conversation_id }); },
			done: done
		});
	}

	function declineRequest(conv, done) {
		confirmDialog({
			title: 'Decline this <em>request</em>?', username: conv.other_username,
			before: 'You won\'t be able to accept it later, and you can\'t message each other unless one of you sends a new request. ', after: ' isn\'t told you declined.',
			confirm: 'Decline Request', busy: 'Declining…', keep: 'Keep it for now', danger: true,
			run: function () { return rpc('respond_to_request', { conversation: conv.conversation_id, accept: false }); },
			done: done
		});
	}

	function leaveConversation(conv, done) {
		confirmDialog({
			title: 'Leave this <em>conversation</em>?', username: conv.other_username,
			before: 'It will disappear from your Messages. ', after: ' will see that you left and won\'t be able to reply. To talk again, one of you would send a new request.',
			confirm: 'Leave Conversation', busy: 'Leaving…', keep: 'Stay', danger: true,
			run: function () { return rpc('leave_conversation', { conversation: conv.conversation_id }); },
			done: done
		});
	}

	function blockUser(conv, done) {
		confirmDialog({
			title: 'Block this <em>user</em>?', username: conv.other_username,
			before: 'You and ', after: ' won\'t be able to see each other\'s profiles, posts or comments, or send each other messages. This conversation is hidden too. They aren\'t notified.',
			confirm: 'Block', busy: 'Blocking…', keep: 'Cancel',
			run: async function () {
				const { error } = await core.sb.from('blocks').insert({ blocked_id: conv.other_user_id });
				return error && error.code !== '23505' ? core.friendlyError(error).message : null;
			},
			done: done
		});
	}

	function reportUser(conv) {
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Report this <em>user</em>'));
			const p = kit.el('p', 'crwdModalText', 'Reports go to the CRWD SRFR team for review. ');
			p.appendChild(kit.el('strong', null, at(conv.other_username)));
			p.append(' won\'t see who reported them.');
			body.appendChild(p);
			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;
			const choices = kit.el('fieldset', 'crwdChoices');
			const legend = kit.el('legend', 'crwdLabel', 'What\'s going on?');
			legend.style.marginBottom = '8px';
			choices.appendChild(legend);
			REPORT_REASONS.forEach(function (r) {
				const label = kit.el('label', 'crwdChoice');
				const input = el('input');
				input.type = 'radio';
				input.name = 'reason';
				input.value = r[0];
				label.append(input, r[1]);
				choices.appendChild(label);
			});
			const wrap = kit.el('label', 'crwdField');
			wrap.appendChild(kit.el('span', 'crwdLabel', 'Anything else we should know? (optional)'));
			const details = el('textarea');
			details.name = 'details';
			details.maxLength = 1000;
			wrap.appendChild(details);
			const err = kit.errorBox();
			const btn = kit.submitButton('Send report');
			form.append(choices, wrap, err, btn);
			body.appendChild(form);

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const picked = form.querySelector('input[name=reason]:checked');
				if (!picked) { kit.showError(err, 'Choose what\'s going on.'); return; }
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Sending…');
				const { error } = await core.sb.from('reports').insert({
					target_type: 'user', target_id: conv.other_user_id, reason: picked.value,
					details: details.value.trim() || null
				});
				if (error) { kit.setBusy(btn, false, 'Send report'); kit.showError(err, core.friendlyError(error).message); return; }
				body.replaceChildren();
				body.appendChild(kit.title('Thanks for <em>reporting</em>'));
				body.appendChild(kit.el('p', 'crwdNotice', 'We\'ll take a look. Reports help keep CRWD SRFR a good place to be.'));
				const ok = kit.el('button', 'crwdButton', 'Done');
				ok.type = 'button';
				ok.style.marginTop = '20px';
				ok.addEventListener('click', kit.close);
				body.appendChild(ok);
				ok.focus({ preventScroll: true });
			});
		});
	}

	// ------------------------------------------------------------------
	// The list: Requests + Conversations
	// ------------------------------------------------------------------

	const SECTIONS = [
		{ key: 'requests', title: 'Requests', status: 'pending', empty: 'No message requests right now.' },
		{ key: 'conversations', title: 'Conversations', status: 'accepted', empty: 'No conversations yet. Start one from someone\'s profile with Message.' }
	];

	function showList() {
		document.title = 'Messages | CRWD SRFR';
		els.state.hidden = true;
		els.thread.hidden = true;
		els.list.hidden = false;
		els.list.replaceChildren();
		SECTIONS.forEach(function (s) { els.list.appendChild(listSection(s)); });
	}

	// One show/hide section. Closed when it has nothing in it.
	function listSection(def) {
		const section = el('section', 'msgSection');
		const toggle = el('button', 'msgSectionToggle');
		toggle.type = 'button';
		toggle.id = 'msgToggle-' + def.key;
		toggle.setAttribute('aria-expanded', 'false');
		toggle.setAttribute('aria-controls', 'msgSection-' + def.key);
		const label = el('span', 'msgSectionTitle', def.title);
		toggle.append(label, el('span', 'msgChevron'));
		const body = el('div', 'msgSectionBody');
		body.id = 'msgSection-' + def.key;
		body.hidden = true;
		const list = el('ul', 'msgCards');
		const more = button('Load More', 'msgLoadMore');
		more.hidden = true;
		const note = el('p', 'msgNote');
		note.setAttribute('role', 'status');
		body.append(list, more, note);
		section.append(toggle, body);

		let total = 0;
		let loaded = 0;
		function setTotal(n) {
			total = n;
			label.textContent = def.title + ' (' + n + ')';
		}
		function setOpen(open) {
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
			body.hidden = !open;
		}
		toggle.addEventListener('click', function () { setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });

		// A card left the list (declined, cancelled, left, blocked)
		function removed(card, message) {
			const next = card.nextElementSibling || card.previousElementSibling;
			card.remove();
			loaded -= 1;
			setTotal(total - 1);
			note.textContent = message;
			if (!total) { list.replaceChildren(el('li', 'msgEmpty', def.empty)); toggle.focus(); return; }
			const focusTarget = next && next.querySelector('.msgCardLink');
			(focusTarget || toggle).focus();
		}

		async function loadPage(first) {
			more.disabled = true;
			more.textContent = 'Loading…';
			const { data, error, count } = await core.sb.from('my_conversations')
				.select('*', { count: 'exact' })
				.eq('status', def.status)
				.order('updated_at', { ascending: false })
				.range(loaded, loaded + PAGE - 1);
			more.disabled = false;
			more.textContent = 'Load More';
			if (error) {
				console.error('[messages]', error);
				label.textContent = def.title;
				note.textContent = 'These couldn\'t load right now. Please try again in a bit.';
				return;
			}
			if (typeof count === 'number') setTotal(count);
			if (first) {
				list.replaceChildren();
				if (!data.length) list.appendChild(el('li', 'msgEmpty', def.empty));
				setOpen(data.length > 0);
			}
			data.forEach(function (c) { list.appendChild(card(c, removed)); });
			loaded += data.length;
			more.hidden = loaded >= total;
			if (!first) {
				const firstNew = list.children[loaded - data.length];
				if (firstNew) firstNew.querySelector('.msgCardLink').focus();
			}
		}
		more.addEventListener('click', function () { loadPage(false); });

		label.textContent = def.title;
		loadPage(true);
		return section;
	}

	function card(c, removed) {
		const li = el('li', 'msgCard' + (c.unread ? ' isUnread' : ''));
		const link = el('a', 'msgCardLink');
		link.href = messagesUrl(c.conversation_id);
		link.appendChild(el('span', 'msgDot'));
		const text = el('span', 'msgCardText');
		text.appendChild(el('span', 'msgCardTitle', at(c.other_username)));
		let meta;
		if (c.status === 'pending') meta = timeEl(c.created_at, c.i_requested ? 'Sent ' : 'Received ', 'msgCardMeta');
		else if (c.other_left_at) meta = timeEl(c.other_left_at, 'Left ', 'msgCardMeta');
		else meta = timeEl(c.updated_at, 'Updated ', 'msgCardMeta');
		text.appendChild(meta);
		link.appendChild(text);
		if (c.unread) link.appendChild(el('span', 'msgSrOnly', ' (new)'));
		li.appendChild(link);

		const gone = function (msg) { return function () { removed(li, msg); }; };
		let items;
		if (c.status === 'pending' && c.i_requested) {
			items = [{ label: 'Cancel', danger: true, onClick: function () { cancelRequest(c, gone('Request to ' + at(c.other_username) + ' cancelled.')); } }];
		} else if (c.status === 'pending') {
			items = [{ label: 'Decline', danger: true, onClick: function () { declineRequest(c, gone('Request from ' + at(c.other_username) + ' declined.')); } }];
		} else {
			items = [{ label: 'Leave Conversation', danger: true, onClick: function () { leaveConversation(c, gone('You left your conversation with ' + at(c.other_username) + '.')); } }];
		}
		items.push(
			{ label: 'Block', onClick: function () { blockUser(c, gone('You blocked ' + at(c.other_username) + '.')); } },
			{ label: 'Report', danger: true, onClick: function () { reportUser(c); } }
		);
		li.appendChild(kebab(items, 'Options for ' + at(c.other_username)).wrap);
		return li;
	}

	// ------------------------------------------------------------------
	// One conversation
	// ------------------------------------------------------------------

	let channel = null; // realtime subscription for new messages

	// opts.reply: open the reply box right away (after accepting a request)
	async function showThread(id, opts) {
		showState('Loading conversation…');
		const { data: conv, error } = await core.sb.from('my_conversations').select('*').eq('conversation_id', id).maybeSingle();
		if (error) { console.error('[messages]', error); showState('This conversation couldn\'t load. Please try again in a bit.', [{ label: 'Back to Messages', href: messagesUrl() }]); return; }
		if (!conv) {
			document.title = 'Messages | CRWD SRFR';
			showState('This conversation isn\'t available. It may have been cancelled or left.', [{ label: 'Back to Messages', href: messagesUrl() }]);
			return;
		}
		thread(conv, opts || {});
	}

	function thread(conv, opts) {
		document.title = at(conv.other_username) + ' | Messages | CRWD SRFR';
		els.state.hidden = true;
		els.list.hidden = true;
		els.thread.hidden = false;
		els.thread.replaceChildren();

		const me = core.user.id;
		const them = at(conv.other_username);
		const youOrThem = function (mine) { return mine ? 'You' : them; };
		let messages = [];   // oldest first
		let hasEarlier = false;
		let replyOpen = !!opts.reply && conv.status === 'accepted' && !conv.other_left_at;

		// Back + header
		const back = el('a', 'msgBack', '← All Messages');
		back.href = messagesUrl();
		const head = el('div', 'msgThreadHead');
		const title = el('h2', 'msgThreadTitle', them);
		head.appendChild(title);

		const leaveTo = function (text) {
			return function () { showState(text, [{ label: 'Back to Messages', href: messagesUrl() }]); };
		};
		const items = [{ label: 'View Profile', href: core.profileUrl(conv.other_username) }];
		if (conv.status === 'pending' && conv.i_requested) {
			items.push({ label: 'Cancel', danger: true, onClick: function () { cancelRequest(conv, leaveTo('You cancelled your request to ' + them + '.')); } });
		} else if (conv.status === 'pending') {
			items.push({ label: 'Decline Request', danger: true, onClick: function () { declineRequest(conv, reload); } });
		} else if (conv.status === 'accepted') {
			items.push({ label: 'Leave Conversation', danger: true, onClick: function () { leaveConversation(conv, leaveTo('You left your conversation with ' + them + '.')); } });
		}
		items.push(
			{ label: 'Block', onClick: function () { blockUser(conv, leaveTo('You blocked ' + them + '. You won\'t see each other\'s profiles, posts, comments or messages.')); } },
			{ label: 'Report', danger: true, onClick: function () { reportUser(conv); } }
		);
		head.appendChild(kebab(items, 'Options for this conversation').wrap);

		const earlier = button('Load earlier messages', 'msgEarlier');
		earlier.hidden = true;
		const timeline = el('ol', 'msgTimeline');
		timeline.setAttribute('aria-label', 'Conversation with ' + them);
		const footer = el('div', 'msgFooter');
		const live = el('p', 'msgSrOnly');
		live.setAttribute('aria-live', 'polite');
		els.thread.append(back, head, earlier, timeline, footer, live);

		async function reload() { showThread(conv.conversation_id); }

		// ---- loading messages (newest page first, shown oldest → newest)
		async function loadMessages(before) {
			let q = core.sb.from('messages').select('id, sender_id, body, created_at')
				.eq('conversation_id', conv.conversation_id)
				.order('created_at', { ascending: false })
				.limit(THREAD_PAGE + 1);
			if (before) q = q.lt('created_at', before);
			const { data, error } = await q;
			if (error) { console.error('[messages]', error); return null; }
			const more = data.length > THREAD_PAGE;
			return { rows: data.slice(0, THREAD_PAGE).reverse(), more: more };
		}

		// ---- drawing
		function statusLine(text) {
			const li = el('li', 'msgStatus');
			li.appendChild(el('span', 'msgStatusText', text));
			return li;
		}

		function bubble(m) {
			const mine = m.sender_id === me;
			const li = el('li', 'msgBubbleRow ' + (mine ? 'isMine' : 'isTheirs'));
			const b = el('div', 'msgBubble');
			const who = el('span', 'msgSrOnly', mine ? 'You: ' : them + ': ');
			b.append(who, timeEl(m.created_at, '', 'msgBubbleTime'), el('p', 'msgBubbleText', m.body));
			li.appendChild(b);
			return li;
		}

		// Statuses + messages in time order. Statuses go first when the times match
		// (the request and its first message are saved together).
		function draw() {
			timeline.replaceChildren();
			const events = [];
			if (!hasEarlier) events.push({ t: conv.created_at, rank: 0, node: statusLine(youOrThem(conv.i_requested) + ' sent a message request') });
			if (conv.responded_at && conv.status !== 'pending') {
				const word = conv.status === 'accepted' ? 'accepted' : 'declined';
				events.push({ t: conv.responded_at, rank: 0, node: statusLine(youOrThem(!conv.i_requested) + ' ' + word + ' the request') });
			}
			if (conv.other_left_at) events.push({ t: conv.other_left_at, rank: 2, node: statusLine(them + ' left the conversation') });
			messages.forEach(function (m) { events.push({ t: m.created_at, rank: 1, node: bubble(m) }); });
			events.sort(function (a, b) { return a.t < b.t ? -1 : a.t > b.t ? 1 : a.rank - b.rank; });
			events.forEach(function (e) { timeline.appendChild(e.node); });
			earlier.hidden = !hasEarlier;
			drawFooter();
		}

		// What goes under the last message depends on where the conversation stands
		function drawFooter() {
			footer.replaceChildren();
			if (conv.status === 'pending' && conv.i_requested) {
				footer.appendChild(el('p', 'msgStatusText msgFooterNote', them + ' hasn\'t accepted this request yet'));
				const cancel = button('Cancel Request', 'isDanger');
				cancel.addEventListener('click', function () { cancelRequest(conv, leaveTo('You cancelled your request to ' + them + '.')); });
				footer.appendChild(cancel);
				footer.className = 'msgFooter isCentered';
			} else if (conv.status === 'pending') {
				const row = el('div', 'msgFooterActions');
				const accept = button('Accept Request', 'isPrimary');
				const decline = button('Decline Request', 'isDanger');
				const err = el('p', 'msgError');
				err.setAttribute('role', 'alert');
				accept.addEventListener('click', async function () {
					accept.disabled = true;
					accept.textContent = 'Accepting…';
					const problem = await rpc('respond_to_request', { conversation: conv.conversation_id, accept: true });
					if (problem) { accept.disabled = false; accept.textContent = 'Accept Request'; err.textContent = problem; return; }
					live.textContent = 'Request accepted. You can reply now.';
					await showThread(conv.conversation_id, { reply: true });
				});
				decline.addEventListener('click', function () { declineRequest(conv, reload); });
				row.append(accept, decline);
				footer.append(row, err);
				footer.className = 'msgFooter isCentered';
			} else if (conv.status === 'declined') {
				footer.className = 'msgFooter isCentered';
				footer.appendChild(el('p', 'msgFooterNote', 'You declined this request. ' + them + ' isn\'t told.'));
			} else if (conv.other_left_at) {
				footer.className = 'msgFooter isCentered';
				footer.appendChild(el('p', 'msgFooterNote', 'You can\'t reply to this conversation anymore.'));
			} else if (replyOpen) {
				footer.className = 'msgFooter';
				footer.appendChild(replyBox());
			} else {
				footer.className = 'msgFooter isRight';
				const reply = button('Reply', 'isPrimary msgReplyButton');
				reply.addEventListener('click', function () {
					replyOpen = true;
					drawFooter();
					footer.querySelector('textarea').focus();
				});
				footer.appendChild(reply);
			}
		}

		function replyBox() {
			const form = el('form', 'msgReply');
			form.noValidate = true;
			const field = el('label', 'crwdField msgReplyField');
			field.appendChild(el('span', 'msgSrOnly', 'Reply to ' + them));
			const ta = el('textarea');
			ta.name = 'reply';
			ta.rows = 3;
			ta.maxLength = MAX_MESSAGE;
			ta.placeholder = 'Write a reply…';
			const counter = el('span', 'crwdCounter', '0 / ' + MAX_MESSAGE);
			ta.addEventListener('input', function () { counter.textContent = ta.value.length + ' / ' + MAX_MESSAGE; err.textContent = ''; });
			field.append(ta, counter);
			const err = el('p', 'msgError');
			err.setAttribute('role', 'alert');
			const row = el('div', 'msgReplyActions');
			const cancel = button('Cancel', 'isDanger');
			const send = el('button', 'messagesButton isPrimary', 'Send');
			send.type = 'submit';
			row.append(cancel, send);
			form.append(field, err, row);

			function close() {
				replyOpen = false;
				drawFooter();
				const r = footer.querySelector('.msgReplyButton');
				if (r) r.focus();
			}
			cancel.addEventListener('click', close);
			ta.addEventListener('keydown', function (e) {
				if (e.key === 'Escape') { e.stopPropagation(); close(); }
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
			});
			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const text = ta.value.trim();
				if (!text) { err.textContent = 'Write a message first.'; ta.focus(); return; }
				send.disabled = true;
				send.textContent = 'Sending…';
				const { data, error } = await core.sb.from('messages')
					.insert({ conversation_id: conv.conversation_id, body: text })
					.select('id, sender_id, body, created_at').single();
				if (error) {
					send.disabled = false;
					send.textContent = 'Send';
					err.textContent = /row-level security/i.test(error.message || '')
						? 'This conversation can\'t take new messages anymore.' : core.friendlyError(error).message;
					return;
				}
				if (!messages.some(function (m) { return m.id === data.id; })) messages.push(data);
				replyOpen = false;
				draw();
				markRead();
				live.textContent = 'Message sent.';
				const r = footer.querySelector('.msgReplyButton');
				if (r) r.focus();
			});
			return form;
		}

		function markRead() {
			core.sb.from('conversation_members').update({ last_read_at: new Date().toISOString() })
				.eq('conversation_id', conv.conversation_id).eq('user_id', me)
				.then(function (r) {
					if (r.error) { console.warn('[messages] mark read', r.error); return; }
					if (ui && typeof ui.refreshUnread === 'function') ui.refreshUnread(); // header dot
				});
		}

		earlier.addEventListener('click', async function () {
			earlier.disabled = true;
			const page = await loadMessages(messages.length ? messages[0].created_at : null);
			earlier.disabled = false;
			if (!page) return;
			messages = page.rows.concat(messages);
			hasEarlier = page.more;
			draw();
		});

		// New messages from them while the page is open
		function listen() {
			if (channel) { core.sb.removeChannel(channel); channel = null; }
			if (conv.status !== 'accepted' || conv.other_left_at || typeof core.sb.channel !== 'function') return;
			channel = core.sb.channel('messages-' + conv.conversation_id)
				.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: 'conversation_id=eq.' + conv.conversation_id }, function (payload) {
					const m = payload && payload.new;
					if (!m || messages.some(function (x) { return x.id === m.id; })) return;
					messages.push(m);
					draw();
					markRead();
					if (m.sender_id !== me) live.textContent = 'New message from ' + them + '.';
				})
				.subscribe();
		}

		(async function start() {
			const page = await loadMessages(null);
			if (!page) { showState('This conversation couldn\'t load. Please try again in a bit.', [{ label: 'Back to Messages', href: messagesUrl() }]); return; }
			messages = page.rows;
			hasEarlier = page.more;
			draw();
			markRead();
			listen();
			// Reply box open (just accepted): start typing right away. Otherwise land on the newest message.
			const box = footer.querySelector('textarea');
			if (box) box.focus();
			else {
				const last = timeline.lastElementChild;
				if (last) last.scrollIntoView({ block: 'nearest' });
			}
		})();
	}

	// ------------------------------------------------------------------
	// Start
	// ------------------------------------------------------------------

	function route() {
		const id = new URLSearchParams(window.location.search).get('c');
		if (id) showThread(id); else showList();
	}

	// Keep "5 mins ago" current
	setInterval(function () {
		document.querySelectorAll('time[data-ago]').forEach(function (t) {
			t.textContent = t.dataset.ago + ago(t.dateTime);
		});
	}, 60000);

	if (!core || !core.enabled) {
		showState('Messages are unavailable right now. Please try again in a bit.');
		return;
	}

	core.onChange(function (state) {
		if (!state.user) {
			builtFor = null;
			if (channel) { core.sb.removeChannel(channel); channel = null; }
			showState('Sign in to see your messages.', [{ label: 'Sign In', onClick: function () { ui.openAuth('signin'); } }]);
			return;
		}
		if (state.user.id !== builtFor) {
			builtFor = state.user.id;
			route();
		}
	});
})();
