// supabase/functions/notify-message/index.ts
//
// Emails a member when they get a message request or a new message, if they've
// left that email turned on (Settings → Notifications: profiles.email_message_requests /
// email_new_messages). Sent through Resend from the mail.crwdsrfr.com domain.
//
// How it's called: a Database Webhook on INSERT into public.messages (Supabase Dashboard →
// Database → Webhooks) POSTs the new row here, with an x-webhook-secret header.
//
// When it emails (all checked a short while after the message is sent, NOTIFY_DELAY_SECONDS):
//   • Message request: the first message of a pending conversation, sent by the requester.
//   • New message: a message in an accepted conversation, and only the FIRST one the
//     recipient hasn't read yet from that person. More messages before they open the
//     conversation don't send more emails.
// It skips the email if, by then, the recipient has read the message (e.g. they had the
// conversation open), the request was cancelled, either person left or blocked the other,
// or the recipient turned that email off.
//
// The email never includes the message itself, only who it's from and a link to read it
// (as the Privacy Policy says).
//
// Secrets (npx supabase secrets set NAME=value):
//   RESEND_API_KEY    a Resend API key with sending access (required)
//   WEBHOOK_SECRET    any long random string; the same value goes in the webhook's
//                     x-webhook-secret header (required)
//   EMAIL_FROM        optional, default 'CRWD SRFR <notifications@mail.crwdsrfr.com>'
//   SITE_URL          optional, default 'https://crwdsrfr.com'
//   NOTIFY_DELAY_SECONDS  optional, default 60
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
//
// Deploy without the sign-in check (the webhook isn't a signed-in user; the secret header
// protects it instead):
//   npx supabase functions deploy notify-message --no-verify-jwt

import { createClient } from 'npm:@supabase/supabase-js@2';

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined;

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';
const EMAIL_FROM = Deno.env.get('EMAIL_FROM') ?? 'CRWD SRFR <notifications@mail.crwdsrfr.com>';
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://crwdsrfr.com').replace(/\/+$/, '');
const DELAY_SECONDS = Number(Deno.env.get('NOTIFY_DELAY_SECONDS') ?? '60');

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
	auth: { persistSession: false, autoRefreshToken: false },
});

type MessageRow = { id: string; conversation_id: string; sender_id: string; created_at: string };

Deno.serve(async (req) => {
	if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
	if (!WEBHOOK_SECRET || req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
		return new Response('unauthorized', { status: 401 });
	}

	let payload: { type?: string; table?: string; record?: MessageRow };
	try { payload = await req.json(); } catch { return new Response('bad request', { status: 400 }); }
	const msg = payload.record;
	if (payload.type !== 'INSERT' || payload.table !== 'messages' || !msg?.id) {
		return new Response('ignored', { status: 200 });
	}

	// Answer the webhook straight away (it only waits a few seconds), then wait and decide
	const work = notifyLater(msg).catch((e) => console.error('notify-message failed', msg.id, e));
	if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
	else await work;
	return new Response('accepted', { status: 202 });
});

async function notifyLater(msg: MessageRow) {
	if (DELAY_SECONDS > 0) await new Promise((r) => setTimeout(r, DELAY_SECONDS * 1000));

	// Still there? (a cancelled request deletes the conversation and its message)
	const { data: conv } = await admin.from('conversations')
		.select('id, status, requester_id').eq('id', msg.conversation_id).maybeSingle();
	if (!conv) return;
	const { data: stillThere } = await admin.from('messages').select('id').eq('id', msg.id).maybeSingle();
	if (!stillThere) return;

	const isRequest = conv.status === 'pending' && conv.requester_id === msg.sender_id;
	if (!isRequest && conv.status !== 'accepted') return;

	// The other person, if they're still in the conversation
	const { data: members } = await admin.from('conversation_members')
		.select('user_id, last_read_at, left_at').eq('conversation_id', conv.id);
	const recipient = (members ?? []).find((m) => m.user_id !== msg.sender_id);
	const sender = (members ?? []).find((m) => m.user_id === msg.sender_id);
	if (!recipient || recipient.left_at || !sender || sender.left_at) return;

	// Already read it (e.g. they had the conversation open)
	if (recipient.last_read_at && Date.parse(recipient.last_read_at) >= Date.parse(msg.created_at)) return;

	// New messages: one email per unread stretch. Skip if they already have an unread
	// message from this person from before this one (that one got the email).
	if (!isRequest) {
		let earlier = admin.from('messages').select('id')
			.eq('conversation_id', conv.id).eq('sender_id', msg.sender_id)
			.lt('created_at', msg.created_at).limit(1);
		if (recipient.last_read_at) earlier = earlier.gt('created_at', recipient.last_read_at);
		const { data: unreadBefore } = await earlier;
		if (unreadBefore && unreadBefore.length) return;
	}

	// Blocked either way: no email
	const { data: blocks } = await admin.from('blocks').select('blocker_id')
		.or(`and(blocker_id.eq.${recipient.user_id},blocked_id.eq.${msg.sender_id}),and(blocker_id.eq.${msg.sender_id},blocked_id.eq.${recipient.user_id})`)
		.limit(1);
	if (blocks && blocks.length) return;

	// The recipient's email settings, and the sender's username
	const { data: people } = await admin.from('profiles')
		.select('id, username, email_message_requests, email_new_messages')
		.in('id', [recipient.user_id, msg.sender_id]);
	const to = (people ?? []).find((p) => p.id === recipient.user_id);
	const from = (people ?? []).find((p) => p.id === msg.sender_id);
	if (!to || !from) return;
	if (isRequest ? to.email_message_requests === false : to.email_new_messages === false) return;

	const { data: account } = await admin.auth.admin.getUserById(recipient.user_id);
	const email = account?.user?.email;
	if (!email) return;

	const link = `${SITE_URL}/messages/?c=${encodeURIComponent(conv.id)}`;
	const content = isRequest ? requestEmail(from.username, link) : messageEmail(from.username, link);
	await sendEmail(email, content, `message-notify-${msg.id}`);
}

// ---------- Emails ----------

type Email = { subject: string; heading: string; text: string; button: string; link: string; why: string };

function requestEmail(username: string, link: string): Email {
	return {
		subject: `@${username} sent you a message request`,
		heading: 'New message request',
		text: `@${username} wants to start a conversation with you on CRWD SRFR. Open it to read their message and accept or decline.`,
		button: 'View Request',
		link,
		why: 'You\'re getting this because new message request emails are turned on for your CRWD SRFR account.',
	};
}

function messageEmail(username: string, link: string): Email {
	return {
		subject: `New message from @${username}`,
		heading: 'New message',
		text: `@${username} sent you a message on CRWD SRFR. You won't get another email for this conversation until you've read it.`,
		button: 'Read Message',
		link,
		why: 'You\'re getting this because new message emails are turned on for your CRWD SRFR account.',
	};
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function sendEmail(to: string, e: Email, idempotencyKey: string) {
	const settings = `${SITE_URL}/settings/#notifications`;
	const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#222222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#222222;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#101010;border-radius:9px;padding:32px;font-family:Helvetica,Arial,sans-serif;color:#FFFFFF;">
<tr><td style="font-size:14px;letter-spacing:0.1em;color:#62CBB8;font-weight:bold;">CRWD SRFR</td></tr>
<tr><td style="padding-top:16px;font-size:26px;font-weight:bold;line-height:1.2;">${escapeHtml(e.heading)}</td></tr>
<tr><td style="padding-top:12px;font-size:16px;line-height:1.55;color:#DADADA;">${escapeHtml(e.text)}</td></tr>
<tr><td style="padding-top:24px;"><a href="${escapeHtml(e.link)}" style="display:inline-block;padding:12px 20px;background:#F9F976;color:#101010;border-radius:9px;font-size:16px;font-weight:bold;text-decoration:none;">${escapeHtml(e.button)}</a></td></tr>
<tr><td style="padding-top:32px;font-size:12px;line-height:1.5;color:#ADADAD;">${escapeHtml(e.why)} <a href="${escapeHtml(settings)}" style="color:#62CBB8;">Change your email settings</a>.</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
	const text = `${e.heading}\n\n${e.text}\n\n${e.button}: ${e.link}\n\n${e.why}\nChange your email settings: ${settings}\n`;

	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${RESEND_API_KEY}`,
			'Content-Type': 'application/json',
			'Idempotency-Key': idempotencyKey, // a retried webhook can't send the same email twice
		},
		body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject: e.subject, html, text }),
	});
	if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}
