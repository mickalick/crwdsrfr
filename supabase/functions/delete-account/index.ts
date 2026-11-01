// supabase/functions/delete-account/index.ts
//
// Deletes the signed-in user's account: their uploaded files first, then the account itself.
// Deleting the account removes everything else that belongs to them (profile, posts, comments,
// hypes, follows, blocks, conversations and messages) through "on delete cascade" in the schema.
//
// Called from the Settings page after the person enters the code we emailed them:
//   sb.auth.verifyOtp({ email, token, type: 'email' })     ← a fresh sign-in
//   sb.functions.invoke('delete-account', { method: 'POST' })
// The function refuses unless that fresh sign-in happened in the last FRESH_MINUTES, so a laptop
// left signed in can't be used to delete someone's account without access to their inbox.
//
// Needs no secrets of your own: Supabase gives every Edge Function SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY automatically.
//
// Optional: set SITE_ORIGINS (comma-separated) to the sites allowed to call it,
// e.g. "https://crwdsrfr.com,https://www.crwdsrfr.com,https://staging.crwdsrfr.com".

import { createClient } from 'npm:@supabase/supabase-js@2';

const FRESH_MINUTES = 10;
const BUCKETS = ['avatars', 'profile-heroes', 'post-media']; // every bucket keeps files under "<user id>/..."
const PAGE = 100;

const ORIGINS = (Deno.env.get('SITE_ORIGINS') ?? 'https://crwdsrfr.com,https://www.crwdsrfr.com')
	.split(',').map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
	const origin = req.headers.get('Origin') ?? '';
	const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
	return {
		'Access-Control-Allow-Origin': ORIGINS.includes(origin) || local ? origin : ORIGINS[0],
		'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Vary': 'Origin',
	};
}

function reply(req: Request, status: number, body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
	});
}

// The token's claims. Only read AFTER auth.getUser() has confirmed the token is genuine.
function claimsOf(jwt: string): Record<string, unknown> {
	const part = jwt.split('.')[1] ?? '';
	const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
	return JSON.parse(atob(base64));
}

// True if the person signed in with an emailed code/link within the last FRESH_MINUTES
function signedInRecently(claims: Record<string, unknown>): boolean {
	const amr = Array.isArray(claims.amr) ? claims.amr as { method?: string; timestamp?: number }[] : [];
	const now = Date.now() / 1000;
	return amr.some((a) =>
		['otp', 'magiclink'].includes(a.method ?? '') &&
		typeof a.timestamp === 'number' &&
		now - a.timestamp < FRESH_MINUTES * 60
	);
}

Deno.serve(async (req) => {
	if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
	if (req.method !== 'POST') return reply(req, 405, { error: 'method_not_allowed' });

	const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
	if (!jwt) return reply(req, 401, { error: 'not_signed_in' });

	const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
		auth: { persistSession: false, autoRefreshToken: false },
	});

	// Who's asking? (getUser checks the token with Supabase Auth, so it can't be faked)
	const { data: { user }, error: userError } = await admin.auth.getUser(jwt);
	if (userError || !user) return reply(req, 401, { error: 'not_signed_in' });

	if (!signedInRecently(claimsOf(jwt))) {
		return reply(req, 403, { error: 'code_required', message: 'Enter the code we emailed you, then try again.' });
	}

	// TODO (when Max payments exist): cancel their subscription with the payment provider here.

	// 1. Their files. Supabase doesn't allow deleting storage files with SQL, so this goes
	//    through the Storage API. If anything fails, stop before deleting the account,
	//    so no files are left behind without an owner.
	try {
		for (const bucket of BUCKETS) {
			const paths = await listAll(admin, bucket, user.id);
			for (let i = 0; i < paths.length; i += PAGE) {
				const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + PAGE));
				if (error) throw error;
			}
		}
	} catch (e) {
		console.error('delete-account: storage cleanup failed', user.id, e);
		return reply(req, 500, { error: 'storage_cleanup_failed' });
	}

	// 2. The account (and, by cascade, everything in the database)
	const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
	if (deleteError) {
		console.error('delete-account: deleteUser failed', user.id, deleteError);
		return reply(req, 500, { error: 'delete_failed' });
	}

	return reply(req, 200, { deleted: true });
});

// Every file path under a folder, including subfolders (post-media is <user id>/<post folder>/<file>)
// deno-lint-ignore no-explicit-any
async function listAll(admin: any, bucket: string, folder: string): Promise<string[]> {
	const out: string[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const { data, error } = await admin.storage.from(bucket).list(folder, { limit: PAGE, offset });
		if (error) throw error;
		for (const item of data ?? []) {
			const path = `${folder}/${item.name}`;
			if (item.id === null) out.push(...await listAll(admin, bucket, path)); // a folder
			else out.push(path);
		}
		if (!data || data.length < PAGE) break;
	}
	return out;
}
