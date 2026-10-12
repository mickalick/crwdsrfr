/*
 * js/nav.js — single source of truth for the CRWD SRFR site menu.
 *
 * On every page:
 *   <head>
 *     <link rel="stylesheet" href="/css/nav.css">
 *     <script src="/js/nav.js" defer></script>
 *   </head>
 *   <header><nav>
 *     <a id="logo" aria-label="Home" href="/"></a>
 *     <div id="siteNav"></div>   <!-- replaced by the menu button + drawer -->
 *   </nav></header>
 *
 * To add, rename or reorder a page, edit NAV_PRIMARY / NAV_SECONDARY only.
 */
(function () {
	'use strict';

	// Root-absolute hrefs so links resolve the same from / and from /board/, /acts/, etc.
	const NAV_PRIMARY = [
		{ label: 'Calendar',      href: '/' },
		{ label: 'Featured',      href: '/featured/' },
		{ label: 'Venues',        href: '/venues/' },
		{ label: 'Acts',          href: '/acts/', badge: 'Beta' },
		{ label: 'The SRF Board', href: '/board/' },
	];

	const NAV_SECONDARY = [
		{ label: 'About',   href: '/about.html' },
		{ label: 'Contact', href: '/contact.html' },
	];

	const NAV_SOCIAL = [
		{ label: 'Instagram', href: 'https://www.instagram.com/crwdsrfr/', icon: 'navInsta' },
	];

	// Icon-only external links, same pattern as the footer's #social block
	function renderSocial(items) {
		const links = items.map(function (item) {
			return '<a href="' + item.href + '" target="_blank" rel="noopener" aria-label="' + item.label + '">' +
				'<span class="icon ' + item.icon + '"></span></a>';
		}).join('');
		return '<div class="navSocial">' + links + '</div>';
	}

	// GitHub Pages serves /about.html at /about too, and /board/ at /board/index.html.
	// Normalize both forms so the current-page highlight matches either way.
	function normalize(path) {
		return path.replace(/index\.html$/, '').replace(/\.html$/, '');
	}

	function isCurrent(href) {
		const here = normalize(window.location.pathname);
		const target = normalize(href);
		if (target === '/') return here === '/';                   // Calendar: exact match only
		if (target.endsWith('/')) return here.startsWith(target);  // Sections: /venues/ also matches /venues/<venue>/
		return here === target;
	}

	function renderList(items, listClass) {
		const lis = items.map(function (item) {
			const current = isCurrent(item.href);
			const badge = item.badge ? ' <span class="navBadge">' + item.badge + '</span>' : '';
			return '<li><a class="navLink' + (current ? ' currentPage' : '') + '" href="' + item.href + '"' +
				(current ? ' aria-current="page"' : '') + '>' + item.label + badge + '</a></li>';
		}).join('');
		return '<ul class="' + listClass + '">' + lis + '</ul>';
	}

	function buildMarkup() {
		return '' +
			'<button type="button" id="menuButton" aria-label="Open menu" aria-expanded="false" aria-controls="menuNav">' +
				'<span class="icon" id="mnu"></span>' +
			'</button>' +
			'<div id="menuBackdrop"></div>' +
			// `inert` keeps the off-screen links out of the tab order until the drawer opens
			'<div id="menuNav" role="dialog" aria-modal="true" aria-label="Site menu" inert>' +
				'<div class="menuNavHeader">' +
					'<button type="button" id="menuClose" aria-label="Close menu"><span class="icon" id="cls"></span></button>' +
				'</div>' +
				renderList(NAV_PRIMARY, 'navPrimary') +
				renderList(NAV_SECONDARY, 'navSecondary') +
				renderSocial(NAV_SOCIAL) +
			'</div>';
	}

	// Mount immediately (not on DOMContentLoaded): deferred scripts run before jQuery's
	// ready handlers, so the existing header-scroll code can still find #menuButton.
	const mount = document.getElementById('siteNav');
	if (!mount) return;
	mount.outerHTML = buildMarkup();

	const root = document.documentElement;
	const btn = document.getElementById('menuButton');
	const nav = document.getElementById('menuNav');
	const closeBtn = document.getElementById('menuClose');
	const backdrop = document.getElementById('menuBackdrop');

	function openMenu() {
		root.classList.add('menuOpen');          // drives the slide-in + page scroll lock in nav.css
		nav.inert = false;
		btn.setAttribute('aria-expanded', 'true');
		closeBtn.focus({ preventScroll: true });
	}

	function closeMenu(returnFocus) {
		if (!root.classList.contains('menuOpen')) return;
		root.classList.remove('menuOpen');
		nav.inert = true;
		btn.setAttribute('aria-expanded', 'false');
		if (returnFocus !== false) btn.focus({ preventScroll: true });
	}

	btn.addEventListener('click', openMenu);
	closeBtn.addEventListener('click', function () { closeMenu(); });
	backdrop.addEventListener('click', function () { closeMenu(); });

	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') closeMenu();
	});

	// Keep Tab cycling inside the open drawer
	nav.addEventListener('keydown', function (e) {
		if (e.key !== 'Tab') return;
		const focusable = nav.querySelectorAll('a[href], button');
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	});

	// Back button can restore a page from cache with the drawer still open — reset it
	window.addEventListener('pageshow', function (e) {
		if (e.persisted) closeMenu(false);
	});
})();
