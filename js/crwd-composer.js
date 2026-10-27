/* =====================================================================
   js/crwd-composer.js — the New Post form (profile page + Board)

   CrwdComposer.open({
     destination: 'board' | 'profile',   // which "Post to" choice starts selected
     onPosted: function (row) { … }      // after the post is saved (it starts as pending)
   });

   Needs: crwd-core.js, crwd-ui.js (the modal), board.js (BoardMedia: acts + venues lists).
   Styles: css/crwd-composer.css

   Photos and videos are prepared in the browser before anything uploads:
   - Photos are resized (longest side PHOTO_MAX px) and saved as WebP (JPEG on
     browsers that can't make WebP), plus a small thumbnail for tiles.
   - Videos aren't re-encoded (browsers can't do that cheaply). They're limited
     to VIDEO_MAX_SECONDS and VIDEO_MAX_MB, and a still frame becomes the thumbnail.
   The script's video settings (720p H.264, CRF 24) need ffmpeg, which browsers
   don't have, so that part isn't matched.
   Nothing uploads until "Post" is pressed, so closing the form leaves nothing behind.
   ===================================================================== */

(function () {
	'use strict';

	// --- Limits + compression settings (photo/thumb numbers match scripts/process-media.js) ---
	const MAX_MEDIA = 10;
	const PHOTO_MAX = 1600;           // longest side of an uploaded photo, px (PHOTO_MAX_DIMENSION)
	const PHOTO_QUALITY = 0.80;       // PHOTO_QUALITY 80
	const THUMB_MAX = 500;            // longest side of a tile thumbnail / video poster, px (THUMB_MAX_DIMENSION)
	const THUMB_QUALITY = 0.72;       // THUMB_QUALITY 72
	const VIDEO_MAX_SECONDS = 60;
	const VIDEO_MAX_MB = 50;          // same as the post-media storage limit
	const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
	const LIMITS = { title: 120, text: 4000, caption: 1000, acts: 10, actName: 80 };

	const core = window.CrwdCore;
	const ui = window.CrwdUI;

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	function button(className, label, ariaLabel) {
		const b = el('button', className, label);
		b.type = 'button';
		if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
		return b;
	}

	// Adds a muted "(optional)" after a field's label
	function markOptional(wrap) {
		const label = wrap.querySelector('.crwdLabel');
		label.append(' ', el('span', 'composerOptional', '(optional)'));
	}

	function formatSize(bytes) {
		return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
	}

	// ------------------------------------------------------------------
	// Media preparation
	// ------------------------------------------------------------------

	function loadImage(file) {
		return new Promise(function (resolve, reject) {
			const url = URL.createObjectURL(file);
			const img = new Image();
			img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
			img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('couldn\'t be opened. Try a JPG, PNG or WebP.')); };
			img.src = url;
		});
	}

	// Draws a picture (img or video frame) at most `max` px on its longest side
	function encode(source, srcW, srcH, max, quality) {
		const scale = Math.min(1, max / Math.max(srcW, srcH));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(srcW * scale));
		canvas.height = Math.max(1, Math.round(srcH * scale));
		canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
		function toBlob(type) { return new Promise(function (r) { canvas.toBlob(r, type, quality); }); }
		return toBlob('image/webp').then(function (blob) {
			// Older Safari can't make WebP and quietly hands back a PNG: use JPEG instead
			return blob && blob.type === 'image/webp' ? blob : toBlob('image/jpeg');
		}).then(function (blob) {
			if (!blob) throw new Error('couldn\'t be prepared. Try a different photo.');
			return blob;
		});
	}

	async function preparePhoto(file) {
		const img = await loadImage(file);
		const w = img.naturalWidth, h = img.naturalHeight;
		const blob = await encode(img, w, h, PHOTO_MAX, PHOTO_QUALITY);
		const thumb = await encode(img, w, h, THUMB_MAX, THUMB_QUALITY);
		return { type: 'photo', blob: blob, thumb: thumb };
	}

	function waitFor(target, okEvent, timeoutMs) {
		return new Promise(function (resolve, reject) {
			const timer = setTimeout(function () { done(); reject(new Error('timeout')); }, timeoutMs);
			function ok() { done(); resolve(); }
			function bad() { done(); reject(new Error('error')); }
			function done() {
				clearTimeout(timer);
				target.removeEventListener(okEvent, ok);
				target.removeEventListener('error', bad);
			}
			target.addEventListener(okEvent, ok);
			target.addEventListener('error', bad);
		});
	}

	async function prepareVideo(file) {
		if (!VIDEO_TYPES[file.type]) throw new Error('isn\'t a video type we take. Use MP4, WebM or MOV.');
		if (file.size > VIDEO_MAX_MB * 1024 * 1024) throw new Error('is ' + formatSize(file.size) + '. Videos can be up to ' + VIDEO_MAX_MB + ' MB.');

		const url = URL.createObjectURL(file);
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		video.src = url;
		try {
			try {
				await waitFor(video, 'loadeddata', 15000);
			} catch (e) {
				// Most often an iPhone HEVC .mov in a browser that can't play it — viewers couldn't either
				throw new Error('can\'t be played in this browser, so others may not be able to play it either. Try exporting it as an MP4 (H.264).');
			}
			if (video.duration > VIDEO_MAX_SECONDS + 0.5) {
				throw new Error('is ' + Math.round(video.duration) + ' seconds long. Videos can be up to ' + VIDEO_MAX_SECONDS + ' seconds.');
			}
			// A frame a moment in, so the poster isn't a black fade-in
			video.currentTime = Math.min(1, (video.duration || 0) / 2);
			await waitFor(video, 'seeked', 10000).catch(function () { /* keep whatever frame is showing */ });
			const thumb = await encode(video, video.videoWidth || 640, video.videoHeight || 360, THUMB_MAX, THUMB_QUALITY);
			return { type: 'video', blob: file, thumb: thumb, duration: video.duration };
		} finally {
			video.removeAttribute('src');
			video.load();
			URL.revokeObjectURL(url);
		}
	}

	function prepare(file) {
		if (/^video\//.test(file.type)) return prepareVideo(file);
		if (/^image\//.test(file.type) || !file.type) return preparePhoto(file);
		return Promise.reject(new Error('isn\'t a photo or video.'));
	}

	function extFor(blob) {
		if (VIDEO_TYPES[blob.type]) return VIDEO_TYPES[blob.type];
		return blob.type === 'image/webp' ? 'webp' : 'jpg';
	}

	// ------------------------------------------------------------------
	// The form
	// ------------------------------------------------------------------

	let open_ = false;

	async function open(opts) {
		opts = opts || {};
		if (!core || !core.enabled || !ui) return;
		if (!ui.requireSignIn()) return;

		// Acts + venues for the Tags section (board.js keeps these cached per page load)
		const BM = window.BoardMedia;
		const [actsList, venueLookup] = BM
			? await Promise.all([BM.fetchActsList(), BM.fetchVenueLookup()])
			: [[], {}];
		const acts = actsList.map(function (a) {
			const aliases = (Array.isArray(a.aliases) ? a.aliases : []).map(function (x) { return String(x).toLowerCase(); });
			return { id: a.slug, name: a.name || a.slug, aliases: aliases, search: [a.name || a.slug].concat(aliases).join(' ').toLowerCase() };
		}).sort(function (a, b) { return a.name.localeCompare(b.name); });
		const sortName = function (n) { return String(n).replace(/^the\s+/i, ''); };
		const venues = Object.keys(venueLookup).map(function (id) { return { id: id, name: venueLookup[id].name || id }; })
			.sort(function (a, b) { return sortName(a.name).localeCompare(sortName(b.name)); });

		open_ = true;
		const media = [];        // { id, file, status: 'working'|'ready', prepared, previewUrl, caption }
		const actTags = [];      // { id: acts.json key, name } — id is null for acts not on the Acts page
		let busy = false;
		let posted = false;
		let nextId = 1;
		let confirmBox = null;
		let guard = null;        // set once the form is built; decides whether Escape / ✕ may close it

		ui.openDialog(function (body, kit) {
			// Start on the title, not in the Title field, so phones don't pop the keyboard up on open
			const heading = kit.title('New <em>post</em>');
			heading.tabIndex = -1;
			heading.setAttribute('data-autofocus', '');
			body.appendChild(heading);
			const form = el('form', 'crwdForm composerForm');
			form.noValidate = true;

			// --- Post to: Board / Profile Only
			const dest = el('fieldset', 'composerDestination');
			dest.appendChild(el('legend', 'crwdLabel', 'Post to'));
			const destGroup = el('div', 'composerSegmented');
			const destHint = el('span', 'crwdHint');
			[['board', 'Board'], ['profile', 'Profile Only']].forEach(function (pair) {
				const label = el('label', 'composerSegment');
				const radio = document.createElement('input');
				radio.type = 'radio';
				radio.name = 'destination';
				radio.value = pair[0];
				radio.checked = (opts.destination === 'board' ? 'board' : 'profile') === pair[0];
				label.append(radio, el('span', null, pair[1]));
				destGroup.appendChild(label);
			});
			function destination() { return destGroup.querySelector('input[name=destination]:checked').value; }
			function updateDestHint() {
				destHint.textContent = destination() === 'board'
					? 'Displays on the Board and your profile once approved.'
					: 'Displays only on your profile once approved.';
			}
			destGroup.addEventListener('change', updateDestHint);
			updateDestHint();
			dest.append(destGroup, destHint);

			// --- Title
			const title = kit.field({ label: 'Title', name: 'title', maxLength: LIMITS.title,
				placeholder: 'What\'s the post about?' });
			title.input.required = true;
			addCounter(title.wrap, title.input, LIMITS.title);

			// --- Opening
			const opener = textArea(kit, { label: 'Opening', name: 'opener', max: LIMITS.text, rows: 3,
				placeholder: 'Displays above your shots.' });
			markOptional(opener.wrap);

			// --- Shots (photos + videos)
			const mediaWrap = el('div', 'crwdField composerMedia');
			const mediaLabel = el('span', 'crwdLabel', 'Shots');
			mediaLabel.id = 'composerMediaLabel';
			const mediaList = el('ol', 'composerMediaList');
			mediaList.setAttribute('aria-labelledby', 'composerMediaLabel');
			const addLabel = el('label', 'crwdSmallButton composerAddMedia');
			const addText = el('span', null, 'Add Shots');
			const fileInput = document.createElement('input');
			fileInput.type = 'file';
			fileInput.multiple = true;
			fileInput.accept = 'image/*,video/mp4,video/webm,video/quicktime';
			addLabel.append(addText, fileInput);
			const mediaHint = el('span', 'crwdHint', 'Up to ' + MAX_MEDIA + ' photos or videos. Videos can be up to '
				+ VIDEO_MAX_SECONDS + ' seconds and ' + VIDEO_MAX_MB + ' MB.');
			const mediaNote = el('p', 'composerMediaNote');
			mediaNote.setAttribute('role', 'status');
			mediaNote.hidden = true;
			// Limits hint, then the Add button + its note, all above the shots, so the list grows downward from them
			mediaWrap.append(mediaLabel, mediaHint, addLabel, mediaNote, mediaList);
			markOptional(mediaWrap);

			// --- Post cover: optional, picked on the shots themselves.
			// Real radio buttons sharing one name, so only one can be on, and arrow keys
			// move between them (and announce "2 of 4"). "No Cover" is the last one, under the shots.
			let coverId = null;      // media id (stays put when items are reordered)
			const coverBar = el('div', 'composerCoverBar');
			const coverHint = el('span', 'crwdHint', 'Choose a "Cover" shot to display it at the top of your post and on its thumbnail.');
			coverHint.id = 'composerCoverHint';
			const noCover = coverRadio('', 'No Cover', null);
			coverBar.append(noCover.label, coverHint);
			mediaWrap.appendChild(coverBar);

			function coverRadio(value, text, srText) {
				const label = el('label', 'composerCoverPick');
				const radio = document.createElement('input');
				radio.type = 'radio';
				radio.name = 'composerCover';
				radio.value = value;
				radio.dataset.action = 'cover'; // lets keepFocus() find it again after a re-render
				radio.setAttribute('aria-describedby', 'composerCoverHint');
				label.append(radio, el('span', null, text));
				// Screen readers hear "Cover, photo 2"; the visible text stays just "Cover"
				if (srText) radio.setAttribute('aria-label', text + ', ' + srText);
				return { label: label, radio: radio };
			}

			function onCoverChange(e) {
				if (e.target.name !== 'composerCover') return;
				coverId = e.target.value ? Number(e.target.value) : null;
				keepFocus(function () { renderMedia(); });
			}
			mediaWrap.addEventListener('change', onCoverChange);

			function renderCoverOptions() {
				// A single shot is already the picture, so the choice only shows for 2 or more
				const allowed = media.length >= 2;
				coverBar.hidden = !allowed;
				if (!allowed || !media.some(function (m) { return m.id === coverId && m.status === 'ready'; })) coverId = null;
				noCover.radio.checked = coverId == null;
				noCover.radio.disabled = busy;
			}

			// --- Closing
			const closer = textArea(kit, { label: 'Closing', name: 'closer', max: LIMITS.text, rows: 3,
				placeholder: 'Displays below your shots.' });
			markOptional(closer.wrap);

			// --- Tags: acts, venue, show date
			const tagsHead = el('h3', 'crwdSection', 'Tags');
			tagsHead.appendChild(el('span', 'composerOptional', '(optional)')); // every field in Tags is optional
			const tagsHint = el('p', 'crwdHint composerTagsHint', 'Tag any details for what this post is about.');
			const actsField = actPicker();
			const venueWrap = el('label', 'crwdField');
			venueWrap.appendChild(el('span', 'crwdLabel', 'Venue'));
			const venueSelect = document.createElement('select');
			venueSelect.name = 'venue_id';
			venueSelect.className = 'composerSelect';
			venueSelect.appendChild(new Option('No venue', ''));
			venues.forEach(function (v) { venueSelect.appendChild(new Option(v.name, v.id)); });
			venueWrap.appendChild(venueSelect);
			const date = kit.field({ label: 'Show date', name: 'show_date', type: 'date' });
			date.input.classList.add('composerDate');
			const tagRow = el('div', 'crwdFieldRow composerTagRow');
			tagRow.append(venueWrap, date.wrap);

			const note = el('p', 'crwdHint composerReviewNote', 'All posts are reviewed before going live.');
			const err = kit.errorBox();
			const submit = kit.submitButton('Post');
			form.append(note, dest, title.wrap, opener.wrap, mediaWrap, closer.wrap, tagsHead, tagsHint, actsField.wrap, tagRow, err, submit);
			body.appendChild(form);

			// ---------- media list ----------

			function setMediaNote(text) {
				mediaNote.textContent = text || '';
				mediaNote.hidden = !text;
			}

			function renderMedia(focusId, focusAction) {
				renderCoverOptions();
				mediaList.replaceChildren();
				media.forEach(function (m, i) {
					const li = el('li', 'composerMediaItem' + (m.status === 'working' ? ' isWorking' : '') + (m.id === coverId ? ' isCover' : ''));
					li.dataset.id = m.id;

					const preview = el('div', 'composerMediaPreview');
					if (m.previewUrl) {
						const img = el('img');
						img.src = m.previewUrl;
						img.alt = '';
						preview.appendChild(img);
					}
					if (m.status === 'working') preview.appendChild(el('span', 'composerMediaWorking', 'Preparing…'));
					if (m.prepared && m.prepared.type === 'video') preview.appendChild(el('span', 'composerMediaPlay'));
					if (m.id === coverId) {
						const badge = el('span', 'composerMediaCover', 'Cover');
						badge.setAttribute('aria-hidden', 'true'); // the checked radio already says so
						preview.appendChild(badge);
					}

					const main = el('div', 'composerMediaMain');
					const meta = el('div', 'composerMediaMeta');
					const kind = 'Shot';
					meta.appendChild(el('span', 'composerMediaKind', kind + ' ' + (i + 1)));
					if (m.prepared) meta.appendChild(el('span', 'composerMediaSize', (m.prepared.type === 'video' ? 'Video · ' : 'Photo · ') + formatSize(m.prepared.blob.size)));
					main.appendChild(meta);

					const caption = document.createElement('textarea');
					caption.className = 'composerCaption';
					caption.rows = 2;
					caption.maxLength = LIMITS.caption;
					caption.placeholder = 'Caption (optional)';
					caption.setAttribute('aria-label', 'Caption for ' + kind.toLowerCase() + ' ' + (i + 1));
					caption.value = m.caption;
					caption.addEventListener('input', function () { m.caption = caption.value; });
					main.appendChild(caption);

					// Cover choice, under the caption
					if (media.length >= 2 && m.status === 'ready') {
						const pick = coverRadio(String(m.id), 'Cover', kind.toLowerCase() + ' ' + (i + 1));
						pick.radio.checked = m.id === coverId;
						pick.radio.disabled = busy;
						main.appendChild(pick.label);
					}

					const tools = el('div', 'composerMediaTools');
					const up = button('composerMediaTool', null, 'Move ' + kind.toLowerCase() + ' ' + (i + 1) + ' up');
					up.appendChild(el('span', 'composerArrow isUp'));
					up.disabled = i === 0;
					up.dataset.action = 'up';
					const down = button('composerMediaTool', null, 'Move ' + kind.toLowerCase() + ' ' + (i + 1) + ' down');
					down.appendChild(el('span', 'composerArrow isDown'));
					down.disabled = i === media.length - 1;
					down.dataset.action = 'down';
					const remove = button('composerMediaTool isDanger', null, 'Remove ' + kind.toLowerCase() + ' ' + (i + 1));
					remove.appendChild(el('span', 'composerRemove'));
					remove.dataset.action = 'remove';
					tools.append(up, down, remove);

					li.append(preview, main, tools);
					mediaList.appendChild(li);
				});
				mediaList.hidden = media.length === 0;
				const full = media.length >= MAX_MEDIA;
				addLabel.classList.toggle('isDisabled', full || busy);
				fileInput.disabled = full || busy;
				addText.textContent = media.length ? 'Add More' : 'Add Shots';

				// Keep the keyboard where it was after a move/remove
				if (focusId != null) {
					const li = mediaList.querySelector('[data-id="' + focusId + '"]');
					let target = li && li.querySelector('[data-action="' + focusAction + '"]:not(:disabled)');
					if (!target && li) target = li.querySelector('[data-action]:not(:disabled)');
					if (!target) target = mediaList.querySelector('[data-action]:not(:disabled)') || fileInput;
					target.focus();
				}
			}

			mediaList.addEventListener('click', function (e) {
				const b = e.target.closest('[data-action]');
				if (!b || busy) return;
				const id = Number(b.closest('.composerMediaItem').dataset.id);
				const i = media.findIndex(function (m) { return m.id === id; });
				if (i === -1) return;
				const action = b.dataset.action;
				if (action === 'up' && i > 0) { media.splice(i - 1, 0, media.splice(i, 1)[0]); renderMedia(id, 'up'); }
				else if (action === 'down' && i < media.length - 1) { media.splice(i + 1, 0, media.splice(i, 1)[0]); renderMedia(id, 'down'); }
				else if (action === 'remove') {
					const gone = media.splice(i, 1)[0];
					gone.removed = true;
					if (gone.previewUrl) URL.revokeObjectURL(gone.previewUrl);
					const neighbor = media[i] || media[i - 1];
					renderMedia(neighbor ? neighbor.id : null, 'remove');
					setMediaNote('');
				}
			});

			// One at a time, so a phone isn't decoding ten big photos at once
			let queue = Promise.resolve();
			fileInput.addEventListener('change', function () {
				const files = Array.from(fileInput.files || []);
				fileInput.value = '';
				if (!files.length) return;
				const room = MAX_MEDIA - media.length;
				const taking = files.slice(0, room);
				const problems = [];
				if (files.length > room) problems.push('Only ' + MAX_MEDIA + ' shots per post — ' + (files.length - room) + ' left out.');

				taking.forEach(function (file) {
					const m = { id: nextId++, file: file, status: 'working', prepared: null, previewUrl: null, caption: '' };
					media.push(m);
					m.ready = queue = queue.then(function () {
						if (m.removed) return;
						return prepare(file).then(function (prepared) {
							m.prepared = prepared;
							m.status = 'ready';
							m.previewUrl = URL.createObjectURL(prepared.thumb);
						}, function (ex) {
							const i = media.indexOf(m);
							if (i !== -1) media.splice(i, 1);
							problems.push('"' + file.name + '" ' + ex.message);
						}).then(function () {
							if (!open_) return;
							keepFocus(function () { renderMedia(); });
							setMediaNote(problems.join(' '));
						});
					});
				});
				renderMedia();
				setMediaNote(problems.join(' '));
			});

			// Re-rendering the list replaces its buttons; put focus back on the same spot if it was in there
			function keepFocus(fn) {
				const active = document.activeElement;
				const li = active && active.closest && active.closest('.composerMediaItem');
				const spot = li ? { id: li.dataset.id, action: active.dataset.action, caption: active.classList.contains('composerCaption'), pos: active.selectionStart } : null;
				fn();
				if (!spot) return;
				const again = mediaList.querySelector('[data-id="' + spot.id + '"]');
				if (!again) return;
				const target = spot.caption ? again.querySelector('.composerCaption') : again.querySelector('[data-action="' + spot.action + '"]');
				if (target) {
					target.focus();
					if (spot.caption && spot.pos != null) target.setSelectionRange(spot.pos, spot.pos);
				}
			}

			renderMedia();

			// ---------- act picker ----------

			function actPicker() {
				const wrap = el('div', 'crwdField composerActs');
				const label = el('label', 'crwdLabel', 'Acts');
				label.htmlFor = 'composerActInput';
				const chips = el('ul', 'composerActChips');
				chips.setAttribute('aria-label', 'Tagged acts');
				const box = el('div', 'composerCombo');
				const input = document.createElement('input');
				input.type = 'text';
				input.id = 'composerActInput';
				input.autocomplete = 'off';
				input.placeholder = 'Search or type an act';
				input.setAttribute('role', 'combobox');
				input.setAttribute('aria-autocomplete', 'list');
				input.setAttribute('aria-expanded', 'false');
				input.setAttribute('aria-controls', 'composerActOptions');
				const list = el('ul', 'composerComboList');
				list.id = 'composerActOptions';
				list.setAttribute('role', 'listbox');
				list.hidden = true;
				box.append(input, list);
				const hint = el('span', 'crwdHint', 'Up to ' + LIMITS.acts + '. Choose from the Acts list, or add an Act name.');
				wrap.append(label, chips, box, hint);

				let matches = [];        // [{ act }] from the Acts page, or [{ name }] to add as typed
				let active = -1;

				function tagKey(t) { return t.id || 'name:' + t.name.toLowerCase(); }

				function renderChips() {
					chips.replaceChildren();
					actTags.forEach(function (t) {
						const li = el('li', 'composerActChip');
						li.appendChild(el('span', null, t.name));
						const x = button('composerChipRemove', null, 'Remove ' + t.name);
						x.appendChild(el('span', 'composerRemove'));
						x.addEventListener('click', function () {
							actTags.splice(actTags.indexOf(t), 1);
							renderChips();
							input.focus();
						});
						li.appendChild(x);
						chips.appendChild(li);
					});
					chips.hidden = actTags.length === 0;
					const full = actTags.length >= LIMITS.acts;
					input.disabled = full;
					input.placeholder = full ? 'That\'s the most acts per post' : 'Search or type an act';
				}

				function close() {
					list.hidden = true;
					input.setAttribute('aria-expanded', 'false');
					input.removeAttribute('aria-activedescendant');
					active = -1;
				}

				function highlight(i) {
					active = i;
					list.querySelectorAll('[role=option]').forEach(function (o, j) {
						o.classList.toggle('isActive', j === i);
						o.setAttribute('aria-selected', j === i ? 'true' : 'false');
					});
					if (i >= 0) {
						const o = list.querySelectorAll('[role=option]')[i];
						input.setAttribute('aria-activedescendant', o.id);
						o.scrollIntoView({ block: 'nearest' });
					} else {
						input.removeAttribute('aria-activedescendant');
					}
				}

				// The act on the Acts page this exact name (or alias) belongs to, if any
				function knownAct(name) {
					const q = name.trim().toLowerCase();
					return acts.find(function (a) { return a.name.toLowerCase() === q || a.aliases.indexOf(q) !== -1; }) || null;
				}

				function search() {
					const typed = input.value.trim().replace(/\s+/g, ' ');
					const q = typed.toLowerCase();
					if (!q) { close(); return; }
					const taken = actTags.map(tagKey);
					const starts = [], contains = [];
					acts.forEach(function (a) {
						if (taken.indexOf(a.id) !== -1) return;
						if (a.name.toLowerCase().indexOf(q) === 0) starts.push(a);
						else if (a.search.indexOf(q) !== -1) contains.push(a);
					});
					matches = starts.concat(contains).slice(0, 8).map(function (a) { return { act: a }; });
					// Not on the Acts page (or not spelled the same): offer to add it as typed
					if (!knownAct(typed) && taken.indexOf('name:' + q) === -1) matches.push({ name: typed.slice(0, LIMITS.actName) });

					list.replaceChildren();
					matches.forEach(function (m, i) {
						const o = el('li', 'composerComboOption' + (m.act ? '' : ' isNew'));
						if (m.act) o.textContent = m.act.name;
						else o.append('Add ', el('strong', null, '"' + m.name + '"'));
						o.id = 'composerActOption' + i;
						o.setAttribute('role', 'option');
						o.setAttribute('aria-selected', 'false');
						// mousedown, not click: keeps focus in the input
						o.addEventListener('mousedown', function (e) { e.preventDefault(); pick(m); });
						list.appendChild(o);
					});
					if (!matches.length) list.appendChild(el('li', 'composerComboEmpty', 'Already tagged'));
					list.hidden = false;
					input.setAttribute('aria-expanded', 'true');
					highlight(matches.length ? 0 : -1);
				}

				function pick(m) {
					if (actTags.length < LIMITS.acts) {
						const tag = m.act ? { id: m.act.id, name: m.act.name } : { id: null, name: m.name };
						if (actTags.map(tagKey).indexOf(tagKey(tag)) === -1) actTags.push(tag);
					}
					input.value = '';
					close();
					renderChips();
					if (!input.disabled) input.focus();
				}

				// Text left in the box when Post is pressed still counts as a tag
				function commit() {
					const typed = input.value.trim().replace(/\s+/g, ' ');
					if (!typed) return;
					const act = knownAct(typed);
					pick(act ? { act: act } : { name: typed.slice(0, LIMITS.actName) });
				}

				input.addEventListener('input', search);
				input.addEventListener('blur', function () { setTimeout(close, 100); });
				input.addEventListener('keydown', function (e) {
					if (e.key === 'Enter') {
						e.preventDefault(); // never submits the form from here
						if (!list.hidden && matches[active]) pick(matches[active]);
						else commit();
						return;
					}
					if (list.hidden) {
						if (e.key === 'ArrowDown' && input.value.trim()) { search(); e.preventDefault(); }
						return;
					}
					if (e.key === 'ArrowDown') { e.preventDefault(); if (matches.length) highlight((active + 1) % matches.length); }
					else if (e.key === 'ArrowUp') { e.preventDefault(); if (matches.length) highlight((active - 1 + matches.length) % matches.length); }
					else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } // close the list, not the whole form
				});

				renderChips();
				return { wrap: wrap, commit: commit };
			}

			// ---------- leaving with unsaved work ----------

			function hasWork() {
				return !!(title.input.value.trim() || opener.input.value.trim() || closer.input.value.trim()
					|| media.length || actTags.length || venueSelect.value || date.input.value);
			}

			// "Discard post?" sits on its own overlay above the whole post form, centered on
			// the screen. While it's up, the form underneath can't be clicked, tabbed into or
			// read by screen readers (inert), so the only choices are the dialog's own.
			let confirmReturnFocus = null;

			function hideConfirm(restoreFocus) {
				if (!confirmBox) return;
				confirmBox.remove();
				confirmBox = null;
				const panel = body.closest('.crwdModalPanel');
				if (panel) panel.inert = false;
				if (restoreFocus) {
					const back = confirmReturnFocus && document.contains(confirmReturnFocus) ? confirmReturnFocus : title.input;
					back.focus({ preventScroll: true });
				}
				confirmReturnFocus = null;
			}

			function showConfirm() {
				if (confirmBox) { hideConfirm(true); return; }
				const modalRoot = body.closest('.crwdModal') || document.body;
				const panel = body.closest('.crwdModalPanel');
				confirmReturnFocus = document.activeElement;

				confirmBox = el('div', 'composerConfirmLayer'); // the overlay (clicks on it do nothing)
				const dialog = el('div', 'composerConfirm');
				dialog.setAttribute('role', 'alertdialog');
				dialog.setAttribute('aria-modal', 'true');
				dialog.setAttribute('aria-labelledby', 'composerConfirmTitle');
				dialog.setAttribute('aria-describedby', 'composerConfirmText');

				const close = button('composerConfirmClose', null, 'Close and keep editing');
				close.appendChild(el('span', 'crwdIconClose'));
				const heading = el('h3', 'composerConfirmTitle', 'Discard post?');
				heading.id = 'composerConfirmTitle';
				const text = el('p', null, 'What you\'ve written and added will be lost.');
				text.id = 'composerConfirmText';
				const keep = button('crwdSmallButton', 'Keep editing');
				const discard = button('crwdSmallButton isDanger', 'Discard');
				close.addEventListener('click', function () { hideConfirm(true); });   // back to the form, nothing changed
				keep.addEventListener('click', function () { hideConfirm(true); });
				discard.addEventListener('click', function () { hideConfirm(false); cleanup(); kit.close(); });
				const row = el('div', 'composerConfirmActions');
				row.append(keep, discard);
				dialog.append(close, heading, text, row);
				confirmBox.appendChild(dialog);

				// Keys stay in here: Escape = close (keep editing), Tab cycles the three buttons.
				// stopPropagation keeps the account modal's own Escape/Tab handling out of it.
				confirmBox.addEventListener('keydown', function (e) {
					if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideConfirm(true); return; }
					if (e.key !== 'Tab') return;
					e.stopPropagation();
					const stops = [close, keep, discard];
					const at = stops.indexOf(document.activeElement);
					const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at === stops.length - 1 ? 0 : at + 1);
					e.preventDefault();
					stops[next].focus();
				});

				if (panel) panel.inert = true;
				modalRoot.appendChild(confirmBox);
				keep.focus();
			}

			guard = function () {
				if (busy) return false;               // mid-upload: stay put
				if (posted || !hasWork()) { cleanup(); return true; }
				showConfirm();
				return false;
			};

			// Once they start fixing things, an old "add a title" message shouldn't hang around
			form.addEventListener('input', function () { if (!busy) kit.showError(err, ''); });
			fileInput.addEventListener('change', function () { kit.showError(err, ''); });

			// ---------- posting ----------

			form.addEventListener('submit', async function (e) {
				e.preventDefault();
				if (busy) return;
				kit.showError(err, '');

				actsField.commit();
				const t = title.input.value.trim();
				const o = opener.input.value.trim();
				const c = closer.input.value.trim();
				if (!t) { kit.showError(err, 'Give your post a title.'); title.input.focus(); return; }
				if (!media.length && !o) { kit.showError(err, 'Add an opening or at least one shot.'); opener.input.focus(); return; }

				busy = true;
				kit.setBusy(submit, true, 'Preparing…');
				form.classList.add('isBusy');
				renderMedia();

				// Wait for anything still being prepared
				await Promise.all(media.map(function (m) { return m.ready; }));
				if (!media.length && !o) {
					busy = false; form.classList.remove('isBusy'); renderMedia();
					kit.setBusy(submit, false, 'Post');
					kit.showError(err, 'None of those files could be used. Add an opening or a different shot.');
					return;
				}

				const uid = core.user.id;
				const folder = uid + '/' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
				const uploaded = [];
				const bucket = core.sb.storage.from('post-media');
				async function put(path, blob) {
					const { error } = await bucket.upload(path, blob, { contentType: blob.type, upsert: false });
					if (error) throw new Error('A file couldn\'t upload. Check your connection and try again.');
					uploaded.push(path);
					return path;
				}

				try {
					const items = [];
					let cover = null;
					for (let i = 0; i < media.length; i++) {
						kit.setBusy(submit, true, 'Uploading ' + (i + 1) + ' of ' + media.length + '…');
						const m = media[i];
						const n = String(i + 1).padStart(2, '0');
						const entry = { src: await put(folder + '/' + n + '.' + extFor(m.prepared.blob), m.prepared.blob), type: m.prepared.type };
						entry.thumb = await put(folder + '/' + n + '-thumb.' + extFor(m.prepared.thumb), m.prepared.thumb);
						if (m.caption.trim()) entry.caption = m.caption.trim();
						items.push(entry);
						if (m.id === coverId) cover = { src: entry.src, type: entry.type, thumb: entry.thumb };
					}

					kit.setBusy(submit, true, 'Posting…');
					const row = {
						destination: destination(),
						post_type: items.length === 0 ? 'discussion' : items.length === 1 ? 'shot' : 'gallery',
						title: t,
						opener: o || null,
						media: items,
						hero: items.length >= 2 ? cover : null, // same files as that item; nothing extra uploads
						closer: c || null,
						venue_id: venueSelect.value || null,
						show_date: date.input.value || null, // already YYYY-MM-DD; never goes through Date
						act_ids: actTags.filter(function (t) { return t.id; }).map(function (t) { return t.id; }),
						act_names: actTags.filter(function (t) { return !t.id; }).map(function (t) { return t.name; })
					};
					const { data, error } = await core.sb.from('posts').insert(row).select().single();
					if (error) throw new Error(error.message && /too_many_media/.test(error.message)
						? 'Posts can have up to ' + MAX_MEDIA + ' shots.'
						: 'Your post couldn\'t be saved. Please try again.');

					posted = true;
					busy = false;
					cleanup();
					showDone(body, kit, row.destination);
					if (typeof opts.onPosted === 'function') opts.onPosted(data);
				} catch (ex) {
					// Don't leave half a post's files behind
					if (uploaded.length) bucket.remove(uploaded);
					busy = false;
					form.classList.remove('isBusy');
					renderMedia();
					kit.setBusy(submit, false, 'Post');
					kit.showError(err, ex.message);
				}
			});
		}, { size: 'wide', beforeClose: function () { return guard ? guard() : true; } });

		function cleanup() {
			open_ = false;
			media.forEach(function (m) { m.removed = true; if (m.previewUrl) URL.revokeObjectURL(m.previewUrl); });
		}
	}

	function showDone(body, kit, destination) {
		body.replaceChildren();
		body.appendChild(kit.title('Thanks for <em>posting</em>'));
		const p = el('p', 'crwdNotice', destination === 'board'
			? 'Your post is waiting for review. Once approved it\'ll show on the Board and your profile.'
			: 'Your post is waiting for review. Once approved it\'ll show on your profile.');
		const actions = el('div', 'composerDoneActions');
		const done = button('crwdButton', 'Done');
		done.addEventListener('click', function () { kit.close(); });
		actions.appendChild(done);
		if (!/^\/u\//.test(window.location.pathname) && core.profile && core.profile.username) {
			const link = el('a', 'crwdLinkButton', 'See it on your profile');
			link.href = '/u/?' + encodeURIComponent(core.profile.username);
			actions.appendChild(link);
		}
		body.append(p, actions);
		done.focus();
	}

	// ------------------------------------------------------------------
	// Small form helpers (same look as Edit Profile)
	// ------------------------------------------------------------------

	function addCounter(wrap, input, max) {
		const counter = el('span', 'crwdCounter');
		function update() {
			counter.textContent = input.value.length + ' / ' + max;
		}
		input.addEventListener('input', update);
		update();
		wrap.insertBefore(counter, wrap.querySelector('.crwdHint'));
	}

	function textArea(kit, opts) {
		const wrap = el('label', 'crwdField');
		wrap.appendChild(el('span', 'crwdLabel', opts.label));
		const ta = document.createElement('textarea');
		ta.name = opts.name;
		ta.maxLength = opts.max;
		ta.rows = opts.rows || 4;
		if (opts.placeholder) ta.placeholder = opts.placeholder;
		wrap.appendChild(ta);
		if (opts.hint) wrap.appendChild(el('span', 'crwdHint', opts.hint));
		addCounter(wrap, ta, opts.max);
		return { wrap: wrap, input: ta };
	}

	window.CrwdComposer = { open: open, MAX_MEDIA: MAX_MEDIA };
})();
