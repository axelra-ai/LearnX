import jwt from 'jsonwebtoken';
import { getUserFromReq } from '../lib/auth.js';
import { sql } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login required.' });
  const accounts = await sql`select is_banned from users where id = ${user.uid} limit 1`;
  if (!accounts.length || accounts[0].is_banned) return res.status(403).json({ error: 'Account access denied.' });
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) return res.status(503).json({ error: 'Realtime JWT secret is not configured.' });

  const token = jwt.sign({ sub: user.uid, email: user.email, role: 'authenticated', aud: 'authenticated' }, secret, {
    algorithm: 'HS256', expiresIn: '10m',
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ token });
}
