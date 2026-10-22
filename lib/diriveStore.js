// lib/driveStore.js
// Server-side Google Drive helper (sirf video ke owner ke Drive ke saath kaam karta hai).
//  1) getDriveToken(userId)  -> user ke saved refresh token se Drive access token
//  2) streamDriveFile(...)    -> Origin Play video ko Range support ke saath stream karta hai
//  3) likes / comments        -> video ke owner ke Google Drive me chhoti JSON files ke roop me save hote hain
//
// Likes/comments Supabase me nahi jaate. Har like/comment owner ke Drive ke
// "LearnX video activity" folder me ek chhoti file hoti hai (description me JSON).

import { createDecipheriv, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { OAuth2Client } from 'google-auth-library';
import { sql } from './db.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_NAME = 'LearnX video activity';
const STREAM_CHUNK = 8 * 1024 * 1024; // ek request me max 8 MB, taaki Vercel ka time limit beech me na kaate

/* ---------- Drive token (realtime-token.js jaisa hi decrypt) ---------- */
function driveTokenKey() {
  return createHash('sha256').update(String(process.env.JWT_SECRET || '') + ':google-drive-refresh').digest();
}
function decryptRefreshToken(value) {
  const [version, ivText, tagText, ciphertextText] = String(value || '').split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('Stored Drive grant is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', driveTokenKey(), Buffer.from(ivText, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64url')), decipher.final()]).toString('utf8');
}

const tokenCache = new Map(); // userId -> { token, exp }
export function forgetDriveToken(userId) { tokenCache.delete(userId); }

export async function getDriveToken(userId) {
  const hit = tokenCache.get(userId);
  if (hit && hit.exp - Date.now() > 60 * 1000) return hit.token;
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return null;
  const rows = await sql`select drive_refresh_token from users where id = ${userId} limit 1`;
  if (!rows[0] || !rows[0].drive_refresh_token) return null;
  try {
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    client.setCredentials({ refresh_token: decryptRefreshToken(rows[0].drive_refresh_token) });
    const refreshed = await client.refreshAccessToken();
    const credentials = refreshed.credentials || {};
    if (!credentials.access_token) return null;
    tokenCache.set(userId, { token: credentials.access_token, exp: credentials.expiry_date || Date.now() + 50 * 60 * 1000 });
    return credentials.access_token;
  } catch (err) {
    console.warn('Drive token refresh fail:', err && err.message);
    return null;
  }
}

async function driveCall(ownerId, url, options = {}, retry = true) {
  const token = await getDriveToken(ownerId);
  if (!token) throw Object.assign(new Error('Drive not connected'), { code: 'NO_DRIVE' });
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, options.headers || {});
  const response = await fetch(url, Object.assign({}, options, { headers }));
  if (response.status === 401 && retry) { forgetDriveToken(ownerId); return driveCall(ownerId, url, options, false); }
  return response;
}
async function driveJson(ownerId, url, options = {}) {
  const response = await driveCall(ownerId, url, options);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error('Drive error ' + response.status + ' ' + text.slice(0, 200)), { status: response.status });
  }
  if (response.status === 204) return {};
  return response.json();
}

/* ---------- Video streaming (Range support) ---------- */
const fileOwnerCache = new Map(); // driveFileId -> { ownerId, exp }
async function ownerOfDriveFile(driveFileId) {
  const hit = fileOwnerCache.get(driveFileId);
  if (hit && hit.exp > Date.now()) return hit.ownerId;
  const rows = await sql`select user_id as "ownerId" from videos where drive_file_id = ${driveFileId} limit 1`;
  if (!rows[0]) return null;
  fileOwnerCache.set(driveFileId, { ownerId: rows[0].ownerId, exp: Date.now() + 10 * 60 * 1000 });
  return rows[0].ownerId;
}

export async function streamDriveFile(req, res, driveFileId) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(driveFileId)) return res.status(400).end();
  const ownerId = await ownerOfDriveFile(driveFileId); // sirf LearnX me upload hui videos hi stream hoti hain
  if (!ownerId) return res.status(404).end();

  const rangeHeader = String(req.headers.range || '');
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  let upstreamRange = null;
  if (match) {
    const start = match[1] === '' ? 0 : parseInt(match[1], 10);
    let end = match[2] === '' ? start + STREAM_CHUNK - 1 : parseInt(match[2], 10);
    if (match[1] === '' && match[2] !== '') { upstreamRange = 'bytes=-' + Math.min(parseInt(match[2], 10), STREAM_CHUNK); }
    else {
      end = Math.min(end, start + STREAM_CHUNK - 1);
      upstreamRange = 'bytes=' + start + '-' + end;
    }
  } else {
    upstreamRange = 'bytes=0-' + (STREAM_CHUNK - 1); // browser ne Range nahi bheja: pehla chunk 206 ke roop me
  }

  let upstream;
  try {
    upstream = await driveCall(ownerId, DRIVE_FILES + '/' + encodeURIComponent(driveFileId) + '?alt=media&supportsAllDrives=true', { headers: { Range: upstreamRange } });
  } catch (err) {
    if (err && err.code === 'NO_DRIVE') return res.status(503).end();
    throw err;
  }
  if (upstream.status === 404) return res.status(404).end();
  if (upstream.status === 416) {
    res.status(416);
    const cr = upstream.headers.get('content-range'); if (cr) res.setHeader('Content-Range', cr);
    return res.end();
  }
  if (!upstream.ok && upstream.status !== 206) return res.status(502).end();

  const type = upstream.headers.get('content-type') || 'video/mp4';
  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader('Content-Type', /^(video|audio)\//i.test(type) ? type : 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const length = upstream.headers.get('content-length'); if (length) res.setHeader('Content-Length', length);
  const contentRange = upstream.headers.get('content-range'); if (contentRange) res.setHeader('Content-Range', contentRange);
  if (!upstream.body) return res.end();
  const stream = Readable.fromWeb(upstream.body);
  req.on('close', () => { try { stream.destroy(); } catch (e) {} }); // user video band kare to Drive se download bhi ruk jaye
  stream.on('error', () => { try { res.end(); } catch (e) {} });
  stream.pipe(res);
}

/* ---------- Likes / comments (owner ke Drive me) ---------- */
const folderCache = new Map(); // ownerId -> folderId
const q = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function ensureFolder(ownerId, force = false) {
  if (!force && folderCache.has(ownerId)) return folderCache.get(ownerId);
  const query = "name = '" + q(FOLDER_NAME) + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const found = await driveJson(ownerId, DRIVE_FILES + '?q=' + encodeURIComponent(query) + '&pageSize=1&fields=files(id)');
  let id = found.files && found.files[0] && found.files[0].id;
  if (!id) {
    const created = await driveJson(ownerId, DRIVE_FILES + '?fields=id', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    id = created.id;
  }
  folderCache.set(ownerId, id);
  return id;
}

function activityQuery(folderId, videoId, extra = '') {
  return "'" + q(folderId) + "' in parents and trashed = false and appProperties has { key='lxVideo' and value='" + q(videoId) + "' }" + extra;
}

async function listFiles(ownerId, query) {
  const files = [];
  let pageToken = '';
  do {
    const url = DRIVE_FILES + '?q=' + encodeURIComponent(query) + '&pageSize=1000&orderBy=createdTime desc&fields=nextPageToken,files(id,description,createdTime,appProperties)' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const data = await driveJson(ownerId, url);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken && files.length < 5000);
  return files;
}

// Owner ke Drive se is video ke saare likes + comments
export async function readActivity(ownerId, videoId, viewerId) {
  const folderId = await ensureFolder(ownerId);
  const files = await listFiles(ownerId, activityQuery(folderId, videoId));
  const likers = new Set();
  const comments = [];
  for (const file of files) {
    const props = file.appProperties || {};
    if (props.lxType === 'like') { if (props.lxUser) likers.add(props.lxUser); continue; }
    if (props.lxType !== 'comment') continue;
    try {
      const data = JSON.parse(file.description || '{}');
      if (!data.body) continue;
      comments.push({ id: file.id, userId: props.lxUser || data.userId, name: data.name || '', avatarUrl: data.avatarUrl || null, body: String(data.body), createdAt: data.createdAt || file.createdTime });
    } catch (e) {}
  }
  comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { likeCount: likers.size, likedByMe: !!viewerId && likers.has(viewerId), comments: comments.slice(0, 200), commentCount: comments.length };
}

async function createActivityFile(ownerId, videoId, type, userId, description) {
  const make = async (folderId) => driveJson(ownerId, DRIVE_FILES + '?fields=id,createdTime', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'learnx-' + type + '-' + Date.now().toString(36) + '.json', mimeType: 'application/json',
      parents: [folderId], description: JSON.stringify(description),
      appProperties: { lxVideo: videoId, lxType: type, lxUser: userId },
    }),
  });
  try { return await make(await ensureFolder(ownerId)); }
  catch (err) {
    if (err && err.status === 404) return make(await ensureFolder(ownerId, true)); // owner ne folder delete kar diya ho
    throw err;
  }
}

export async function toggleLike(ownerId, videoId, userId) {
  const folderId = await ensureFolder(ownerId);
  const mine = await listFiles(ownerId, activityQuery(folderId, videoId, " and appProperties has { key='lxType' and value='like' } and appProperties has { key='lxUser' and value='" + q(userId) + "' }"));
  if (mine.length) {
    await Promise.all(mine.map(file => driveCall(ownerId, DRIVE_FILES + '/' + encodeURIComponent(file.id), { method: 'DELETE' })));
    return { liked: false };
  }
  await createActivityFile(ownerId, videoId, 'like', userId, { userId, createdAt: new Date().toISOString() });
  return { liked: true };
}

export async function addComment(ownerId, videoId, user, body) {
  const created = await createActivityFile(ownerId, videoId, 'comment', user.uid, {
    userId: user.uid, name: user.name || '', avatarUrl: user.avatarUrl || null, body, createdAt: new Date().toISOString(),
  });
  return { id: created.id, userId: user.uid, name: user.name || '', avatarUrl: user.avatarUrl || null, body, createdAt: new Date().toISOString() };
}

// Comment likhne wala ya video ka owner delete kar sakta hai
export async function deleteComment(ownerId, videoId, commentId, requesterId) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(commentId)) return { ok: false, status: 400 };
  const response = await driveCall(ownerId, DRIVE_FILES + '/' + encodeURIComponent(commentId) + '?fields=id,appProperties');
  if (response.status === 404) return { ok: false, status: 404 };
  if (!response.ok) throw Object.assign(new Error('Drive error ' + response.status), { status: response.status });
  const file = await response.json();
  const props = file.appProperties || {};
  if (props.lxVideo !== videoId || props.lxType !== 'comment') return { ok: false, status: 404 };
  if (requesterId !== ownerId && props.lxUser !== requesterId) return { ok: false, status: 403 };
  await driveCall(ownerId, DRIVE_FILES + '/' + encodeURIComponent(commentId), { method: 'DELETE' });
  return { ok: true };
}
