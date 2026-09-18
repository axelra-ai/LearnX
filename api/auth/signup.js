// api/auth/signup.js
import { sql } from '../../lib/db.js';
import { hashPassword, signToken, EMAIL_RE } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Naam, email aur password zaroori hai.' });
    }
    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Sahi email daalo.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password kam se kam 6 characters ka hona chahiye.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const existing = await sql`select id from users where email = ${normalizedEmail}`;
    if (existing.length) {
      return res.status(409).json({ error: 'Is email se account pehle se bana hua hai. Login karo.' });
    }

    const passwordHash = await hashPassword(password);
    const inserted = await sql`
      insert into users (name, email, password_hash)
      values (${name.trim()}, ${normalizedEmail}, ${passwordHash})
      returning id, name, email
    `;
    const user = inserted[0];

    // Har naye user ke liye khaali state row bana do
    await sql`insert into user_state (user_id) values (${user.id})`;

    const token = signToken(user);
    return res.status(201).json({ token, user });
  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).json({ error: 'Account banane me dikkat aayi. Dobara try karo.' });
  }
}
