/*
 * js/settings.js — the Settings & Privacy page (/settings/).
 *
 * Tabs: Account · Max (paid members only) · Notifications · Privacy
 * The tab is kept in the URL (#account, #max, #notifications, #privacy) so links can open one directly.
 *
 * Checkboxes and choices save as soon as they change ("Saved" appears next to them).
 * Email and username changes, Go Max and Delete Account open dialogs (CrwdUI.openDialog).
 *
 * Needs crwd-core.js + crwd-ui.js. Styles: /css/settings.css (+ crwd-ui.css for the dialogs).
 * Anything a user typed (emails, usernames) is inserted with textContent, never innerHTML.
 */
(function () {
	'use strict';

	const core = window.CrwdCore;
	const ui = window.CrwdUI;

	const $ = function (id) { return document.getElementById(id); };
	const els = {
		state: $('settingsState'), stateText: $('settingsStateText'), stateActions: $('settingsStateActions'),
		content: $('settingsContent')
	};

	const TABS = ['account', 'max', 'notifications', 'privacy'];
	const tabParts = function (name) {
		const cap = name.charAt(0).toUpperCase() + name.slice(1);
		return { tab: $('settingsTab' + cap), panel: $('settingsPanel' + cap) };
	};

	const USERNAME_DAYS = 30;
	const PLACEHOLDER_RE = /^user_[0-9a-f]{12}$/;
	const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
	const RESEND_SECONDS = 60;

	let loadedFor = null;  // user id the page was built for
	let emailShown = '';   // email + pending email the Account tab was drawn with
	let isMax = false;
	let deleted = false;   // shows a goodbye instead of "sign in" after deleting the account

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function at(username) { return '@' + username; }

	// The Max badge from crwd-ui.js. If that file is an older copy without it, skip the badge
	// instead of stopping the page.
	function maxBadge() {
		return ui && typeof ui.maxBadge === 'function' ? ui.maxBadge() : document.createTextNode('');
	}

	function longDate(value) {
		return new Date(value).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
	}

	// ------------------------------------------------------------------
	// Page states (loading / signed out / errors)
	// ------------------------------------------------------------------

	function showState(text, actions) {
		els.content.hidden = true;
		els.state.hidden = false;
		els.stateText.textContent = text;
		els.stateActions.replaceChildren();
		(actions || []).forEach(function (a) {
			const b = el(a.href ? 'a' : 'button', 'settingsButton', a.label);
			if (a.href) b.href = a.href; else { b.type = 'button'; b.addEventListener('click', a.onClick); }
			els.stateActions.appendChild(b);
		});
	}

	// ------------------------------------------------------------------
	// Tabs
	// ------------------------------------------------------------------

	function visibleTabs() {
		return TABS.filter(function (name) { return !tabParts(name).tab.hidden; });
	}

	function selectTab(name, focus) {
		if (visibleTabs().indexOf(name) === -1) name = 'account';
		TABS.forEach(function (t) {
			const parts = tabParts(t);
			const on = t === name;
			parts.tab.setAttribute('aria-selected', on ? 'true' : 'false');
			parts.tab.tabIndex = on ? 0 : -1;
			parts.panel.hidden = !on;
		});
		if (focus) tabParts(name).tab.focus();
		const hash = name === 'account' ? '' : '#' + name;
		if (window.location.hash !== hash) history.replaceState(null, '', window.location.pathname + window.location.search + hash);
	}

	TABS.forEach(function (name) {
		const tab = tabParts(name).tab;
		tab.addEventListener('click', function () { selectTab(name); });
		tab.addEventListener('keydown', function (e) {
			const list = visibleTabs();
			const i = list.indexOf(name);
			let next = null;
			if (e.key === 'ArrowRight') next = list[(i + 1) % list.length];
			if (e.key === 'ArrowLeft') next = list[(i - 1 + list.length) % list.length];
			if (e.key === 'Home') next = list[0];
			if (e.key === 'End') next = list[list.length - 1];
			if (next) { e.preventDefault(); selectTab(next, true); }
		});
	});

	window.addEventListener('hashchange', function () {
		if (!els.content.hidden) selectTab(window.location.hash.replace('#', ''));
	});

	// ------------------------------------------------------------------
	// Shared pieces
	// ------------------------------------------------------------------

	// A titled block inside a panel
	function section(panel, title, extraClass) {
		const s = el('section', 'settingsSection' + (extraClass ? ' ' + extraClass : ''));
		const head = el('div', 'settingsSectionHead');
		const h = el('h2', 'settingsHeading', title);
		head.appendChild(h);
		s.appendChild(head);
		panel.appendChild(s);
		return { el: s, head: head, heading: h };
	}

	// "Saved" / error line that sits next to a group of settings
	function statusLine() {
		const s = el('span', 'settingsStatus');
		s.setAttribute('role', 'status');
		let timer = null;
		return {
			el: s,
			saved: function () {
				clearTimeout(timer);
				s.textContent = 'Saved';
				s.dataset.state = 'good';
				timer = setTimeout(function () { s.textContent = ''; }, 2500);
			},
			error: function (msg) {
				clearTimeout(timer);
				s.textContent = msg;
				s.dataset.state = 'bad';
			},
			clear: function () { clearTimeout(timer); s.textContent = ''; }
		};
	}

	// Saves profile columns right away; undo() puts the control back if it fails
	async function saveNow(fields, status, undo) {
		status.clear();
		try {
			await core.updateProfile(fields);
			status.saved();
			return true;
		} catch (e) {
			if (undo) undo();
			status.error(e.message);
			return false;
		}
	}

	// One Save button for a whole tab. read() returns { column: value } for every setting in the tab;
	// Save sends only the ones that changed, and stays off until something does.
	const unsaved = {}; // tab name → "does it have unsaved changes?"
	function saveBar(tabName, read) {
		const panel = tabParts(tabName).panel;
		const bar = el('div', 'settingsSaveBar');
		const btn = settingsButton('Save', 'isPrimary');
		const status = statusLine();
		bar.append(btn, status.el);
		let saved = read();

		function changes() {
			const now = read();
			const out = {};
			Object.keys(now).forEach(function (k) { if (now[k] !== saved[k]) out[k] = now[k]; });
			return out;
		}
		function refresh() {
			const dirty = Object.keys(changes()).length > 0;
			btn.disabled = !dirty;
			if (dirty) status.clear();
		}
		panel.addEventListener('change', refresh);
		btn.addEventListener('click', async function () {
			const fields = changes();
			if (!Object.keys(fields).length) return;
			btn.disabled = true;
			btn.textContent = 'Saving…';
			const ok = await saveNow(fields, status);
			btn.textContent = 'Save';
			if (ok) saved = read();
			btn.disabled = ok;
		});
		unsaved[tabName] = function () { return Object.keys(changes()).length > 0; };
		refresh();
		return bar;
	}

	// Leaving the page with unsaved settings asks first
	window.addEventListener('beforeunload', function (e) {
		if (Object.keys(unsaved).some(function (k) { return unsaved[k](); })) {
			e.preventDefault();
			e.returnValue = '';
		}
	});

	// Checkbox row: [box] Label, with an optional note under it
	function checkbox(label, checked, hint) {
		const wrap = el('div', 'settingsCheckWrap');
		const row = el('label', 'settingsCheck');
		const input = el('input');
		input.type = 'checkbox';
		input.checked = !!checked;
		const text = el('span', 'settingsCheckText', label);
		row.append(input, text);
		wrap.appendChild(row);
		if (hint) {
			const h = el('p', 'settingsCheckHint', hint);
			h.id = 'settingsHint-' + Math.random().toString(36).slice(2, 9);
			input.setAttribute('aria-describedby', h.id);
			wrap.appendChild(h);
		}
		return { wrap: wrap, input: input, label: row, text: text };
	}

	// A set of radio choices, each with a short description (saved by the tab's Save button)
	function choices(name, legend, options, current) {
		const fs = el('fieldset', 'settingsChoices');
		fs.appendChild(el('legend', 'settingsHeading', legend));
		const list = el('div', 'crwdChoices');
		options.forEach(function (o) {
			const row = el('label', 'crwdChoice settingsChoice');
			const input = el('input');
			input.type = 'radio';
			input.name = name;
			input.value = o.value;
			input.checked = o.value === current;
			const text = el('span', 'settingsChoiceText');
			text.append(el('span', 'settingsChoiceLabel', o.label), el('span', 'settingsChoiceNote', o.note));
			row.append(input, text);
			list.appendChild(row);
		});
		fs.appendChild(list);
		return fs;
	}

	function settingsButton(label, extraClass) {
		const b = el('button', 'settingsButton' + (extraClass ? ' ' + extraClass : ''), label);
		b.type = 'button';
		return b;
	}

	// A paragraph mixing static copy with user text (an email or username), safely
	function textWith(kit, before, value, after) {
		const p = kit.el('p', 'crwdModalText', before);
		p.appendChild(kit.el('strong', null, value));
		if (after) p.append(after);
		return p;
	}

	function doneView(body, kit, titleHtml, noticeText, buttonLabel, onDone) {
		body.replaceChildren();
		body.appendChild(kit.title(titleHtml));
		body.appendChild(kit.el('p', 'crwdNotice', noticeText));
		const done = kit.el('button', 'crwdButton settingsDialogDone', buttonLabel || 'Done');
		done.type = 'button';
		done.addEventListener('click', onDone || kit.close);
		body.appendChild(done);
		done.focus({ preventScroll: true });
	}

	// ------------------------------------------------------------------
	// Building the page
	// ------------------------------------------------------------------

	async function build() {
		const user = core.user;
		loadedFor = user.id;
		showState('Loading your settings…');

		// Max = an active paid tier (the entitlements row is written only by the payment webhook)
		const { data: tier } = await core.sb.from('entitlements').select('tier, pro_until').eq('user_id', user.id).maybeSingle();
		isMax = !!(tier && tier.tier === 'pro' && (!tier.pro_until || new Date(tier.pro_until) > new Date()));

		if (!core.profile) {
			showState('We couldn\'t load your settings. Please try again in a bit.');
			return;
		}

		els.state.hidden = true;
		els.content.hidden = false;

		renderAccount();
		renderMax();
		renderNotifications();
		renderPrivacy();
		selectTab(window.location.hash.replace('#', '') || 'account');
	}

	// ---------- Account ----------

	function renderAccount() {
		const panel = tabParts('account').panel;
		panel.replaceChildren();
		const user = core.user;
		const me = core.profile;
		emailShown = (user.email || '') + '|' + (user.new_email || '');

		// Email
		const email = section(panel, 'Email');
		email.el.appendChild(el('p', 'settingsValue', user.email || ''));
		if (user.new_email) {
			const pending = el('p', 'settingsNote', 'Waiting for you to confirm ');
			pending.append(el('strong', null, user.new_email), '. Check both inboxes for the links.');
			email.el.appendChild(pending);
		}
		const emailBtn = settingsButton('Change Email');
		emailBtn.addEventListener('click', openEmailDialog);
		email.el.appendChild(emailBtn);

		// Username
		const name = section(panel, 'Username');
		name.el.appendChild(el('p', 'settingsValue', at(me.username)));
		const nameBtn = settingsButton('Change Username');
		nameBtn.addEventListener('click', openUsernameDialog);
		const next = nextUsernameChange();
		if (next) {
			nameBtn.disabled = true;
			name.el.appendChild(el('p', 'settingsNote', 'You can change your username again on ' + longDate(next) + '.'));
		} else {
			name.el.appendChild(el('p', 'settingsNote', 'You can change it once every ' + USERNAME_DAYS + ' days. Your profile link changes with it, so old links to your profile will stop working.'));
		}
		name.el.appendChild(nameBtn);

		// Download My Data
		const data = section(panel, 'Download My Data');
		data.el.appendChild(el('p', 'settingsText', 'Get a copy of your account, profile, posts, comments, hypes and messages as a JSON file.'));
		const dataRow = el('div', 'settingsActions');
		const dataBtn = settingsButton('Download My Data');
		const dataStatus = statusLine();
		dataBtn.addEventListener('click', function () { downloadData(dataBtn, dataStatus); });
		dataRow.append(dataBtn, dataStatus.el);
		data.el.appendChild(dataRow);

		// Delete Account
		const del = section(panel, 'Delete Account', 'isDanger');
		del.el.appendChild(el('p', 'settingsText', 'This permanently deletes your account and everything in it: your profile, posts, comments, hypes and messages. It can\'t be undone.'));
		const delBtn = settingsButton('Delete Account', 'isDanger');
		delBtn.addEventListener('click', openDeleteDialog);
		del.el.appendChild(delBtn);
	}

	// Date the username can change again, or null if it can change now
	function nextUsernameChange() {
		const me = core.profile;
		if (!me || !me.username_changed_at || PLACEHOLDER_RE.test(me.username)) return null;
		const next = new Date(new Date(me.username_changed_at).getTime() + USERNAME_DAYS * 86400000);
		return next > new Date() ? next : null;
	}

	function benefitsList() {
		const ul = el('ul', 'settingsBenefits');
		[
			['Max Badge', 'Displays next to your username to show your support'],
			['Header Image', 'Go further with your profile with a custom header image'],
			['Custom Colors', 'Swap the site\'s two main colors for your own'],
			['Lineup Newsletter', 'A weekly email listing new shows from the acts and venues you\'ve hyped']
		].forEach(function (b) {
			const li = el('li');
			li.append(el('strong', null, b[0]), ': ' + b[1]);
			ul.appendChild(li);
		});
		return ul;
	}

	function openEmailDialog() {
		const current = core.user.email || '';
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Change <em>email</em>'));
			body.appendChild(textWith(kit, 'Your email is ', current, '. We\'ll send a confirmation link to your current and new addresses. The change happens once you\'ve clicked both.'));
			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;
			const f = kit.field({ label: 'New Email Address', name: 'new_email', type: 'email', autocomplete: 'email' });
			const err = kit.errorBox();
			const btn = kit.submitButton('Send Confirmation');
			form.append(f.wrap, err, btn);
			body.appendChild(form);
			f.input.addEventListener('input', function () { kit.showError(err, ''); });

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const next = f.input.value.trim();
				if (!EMAIL_RE.test(next)) { kit.showError(err, 'That email address doesn\'t look right.'); f.input.focus(); return; }
				if (next.toLowerCase() === current.toLowerCase()) { kit.showError(err, 'That\'s already your email.'); f.input.focus(); return; }
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Sending…');
				const { error } = await core.sb.auth.updateUser({ email: next },
					{ emailRedirectTo: window.location.origin + '/settings/' });
				if (error) {
					kit.setBusy(btn, false, 'Send Confirmation');
					kit.showError(err, core.friendlyError(error).message);
					return;
				}
				doneView(body, kit, 'Check your <em>inbox</em>',
					'We sent confirmation links to ' + current + ' and ' + next + '. Your email changes once you\'ve clicked both.');
				// (Supabase reports the pending address with a USER_UPDATED event → the Email section redraws)
			});
		});
	}

	function openUsernameDialog() {
		const current = core.profile.username;
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Change <em>username</em>'));
			body.appendChild(textWith(kit, 'Your username is ', at(current),
				'. After changing it, you can\'t change it again for ' + USERNAME_DAYS + ' days, and old links to your profile will stop working.'));
			const form = kit.el('form', 'crwdForm');
			form.noValidate = true;
			const f = kit.field({ label: 'New Username', name: 'username', autocomplete: 'username', maxLength: 24, username: true,
				hint: '3–24 characters: letters, numbers, underscores' });
			const err = kit.errorBox();
			const btn = kit.submitButton('Change Username');
			form.append(f.wrap, err, btn);
			body.appendChild(form);
			const finalCheck = kit.wireUsername(f);
			f.input.addEventListener('input', function () { kit.showError(err, ''); });

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				const next = f.input.value.trim().toLowerCase();
				if (next === current) { kit.showError(err, 'That\'s already your username.'); f.input.focus(); return; }
				kit.setBusy(btn, true, 'Checking…');
				const check = await finalCheck();
				if (!check.ok) {
					kit.setBusy(btn, false, 'Change Username');
					kit.showError(err, 'Choose a different username.');
					f.input.focus();
					return;
				}
				kit.showError(err, '');
				kit.setBusy(btn, true, 'Saving…');
				try {
					await core.updateProfile({ username: next });
				} catch (ex) {
					kit.setBusy(btn, false, 'Change Username');
					kit.showError(err, ex.message);
					return;
				}
				doneView(body, kit, 'Username <em>changed</em>',
					'You\'re now ' + at(next) + '. Your profile is at crwdsrfr.com/u/?' + next + '.');
				renderAccount();
				// These show the username too; redraw them unless they have unsaved changes
				if (!unsaved.max || !unsaved.max()) renderMax();
				if (!unsaved.privacy || !unsaved.privacy()) renderPrivacy();
			});
		});
	}

	function openMaxDialog() {
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Surf to the <em>Max</em>'));
			body.appendChild(kit.el('p', 'crwdModalText', 'By subscribing to Max, you not only help us keep the lights on, but also unlock these cool features:'));
			body.appendChild(benefitsList());
			// TBD: plans + checkout go here once payments are set up
			body.appendChild(kit.el('p', 'crwdNotice', 'Max is coming soon. Check back here to sign up.'));
			const ok = kit.el('button', 'crwdButton settingsDialogDone', 'Got It');
			ok.type = 'button';
			ok.addEventListener('click', kit.close);
			body.appendChild(ok);
		}, { centered: true });
	}

	// TBD: how cancelling works depends on the payment provider (e.g. a link to its billing page)
	function openCancelMaxDialog() {
		ui.openDialog(function (body, kit) {
			body.appendChild(kit.title('Cancel <em>Max</em>'));
			body.appendChild(kit.el('p', 'crwdModalText', 'You\'ll be able to cancel your Max membership here once Max payments are set up.'));
			body.appendChild(kit.el('p', 'crwdNotice', 'Nothing has changed. You\'re still a Max member.'));
			const ok = kit.el('button', 'crwdButton settingsDialogDone', 'Got It');
			ok.type = 'button';
			ok.addEventListener('click', kit.close);
			body.appendChild(ok);
		}, { centered: true });
	}

	async function downloadData(btn, status) {
		status.clear();
		btn.disabled = true;
		btn.textContent = 'Preparing…';
		const { data, error } = await core.sb.rpc('export_my_data');
		btn.disabled = false;
		btn.textContent = 'Download My Data';
		if (error || !data) { status.error('Your data couldn\'t be prepared. Please try again.'); return; }

		const d = new Date();
		const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = el('a');
		a.href = url;
		a.download = 'crwdsrfr-' + core.profile.username + '-' + today + '.json';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
		status.saved();
		status.el.textContent = 'Downloaded';
	}

	// Delete: email a code → enter it (signs in fresh) → the delete-account Edge Function removes everything
	function openDeleteDialog() {
		const email = core.user.email || '';
		ui.openDialog(function (body, kit) {
			let resendTimer = null;

			function stepIntro() {
				body.replaceChildren();
				body.appendChild(kit.title('Delete <em>account</em>'));
				body.appendChild(kit.el('p', 'crwdModalText settingsDeleteIntro', 'This permanently deletes:'));
				const ul = kit.el('ul', 'settingsDeleteList');
				['Your account and profile (' + at(core.profile.username) + ')', 'Your Board and profile posts, and the comments on them',
					'Your comments, hypes and messages'].forEach(function (t) { ul.appendChild(kit.el('li', null, t)); });
				body.appendChild(ul);
				body.appendChild(kit.el('p', 'crwdModalText settingsWarning', 'This can\'t be undone.'));
				body.appendChild(textWith(kit, 'To confirm it\'s you, we\'ll email a code to ', email, '.'));
				const err = kit.errorBox();
				const btn = kit.el('button', 'crwdButton isDanger', 'Email Me a Code');
				btn.type = 'button';
				body.append(err, btn);
				btn.addEventListener('click', async function () {
					kit.setBusy(btn, true, 'Sending…');
					const problem = await sendCode();
					if (problem) { kit.setBusy(btn, false, 'Email Me a Code'); kit.showError(err, problem); return; }
					stepCode();
				});
			}

			async function sendCode() {
				const { error } = await core.sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: false } });
				return error ? core.friendlyError(error).message : null;
			}

			function stepCode() {
				body.replaceChildren();
				body.appendChild(kit.title('Enter your <em>code</em>'));
				body.appendChild(textWith(kit, 'We sent a code to ', email, '. Enter it below to delete your account for good.'));
				const form = kit.el('form', 'crwdForm');
				form.noValidate = true;
				const f = kit.field({ label: 'Code', name: 'code', autocomplete: 'one-time-code', maxLength: 10 });
				f.input.inputMode = 'numeric';
				f.input.classList.add('settingsCodeInput');
				const err = kit.errorBox();
				const btn = kit.el('button', 'crwdButton isDanger', 'Delete My Account');
				btn.type = 'submit';
				form.append(f.wrap, err, btn);
				body.appendChild(form);
				f.input.focus();
				f.input.addEventListener('input', function () { kit.showError(err, ''); });

				const again = kit.el('p', 'crwdModalSwitch');
				const againBtn = kit.el('button', 'crwdLinkButton', '');
				againBtn.type = 'button';
				again.appendChild(againBtn);
				body.appendChild(again);
				function countdown(n) {
					clearInterval(resendTimer);
					againBtn.disabled = true;
					againBtn.textContent = 'Send a new code in ' + n + 's';
					resendTimer = setInterval(function () {
						n -= 1;
						if (n > 0) { againBtn.textContent = 'Send a new code in ' + n + 's'; return; }
						clearInterval(resendTimer);
						againBtn.disabled = false;
						againBtn.textContent = 'Send a new code';
					}, 1000);
				}
				countdown(RESEND_SECONDS);
				againBtn.addEventListener('click', async function () {
					againBtn.disabled = true;
					const problem = await sendCode();
					if (problem) { kit.showError(err, problem); againBtn.disabled = false; return; }
					kit.showError(err, '');
					countdown(RESEND_SECONDS);
				});

				form.addEventListener('submit', async function (e) {
					e.preventDefault();
					const code = f.input.value.replace(/\s/g, '');
					if (!/^\d{6,10}$/.test(code)) { kit.showError(err, 'Enter the code from the email.'); f.input.focus(); return; }
					kit.setBusy(btn, true, 'Checking…');
					// A fresh sign-in with the code: the Edge Function only deletes accounts signed in within the last few minutes
					const { error: codeError } = await core.sb.auth.verifyOtp({ email: email, token: code, type: 'email' });
					if (codeError) {
						kit.setBusy(btn, false, 'Delete My Account');
						kit.showError(err, 'That code didn\'t work. Check it, or send a new one.');
						f.input.focus();
						return;
					}
					kit.setBusy(btn, true, 'Deleting…');
					const { error } = await core.sb.functions.invoke('delete-account', { method: 'POST' });
					if (error) {
						console.error('[settings] delete-account', error);
						kit.setBusy(btn, false, 'Delete My Account');
						kit.showError(err, 'We couldn\'t delete your account. Please try again, or contact us if it keeps happening.');
						return;
					}
					clearInterval(resendTimer);
					deleted = true;
					try { await core.sb.auth.signOut({ scope: 'local' }); } catch (ex) { /* the account is already gone */ }
					doneView(body, kit, 'Account <em>deleted</em>',
						'Your account and everything in it has been deleted. Thanks for being part of CRWD SRFR.',
						'Back to the Calendar', function () { window.location.href = '/'; });
				});
			}

			stepIntro();
		});
	}

	// ---------- Max (paid members) ----------

	function renderMax() {
		const panel = tabParts('max').panel;
		panel.replaceChildren();
		const me = core.profile;

		// Status (no heading): subscribed or not, with Cancel Max / Go Max
		const status = { el: el('section', 'settingsSection settingsMaxStatus') };
		panel.appendChild(status.el);
		const action = isMax ? settingsButton('Cancel Max', 'isDanger') : settingsButton('Go Max', 'isPrimary');
		action.addEventListener('click', isMax ? openCancelMaxDialog : openMaxDialog);
		if (isMax) {
			status.el.appendChild(el('p', 'settingsValue', 'You\'re a Max member.'));
			status.el.appendChild(el('p', 'settingsNote', 'Thanks for supporting CRWD SRFR!'));
		} else {
			status.el.appendChild(el('p', 'settingsValue', 'You\'re not a Max member.'));
			status.el.appendChild(el('p', 'settingsNote', 'Max is CRWD SRFR\'s paid membership. On top of supporting the site, it unlocks the settings below plus additional profile customizations.'));
		}
		status.el.appendChild(action);

		// Everything below is greyed out (but still shown) without Max
		const locked = !isMax;

		// Badge
		const badge = section(panel, 'Max Badge');
		const box = checkbox('Show the Max badge next to my username', me.show_max_badge !== false,
			'It shows everywhere your username does: your profile, the Board, posts and comments.');
		badge.el.appendChild(box.wrap);
		const preview = el('p', 'settingsBadgePreview');
		preview.setAttribute('aria-hidden', 'true');
		function drawPreview() {
			preview.replaceChildren(el('span', 'settingsPreviewLabel', 'Preview'), el('span', 'settingsPreviewName', at(me.username)));
			if (box.input.checked) preview.lastChild.appendChild(maxBadge());
		}
		drawPreview();
		badge.el.appendChild(preview);
		box.input.addEventListener('change', drawPreview);
		if (locked) { box.input.disabled = true; badge.el.classList.add('isLocked'); }

		// Weekly roundup
		const roundup = section(panel, 'Weekly Roundup');
		const rBox = checkbox('Email me a weekly roundup of my hyped acts and venues', !!me.email_weekly_roundup,
			'New shows from the acts and venues you\'ve hyped, once a week.');
		roundup.el.appendChild(rBox.wrap);
		if (locked) { rBox.input.disabled = true; roundup.el.classList.add('isLocked'); }

		// Custom site colors (placeholder)
		const colors = section(panel, 'Custom Site Colors', 'isComingSoon');
		colors.head.appendChild(el('span', 'settingsComingSoon', 'Coming soon'));
		colors.el.appendChild(el('p', 'settingsText', 'Swap the site\'s two main colors for your own as you browse. To show them to visitors on your profile, turn on "Use custom colors on my profile" in Edit Profile.'));
		const swatches = el('div', 'settingsSwatches');
		[['Main color', '#62CBB8'], ['Accent color', '#F9F976']].forEach(function (c) {
			const label = el('label', 'settingsSwatch');
			const input = el('input');
			input.type = 'color';
			input.value = c[1].toLowerCase();
			input.disabled = true;
			label.append(input, el('span', 'settingsSwatchText', c[0]), el('span', 'settingsSwatchHex', c[1]));
			swatches.appendChild(label);
		});
		colors.el.appendChild(swatches);

		// Nothing to save until they have Max
		if (locked) { delete unsaved.max; return; }
		panel.appendChild(saveBar('max', function () {
			return { show_max_badge: box.input.checked, email_weekly_roundup: rBox.input.checked };
		}));
	}

	// ---------- Notifications ----------

	function renderNotifications() {
		const panel = tabParts('notifications').panel;
		panel.replaceChildren();
		const me = core.profile;

		const mail = section(panel, 'Email Notifications');
		const to = el('p', 'settingsText', 'Emails go to ');
		to.append(el('strong', null, core.user.email || ''), '.');
		mail.el.appendChild(to);

		const list = el('div', 'settingsCheckList');
		[
			['email_message_requests', 'New message requests', 'When someone sends you a message request.'],
			['email_new_messages', 'New messages', 'When someone you\'re chatting with sends you a message.'],
			['email_ripples', 'Ripples', 'Hypes and comments on your posts, and new comments where you\'ve commented.']
		].forEach(function (s) {
			const box = checkbox(s[1], me[s[0]] !== false, s[2]);
			box.input.name = s[0];
			list.appendChild(box.wrap);
		});
		mail.el.appendChild(list);

		if (!isMax) {
			const more = el('p', 'settingsNote', 'For notifications on your hyped acts and venues, manage your Lineup Newsletter in Max settings.');
			const link = el('button', 'settingsLinkButton', 'See Max');
			link.type = 'button';
			link.addEventListener('click', function () { selectTab('max', true); });
			more.appendChild(link);
			mail.el.appendChild(more);
		}

		panel.appendChild(saveBar('notifications', function () {
			return {
				email_message_requests: list.querySelector('input[name=email_message_requests]').checked,
				email_new_messages: list.querySelector('input[name=email_new_messages]').checked,
				email_ripples: list.querySelector('input[name=email_ripples]').checked
			};
		}));
	}

	// ---------- Privacy ----------

	function renderPrivacy() {
		const panel = tabParts('privacy').panel;
		panel.replaceChildren();
		const me = core.profile;

		// Profile visibility
		const vis = el('section', 'settingsSection');
		vis.appendChild(choices('profile_visibility', 'Profile Visibility', [
			{ value: 'everyone', label: 'Everyone (Default)', note: 'Anyone can see your profile, even without an account.' },
			{ value: 'members', label: 'Registered Only', note: 'Only people signed in to CRWD SRFR.' },
			{ value: 'connections', label: 'Connections Only', note: 'Only people you\'ve accepted messages with.' },
			{ value: 'nobody', label: 'No One', note: 'Your profile is hidden from everyone but you.' }
		], me.profile_visibility || 'everyone'));
		const visNote = el('p', 'settingsNote', 'Your Board posts stay on the Board either way. To choose which parts of your profile show, use Edit Profile on ');
		const own = el('a', null, 'your profile');
		own.href = core.profileUrl(me.username);
		visNote.append(own, '.');
		vis.appendChild(visNote);
		panel.appendChild(vis);

		// Message requests
		const msg = el('section', 'settingsSection');
		msg.appendChild(choices('message_requests', 'Message Requests', [
			{ value: 'everyone', label: 'Everyone (Default)', note: 'Anyone with an account can send you a message request.' },
			{ value: 'nobody', label: 'Me Only', note: 'No one can send you requests. You can still message others.' }
		], me.message_requests || 'everyone'));
		panel.appendChild(msg);

		// Save covers the two choices above. Blocked Accounts sits below it: Unblock takes effect right away.
		panel.appendChild(saveBar('privacy', function () {
			return {
				profile_visibility: panel.querySelector('input[name=profile_visibility]:checked').value,
				message_requests: panel.querySelector('input[name=message_requests]:checked').value
			};
		}));

		renderBlocked(panel);
	}

	// Blocked accounts: a show/hide list, closed by default, with the total in its label
	async function renderBlocked(panel) {
		const s = el('section', 'settingsSection settingsBlocked');
		const toggle = el('button', 'settingsDisclosure');
		toggle.type = 'button';
		toggle.setAttribute('aria-expanded', 'false');
		toggle.setAttribute('aria-controls', 'settingsBlockedList');
		const label = el('span', 'settingsHeading', 'Blocked Accounts');
		toggle.append(label, el('span', 'settingsChevron'));
		const status = el('p', 'settingsNote settingsBlockedStatus');
		status.setAttribute('role', 'status');
		const body = el('div', 'settingsBlockedBody');
		body.id = 'settingsBlockedList';
		body.hidden = true;
		s.append(toggle, body, status);
		panel.appendChild(s);

		toggle.addEventListener('click', function () {
			const open = toggle.getAttribute('aria-expanded') !== 'true';
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
			body.hidden = !open;
		});

		const { data, error } = await core.sb.rpc('my_blocked_users');
		if (error) {
			label.textContent = 'Blocked Accounts';
			body.replaceChildren(el('p', 'settingsNote', 'Your blocked accounts couldn\'t load right now.'));
			return;
		}
		let list = data || [];

		function draw(focusIndex) {
			label.textContent = 'Blocked Accounts (' + list.length + ')';
			body.replaceChildren();
			if (!list.length) {
				body.appendChild(el('p', 'settingsNote', 'You haven\'t blocked anyone.'));
				if (focusIndex != null) toggle.focus();
				return;
			}
			body.appendChild(el('p', 'settingsNote', 'You and the people you block can\'t see each other\'s profiles, posts or comments.'));
			const ul = el('ul', 'settingsBlockedList');
			list.forEach(function (b, i) {
				const li = el('li', 'settingsBlockedItem');
				const who = el('div', 'settingsBlockedWho');
				who.append(el('span', 'settingsBlockedName', at(b.username)),
					el('span', 'settingsBlockedDate', 'Blocked ' + longDate(b.blocked_at)));
				const un = el('button', 'crwdSmallButton', 'Unblock');
				un.type = 'button';
				un.setAttribute('aria-label', 'Unblock ' + at(b.username));
				un.addEventListener('click', async function () {
					un.disabled = true;
					const { error: e } = await core.sb.from('blocks').delete().eq('blocked_id', b.user_id);
					if (e) { un.disabled = false; status.textContent = core.friendlyError(e).message; return; }
					list = list.filter(function (x) { return x.user_id !== b.user_id; });
					status.textContent = 'Unblocked ' + at(b.username) + '.';
					draw(i);
				});
				li.append(who, un);
				ul.appendChild(li);
			});
			body.appendChild(ul);
			if (focusIndex != null) {
				const buttons = ul.querySelectorAll('button');
				(buttons[Math.min(focusIndex, buttons.length - 1)] || toggle).focus();
			}
		}
		draw();
	}

	// ------------------------------------------------------------------
	// Start
	// ------------------------------------------------------------------

	if (!core || !core.enabled) {
		showState('Settings are unavailable right now. Please try again in a bit.');
		return;
	}

	core.onChange(function (state) {
		if (!state.user) {
			loadedFor = null;
			if (deleted) { showState('Your account has been deleted.', [{ label: 'Back to the Calendar', href: '/' }]); return; }
			showState('Sign in to see your settings.', [{ label: 'Sign In', onClick: function () { ui.openAuth('signin'); } }]);
			return;
		}
		if (state.user.id !== loadedFor) { build(); return; }
		// Same person, new email details (a change was requested or confirmed): redraw Account
		const emailNow = (state.user.email || '') + '|' + (state.user.new_email || '');
		if (emailNow !== emailShown && !els.content.hidden) renderAccount();
	});
})();
