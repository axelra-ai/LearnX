import { sql } from '../lib/db.js';
import { getUserFromReq } from '../lib/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

function requireUser(user, res) {
  if (!user) {
    res.status(401).json({ error: 'Is action ke liye login zaroori hai.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  const user = getUserFromReq(req);
  const action = req.query.action || (req.body && req.body.action);

  try {
    // ---- Profile picture (chhoti JPEG, ~20KB, DB me; video ki tarah Drive me nahi) ----
    // Public GET: <img> tag Authorization header nahi bhej sakta, isliye login zaroori nahi.
    if (req.method === 'GET' && action === 'avatar') {
      const id = String(req.query.id || '');
      if (!UUID_RE.test(id)) return res.status(400).end();
      const rows = await sql`select avatar_data from users where id = ${id}`;
      if (!rows.length || !rows[0].avatar_data) return res.status(404).end();
      res.setHeader('Content-Type', 'image/jpeg');
      // URL me ?v=<time> hota hai, naya photo = naya URL, isliye lamba cache safe hai
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.status(200).send(rows[0].avatar_data);
    }

    if (req.method === 'POST' && action === 'set-avatar') {
      if (!requireUser(user, res)) return;
      const image = String((req.body && req.body.image) || '');
      const prefix = 'data:image/jpeg;base64,';
      if (!image.startsWith(prefix) || image.length > 140000) {
        return res.status(400).json({ error: 'Photo sahi format ya size ki nahi hai.' });
      }
      const buf = Buffer.from(image.slice(prefix.length), 'base64');
      // JPEG ke pehle 3 bytes: FF D8 FF  |  max 90 KB
      if (buf.length < 200 || buf.length > 90 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
        return res.status(400).json({ error: 'Photo valid JPEG nahi hai.' });
      }
      const url = '/api/videos?action=avatar&id=' + user.uid + '&v=' + Date.now();
      await sql`update users set avatar_data = ${buf}, avatar_url = ${url} where id = ${user.uid}`;
      return res.status(200).json({ avatarUrl: url });
    }

    if (req.method === 'POST' && action === 'remove-avatar') {
      if (!requireUser(user, res)) return;
      await sql`update users set avatar_data = null, avatar_url = null where id = ${user.uid}`;
      return res.status(200).json({ avatarUrl: '' });
    }

    if (req.method === 'GET' && action === 'feed') {
      const rows = await sql`
        select v.id, v.user_id as "channelId", v.title, v.description,
          v.drive_file_id as "driveFileId", v.mime_type as "mimeType",
          v.size_bytes as "sizeBytes", v.view_count as "viewCount", v.created_at as "createdAt",
          u.name as "channelName", u.avatar_url as "avatarUrl"
        from videos v join users u on u.id = v.user_id
        order by case when ${req.query.sort === 'trending'} then v.view_count end desc, v.created_at desc limit 40
      `;
      return res.status(200).json({ videos: rows });
    }

    if (req.method === 'GET' && action === 'channels') {
      const query = String(req.query.q || '').trim().slice(0, 80);
      const rows = query
        ? await sql`
            select u.id, u.name, u.avatar_url as "avatarUrl",
              count(v.id)::int as "videoCount", coalesce(sum(v.view_count), 0)::bigint as "viewCount"
            from users u left join videos v on v.user_id = u.id
            where u.name ilike ${'%' + query + '%'}
            group by u.id order by count(v.id) desc, u.name asc limit 20
          `
        : await sql`
            select u.id, u.name, u.avatar_url as "avatarUrl",
              count(v.id)::int as "videoCount", coalesce(sum(v.view_count), 0)::bigint as "viewCount"
            from users u left join videos v on v.user_id = u.id
            group by u.id order by max(u.created_at) desc limit 20
          `;
      return res.status(200).json({ channels: rows });
    }

    if (req.method === 'GET' && action === 'channel') {
      const channelId = String(req.query.id || '');
      const channels = await sql`
        select u.id, u.name, u.avatar_url as "avatarUrl",
          (select count(*)::int from videos where user_id = u.id) as "videoCount",
          (select coalesce(sum(view_count), 0)::bigint from videos where user_id = u.id) as "viewCount",
          (select count(*)::int from video_follows where channel_id = u.id) as "followerCount",
          exists(select 1 from video_follows where user_id = ${user ? user.uid : null} and channel_id = u.id) as following
        from users u where u.id = ${channelId} limit 1
      `;
      if (!channels.length) return res.status(404).json({ error: 'Channel nahi mila.' });
      const videos = await sql`
        select id, user_id as "channelId", title, description,
          drive_file_id as "driveFileId", mime_type as "mimeType", size_bytes as "sizeBytes",
          view_count as "viewCount", created_at as "createdAt"
        from videos where user_id = ${channelId} order by created_at desc limit 60
      `;
      return res.status(200).json({ channel: channels[0], videos });
    }

    if (req.method === 'GET' && action === 'mine') {
      if (!requireUser(user, res)) return;
      const rows = await sql`
        select id, user_id as "channelId", title, description, drive_file_id as "driveFileId",
          mime_type as "mimeType", size_bytes as "sizeBytes", view_count as "viewCount", created_at as "createdAt"
        from videos where user_id = ${user.uid} order by created_at desc
      `;
      return res.status(200).json({ videos: rows });
    }

    if (req.method === 'GET' && action === 'messages') {
      if (!requireUser(user, res)) return;
      const otherId = String(req.query.with || '');
      const relationship = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${otherId})
          or exists(select 1 from video_follows where user_id = ${otherId} and channel_id = ${user.uid})
      `;
      if (!relationship.length) return res.status(403).json({ error: 'Is chat ke liye channel follow hona chahiye.' });
      const rows = await sql`
        select m.id, m.sender_id as "senderId", m.recipient_id as "recipientId",
          m.message, m.created_at as "createdAt", u.name as "senderName"
        from video_messages m join users u on u.id = m.sender_id
        where (m.sender_id = ${user.uid} and m.recipient_id = ${otherId})
          or (m.sender_id = ${otherId} and m.recipient_id = ${user.uid})
        order by m.created_at desc limit 100
      `;
      return res.status(200).json({ messages: rows.reverse() });
    }

    if (req.method === 'POST' && action === 'drive-init') {
      if (!requireUser(user, res)) return;
      const { googleToken, title, description = '', mimeType, sizeBytes } = req.body || {};
      const size = Number(sizeBytes);
      if (typeof googleToken !== 'string' || googleToken.length > 4096 || !title || typeof title !== 'string' || title.trim().length > 160 || !mimeType || !mimeType.startsWith('video/')) {
        return res.status(400).json({ error: 'Video upload details sahi nahi hain.' });
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VIDEO_BYTES) {
        return res.status(400).json({ error: 'Video 2 GB se chhoti honi chahiye.' });
      }
      const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + googleToken,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(size),
        },
        body: JSON.stringify({ name: title.trim(), mimeType, description: String(description).slice(0, 2000) }),
      });
      if (!response.ok) return res.status(502).json({ error: 'Google Drive upload session start nahi kar paaya.' });
      const uploadUrl = response.headers.get('location');
      if (!uploadUrl) return res.status(502).json({ error: 'Google Drive ne upload session URL nahi diya.' });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ uploadUrl });
    }

    if (req.method === 'GET' && action === 'inbox') {
      if (!requireUser(user, res)) return;
      const rows = await sql`
        select conversation.* from (
          select distinct on (thread.other_id) thread.other_id as "channelId", u.name as "channelName",
            u.avatar_url as "avatarUrl", thread.sender_id as "senderId", thread.message, thread.created_at as "createdAt"
          from (
            select case when sender_id = ${user.uid} then recipient_id else sender_id end as other_id,
              sender_id, message, created_at
            from video_messages where sender_id = ${user.uid} or recipient_id = ${user.uid}
          ) thread join users u on u.id = thread.other_id
          where exists(select 1 from video_follows where user_id = thread.other_id and channel_id = ${user.uid})
            or exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = thread.other_id)
          order by thread.other_id, thread.created_at desc
        ) conversation
        order by conversation."createdAt" desc limit 50
      `;
      return res.status(200).json({ conversations: rows });
    }

    if (req.method === 'POST' && action === 'publish') {
      if (!requireUser(user, res)) return;
      const { title, description = '', driveFileId, mimeType, sizeBytes, googleToken } = req.body || {};
      const size = Number(sizeBytes);
      if (!title || typeof title !== 'string' || title.trim().length > 160 || !driveFileId || !mimeType || !mimeType.startsWith('video/') || typeof googleToken !== 'string' || googleToken.length > 4096) {
        return res.status(400).json({ error: 'Video ka title ya file info sahi nahi hai.' });
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VIDEO_BYTES) {
        return res.status(400).json({ error: 'Video 2 GB se chhoti honi chahiye.' });
      }
      const driveFile = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(String(driveFileId)) + '?fields=id,mimeType,size,ownedByMe', {
        headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!driveFile.ok) return res.status(403).json({ error: 'Google Drive video verify nahi kar paaya.' });
      const verifiedFile = await driveFile.json();
      if (!verifiedFile.ownedByMe || verifiedFile.mimeType !== mimeType || Number(verifiedFile.size) !== size) {
        return res.status(403).json({ error: 'Video aapke Google Drive ki verified file nahi hai.' });
      }
      const rows = await sql`
        insert into videos (user_id, title, description, drive_file_id, mime_type, size_bytes)
        values (${user.uid}, ${title.trim()}, ${String(description).slice(0, 2000)}, ${driveFileId}, ${mimeType}, ${size})
        returning id, title, description, drive_file_id as "driveFileId", mime_type as "mimeType",
          size_bytes as "sizeBytes", view_count as "viewCount", created_at as "createdAt"
      `;
      return res.status(201).json({ video: rows[0] });
    }

    if (req.method === 'POST' && action === 'follow') {
      if (!requireUser(user, res)) return;
      const channelId = String(req.body.channelId || '');
      if (channelId === user.uid) return res.status(400).json({ error: 'Apne channel ko follow nahi kar sakte.' });
      await sql`insert into video_follows (user_id, channel_id) values (${user.uid}, ${channelId}) on conflict do nothing`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'unfollow') {
      if (!requireUser(user, res)) return;
      await sql`delete from video_follows where user_id = ${user.uid} and channel_id = ${String(req.body.channelId || '')}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'message') {
      if (!requireUser(user, res)) return;
      const recipientId = String(req.body.recipientId || '');
      const message = String(req.body.message || '').trim();
      if (recipientId === user.uid || !message || message.length > 2000) {
        return res.status(400).json({ error: 'Message 1 se 2000 characters ka hona chahiye.' });
      }
      const follows = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${recipientId})
          or exists(select 1 from video_follows where user_id = ${recipientId} and channel_id = ${user.uid})
      `;
      if (!follows.length) return res.status(403).json({ error: 'Message karne se pehle channel follow karein.' });
      const recipients = await sql`select id from users where id = ${recipientId}`;
      if (!recipients.length) return res.status(404).json({ error: 'Channel nahi mila.' });
      const rows = await sql`
        insert into video_messages (sender_id, recipient_id, message)
        values (${user.uid}, ${recipientId}, ${message})
        returning id, sender_id as "senderId", recipient_id as "recipientId", message, created_at as "createdAt"
      `;
      return res.status(201).json({ message: rows[0] });
    }

    if (req.method === 'POST' && action === 'view') {
      const rows = await sql`update videos set view_count = view_count + 1 where id = ${String(req.body.videoId || '')} returning view_count as "viewCount"`;
      return res.status(rows.length ? 200 : 404).json(rows.length ? { viewCount: rows[0].viewCount } : { error: 'Video nahi mila.' });
    }

    if (req.method === 'DELETE' && action === 'delete') {
      if (!requireUser(user, res)) return;
      const rows = await sql`delete from videos where id = ${String(req.query.id || '')} and user_id = ${user.uid} returning id`;
      return res.status(rows.length ? 200 : 404).json(rows.length ? { ok: true } : { error: 'Video nahi mila ya aap owner nahi hain.' });
    }

    return res.status(405).json({ error: 'Method ya action valid nahi hai.' });
  } catch (err) {
    console.error('Videos API error:', err);
    return res.status(500).json({ error: 'Video request poori nahi ho paayi.' });
  }
}
