// api/auth/google.js
// Frontend Google Identity Services se ek "credential" (ID token) leke yahan
// bhejta hai. Hum Google ke saath verify karte hain ki ye token asli hai,
// phir user ko database me create/find karke apna JWT issue karte hain.
//
// GOOGLE_CLIENT_ID hi wo "service ID" hai jo Google Cloud Console se milta
// hai (OAuth 2.0 Client ID) — README me steps hain isse banane ke.

import { OAuth2Client } from 'google-auth-library';
import { sql } from '../../lib/db.js';
import { signToken } from '../../lib/auth.js';

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { credential } = req.body || {};
    if (!credential) {
      return res.status(400).json({ error: 'Google credential missing hai.' });
    }

    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Google se sahi info nahi mili.' });
    }

    const { sub: googleId, email, name, picture } = payload;
    const normalizedEmail = email.toLowerCase();

    const existing = await sql`
      select id, name, email from users
      where google_id = ${googleId} or email = ${normalizedEmail}
    `;

    let user;
    if (existing.length) {
      user = existing[0];
      await sql`
        update users set google_id = ${googleId}, avatar_url = ${picture || null}
        where id = ${user.id}
      `;
    } else {
      const inserted = await sql`
        insert into users (name, email, google_id, avatar_url)
        values (${name || normalizedEmail.split('@')[0]}, ${normalizedEmail}, ${googleId}, ${picture || null})
        returning id, name, email
      `;
      user = inserted[0];
      await sql`insert into user_state (user_id) values (${user.id})`;
    }

    const token = signToken(user);
    return res.status(200).json({ token, user });
  } catch (err) {
    console.error('Google auth error:', err);
    return res.status(401).json({ error: 'Google sign-in verify nahi ho paya.' });
  }
}
