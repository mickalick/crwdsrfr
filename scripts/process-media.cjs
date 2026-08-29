#!/usr/bin/env node
// process-media.js
//
// Compresses a submitted photo or video for the /board/ media wall, generates
// a matching thumbnail (or video poster), and prints a ready-to-paste
// data/board-media.json entry — or appends it directly with --append.
//
// Usage (from repo root):
//   node scripts/process-media.js <input-file> --title "Crowd surf at the Grog Shop" \
//       --date 2026-08-15 --venueId grog-shop --submittedBy "Jane Doe" [--append]
//
// Optional flags:
//   --type photo|video   Force the media type instead of inferring from extension
//   --append             Write the entry into data/board-media.json instead of
//                         just printing it
//
// Requires:
//   - sharp (npm install sharp)
//   - ffmpeg + ffprobe on PATH (for video — brew install ffmpeg / apt install ffmpeg)
//
// Output:
//   board/media/<id>.webp or .mp4      — compressed full-size media
//   board/media/thumbs/<id>.webp       — thumbnail (or video poster frame)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const MEDIA_DIR = path.join(__dirname, '..', 'board', 'media');
const THUMBS_DIR = path.join(MEDIA_DIR, 'thumbs');
const BOARD_MEDIA_JSON = path.join(__dirname, '..', 'data', 'board-media.json');

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);

const PHOTO_MAX_DIMENSION = 1600;
const PHOTO_QUALITY = 80;
const THUMB_MAX_DIMENSION = 500;
const THUMB_QUALITY = 72;
const VIDEO_MAX_HEIGHT = 720;
const VIDEO_CRF = 24;

// --- CLI helpers ------------------------------------------------------------

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith('--')) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) {
				args[key] = true;
			} else {
				args[key] = next;
				i++;
			}
		} else {
			args._.push(a);
		}
	}
	return args;
}

function fail(msg) {
	console.error(`process-media.js: ${msg}`);
	process.exit(1);
}

function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Lowercases, replaces whitespace with dashes, and strips anything that
// isn't safe in a filename/URL — mirrors the slugify() convention already
// used elsewhere in the pipeline.
function slugify(str) {
	return String(str)
		.toLowerCase()
		.trim()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-]/g, '')
		.replace(/-+/g, '-')
		.replace(/^-+|-+$/g, '');
}

// --- Filesystem / data helpers ----------------------------------------------

function ensureDirs() {
	fs.mkdirSync(MEDIA_DIR, { recursive: true });
	fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

function loadExistingBoardMedia() {
	if (!fs.existsSync(BOARD_MEDIA_JSON)) return [];
	try {
		const raw = fs.readFileSync(BOARD_MEDIA_JSON, 'utf8');
		const data = JSON.parse(raw);
		return Array.isArray(data) ? data : [];
	} catch (err) {
		console.warn(`process-media.js: could not parse ${BOARD_MEDIA_JSON}, treating as empty (${err.message})`);
		return [];
	}
}

// IDs follow the "<title-slug>-<YYYYMMDD>-<sequence>" pattern, so the same
// title posted more than once on the same day still gets a unique id.
function nextSequence(existing, prefix) {
	let max = 0;
	existing.forEach((item) => {
		if (item && typeof item.id === 'string' && item.id.startsWith(`${prefix}-`)) {
			const suffix = item.id.slice(prefix.length + 1);
			const n = parseInt(suffix, 10);
			if (!Number.isNaN(n) && n > max) max = n;
		}
	});
	return String(max + 1).padStart(2, '0');
}

// --- Media processing --------------------------------------------------------

function processPhoto(inputPath, baseName) {
	const outFile = `${baseName}.webp`;
	const thumbFile = `${baseName}.webp`;
	const outPath = path.join(MEDIA_DIR, outFile);
	const thumbPath = path.join(THUMBS_DIR, thumbFile);

	return sharp(inputPath)
		.rotate() // respect EXIF orientation before resizing
		.resize({ width: PHOTO_MAX_DIMENSION, height: PHOTO_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
		.webp({ quality: PHOTO_QUALITY })
		.toFile(outPath)
		.then(() =>
			sharp(inputPath)
				.rotate()
				.resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
				.webp({ quality: THUMB_QUALITY })
				.toFile(thumbPath)
		)
		.then(() => ({
			type: 'photo',
			src: `media/${outFile}`,
			thumbnail: `media/thumbs/${thumbFile}`,
			outPath,
			thumbPath,
		}));
}

function processVideo(inputPath, baseName) {
	const outFile = `${baseName}.mp4`;
	const thumbFile = `${baseName}.webp`;
	const outPath = path.join(MEDIA_DIR, outFile);
	const thumbPath = path.join(THUMBS_DIR, thumbFile);
	const posterTmpPath = path.join(MEDIA_DIR, `${baseName}-poster-tmp.jpg`);

	execFileSync('ffmpeg', [
		'-y',
		'-i', inputPath,
		'-vf', `scale=-2:${VIDEO_MAX_HEIGHT}`,
		'-c:v', 'libx264',
		'-crf', String(VIDEO_CRF),
		'-preset', 'slow',
		'-c:a', 'aac',
		'-b:a', '128k',
		'-movflags', '+faststart',
		outPath,
	], { stdio: 'inherit' });

	// Grab a poster frame 1 second in, then run it through the same
	// thumbnail pipeline as photos for a consistent size/quality.
	execFileSync('ffmpeg', [
		'-y',
		'-ss', '00:00:01',
		'-i', outPath,
		'-vframes', '1',
		posterTmpPath,
	], { stdio: 'inherit' });

	return sharp(posterTmpPath)
		.resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
		.webp({ quality: THUMB_QUALITY })
		.toFile(thumbPath)
		.then(() => {
			fs.unlinkSync(posterTmpPath);
			return {
				type: 'video',
				src: `media/${outFile}`,
				thumbnail: `media/thumbs/${thumbFile}`,
				outPath,
				thumbPath,
			};
		});
}

// --- Main ---------------------------------------------------------------------

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const inputPath = args._[0];

	if (!inputPath) {
		fail('missing input file.\n  Usage: node scripts/process-media.js <input-file> --title "..." --date YYYY-MM-DD --venueId id --submittedBy "Name" [--append]');
	}
	if (!fs.existsSync(inputPath)) fail(`input file not found: ${inputPath}`);
	if (!args.date) fail('--date is required (YYYY-MM-DD)');
	if (!args.venueId) fail('--venueId is required');

	const ext = path.extname(inputPath).toLowerCase();
	let mediaType;
	if (args.type === 'photo' || args.type === 'video') {
		mediaType = args.type;
	} else if (PHOTO_EXT.has(ext)) {
		mediaType = 'photo';
	} else if (VIDEO_EXT.has(ext)) {
		mediaType = 'video';
	} else {
		fail(`could not determine media type from extension "${ext}" — pass --type photo|video`);
	}

	const title = args.title || path.basename(inputPath, ext);
	const submittedBy = args.submittedBy || '';
	const dateCompact = String(args.date).replace(/-/g, '');

	ensureDirs();

	const existing = loadExistingBoardMedia();
	const titleSlug = slugify(title);
	if (!titleSlug) fail('title must contain at least one alphanumeric character to generate an id/filename');
	const prefix = `${titleSlug}-${dateCompact}`;
	const sequence = nextSequence(existing, prefix);
	const baseName = `${prefix}-${sequence}`;

	console.log(`Processing ${inputPath} as ${mediaType}...`);
	const inputSize = fs.statSync(inputPath).size;

	const result = mediaType === 'photo'
		? await processPhoto(inputPath, baseName)
		: await processVideo(inputPath, baseName);

	const outputSize = fs.statSync(result.outPath).size;
	const thumbSize = fs.statSync(result.thumbPath).size;

	console.log(`  input:     ${formatBytes(inputSize)}`);
	console.log(`  output:    ${formatBytes(outputSize)}  (${result.src})`);
	console.log(`  thumbnail: ${formatBytes(thumbSize)}  (${result.thumbnail})`);

	const entry = {
		id: baseName,
		type: result.type,
		src: result.src,
		thumbnail: result.thumbnail,
		title,
		date: args.date,
		venueId: args.venueId,
		submittedBy,
	};

	console.log('\nboard-media.json entry:\n');
	console.log(JSON.stringify(entry, null, 2));

	if (args.append) {
		existing.push(entry);
		fs.writeFileSync(BOARD_MEDIA_JSON, JSON.stringify(existing, null, '\t') + '\n');
		console.log(`\nAppended to ${path.relative(__dirname, BOARD_MEDIA_JSON)}`);
	} else {
		console.log('\nRun again with --append to add this directly to data/board-media.json.');
	}
}

main().catch((err) => {
	console.error('process-media.js failed:', err.message);
	process.exit(1);
});
