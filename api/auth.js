// api/auth.js
// Google sign-in handler —
// Vercel Hobby plan sirf 12 serverless functions allow karta hai, isliye
// alag-alag files ki jagah ek hi file me "action" field se route karte hain.
//
// Frontend body me { action: 'google', ...} bhejta hai.

import { OAuth2Client } from 'google-auth-library';
import { sql } from '../lib/db.js';
import { signToken } from '../lib/auth.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function doGoogle(body) {
  const { credential } = body;
  if (!credential) return { status: 400, body: { error: 'Google credential missing hai.' } };

  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) return { status: 401, body: { error: 'Google se sahi info nahi mili.' } };

  const { sub: googleId, email, name, picture } = payload;
  const normalizedEmail = email.toLowerCase();

  const existing = await sql`select id, name, email, is_banned from users where google_id = ${googleId} or email = ${normalizedEmail}`;
  let user;
  if (existing.length) {
    user = existing[0];
    if (user.is_banned) return { status: 403, body: { error: 'Ye account suspend kiya gaya hai.' } };
    // Custom profile photos stored in Drive or legacy avatar endpoint should survive Google sign-in.
    const upd = await sql`
      update users set google_id = ${googleId},
        password_hash = null,
        avatar_url = case when avatar_url like '/api/%' or avatar_url like 'https://drive.google.com/%' then avatar_url else ${picture || null} end
      where id = ${user.id} returning avatar_url`;
    user.avatarUrl = (upd[0] && upd[0].avatar_url) || '';
  } else {
    const inserted = await sql`
      insert into users (name, email, google_id, avatar_url)
      values (${name || normalizedEmail.split('@')[0]}, ${normalizedEmail}, ${googleId}, ${picture || null})
      returning id, name, email
    `;
    user = inserted[0];
    user.avatarUrl = picture || '';
    await sql`insert into user_state (user_id) values (${user.id})`;
  }

  const token = signToken(user);
  return { status: 200, body: { token, user } };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { action } = req.body || {};
    if (action !== 'google') return res.status(410).json({ error: 'Google sign-in hi supported hai.' });
    const result = await doGoogle(req.body);

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
