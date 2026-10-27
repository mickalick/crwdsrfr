/*
 * js/crwd-core.js — CRWD SRFR accounts: Supabase client, session, profile, auth actions.
 *
 * No DOM work happens here; the header menu and modals live in crwd-ui.js.
 * Load on every page, all deferred, in this order:
 *   supabase-js (CDN) → /js/crwd-core.js → /js/nav.js → /js/crwd-ui.js → page script
 *
 * Exposes window.CrwdCore. If supabase-js fails to load (CDN down, blocked),
 * CrwdCore.enabled is false and the rest of the site keeps working without accounts.
 */
(function () {
	'use strict';

	// Staging site → staging project; everything else → production
	const STAGING_HOSTS = ['staging.crwdsrfr.com']; // ← your staging site's hostname(s)
	const IS_STAGING = STAGING_HOSTS.indexOf(window.location.hostname) !== -1;

	const SUPABASE_URL = IS_STAGING
		? 'https://kgixthcjojlkacnxtzeg.supabase.co'
		: 'https://YOUR-PRODUCTION-PROJECT.supabase.co';
	const SUPABASE_KEY = IS_STAGING
		? 'sb_publishable_9hn_OpemNeyrJINtqwwUOQ_gZbIfco-'
		: 'YOUR-PRODUCTION-PUBLISHABLE-KEY'; // publishable keys: safe in the browser, the database rules protect the data

	const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
	const PLACEHOLDER_RE = /^user_[0-9a-f]{12}$/; // assigned by the database when a chosen username couldn't be used

	// ---------- Fallback when supabase-js isn't available ----------
	if (!window.supabase || typeof window.supabase.createClient !== 'function') {
		console.warn('[crwd] supabase-js not loaded — accounts disabled on this page');
		window.CrwdCore = { enabled: false, ready: Promise.resolve(), onChange: function () {} };
		return;
	}

	// ---------- Expired / already-used magic link ----------
	// Supabase sends people back with #error=...&error_description=... in the URL.
	// Read it before the client starts, then strip it so a refresh doesn't show it again.
	let linkError = null;
	(function readLinkError() {
		const hash = window.location.hash.replace(/^#/, '');
		if (!/(^|&)error=/.test(hash)) return;
		const params = new URLSearchParams(hash);
		linkError = {
			code: params.get('error_code') || params.get('error'),
			message: params.get('error_description') || 'That sign-in link didn\'t work.'
		};
		history.replaceState(null, '', window.location.pathname + window.location.search);
	})();

	const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
		auth: {
			// 'implicit' lets a magic link work even when it's opened in a different
			// browser than the one that requested it (e.g. tapped in a phone's mail app).
			flowType: 'implicit',
			persistSession: true,
			autoRefreshToken: true,
			detectSessionInUrl: true
		}
	});

	// ---------- State ----------
	let user = null;     // Supabase auth user (holds the email; never shown publicly)
	let profile = null;  // the signed-in user's own row from public.profiles
	let isReady = false;
	const listeners = [];
	let resolveReady;
	const ready = new Promise(function (resolve) { resolveReady = resolve; });

	function snapshot() {
		return { user: user, profile: profile };
	}

	function emit() {
		listeners.forEach(function (fn) {
			try { fn(snapshot()); } catch (e) { console.error('[crwd] listener error', e); }
		});
	}

	function markReady() {
		if (isReady) return;
		isReady = true;
		resolveReady();
	}

	async function loadProfile() {
		if (!user) { profile = null; return; }
		const { data, error } = await sb.from('profiles').select('*').eq('id', user.id).single();
		if (error) {
			console.warn('[crwd] could not load profile', error);
			profile = null;
			return;
		}
		profile = data;
	}

	sb.auth.onAuthStateChange(function (event, session) {
		// supabase-js can deadlock if other Supabase calls are awaited inside this
		// callback, so the profile load runs on the next tick instead.
		setTimeout(async function () {
			const nextUser = session ? session.user : null;
			const userChanged = (nextUser && nextUser.id) !== (user && user.id);
			user = nextUser;
			if (userChanged || event === 'USER_UPDATED' || !isReady) await loadProfile();
			markReady();
			emit();
		}, 0);
	});

	// Safety net: never leave pages waiting if the first auth event is slow
	setTimeout(markReady, 5000);

	// ---------- Errors ----------
	// Turns Supabase/Postgres errors into short messages the UI can show as-is.
	// err.code is kept so the UI can react (e.g. offer "Register" on 'no_account').
	function friendlyError(error) {
		const msg = (error && error.message) || '';
		const code = (error && error.code) || '';
		let out;

		if (code === 'otp_disabled' || /signups? not allowed/i.test(msg)) {
			out = new Error('We couldn\'t find an account with that email.');
			out.code = 'no_account';
		} else if (code === 'over_email_send_rate_limit' || (error && error.status === 429) || /security purposes|rate limit/i.test(msg)) {
			out = new Error('Too many requests. Please wait a minute and try again.');
			out.code = 'rate_limited';
		} else if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) {
			out = new Error('That email address doesn\'t look right.');
			out.code = 'bad_email';
		} else if (code === '23505') {
			out = new Error('That username was just taken. Try another.');
			out.code = 'username_taken';
		} else if (code === 'P0001' && msg) {
			out = new Error(msg); // messages raised by our own database rules are already user-friendly
			out.code = 'rule';
		} else {
			console.error('[crwd]', error);
			out = new Error('Something went wrong. Please try again.');
			out.code = 'unknown';
		}
		return out;
	}

	// ---------- Auth actions ----------
	// Magic links return people to the page they started on (minus any #hash).
	// Every page URL must be covered by the Redirect URLs list in Supabase (https://crwdsrfr.com/**).
	function redirectUrl() {
		return window.location.origin + window.location.pathname + window.location.search;
	}

	// New account: emails a link. Username + display name ride along as signup data
	// and the database uses them when it creates the profile.
	// If the email already has an account, Supabase just sends a normal sign-in link
	// (and ignores the extra data), so this never reveals whether an email is registered.
	async function register(details) {
		const { error } = await sb.auth.signInWithOtp({
			email: details.email.trim(),
			options: {
				shouldCreateUser: true,
				emailRedirectTo: redirectUrl(),
				data: {
					username: details.username.trim().toLowerCase()
				}
			}
		});
		if (error) throw friendlyError(error);
	}

	// Existing account only — a typo'd email gets an error instead of a new account.
	async function signIn(email) {
		const { error } = await sb.auth.signInWithOtp({
			email: email.trim(),
			options: { shouldCreateUser: false, emailRedirectTo: redirectUrl() }
		});
		if (error) throw friendlyError(error);
	}

	async function signOut() {
		const { error } = await sb.auth.signOut();
		if (error) throw friendlyError(error);
	}

	// ---------- Usernames ----------
	// Returns { ok: true } or { ok: false, reason: 'format' | 'unavailable' | 'error' }
	async function checkUsername(name) {
		const clean = (name || '').trim().toLowerCase();
		if (!USERNAME_RE.test(clean)) return { ok: false, reason: 'format' };
		if (profile && profile.username === clean) return { ok: true }; // already theirs
		const { data, error } = await sb.rpc('username_available', { name: clean });
		if (error) {
			console.warn('[crwd] username check failed', error);
			return { ok: false, reason: 'error' };
		}
		return data ? { ok: true } : { ok: false, reason: 'unavailable' };
	}

	// True when the database had to give this account a placeholder username
	function needsUsername() {
		return !!(profile && PLACEHOLDER_RE.test(profile.username));
	}

	// ---------- Profile ----------
	// fields: any columns the user may edit, e.g. { username, display_name, status }
	async function updateProfile(fields) {
		if (!user) throw new Error('Sign in first.');
		const { data, error } = await sb.from('profiles').update(fields).eq('id', user.id).select().single();
		if (error) throw friendlyError(error);
		profile = data;
		emit();
		return data;
	}

	// ---------- Helpers ----------

	function profileUrl(username) {
		return '/u/?' + encodeURIComponent(username);
	}

	function avatarUrl(path) {
		if (!path) return null;
		return sb.storage.from('avatars').getPublicUrl(path).data.publicUrl;
	}

	// Call fn({ user, profile }) now (if auth has loaded) and on every change
	function onChange(fn) {
		listeners.push(fn);
		if (isReady) fn(snapshot());
	}

	window.CrwdCore = {
		enabled: true,
		sb: sb,
		ready: ready,
		get user() { return user; },
		get profile() { return profile; },
		get linkError() { return linkError; },
		clearLinkError: function () { linkError = null; },
		onChange: onChange,
		register: register,
		signIn: signIn,
		signOut: signOut,
		checkUsername: checkUsername,
		needsUsername: needsUsername,
		updateProfile: updateProfile,
		profileUrl: profileUrl,
		avatarUrl: avatarUrl,
		friendlyError: friendlyError, // for pages making their own Supabase calls
		USERNAME_RE: USERNAME_RE
	};
})();
