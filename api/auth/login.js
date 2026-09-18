// api/auth/login.js
import { sql } from '../../lib/db.js';
import { comparePassword, signToken, EMAIL_RE } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email aur password daalo.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Sahi email daalo.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const rows = await sql`select id, name, email, password_hash from users where email = ${normalizedEmail}`;
    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Email ya password galat hai.' });
    }

    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Email ya password galat hai.' });
    }

    const token = signToken(user);
    return res.status(200).json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login me dikkat aayi. Dobara try karo.' });
  }
}
