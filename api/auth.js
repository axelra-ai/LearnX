// api/auth.js
// login.js + signup.js + google.js ko ek file me combine kiya gaya hai —
// Vercel Hobby plan sirf 12 serverless functions allow karta hai, isliye
// alag-alag files ki jagah ek hi file me "action" field se route karte hain.
//
// Frontend body me { action: 'login' | 'signup' | 'google', ...} bhejta hai.

import { OAuth2Client } from 'google-auth-library';
import { sql } from '../lib/db.js';
import { hashPassword, comparePassword, signToken, EMAIL_RE } from '../lib/auth.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function doLogin(body) {
  const { email, password } = body;
  if (!email || !password) return { status: 400, body: { error: 'Email aur password daalo.' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'Sahi email daalo.' } };

  const normalizedEmail = email.trim().toLowerCase();
  const rows = await sql`select id, name, email, password_hash, is_banned, avatar_url from users where email = ${normalizedEmail}`;
  const user = rows[0];
  if (!user || !user.password_hash) return { status: 401, body: { error: 'Email ya password galat hai.' } };
  if (user.is_banned) return { status: 403, body: { error: 'Ye account suspend kiya gaya hai. Support se contact karo.' } };

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) return { status: 401, body: { error: 'Email ya password galat hai.' } };

  const token = signToken(user);
  return { status: 200, body: { token, user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatar_url || '' } } };
}

async function doSignup(body) {
  const { name, email, password } = body;
  if (!name || !email || !password) return { status: 400, body: { error: 'Naam, email aur password zaroori hai.' } };
  if (!EMAIL_RE.test(email)) return { status: 400, body: { error: 'Sahi email daalo.' } };
  if (password.length < 6) return { status: 400, body: { error: 'Password kam se kam 6 characters ka hona chahiye.' } };

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await sql`select id from users where email = ${normalizedEmail}`;
  if (existing.length) return { status: 409, body: { error: 'Is email se account pehle se bana hua hai. Login karo.' } };

  const passwordHash = await hashPassword(password);
  const inserted = await sql`
    insert into users (name, email, password_hash)
    values (${name.trim()}, ${normalizedEmail}, ${passwordHash})
    returning id, name, email
  `;
  const user = inserted[0];
  await sql`insert into user_state (user_id) values (${user.id})`;

  const token = signToken(user);
  return { status: 201, body: { token, user } };
}

async function doGoogle(body) {
  const { credential } = body;
  if (!credential) return { status: 400, body: { error: 'Google credential missing hai.' } };

  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || !payload.email) return { status: 401, body: { error: 'Google se sahi info nahi mili.' } };

  const { sub: googleId, email, name, picture } = payload;
  const normalizedEmail = email.toLowerCase();

  const existing = await sql`select id, name, email from users where google_id = ${googleId} or email = ${normalizedEmail}`;
  let user;
  if (existing.length) {
    user = existing[0];
    // Agar user ne apni khud ki photo lagayi hai (/api/... URL), to Google ki photo se overwrite mat karo
    const upd = await sql`
      update users set google_id = ${googleId},
        avatar_url = case when avatar_url like '/api/%' then avatar_url else ${picture || null} end
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
    let result;
    if (action === 'login') result = await doLogin(req.body);
    else if (action === 'signup') result = await doSignup(req.body);
    else if (action === 'google') result = await doGoogle(req.body);
    else return res.status(400).json({ error: 'Invalid action.' });

    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
