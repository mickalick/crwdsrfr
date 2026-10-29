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
   - Videos upload as they are when they fit VIDEO_MAX_SECONDS and VIDEO_MAX_MB,
     and a still frame becomes the thumbnail.
   - A video over VIDEO_MAX_MB gets a "Shrink it" button: it's re-saved on the
     device as a 1080p MP4 (Mediabunny + WebCodecs, loaded only when needed).
     Browsers without WebCodecs get the old "too big" message instead.
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
	// Shrinking videos that are over VIDEO_MAX_MB (see shrinkVideo)
	const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.63.0/+esm'; // pin to an exact version before launch
	const SHRINK_SHORT_SIDE = 1080;   // 1080p: the shorter side, so portrait phone clips work too
	const SHRINK_MAX_BITRATE = 5e6;   // 5 Mbps: 60 s ≈ 38 MB
	const SHRINK_MIN_BITRATE = 1.5e6;
	const SHRINK_AUDIO_ROOM = 192e3;  // bits/s kept free for the sound track
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

	const UNPLAYABLE = 'can\'t be played in this browser, so others may not be able to play it either. Try exporting it as an MP4 (H.264).';

	async function prepareVideo(file) {
		if (!VIDEO_TYPES[file.type]) throw new Error('isn\'t a video type we take. Use MP4, WebM or MOV.');
		if (file.size > VIDEO_MAX_MB * 1024 * 1024) throw new Error('is ' + formatSize(file.size) + '. Videos can be up to ' + VIDEO_MAX_MB + ' MB.');

		const url = URL.createObjectURL(file);
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.setAttribute('playsinline', ''); // older iPhone Safari reads the attribute, not the property
		video.preload = 'auto';
		// On the page (invisible), since iPhone Safari won't load frames for a video that isn't
		video.className = 'composerProbeVideo';
		document.body.appendChild(video);
		video.src = url;
		try {
			// Step 1: the video's details (size + length). iPhone Safari stops here for a video
			// that isn't playing, so this (not a frame) is the "can it be played at all?" check.
			try {
				await waitFor(video, 'loadedmetadata', 15000);
			} catch (e) {
				throw new Error(UNPLAYABLE);
			}
			// No picture size = the browser can't decode the picture (e.g. HEVC in a browser without it)
			if (!video.videoWidth || !video.videoHeight) throw new Error(UNPLAYABLE);
			if (video.duration > VIDEO_MAX_SECONDS + 0.5) {
				throw new Error('is ' + Math.round(video.duration) + ' seconds long. Videos can be up to ' + VIDEO_MAX_SECONDS + ' seconds.');
			}

			// Step 2: a still a moment in, for the poster (so it isn't a black fade-in)
			const hasFrame = await stillFrame(video);
			const thumb = hasFrame
				? await encode(video, video.videoWidth, video.videoHeight, THUMB_MAX, THUMB_QUALITY)
				: await blankPoster(video.videoWidth, video.videoHeight); // e.g. iPhone in Low Power Mode
			return { type: 'video', blob: file, thumb: thumb, duration: video.duration };
		} finally {
			video.removeAttribute('src');
			video.load();
			video.remove();
			URL.revokeObjectURL(url);
		}
	}

	// Seeks to ~1s and waits for that frame. iPhone Safari often won't load frames until the video
	// plays, so if seeking alone doesn't do it, it plays (muted, invisibly) for a moment and pauses.
	// Resolves true once a frame is ready to draw.
	async function stillFrame(video) {
		const HAVE_CURRENT_DATA = 2;
		video.currentTime = Math.min(1, (video.duration || 0) / 2);
		await waitFor(video, 'seeked', 4000).catch(function () {});
		if (video.readyState >= HAVE_CURRENT_DATA) return true;
		try {
			const playing = waitFor(video, 'timeupdate', 6000);
			await video.play();
			await playing;
		} catch (e) {
			// play() refused (Low Power Mode) or nothing came in time
		}
		video.pause();
		return video.readyState >= HAVE_CURRENT_DATA;
	}

	// Plain dark poster in the video's shape, used when no frame could be grabbed
	function blankPoster(w, h) {
		const scale = Math.min(1, THUMB_MAX / Math.max(w, h));
		const canvas = document.createElement('canvas');
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#1A1A1A';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		return encode(canvas, canvas.width, canvas.height, THUMB_MAX, THUMB_QUALITY);
	}

	// ------------------------------------------------------------------
	// Shrinking big videos (only loads when someone presses "Shrink it")
	// ------------------------------------------------------------------

	function isTooBig(file) {
		return /^video\//.test(file.type) && file.size > VIDEO_MAX_MB * 1024 * 1024;
	}

	// WebCodecs does the actual work; without it there's nothing to shrink with
	function canShrink() {
		return typeof window.VideoEncoder === 'function' && typeof window.VideoDecoder === 'function';
	}

	let mediabunny = null;
	function loadMediabunny() {
		if (!mediabunny) {
			mediabunny = import(MEDIABUNNY_URL).catch(function (e) {
				mediabunny = null; // let a later try load it again
				throw e;
			});
		}
		return mediabunny;
	}

	// Video length from the file's details alone (no frames needed). NaN if the browser can't tell.
	async function probeDuration(file) {
		const url = URL.createObjectURL(file);
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.setAttribute('playsinline', '');
		video.preload = 'metadata';
		video.className = 'composerProbeVideo';
		document.body.appendChild(video);
		video.src = url;
		try {
			await waitFor(video, 'loadedmetadata', 8000);
			return video.duration;
		} catch (e) {
			return NaN;
		} finally {
			video.removeAttribute('src');
			video.load();
			video.remove();
			URL.revokeObjectURL(url);
		}
	}

	function shrinkError(text) {
		const e = new Error(text);
		e.shrink = true;
		return e;
	}

	// Re-saves a video as a 1080p H.264 MP4 that fits VIDEO_MAX_MB.
	// job: { onProgress(0..1), cancel (set here), canceled (set by the caller) }
	// Resolves with a new File, or rejects (err.canceled when job.cancel() was used).
	async function shrinkVideo(file, job) {
		let mb;
		try {
			mb = await loadMediabunny();
		} catch (e) {
			throw shrinkError('couldn\'t be shrunk: the video tools didn\'t load. Check your connection and try again.');
		}
		if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });

		let wakeLock = null; // keeps a phone screen on (it would pause the work)
		try { wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (e) {}

		const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) throw new Error(UNPLAYABLE);
			const seconds = await input.computeDuration();
			if (seconds > VIDEO_MAX_SECONDS + 0.5) {
				throw new Error('is ' + Math.round(seconds) + ' seconds long. Videos can be up to ' + VIDEO_MAX_SECONDS + ' seconds.');
			}

			// Size: shorter side at most SHRINK_SHORT_SIDE, even numbers (H.264 needs them)
			const w = track.displayWidth, h = track.displayHeight; // already turned upright
			const scale = Math.min(1, SHRINK_SHORT_SIDE / Math.min(w, h));
			function even(n) { return Math.max(2, Math.round(n / 2) * 2); }
			const width = even(w * scale), height = even(h * scale);

			// Bitrate: whatever fits the limit for this length (85% of it, for headroom), capped
			const fits = VIDEO_MAX_MB * 1024 * 1024 * 8 * 0.85 / Math.max(1, seconds) - SHRINK_AUDIO_ROOM;
			const bitrate = Math.max(SHRINK_MIN_BITRATE, Math.min(SHRINK_MAX_BITRATE, fits));

			// H.264 plays everywhere; if this browser can't make it, let Mediabunny pick what it can
			const avc = await mb.canEncodeVideo('avc', { width: width, height: height, bitrate: bitrate }).catch(function () { return false; });

			const output = new mb.Output({
				format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), // plays before it's fully downloaded
				target: new mb.BufferTarget()
			});
			const conversion = await mb.Conversion.init({
				input: input,
				output: output,
				video: { width: width, height: height, fit: 'contain', bitrate: bitrate, codec: avc ? 'avc' : undefined, forceTranscode: true }
				// no audio options: the sound is copied as-is when it can be, re-encoded only if it must
			});
			if (!conversion.isValid) throw shrinkError('couldn\'t be shrunk in this browser. Try a shorter clip, or record at 1080p.');

			// Never post it silently: if the sound track couldn't come along, stop
			const hadAudio = (await input.getAudioTracks()).length > 0;
			const keptAudio = (conversion.utilizedTracks || []).some(function (t) { return t.type === 'audio'; });
			if (hadAudio && !keptAudio) throw shrinkError('couldn\'t be shrunk with its sound in this browser. Try a shorter clip, or record at 1080p.');

			if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });
			job.cancel = function () { job.canceled = true; conversion.cancel(); };
			conversion.onProgress = function (p) { if (job.onProgress) job.onProgress(p); };
			try {
				await conversion.execute();
			} catch (e) {
				if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });
				throw e;
			}

			const out = new File([output.target.buffer], file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
			if (out.size > VIDEO_MAX_MB * 1024 * 1024) {
				throw shrinkError('is still ' + formatSize(out.size) + ' after shrinking. Try a shorter clip.');
			}
			return out;
		} catch (e) {
			if (e.canceled || e.shrink || e.message === UNPLAYABLE || /^is \d+ seconds/.test(e.message)) throw e;
			console.warn('[composer] shrink failed', e);
			throw shrinkError('couldn\'t be shrunk in this browser. Try a shorter clip, or record at 1080p.');
		} finally {
			job.cancel = null;
			if (input.dispose) input.dispose();
			if (wakeLock) wakeLock.release().catch(function () {});
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
				+ VIDEO_MAX_SECONDS + ' seconds and ' + VIDEO_MAX_MB + ' MB' + (canShrink() ? ' (bigger ones can be shrunk here).' : '.'));
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
					if (m.status === 'shrinking') preview.appendChild(el('span', 'composerMediaWorking', 'Shrinking…'));
					if (m.status === 'big') preview.appendChild(el('span', 'composerMediaWorking isStill', 'Too big'));
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
					if (m.prepared) {
						meta.appendChild(el('span', 'composerMediaSize', (m.prepared.type === 'video' ? 'Video · ' : 'Photo · ') + formatSize(m.prepared.blob.size)
							+ (m.shrunkFrom ? ' (shrunk from ' + formatSize(m.shrunkFrom) + ')' : '')));
					} else if (m.status === 'big' || m.status === 'shrinking') {
						meta.appendChild(el('span', 'composerMediaSize', 'Video · ' + formatSize(m.file.size)));
					}
					main.appendChild(meta);
					if (m.status === 'big' || m.status === 'shrinking') main.appendChild(shrinkBox(m, kind.toLowerCase() + ' ' + (i + 1)));

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
				else if (action === 'shrink' && media[i].status === 'big') { setMediaNote(''); startShrink(media[i]); }
				else if (action === 'cancel' && media[i].status === 'shrinking') {
					const m = media[i];
					if (m.job.cancel) m.job.cancel();
					else m.job.canceled = true; // still loading the tools; stops before it starts
				}
				else if (action === 'remove') {
					const gone = media.splice(i, 1)[0];
					gone.removed = true;
					if (gone.job && gone.job.cancel) gone.job.cancel();
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
					track(m, problems, isTooBig(file) ? function () { return checkBig(m); } : function () { return prepare(file); });
				});
				renderMedia();
				setMediaNote(problems.join(' '));
			});

			// Runs one file's work in the queue. work() resolves with the prepared media,
			// or with nothing when the file is left waiting (a big video before "Shrink it").
			function track(m, problems, work) {
				m.ready = queue = queue.then(function () {
					if (m.removed) return;
					return work().then(function (prepared) {
						if (!prepared) return;
						m.prepared = prepared;
						m.status = 'ready';
						m.previewUrl = URL.createObjectURL(prepared.thumb);
					}, function (ex) {
						if (m.removed) return;
						if (ex.canceled) { m.status = 'big'; return; } // back to the "Shrink it" offer
						const i = media.indexOf(m);
						if (i !== -1) media.splice(i, 1);
						problems.push('"' + m.file.name + '" ' + ex.message);
					}).then(function () {
						if (!open_) return;
						keepFocus(function () { renderMedia(); });
						setMediaNote(problems.join(' '));
					});
				});
			}

			// A video over the size limit: too long → no; can't shrink here → the old message;
			// otherwise it waits in the list with a "Shrink it" button.
			async function checkBig(m) {
				const tooBig = 'is ' + formatSize(m.file.size) + '. Videos can be up to ' + VIDEO_MAX_MB + ' MB';
				if (!VIDEO_TYPES[m.file.type]) throw new Error('isn\'t a video type we take. Use MP4, WebM or MOV.');
				if (!canShrink()) throw new Error(tooBig + ', and this browser can\'t shrink it. Try a shorter clip, or record at 1080p.');
				const seconds = await probeDuration(m.file);
				if (seconds > VIDEO_MAX_SECONDS + 0.5) {
					throw new Error('is ' + Math.round(seconds) + ' seconds long. Videos can be up to ' + VIDEO_MAX_SECONDS + ' seconds.');
				}
				m.status = 'big';
				return null;
			}

			function startShrink(m) {
				m.status = 'shrinking';
				m.progress = 0;
				m.job = { onProgress: function (p) { m.progress = p; showShrinkProgress(m); } };
				renderMedia(m.id, 'cancel');
				track(m, [], function () {
					return shrinkVideo(m.file, m.job).then(function (small) {
						m.shrunkFrom = m.file.size;
						return prepareVideo(small);
					});
				});
			}

			// Under a too-big video: the offer to shrink it, then its progress
			function shrinkBox(m, name) {
				const box = el('div', 'composerShrink');
				if (m.status === 'big') {
					box.appendChild(el('p', 'composerShrinkText', 'Over the ' + VIDEO_MAX_MB + ' MB limit. Shrink it to 1080p here? It stays on your device until you post.'));
					const go = button('crwdSmallButton composerShrinkButton', 'Shrink It', 'Shrink ' + name);
					go.dataset.action = 'shrink';
					go.disabled = busy;
					box.appendChild(go);
				} else {
					const pct = Math.round((m.progress || 0) * 100);
					box.appendChild(el('p', 'composerShrinkText', 'Shrinking… ' + pct + '%'));
					const bar = el('div', 'composerShrinkBar');
					bar.setAttribute('role', 'progressbar');
					bar.setAttribute('aria-label', 'Shrinking ' + name);
					bar.setAttribute('aria-valuemin', '0');
					bar.setAttribute('aria-valuemax', '100');
					bar.setAttribute('aria-valuenow', String(pct));
					const fill = el('span', 'composerShrinkFill');
					fill.style.width = pct + '%';
					bar.appendChild(fill);
					const stop = button('crwdLinkButton composerShrinkCancel', 'Cancel', 'Stop shrinking ' + name);
					stop.dataset.action = 'cancel';
					box.append(bar, el('p', 'crwdHint composerShrinkHint', 'Keep this page open while it works.'), stop);
				}
				return box;
			}

			// Progress updates touch only the bar, so typing in a caption isn't interrupted
			function showShrinkProgress(m) {
				const li = mediaList.querySelector('[data-id="' + m.id + '"]');
				if (!li) return;
				const pct = Math.round(m.progress * 100);
				const bar = li.querySelector('.composerShrinkBar');
				const fill = li.querySelector('.composerShrinkFill');
				const text = li.querySelector('.composerShrinkText');
				if (bar) bar.setAttribute('aria-valuenow', String(pct));
				if (fill) fill.style.width = pct + '%';
				if (text) text.textContent = 'Shrinking… ' + pct + '%';
			}

			// Re-rendering the list replaces its buttons; put focus back on the same spot if it was in there
			function keepFocus(fn) {
				const active = document.activeElement;
				const li = active && active.closest && active.closest('.composerMediaItem');
				const spot = li ? { id: li.dataset.id, action: active.dataset.action, caption: active.classList.contains('composerCaption'), pos: active.selectionStart } : null;
				fn();
				if (!spot) return;
				const again = mediaList.querySelector('[data-id="' + spot.id + '"]');
				if (!again) return;
				// (a button that's gone, like Cancel after shrinking ends, hands focus to the tile's first button)
				const target = spot.caption ? again.querySelector('.composerCaption')
					: again.querySelector('[data-action="' + spot.action + '"]:not(:disabled)') || again.querySelector('[data-action]:not(:disabled)');
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

				// A too-big video has to be shrunk (or removed) first
				function waitingToShrink() {
					const waiting = media.find(function (m) { return m.status === 'big'; });
					if (!waiting) return false;
					kit.showError(err, 'Shrink or remove the video that\'s over ' + VIDEO_MAX_MB + ' MB first.');
					const go = mediaList.querySelector('[data-id="' + waiting.id + '"] [data-action="shrink"]');
					if (go) go.focus();
					return true;
				}
				if (waitingToShrink()) return;

				busy = true;
				kit.setBusy(submit, true, 'Preparing…');
				form.classList.add('isBusy');
				renderMedia();

				// Wait for anything still being prepared
				await Promise.all(media.map(function (m) { return m.ready; }));
				if (media.some(function (m) { return m.status === 'big'; })) { // turned out too big while waiting
					busy = false; form.classList.remove('isBusy'); renderMedia();
					kit.setBusy(submit, false, 'Post');
					waitingToShrink();
					return;
				}
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
			media.forEach(function (m) {
				m.removed = true;
				if (m.job && m.job.cancel) m.job.cancel(); // stop shrinking a video nobody will post
				if (m.previewUrl) URL.revokeObjectURL(m.previewUrl);
			});
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
