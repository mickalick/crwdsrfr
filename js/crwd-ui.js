/*
 * js/crwd-ui.js — CRWD SRFR account UI shared by every page:
 *   • the profile button + popup menu on the right side of the header
 *   • the account modal: Sign In, Register, "check your email" (emailed code or link), username setup
 *
 * Needs crwd-core.js (data) and nav.js (which creates the #accountNav mount),
 * both loaded before this file. Styles live in /css/crwd-ui.css.
 *
 * Exposes window.CrwdUI:
 *   CrwdUI.openAuth('signin' | 'register' | 'username')
 *   CrwdUI.openDialog(build, { size: 'wide' })  → same modal, your own content (see openDialog below)
 *   CrwdUI.requireSignIn()  → true if signed in; otherwise opens Sign In and returns false
 *   CrwdUI.closeModal()
 *   CrwdUI.refreshUnread()  → re-check the "new" dots (Messages and Lineup call it after something is read or dismissed)
 *   CrwdUI.maxBadge()  → the Max badge to put after a username (when the profile's max_badge is true)
 *
 * Anything a user typed (names, usernames, emails) is inserted with textContent,
 * never innerHTML.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const mount = document.getElementById('accountNav');

	// No accounts on this page (supabase-js didn't load): leave the header as-is
	if (!core || !core.enabled) {
		if (mount) mount.remove();
		window.CrwdUI = { openAuth: function () {}, openDialog: function () {}, requireSignIn: function () { return false; }, closeModal: function () {}, refreshUnread: function () {}, maxBadge: function () { return document.createTextNode(''); } };
		return;
	}

	const RESEND_SECONDS = 60; // Supabase allows one email per address per 60s by default
	const CODE = core.CODE_LENGTH || 6; // digits in the emailed code (set in crwd-core.js)

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	// =====================================================================
	// Header: profile button + popup menu
	// =====================================================================

	let menuBtn = null;
	let menu = null;

	if (mount) {
		mount.innerHTML =
			// isLoading hides the icon until we know which one to show (login vs user)
			'<button type="button" id="profileButton" class="isLoading" aria-controls="profileMenu" aria-label="Account">' +
				'<span class="icon" id="prf"></span>' +
				'<span class="crwdUnreadDot" aria-hidden="true"></span>' +
			'</button>' +
			'<div id="profileMenu" hidden></div>';

		menuBtn = document.getElementById('profileButton');
		menu = document.getElementById('profileMenu');

		menuBtn.addEventListener('click', function (e) {
			// Signed out: no menu, go straight to the sign-in modal
			if (!core.user) { openAuth('signin'); return; }
			// e.detail is 0 for Enter/Space, so only keyboard users get focus moved into the menu
			if (menu.hidden) openMenu(e.detail === 0); else closeMenu();
		});

		// Close when clicking anywhere else (same behavior as the calendar's View menu)
		document.addEventListener('click', function (e) {
			if (!menu.hidden && !mount.contains(e.target)) closeMenu(false);
		});

		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && !menu.hidden) closeMenu();
		});

		// Back button can restore a page from cache with the menu still open
		window.addEventListener('pageshow', function (e) {
			if (e.persisted) closeMenu(false);
		});
	}

	function openMenu(focusFirst) {
		menu.hidden = false;
		menuBtn.classList.add('open');
		menuBtn.setAttribute('aria-expanded', 'true');
		const first = menu.querySelector('a, button');
		if (focusFirst && first) first.focus({ preventScroll: true });
	}

	function closeMenu(returnFocus) {
		if (!menu || menu.hidden) return;
		menu.hidden = true;
		menuBtn.classList.remove('open');
		menuBtn.setAttribute('aria-expanded', 'false');
		if (returnFocus !== false) menuBtn.focus({ preventScroll: true });
	}

	// The icon itself swaps in CSS: login.svg signed out, user.svg signed in
	function renderAvatar(state) {
		const p = state.profile;
		menuBtn.classList.remove('isLoading');
		menuBtn.classList.toggle('isGuest', !state.user);

		if (state.user) {
			menuBtn.setAttribute('aria-haspopup', 'true');
			menuBtn.setAttribute('aria-expanded', menu.hidden ? 'false' : 'true');
			menuBtn.setAttribute('aria-label', accountLabel());
		} else {
			closeMenu(false); // e.g. signed out in another tab while the menu was open
			menuBtn.removeAttribute('aria-haspopup');
			menuBtn.removeAttribute('aria-expanded');
			menuBtn.setAttribute('aria-label', 'Sign in');
		}
	}

	// Icon artwork for each name is set in crwd-ui.css (.profileMenuIcon[data-icon=…])
	function menuIcon(name) {
		const icon = el('span', 'profileMenuIcon');
		icon.dataset.icon = name;
		icon.setAttribute('aria-hidden', 'true');
		return icon;
	}

	function menuLink(label, href, icon) {
		const li = el('li');
		const a = el('a', 'profileMenuItem');
		a.href = href;
		a.append(menuIcon(icon), label);
		li.appendChild(a);
		return li;
	}

	// ---------- "new" dots ----------
	// The account button gets a dot when anything is new; inside the menu, Messages gets one for
	// new requests/conversation updates (my_conversations.unread) and Lineup for undismissed
	// ripples (my_ripples). Just dots, no counts.
	const unread = { messages: false, lineup: false };

	function accountLabel() {
		const p = core.profile;
		const what = [unread.messages ? 'new messages' : null, unread.lineup ? 'new ripples' : null].filter(Boolean);
		return 'Account menu' + (p ? ' for @' + p.username : '') + (what.length ? ', ' + what.join(' and ') : '');
	}

	// The dot + screen-reader "(new)" on one menu item (data-unread="messages" / "lineup")
	function markMenuItem(key) {
		const item = menu && menu.querySelector('[data-unread="' + key + '"]');
		if (!item) return;
		item.classList.toggle('hasUnread', unread[key]);
		item.querySelector('.crwdUnreadNote').textContent = unread[key] ? ' (new)' : '';
	}

	function setUnread(key, on) {
		unread[key] = on;
		if (!mount) return;
		mount.classList.toggle('hasUnread', unread.messages || unread.lineup);
		if (core.user) menuBtn.setAttribute('aria-label', accountLabel());
		markMenuItem(key);
	}

	let unreadCheck = 0; // only the newest check counts (an older, slower one could be out of date)
	async function refreshUnread() {
		const mine = ++unreadCheck;
		if (!core.user) { setUnread('messages', false); setUnread('lineup', false); return; }
		const [msgs, ripples] = await Promise.all([
			core.sb.from('my_conversations')
				.select('conversation_id', { count: 'exact', head: true })
				.eq('unread', true)
				.in('status', ['pending', 'accepted']),
			core.sb.from('my_ripples').select('id', { count: 'exact', head: true })
		]);
		if (mine !== unreadCheck) return;
		if (msgs.error) console.warn('[crwd] unread messages check failed', msgs.error);
		else setUnread('messages', (msgs.count || 0) > 0);
		if (ripples.error) console.warn('[crwd] ripples check failed', ripples.error);
		else setUnread('lineup', (ripples.count || 0) > 0);
	}

	// A menu link with room for a "new" dot on its icon
	function dottedMenuLink(label, href, icon, key) {
		const li = menuLink(label, href, icon);
		const link = li.firstChild;
		const iconEl = link.querySelector('.profileMenuIcon');
		const wrap = el('span', 'profileMenuIconWrap');
		iconEl.replaceWith(wrap);
		wrap.append(iconEl, el('span', 'crwdUnreadDot'));
		link.dataset.unread = key;
		link.appendChild(el('span', 'crwdSrOnly crwdUnreadNote'));
		return li;
	}

	// Check again when someone comes back to the tab, and every couple of minutes while it's open
	document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshUnread(); });
	setInterval(function () { if (!document.hidden) refreshUnread(); }, 120000);

	function menuAction(label, icon, onClick, extraClass) {
		const li = el('li');
		const b = el('button', 'profileMenuItem' + (extraClass ? ' ' + extraClass : ''));
		b.type = 'button';
		b.append(menuIcon(icon), label);
		b.addEventListener('click', onClick);
		li.appendChild(b);
		return li;
	}

	// Only used when signed in; signed-out clicks open the sign-in modal instead
	function renderMenu(state) {
		menu.replaceChildren();
		if (!state.user) return;

		const list = el('ul', 'profileMenuList');
		const p = state.profile;
		// Username only; display names appear on profile pages and nowhere else.
		// Skipped for placeholder accounts, which see "Pick your username" instead.
		if (p && !core.needsUsername()) {
			const head = el('div', 'profileMenuHead');
			head.appendChild(el('span', 'profileMenuName', '@' + p.username));
			menu.appendChild(head);
		}

		if (core.needsUsername()) {
			list.appendChild(menuAction('Pick your username', 'profile', function () { closeMenu(false); openAuth('username'); }, 'isAlert'));
		} else if (p) {
			list.appendChild(menuLink('My Profile', core.profileUrl(p.username), 'profile'));
		}
		list.appendChild(dottedMenuLink('Lineup', '/lineup/', 'lineup', 'lineup'));
		list.appendChild(dottedMenuLink('Messages', '/messages/', 'messages', 'messages'));
		list.appendChild(menuLink('Settings', '/settings/', 'settings'));

		const out = menuAction('Sign Out', 'logout', async function () {
			closeMenu(false);
			try { await core.signOut(); } catch (e) { alert(e.message); }
		});
		out.classList.add('profileMenuDivider');
		list.appendChild(out);

		menu.appendChild(list);
	}

	// =====================================================================
	// Account modal
	// =====================================================================

	const modal = el('div', 'crwdModal');
	modal.id = 'crwdModal';
	modal.hidden = true;
	modal.innerHTML =
		'<div class="crwdModalBackdrop" data-close></div>' +
		'<div class="crwdModalPanel" role="dialog" aria-modal="true" aria-labelledby="crwdModalTitle">' +
			'<button type="button" class="crwdModalClose" aria-label="Close" data-close><span class="crwdIconClose"></span></button>' +
			'<div class="crwdModalBody"></div>' +
		'</div>';
	document.body.appendChild(modal);

	const panel = modal.querySelector('.crwdModalPanel');
	const body = modal.querySelector('.crwdModalBody');
	let currentView = null;
	let returnFocusTo = null;
	let resendTimer = null;
	let closeGuard = null;   // a dialog's beforeClose(): return false to keep it open (e.g. unsaved post)

	// Remembers what was typed, so "Use a different email" or switching views keeps it
	const draft = { email: '', username: '', remember: true };

	modal.addEventListener('click', function (e) {
		if (e.target.closest('[data-close]')) closeModal();
	});

	// Listens on the whole document, not just the modal: when a button is disabled
	// while busy, the browser moves focus out of the modal, and keys still need to work.
	document.addEventListener('keydown', function (e) {
		if (modal.hidden) return;
		if (e.key === 'Escape') { closeModal(); return; }
		if (e.key !== 'Tab') return;
		// Keep Tab inside the dialog
		const focusable = [...panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')]
			.filter(function (n) { return n.offsetParent !== null; });
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (!panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
		else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	});

	function openAuth(view, opts) {
		if (modal.hidden) returnFocusTo = document.activeElement;
		modal.hidden = false;
		document.documentElement.classList.add('crwdModalOpen');
		showView(view, opts || {});
	}

	// force: skip the dialog's beforeClose check (used after a successful save)
	function closeModal(force) {
		if (modal.hidden) return;
		if (force !== true && closeGuard && closeGuard() === false) return;
		closeGuard = null;
		modal.hidden = true;
		document.documentElement.classList.remove('crwdModalOpen');
		clearInterval(resendTimer);
		currentView = null;
		if (returnFocusTo && document.contains(returnFocusTo)) returnFocusTo.focus({ preventScroll: true });
	}

	function showView(view, opts) {
		clearInterval(resendTimer);
		currentView = view;
		closeGuard = opts.beforeClose || null;
		panel.dataset.view = view;
		// Sign in / register / code / username: always centered, even on phones (see crwd-ui.css)
		modal.classList.toggle('isAccount', view !== 'dialog');
		panel.dataset.size = opts.size || '';
		body.replaceChildren();
		({ signin: viewSignIn, register: viewRegister, sent: viewSent, username: viewUsername, dialog: viewDialog })[view](opts);
		// [data-autofocus] wins; otherwise the first text field, then the first button
		const target = body.querySelector('[data-autofocus]')
			|| body.querySelector('input:not([type=file]):not([type=checkbox]):not([type=radio]), textarea')
			|| body.querySelector('button');
		(target || panel).focus({ preventScroll: true });
	}

	// ---------- custom dialogs (used by other pages) ----------

	// The pieces the sign-in views are built from, handed to other pages' dialogs
	// so every modal on the site looks and behaves the same.
	const kit = {
		el: el,
		title: function (html) { return title(html); }, // static copy only — never user input
		field: function (opts) { return field(opts); },
		errorBox: function () { return errorBox(); },
		showError: function (box, msg) { showError(box, msg); },
		submitButton: function (label) { return submitButton(label); },
		setBusy: function (btn, busy, label) { setBusy(btn, busy, label); },
		wireUsername: function (f) { return wireUsername(f); }, // live "is it free?" hint; returns a final-check function
		close: function () { closeModal(true); }
	};

	function viewDialog(opts) {
		opts.build(body, kit);
	}

	// build(body, kit) fills the modal with your content, e.g.
	//   CrwdUI.openDialog(function (body, kit) {
	//     body.appendChild(kit.title('Report <em>user</em>'));
	//     ...
	//   }, { size: 'wide' });
	// opts.beforeClose(): called on Escape / ✕ / backdrop; return false to stay open.
	// kit.close() always closes.
	function openDialog(build, opts) {
		openAuth('dialog', Object.assign({}, opts || {}, { build: build }));
	}

	// ---------- shared form pieces ----------

	function title(html) {
		// html here is our own static copy (for the <em> accent), never user input
		const h = el('h2', 'crwdModalTitle');
		h.id = 'crwdModalTitle';
		h.innerHTML = html;
		return h;
	}

	function field(opts) {
		const wrap = el('label', 'crwdField');
		wrap.appendChild(el('span', 'crwdLabel', opts.label));
		const input = document.createElement('input');
		input.type = opts.type || 'text';
		input.name = opts.name;
		if (opts.autocomplete) input.autocomplete = opts.autocomplete;
		if (opts.maxLength) input.maxLength = opts.maxLength;
		if (opts.placeholder) input.placeholder = opts.placeholder;
		if (opts.value) input.value = opts.value;
		if (opts.username) {
			input.autocapitalize = 'none';
			input.spellcheck = false;
			input.setAttribute('autocorrect', 'off');
		}
		wrap.appendChild(input);
		let hint = null;
		if (opts.hint) {
			hint = el('span', 'crwdHint', opts.hint);
			hint.id = 'crwdHint-' + opts.name;
			input.setAttribute('aria-describedby', hint.id);
			wrap.appendChild(hint);
		}
		return { wrap: wrap, input: input, hint: hint };
	}

	function errorBox() {
		const p = el('p', 'crwdFormError');
		p.setAttribute('role', 'alert');
		p.hidden = true;
		return p;
	}

	function showError(box, message) {
		box.textContent = message || '';
		box.hidden = !message;
	}

	function submitButton(label) {
		const b = el('button', 'crwdButton', label);
		b.type = 'submit';
		return b;
	}

	function setBusy(button, busy, label) {
		button.disabled = busy;
		button.textContent = label;
	}

	function switchLine(text, linkLabel, view) {
		const p = el('p', 'crwdModalSwitch', text + ' ');
		const b = el('button', 'crwdLinkButton', linkLabel);
		b.type = 'button';
		b.addEventListener('click', function () { showView(view, {}); });
		p.appendChild(b);
		return p;
	}

	function looksLikeEmail(v) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
	}

	// "Keep me signed in for 30 days" (styles: .crwdCheck in crwd-ui.css)
	function rememberCheckbox() {
		const wrap = el('label', 'crwdCheck');
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.name = 'remember';
		box.checked = draft.remember;
		box.addEventListener('change', function () { draft.remember = box.checked; });
		wrap.append(box, el('span', null, 'Keep me signed in for 30 days'));
		return wrap;
	}

	// Sends the sign-in email. The remember choice must be saved BEFORE the session exists.
	function sendEmail(registering) {
		core.setRememberMe(draft.remember);
		// Lets this browser welcome the account after its first sign-in (see welcomeNewAccount)
		if (registering) store(function (s) { s.setItem(NEW_ACCOUNT_KEY, draft.email.trim().toLowerCase()); });
		return registering
			? core.register({ email: draft.email, username: draft.username })
			: core.signIn(draft.email);
	}

	// Live username availability. Returns a function that reports the latest result.
	function wireUsername(f) {
		const defaultHint = f.hint.textContent;
		let seq = 0;
		let timer = null;
		let result = { ok: false, reason: 'format' };

		function setHint(text, state) {
			f.hint.textContent = text;
			f.hint.dataset.state = state || '';
		}

		async function check() {
			const name = f.input.value;
			const mine = ++seq;
			if (!name) { result = { ok: false, reason: 'format' }; setHint(defaultHint); return result; }
			if (!core.USERNAME_RE.test(name)) {
				result = { ok: false, reason: 'format' };
				setHint(name.length < 3 ? 'At least 3 characters' : 'Only letters, numbers and underscores', 'bad');
				return result;
			}
			setHint('Checking…', 'pending');
			const r = await core.checkUsername(name);
			if (mine !== seq) return result; // a newer keystroke already started another check
			result = r;
			if (r.ok) setHint('crwdsrfr.com/u/?' + name + ' is yours', 'good');
			else if (r.reason === 'unavailable') setHint('That username isn\'t available', 'bad');
			else setHint('Couldn\'t check right now. Try again in a moment.', 'bad');
			return result;
		}

		f.input.addEventListener('input', function () {
			// Usernames are lowercase; convert as they type
			const lower = f.input.value.toLowerCase();
			if (lower !== f.input.value) {
				const pos = f.input.selectionStart;
				f.input.value = lower;
				f.input.setSelectionRange(pos, pos);
			}
			clearTimeout(timer);
			timer = setTimeout(check, 350);
		});

		if (f.input.value) check();
		return function finalCheck() { clearTimeout(timer); return check(); };
	}

	// ---------- views ----------

	function viewSignIn(opts) {
		body.appendChild(title('Welcome <em>back</em>'));
		body.appendChild(el('p', 'crwdModalText', 'Enter your email and we\'ll send you a ' + CODE + '-digit code. No password needed.'));

		const form = el('form', 'crwdForm');
		form.noValidate = true;
		const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', value: draft.email });
		const err = errorBox();
		const btn = submitButton('Send my code');
		form.append(email.wrap, rememberCheckbox(), err, btn);
		body.appendChild(form);
		body.appendChild(switchLine('New here?', 'Register Now', 'register'));

		if (opts.error) showError(err, opts.error);

		form.addEventListener('submit', async function (e) {
			e.preventDefault();
			draft.email = email.input.value.trim();
			if (!looksLikeEmail(draft.email)) { showError(err, 'Enter the email you registered with.'); email.input.focus(); return; }
			showError(err, '');
			setBusy(btn, true, 'Sending…');
			try {
				await sendEmail(false);
				showView('sent', { mode: 'signin' });
			} catch (ex) {
				setBusy(btn, false, 'Send my code');
				showError(err, ex.code === 'no_account' ? ex.message + ' Want to register instead?' : ex.message);
			}
		});
	}

	function viewRegister() {
		body.appendChild(title('Join the <em>crowd</em>'));
		body.appendChild(el('p', 'crwdModalText', 'Register for a SRFR account to hype shows, acts and venues, post to the Board, and message with other SRFRs.'));

		const form = el('form', 'crwdForm');
		form.noValidate = true;
		const email = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', value: draft.email,
			hint: 'Never shown on the site.' });
		const username = field({ label: 'Username', name: 'username', autocomplete: 'username', maxLength: 24, username: true,
			value: draft.username, hint: '3–24 characters: letters, numbers, underscores' });
		const fine = el('p', 'crwdFinePrint', 'By registering you agree to the ');
		const terms = el('a', null, 'Terms of Use'); terms.href = '/terms.html';
		const privacy = el('a', null, 'Privacy Policy'); privacy.href = '/privacy.html';
		fine.append(terms, ' and ', privacy, '.');

		const err = errorBox();
		const btn = submitButton('Send my code');
		// Fields, then fine print, then any error right above the button
		form.append(email.wrap, username.wrap, rememberCheckbox(), fine, err, btn);
		body.appendChild(form);
		body.appendChild(switchLine('Already have an account?', 'Sign in', 'signin'));

		const finalUsernameCheck = wireUsername(username);

		form.addEventListener('submit', async function (e) {
			e.preventDefault();
			draft.email = email.input.value.trim();
			draft.username = username.input.value.trim();

			if (!looksLikeEmail(draft.email)) { showError(err, 'Enter a valid email address.'); email.input.focus(); return; }
			setBusy(btn, true, 'Checking…');
			const u = await finalUsernameCheck();
			if (!u.ok) {
				setBusy(btn, false, 'Send my code');
				showError(err, 'Choose a different username.');
				username.input.focus();
				return;
			}

			showError(err, '');
			setBusy(btn, true, 'Sending…');
			try {
				await sendEmail(true);
				showView('sent', { mode: 'register' });
			} catch (ex) {
				setBusy(btn, false, 'Send my code');
				showError(err, ex.message);
			}
		});
	}

	function viewSent(opts) {
		const registering = opts.mode === 'register';
		body.appendChild(title('Check your <em>email</em>'));

		const p = el('p', 'crwdModalText', 'We sent a ' + CODE + '-digit code to ');
		p.appendChild(el('strong', null, draft.email));
		p.append(registering
			? '. Enter it below to finish creating your account, or tap the button in the email.'
			: '. Enter it below to sign in, or tap the button in the email.');
		body.appendChild(p);

		// Code entry
		const form = el('form', 'crwdForm');
		form.noValidate = true;
		// No maxLength: a pasted "123 456" must fit before the spaces are stripped
		const code = field({ label: CODE + '-digit code', name: 'code', autocomplete: 'one-time-code' });
		code.input.inputMode = 'numeric';
		code.input.classList.add('crwdCodeInput');
		code.input.dataset.autofocus = '';
		const err = errorBox();
		const verify = submitButton(registering ? 'Create my account' : 'Sign in');
		form.append(code.wrap, err, verify);
		body.appendChild(form);

		let verifying = false;
		async function submitCode() {
			if (verifying) return;
			verifying = true;
			showError(err, '');
			setBusy(verify, true, 'Checking…');
			try {
				await core.verifyCode(draft.email, code.input.value);
				// Signed in: onChange (below) closes this modal, and asks placeholder accounts for a username
				setBusy(verify, true, 'Signing in…');
			} catch (ex) {
				verifying = false;
				setBusy(verify, false, registering ? 'Create my account' : 'Sign in');
				showError(err, ex.message);
				code.input.select();
			}
		}

		form.addEventListener('submit', function (e) { e.preventDefault(); submitCode(); });
		// Digits only. Nothing is checked until they press the button (or Enter).
		code.input.addEventListener('input', function () {
			const digits = code.input.value.replace(/\D/g, '').slice(0, CODE);
			if (digits !== code.input.value) code.input.value = digits;
		});

		body.appendChild(el('p', 'crwdModalText crwdMuted', 'Don\'t see it? Check your spam folder. Each code works once and expires in 10 minutes.'));

		const resend = el('button', 'crwdButton crwdButtonSecondary');
		resend.type = 'button';
		body.appendChild(resend);

		const back = el('p', 'crwdModalSwitch');
		const other = el('button', 'crwdLinkButton', 'Use a different email');
		other.type = 'button';
		other.addEventListener('click', function () { showView(registering ? 'register' : 'signin', {}); });
		back.appendChild(other);
		body.appendChild(back);

		function countdown(seconds) {
			let left = seconds;
			resend.disabled = true;
			resend.textContent = 'Resend in ' + left + 's';
			clearInterval(resendTimer);
			resendTimer = setInterval(function () {
				left -= 1;
				if (left <= 0) {
					clearInterval(resendTimer);
					resend.disabled = false;
					resend.textContent = 'Send a new code';
				} else {
					resend.textContent = 'Resend in ' + left + 's';
				}
			}, 1000);
		}

		resend.addEventListener('click', async function () {
			showError(err, '');
			resend.disabled = true;
			resend.textContent = 'Sending…';
			try {
				await sendEmail(registering);
				code.input.value = '';
				code.input.focus();
				countdown(RESEND_SECONDS);
			} catch (ex) {
				showError(err, ex.message);
				countdown(ex.code === 'rate_limited' ? RESEND_SECONDS : 5);
			}
		});

		countdown(RESEND_SECONDS);
	}

	// Shown when the database gave the account a placeholder username
	// (their pick was taken during sign-up), or from "Pick your username" in the menu.
	function viewUsername() {
		body.appendChild(title('Pick a <em>username</em>'));
		body.appendChild(el('p', 'crwdModalText',
			'The username you chose was taken while your account was being created. Pick another. It becomes your profile link.'));

		const form = el('form', 'crwdForm');
		form.noValidate = true;
		const username = field({ label: 'Username', name: 'username', autocomplete: 'username', maxLength: 24, username: true,
			hint: '3–24 characters: letters, numbers, underscores' });
		const err = errorBox();
		const btn = submitButton('Save');
		form.append(username.wrap, err, btn);
		body.appendChild(form);

		const later = el('p', 'crwdModalSwitch');
		const laterBtn = el('button', 'crwdLinkButton', 'Not now');
		laterBtn.type = 'button';
		laterBtn.addEventListener('click', closeModal);
		later.appendChild(laterBtn);
		body.appendChild(later);

		const finalUsernameCheck = wireUsername(username);

		form.addEventListener('submit', async function (e) {
			e.preventDefault();
			setBusy(btn, true, 'Checking…');
			const u = await finalUsernameCheck();
			if (!u.ok) { setBusy(btn, false, 'Save'); showError(err, 'Choose a different username.'); username.input.focus(); return; }
			showError(err, '');
			setBusy(btn, true, 'Saving…');
			try {
				await core.updateProfile({ username: username.input.value.trim() });
				closeModal();
			} catch (ex) {
				setBusy(btn, false, 'Save');
				showError(err, ex.message);
			}
		});
	}

	// =====================================================================
	// React to sign-in state
	// =====================================================================

	let usernamePromptShown = false;

	// ---------- Brand-new accounts land on their profile with Edit Profile open ----------
	// "New" = registered in this browser (the Register form sets a note), or the account was created
	// within the last hour (covers the email's button opened in another browser). Each account is
	// welcomed once per browser; if that can't be remembered (storage blocked), there's no redirect,
	// so it can never loop.
	const NEW_ACCOUNT_KEY = 'crwd-new-account';  // email typed on the Register form
	const WELCOMED_KEY = 'crwd-welcomed';         // account ids already welcomed in this browser
	const NEW_ACCOUNT_MS = 60 * 60 * 1000;

	function store(fn) { try { return fn(window.localStorage); } catch (e) { return null; } }

	function welcomedIds() {
		return store(function (s) { return JSON.parse(s.getItem(WELCOMED_KEY) || '[]'); }) || [];
	}

	function welcomeNewAccount(state) {
		if (!state.user || !state.profile || core.needsUsername()) return; // placeholder accounts pick a username first
		if (welcomedIds().indexOf(state.user.id) !== -1) return;
		const registeredHere = store(function (s) { return s.getItem(NEW_ACCOUNT_KEY); }) === (state.user.email || '').toLowerCase();
		const created = Date.parse(state.user.created_at || '');
		const justCreated = created && Date.now() - created < NEW_ACCOUNT_MS;
		if (!registeredHere && !justCreated) return;

		const ids = welcomedIds().concat([state.user.id]).slice(-20);
		store(function (s) { s.setItem(WELCOMED_KEY, JSON.stringify(ids)); s.removeItem(NEW_ACCOUNT_KEY); });
		if (welcomedIds().indexOf(state.user.id) === -1) return; // couldn't save it: skip rather than risk a loop

		closeModal(true);
		window.location.href = core.profileUrl(state.profile.username) + '&welcome';
	}

	core.onChange(function (state) {
		if (menuBtn) {
			renderAvatar(state);
			renderMenu(state);
			markMenuItem('messages');
			markMenuItem('lineup');
			refreshUnread();
		}

		// Signed in (code entered here, or the email link opened in another tab): "check your email" is done
		if (state.user && currentView === 'sent') closeModal();

		welcomeNewAccount(state);

		// Once per page load, ask placeholder accounts to pick a username
		if (state.user && core.needsUsername() && !usernamePromptShown && modal.hidden) {
			usernamePromptShown = true;
			openAuth('username');
		}
	});

	// Came back from an expired or already-used link
	core.ready.then(function () {
		if (core.linkError && !core.user) {
			openAuth('signin', { error: 'That link has expired or was already used. Enter your email to get a new one.' });
			core.clearLinkError();
		}
	});

	// Max badge (srfrMax.svg, colored by crwd-ui.css) shown after a paid member's username, if they chose to show it
	function maxBadge() {
		const badge = el('span', 'icon crwdMaxBadge');
		badge.setAttribute('role', 'img');
		badge.setAttribute('aria-label', 'Max member');
		badge.title = 'Max member';
		return badge;
	}

	window.CrwdUI = {
		maxBadge: maxBadge,
		refreshUnread: refreshUnread,
		openAuth: openAuth,
		openDialog: openDialog,
		closeModal: closeModal,
		requireSignIn: function () {
			if (core.user) return true;
			openAuth('signin');
			return false;
		}
	};
})();
