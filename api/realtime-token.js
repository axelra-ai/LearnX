import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { getUserFromReq } from '../lib/auth.js';
import { sql } from '../lib/db.js';

function driveTokenKey() {
  return createHash('sha256').update(String(process.env.JWT_SECRET || '') + ':google-drive-refresh').digest();
}

function encryptRefreshToken(token) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', driveTokenKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptRefreshToken(value) {
  const [version, ivText, tagText, ciphertextText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('Stored Drive grant is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', driveTokenKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

function makeGoogleClient(redirectUri) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error('Google OAuth client credentials are not configured.');
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
}

function isSameOrigin(req) {
  try { return !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; }
  catch (e) { return false; }
}

async function getAppUser(req, res) {
  const user = getUserFromReq(req);
  if (!user) { res.status(401).json({ error: 'Login required.' }); return null; }
  const accounts = await sql`select is_banned from users where id = ${user.uid} limit 1`;
  if (!accounts.length || accounts[0].is_banned) { res.status(403).json({ error: 'Account access denied.' }); return null; }
  return user;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const user = await getAppUser(req, res);
    if (!user) return;
    const { action, code } = req.body || {};

    if (action === 'drive-connect') {
      if (!isSameOrigin(req) || String(req.headers['x-requested-with'] || '').toLowerCase() !== 'xmlhttprequest') {
        return res.status(403).json({ error: 'Google authorization request origin invalid hai.' });
      }
      if (typeof code !== 'string' || code.length > 4096) return res.status(400).json({ error: 'Google authorization code missing hai.' });
      const client = makeGoogleClient(req.headers.origin);
      const result = await client.getToken({ code, redirect_uri: req.headers.origin });
      const credentials = result.tokens || {};
      if (!credentials.access_token) return res.status(502).json({ error: 'Google access token nahi mila.' });
      const profileResponse = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + credentials.access_token },
      });
      if (!profileResponse.ok) return res.status(403).json({ error: 'Google account verify nahi ho paaya.' });
      const profile = await profileResponse.json();
      if (!profile.email || profile.email.toLowerCase() !== String(user.email || '').toLowerCase()) {
        return res.status(403).json({ error: 'Drive ke liye app wale Google account ka use karein.' });
      }
      let refreshToken = credentials.refresh_token;
      if (!refreshToken) {
        const saved = await sql`select drive_refresh_token from users where id = ${user.uid} limit 1`;
        if (!saved[0] || !saved[0].drive_refresh_token) {
          return res.status(409).json({ error: 'Google ne offline access nahi diya. Google Account settings se LearnX access revoke karke dobara connect karein.' });
        }
        refreshToken = decryptRefreshToken(saved[0].drive_refresh_token);
      } else {
        await sql`update users set drive_refresh_token = ${encryptRefreshToken(refreshToken)} where id = ${user.uid}`;
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ accessToken: credentials.access_token, expiresIn: credentials.expiry_date ? Math.max(60, Math.floor((credentials.expiry_date - Date.now()) / 1000)) : 3600 });
    }

    if (action === 'drive-token') {
      const rows = await sql`select drive_refresh_token from users where id = ${user.uid} limit 1`;
      if (!rows[0] || !rows[0].drive_refresh_token) return res.status(401).json({ error: 'Drive authorization required.' });
      const client = makeGoogleClient();
      client.setCredentials({ refresh_token: decryptRefreshToken(rows[0].drive_refresh_token) });
      const refreshed = await client.refreshAccessToken();
      const credentials = refreshed.credentials || {};
      if (!credentials.access_token) return res.status(401).json({ error: 'Drive access refresh nahi ho paaya.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ accessToken: credentials.access_token, expiresIn: credentials.expiry_date ? Math.max(60, Math.floor((credentials.expiry_date - Date.now()) / 1000)) : 3600 });
    }

    if (action === 'realtime') {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) return res.status(503).json({ error: 'Realtime JWT secret is not configured.' });
      const token = jwt.sign({ sub: user.uid, email: user.email, role: 'authenticated', aud: 'authenticated' }, secret, {
        algorithm: 'HS256', expiresIn: '10m',
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ token });
    }

    return res.status(400).json({ error: 'Token action invalid hai.' });
  } catch (err) {
    console.error('Realtime/Drive token error:', err);
    return res.status(500).json({ error: 'Google Drive authorization complete nahi ho paayi.' });
  }
}
