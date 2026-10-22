import { sql } from '../lib/db.js';
import { getUserFromReq } from '../lib/auth.js';
import { streamDriveFile, readActivity, toggleLike, addComment, deleteComment } from '../lib/driveStore.js';

// Push optional hai: file/package/keys na hon to bhi videos aur chats chalte rehne chahiye.
async function loadPush() {
  try { return await import('../lib/push.js'); }
  catch (err) { console.error('push.js load nahi hui:', err && err.message); return null; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REEL_BYTES = 500 * 1024 * 1024;
const MAX_POST_BYTES = 10 * 1024 * 1024;
const SCHEMA_HINT = 'Supabase me latest schema.sql run karein (reels/likes/comments tables missing hain).';


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
    // Legacy profile photos remain until users replace or remove them.
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
      const { driveFileId, googleToken } = req.body || {};
      if (typeof driveFileId !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(driveFileId) || typeof googleToken !== 'string' || googleToken.length > 4096) {
        return res.status(400).json({ error: 'Google Drive photo details sahi nahi hain.' });
      }
      const response = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFileId) + '?fields=id,mimeType,size,ownedByMe,permissions(type,role)', {
        headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!response.ok) return res.status(403).json({ error: 'Google Drive photo verify nahi ho paayi.' });
      const file = await response.json();
      const publicImage = (file.permissions || []).some(permission => permission.type === 'anyone' && permission.role === 'reader');
      if (!file.ownedByMe || file.mimeType !== 'image/jpeg' || Number(file.size) > 90 * 1024 || !publicImage) {
        return res.status(403).json({ error: 'Photo aapki Drive ki public JPEG file nahi hai.' });
      }
      const url = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(driveFileId) + '&sz=w256';
      await sql`update users set avatar_data = null, avatar_url = ${url} where id = ${user.uid}`;
      return res.status(200).json({ avatarUrl: url });
    }

    if (req.method === 'POST' && action === 'remove-avatar') {
      if (!requireUser(user, res)) return;
      await sql`update users set avatar_data = null, avatar_url = null where id = ${user.uid}`;
      return res.status(200).json({ avatarUrl: '' });
    }

    if (req.method === 'POST' && action === 'presence') {
      if (!requireUser(user, res)) return;
      const online = !(req.body && req.body.online === false);
      await sql`
        insert into video_presence (user_id, last_seen, typing_to, typing_until)
        values (${user.uid}, ${online ? new Date() : new Date(Date.now() - 60000)}, null, null)
        on conflict (user_id) do update set
          last_seen = excluded.last_seen, typing_to = null, typing_until = null
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && action === 'feed') {
      const kind = req.query.kind === 'reel' ? 'reel' : req.query.kind === 'post' ? 'post' : 'video';
      const trending = req.query.sort === 'trending';
      if (kind === 'reel' || kind === 'post') {
        // Reels: likes/comments ke counts ke saath. Schema run na hui ho to 503 + hint.
        try {
          const rows = await sql`
            select v.id, v.user_id as "channelId", v.title, v.description,
              v.drive_file_id as "driveFileId", v.thumbnail_file_id as "thumbnailFileId", v.mime_type as "mimeType",
              v.size_bytes as "sizeBytes", v.view_count as "viewCount", v.created_at as "createdAt", v.kind,
              u.name as "channelName", u.avatar_url as "avatarUrl",
              (select count(*)::int from video_likes l where l.video_id = v.id) as "likeCount",
              (select count(*)::int from video_comments c where c.video_id = v.id) as "commentCount",
              exists(select 1 from video_likes l where l.video_id = v.id and l.user_id = ${user ? user.uid : null}) as "likedByMe"
            from videos v join users u on u.id = v.user_id
            where v.kind = ${kind}
            order by case when ${trending} then v.view_count end desc, v.created_at desc limit 40
          `;
          return res.status(200).json({ videos: rows });
        } catch (err) {
          if (err && (err.code === '42703' || err.code === '42P01')) return res.status(503).json({ error: SCHEMA_HINT });
          throw err;
        }
      }
      const longQuery = async (withKind) => withKind
        ? sql`
            select v.id, v.user_id as "channelId", v.title, v.description,
              v.drive_file_id as "driveFileId", v.thumbnail_file_id as "thumbnailFileId", v.mime_type as "mimeType",
              v.size_bytes as "sizeBytes", v.view_count as "viewCount", v.created_at as "createdAt",
              u.name as "channelName", u.avatar_url as "avatarUrl"
            from videos v join users u on u.id = v.user_id
            where v.kind = 'video'
            order by case when ${trending} then v.view_count end desc, v.created_at desc limit 40
          `
        : sql`
            select v.id, v.user_id as "channelId", v.title, v.description,
              v.drive_file_id as "driveFileId", v.thumbnail_file_id as "thumbnailFileId", v.mime_type as "mimeType",
              v.size_bytes as "sizeBytes", v.view_count as "viewCount", v.created_at as "createdAt",
              u.name as "channelName", u.avatar_url as "avatarUrl"
            from videos v join users u on u.id = v.user_id
            order by case when ${trending} then v.view_count end desc, v.created_at desc limit 40
          `;
      let rows;
      try { rows = await longQuery(true); }
      catch (err) { if (err && err.code === '42703') rows = await longQuery(false); else throw err; } // schema abhi run nahi hui to purana behaviour
      return res.status(200).json({ videos: rows });
    }

    if (req.method === 'GET' && action === 'channels') {
      const query = String(req.query.q || '').trim().slice(0, 80);
      // Bina search ke users ki list nahi dete (koi bhi kisi ko dhundkar message na kar sake). Kam se kam 2 akshar chahiye.
      if (query.length < 2) return res.status(200).json({ channels: [] });
      const rows = await sql`
            select u.id, u.name, u.avatar_url as "avatarUrl",
              count(v.id)::int as "videoCount", coalesce(sum(v.view_count), 0)::bigint as "viewCount"
            from users u left join videos v on v.user_id = u.id
            where u.name ilike ${'%' + query.replace(/[\\%_]/g, '\\$&') + '%'}
            group by u.id order by count(v.id) desc, u.name asc limit 20
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
          drive_file_id as "driveFileId", thumbnail_file_id as "thumbnailFileId", mime_type as "mimeType", size_bytes as "sizeBytes",
          view_count as "viewCount", created_at as "createdAt", coalesce(to_jsonb(videos)->>'kind', 'video') as "kind"
        from videos where user_id = ${channelId} and coalesce(to_jsonb(videos)->>'kind', 'video') <> 'post' order by created_at desc limit 60
      `;
      return res.status(200).json({ channel: channels[0], videos });
    }

    if (req.method === 'GET' && action === 'mine') {
      if (!requireUser(user, res)) return;
      const rows = await sql`
        select id, user_id as "channelId", title, description, drive_file_id as "driveFileId",
          thumbnail_file_id as "thumbnailFileId", mime_type as "mimeType", size_bytes as "sizeBytes",
          view_count as "viewCount", created_at as "createdAt", coalesce(to_jsonb(videos)->>'kind', 'video') as "kind"
        from videos where user_id = ${user.uid} and coalesce(to_jsonb(videos)->>'kind', 'video') <> 'post' order by created_at desc
      `;
      return res.status(200).json({ videos: rows });
    }

    if (req.method === 'POST' && action === 'conversation') {
      if (!requireUser(user, res)) return;
      const otherId = String((req.body && req.body.otherId) || '');
      const driveFolderId = String((req.body && req.body.driveFolderId) || '');
      const googleToken = String((req.body && req.body.googleToken) || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid || !/^[a-zA-Z0-9_-]{10,200}$/.test(driveFolderId) || !googleToken || googleToken.length > 4096) {
        return res.status(400).json({ error: 'Conversation ya Drive details valid nahi hain.' });
      }
      const pair = [user.uid, otherId].sort();
      const existing = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      if (existing.length) return res.status(200).json({ conversationId: existing[0].id, driveFolderId: existing[0].driveFolderId, existing: true });
      const relationship = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${otherId})
          or exists(select 1 from video_follows where user_id = ${otherId} and channel_id = ${user.uid})
      `;
      if (!relationship.length) return res.status(403).json({ error: 'Chat ke liye channel follow hona chahiye.' });
      const people = await sql`select id, email from users where id in (${user.uid}, ${otherId})`;
      const other = people.find(person => person.id === otherId);
      if (!other) return res.status(404).json({ error: 'Chat user nahi mila.' });
      const driveResponse = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFolderId) + '?fields=id,mimeType,ownedByMe,permissions(type,role,emailAddress)', {
        headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!driveResponse.ok) return res.status(403).json({ error: 'Drive folder verify nahi ho paaya.' });
      const folder = await driveResponse.json();
      const partnerCanEdit = (folder.permissions || []).some(permission =>
        permission.emailAddress && permission.emailAddress.toLowerCase() === other.email.toLowerCase() && ['writer', 'fileOrganizer', 'organizer'].includes(permission.role)
      );
      if (!folder.ownedByMe || folder.mimeType !== 'application/vnd.google-apps.folder' || !partnerCanEdit) {
        return res.status(403).json({ error: 'Folder aapka hona chahiye aur chat partner ko edit access dena zaroori hai.' });
      }
      const inserted = await sql`
        insert into video_conversations (participant_one_id, participant_two_id, drive_folder_id)
        values (${pair[0]}, ${pair[1]}, ${driveFolderId})
        on conflict (participant_one_id, participant_two_id) do nothing
        returning id, drive_folder_id as "driveFolderId"
      `;
      if (inserted.length) return res.status(201).json({ conversationId: inserted[0].id, driveFolderId: inserted[0].driveFolderId, existing: false });
      const winner = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      return res.status(200).json({ conversationId: winner[0].id, driveFolderId: winner[0].driveFolderId, existing: true });
    }

    if (req.method === 'GET' && action === 'messages') {
      if (!requireUser(user, res)) return;
      const otherId = String(req.query.with || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid) return res.status(400).json({ error: 'Chat user valid nahi hai.' });
      const relationship = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${otherId})
          or exists(select 1 from video_follows where user_id = ${otherId} and channel_id = ${user.uid})
      `;
      if (!relationship.length) return res.status(403).json({ error: 'Is chat ke liye channel follow hona chahiye.' });
      const peerRows = await sql`select email from users where id = ${otherId} limit 1`;
      const pair = [user.uid, otherId].sort();
      // conversationId bhi bhejo: frontend isi se preview/read-receipt/activity update karta hai.
      const conversation = await sql`
        select id, id as "conversationId", drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const totalRows = await sql`
        select count(*)::int as total from video_messages
        where (sender_id = ${user.uid} and recipient_id = ${otherId}) or (sender_id = ${otherId} and recipient_id = ${user.uid})
      `;
      if (conversation.length && totalRows[0].total === 0) {
        return res.status(200).json(Object.assign(conversation[0], {
          otherEmail: peerRows[0] && peerRows[0].email || '', messages: [], legacy: false, legacyCount: 0, offset,
        }));
      }
      const rows = await sql`
        select m.id, m.sender_id as "senderId", m.recipient_id as "recipientId",
          m.message, m.created_at as "createdAt", u.name as "senderName"
        from video_messages m join users u on u.id = m.sender_id
        where (m.sender_id = ${user.uid} and m.recipient_id = ${otherId})
          or (m.sender_id = ${otherId} and m.recipient_id = ${user.uid})
        order by case when ${req.query.offset !== undefined} then m.created_at end asc,
          case when ${req.query.offset === undefined} then m.created_at end desc, m.id
        limit 100 offset ${offset}
      `;
      return res.status(200).json(Object.assign(conversation[0] || {}, {
        otherEmail: peerRows[0] && peerRows[0].email || '',
        messages: req.query.offset === undefined ? rows.reverse() : rows,
        legacy: !conversation.length, legacyCount: totalRows[0].total, offset,
      }));
    }

    if (req.method === 'GET' && action === 'presence') {
      if (!requireUser(user, res)) return;
      const otherId = String(req.query.with || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid) return res.status(400).json({ error: 'Chat user valid nahi hai.' });
      const relationship = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${otherId})
          or exists(select 1 from video_follows where user_id = ${otherId} and channel_id = ${user.uid})
      `;
      if (!relationship.length) return res.status(403).json({ error: 'Is chat ke liye channel follow hona chahiye.' });
      const rows = await sql`
        select
          coalesce(last_seen > now() - interval '45 seconds', false) as "isOnline",
          coalesce(typing_to = ${user.uid} and typing_until > now(), false) as "isTyping"
        from video_presence where user_id = ${otherId}
      `;
      return res.status(200).json(rows[0] || { isOnline: false, isTyping: false });
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

    if (req.method === 'POST' && action === 'drive-upload-status') {
      if (!requireUser(user, res)) return;
      const { googleToken, uploadUrl, sizeBytes } = req.body || {};
      const size = Number(sizeBytes);
      let session;
      try { session = new URL(String(uploadUrl || '')); } catch (e) { return res.status(400).json({ error: 'Drive upload session URL invalid hai.' }); }
      if (!['www.googleapis.com', 'upload.googleapis.com'].includes(session.hostname) || !session.pathname.startsWith('/upload/drive/v3/files')) {
        return res.status(400).json({ error: 'Drive upload session URL invalid hai.' });
      }
      if (typeof googleToken !== 'string' || googleToken.length > 4096 || !Number.isSafeInteger(size) || size < 1 || size > MAX_VIDEO_BYTES) {
        return res.status(400).json({ error: 'Drive upload status request invalid hai.' });
      }
      const response = await fetch(session.toString(), {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + googleToken, 'Content-Range': 'bytes */' + size },
        body: '',
      });
      if (response.status === 308) return res.status(200).json({ complete: false, range: response.headers.get('range') || '' });
      if (response.status === 200 || response.status === 201) {
        const file = await response.json();
        return res.status(200).json({ complete: true, file });
      }
      const body = await response.json().catch(() => ({}));
      return res.status(response.status >= 500 ? 502 : response.status).json({ error: body.error && body.error.message || 'Google Drive upload status verify nahi kar paaya.' });
    }

    if (req.method === 'GET' && action === 'inbox') {
      if (!requireUser(user, res)) return;
      const inboxLimit = req.query.all === '1' ? 10000 : 500;
      const driveRows = await sql`
        select c.id as "conversationId", c.drive_folder_id as "driveFolderId",
          case when c.participant_one_id = ${user.uid} then c.participant_two_id else c.participant_one_id end as "channelId",
          u.name as "channelName", u.email as "channelEmail", u.avatar_url as "avatarUrl", c.last_sender_id as "senderId",
          coalesce(c.last_message_preview, 'Open to view messages') as message,
          (c.last_message_preview is null) as "previewMissing", c.updated_at as "createdAt",
          case when c.last_sender_id = ${user.uid} then
            case when c.participant_one_id = ${user.uid} then coalesce(c.last_read_two_at >= c.updated_at, false)
              else coalesce(c.last_read_one_at >= c.updated_at, false) end
            else false end as "isSeen",
          case when c.last_sender_id is null or c.last_sender_id = ${user.uid} then false
            when c.participant_one_id = ${user.uid} then coalesce(c.last_read_one_at < c.updated_at or c.last_read_one_at is null, true)
            else coalesce(c.last_read_two_at < c.updated_at or c.last_read_two_at is null, true) end as "isUnread",
          exists(select 1 from video_presence p where p.user_id = u.id and p.last_seen > now() - interval '45 seconds') as "isOnline",
          exists(select 1 from video_presence p where p.user_id = u.id and p.typing_to = ${user.uid} and p.typing_until > now()) as "isTyping"
        from video_conversations c
        join users u on u.id = case when c.participant_one_id = ${user.uid} then c.participant_two_id else c.participant_one_id end
        where c.participant_one_id = ${user.uid} or c.participant_two_id = ${user.uid}
        order by c.updated_at desc limit ${inboxLimit}
      `;
      const legacyRows = await sql`
        select conversation.* from (
          select distinct on (thread.other_id) thread.other_id as "channelId", u.name as "channelName", u.email as "channelEmail",
            u.avatar_url as "avatarUrl", thread.sender_id as "senderId",
            case when ${req.query.all === '1'} then 'Legacy chat' else thread.message end as message, thread.created_at as "createdAt",
            exists(select 1 from video_presence p where p.user_id = thread.other_id and p.last_seen > now() - interval '45 seconds') as "isOnline",
            exists(select 1 from video_presence p where p.user_id = thread.other_id and p.typing_to = ${user.uid} and p.typing_until > now()) as "isTyping"
          from (
            select case when sender_id = ${user.uid} then recipient_id else sender_id end as other_id,
              sender_id, message, created_at
            from video_messages where sender_id = ${user.uid} or recipient_id = ${user.uid}
          ) thread join users u on u.id = thread.other_id
          where (exists(select 1 from video_follows where user_id = thread.other_id and channel_id = ${user.uid})
            or exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = thread.other_id))
            and not exists(
              select 1 from video_conversations c
              where c.participant_one_id = least(thread.other_id, ${user.uid}::uuid)
                and c.participant_two_id = greatest(thread.other_id, ${user.uid}::uuid)
            )
          order by thread.other_id, thread.created_at desc
        ) conversation limit ${inboxLimit}
      `;
      const conversations = driveRows.concat(legacyRows)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, inboxLimit);
      return res.status(200).json({ conversations });
    }

    if (req.method === 'POST' && action === 'publish') {
      if (!requireUser(user, res)) return;
      const { title, description = '', driveFileId, mimeType, sizeBytes, googleToken, thumbnailFileId } = req.body || {};
      const reqKind = req.body && req.body.kind;
      const kind = reqKind === 'reel' ? 'reel' : reqKind === 'post' ? 'post' : 'video';
      const size = Number(sizeBytes);
      const wantedMime = kind === 'post' ? 'image/' : 'video/';
      if (!title || typeof title !== 'string' || title.trim().length > 160 || !driveFileId || !mimeType || !mimeType.startsWith(wantedMime) || typeof googleToken !== 'string' || googleToken.length > 4096) {
        return res.status(400).json({ error: kind === 'post' ? 'Post ki photo ya details sahi nahi hain.' : 'Video ka title ya file info sahi nahi hai.' });
      }
      if (kind === 'post' && size > MAX_POST_BYTES) return res.status(400).json({ error: 'Post ki photo 10 MB se chhoti honi chahiye.' });
      if (thumbnailFileId && (typeof thumbnailFileId !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(thumbnailFileId))) {
        return res.status(400).json({ error: 'Thumbnail file id sahi nahi hai.' });
      }
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_VIDEO_BYTES) {
        return res.status(400).json({ error: 'Video 2 GB se chhoti honi chahiye.' });
      }
      if (kind === 'reel' && size > MAX_REEL_BYTES) return res.status(400).json({ error: 'Reel 500 MB se chhoti honi chahiye.' });
      const driveFile = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(String(driveFileId)) + '?fields=id,mimeType,size,ownedByMe', {
        headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!driveFile.ok) return res.status(403).json({ error: 'Google Drive video verify nahi kar paaya.' });
      const verifiedFile = await driveFile.json();
      if (!verifiedFile.ownedByMe || verifiedFile.mimeType !== mimeType || Number(verifiedFile.size) !== size) {
        return res.status(403).json({ error: 'Video aapke Google Drive ki verified file nahi hai.' });
      }
      let rows;
      if (kind === 'reel' || kind === 'post') {
        try {
          rows = await sql`
            insert into videos (user_id, title, description, drive_file_id, mime_type, size_bytes, thumbnail_file_id, kind)
            values (${user.uid}, ${title.trim()}, ${String(description).slice(0, 2000)}, ${driveFileId}, ${mimeType}, ${size}, ${thumbnailFileId || null}, ${kind})
            returning id, title, description, drive_file_id as "driveFileId", mime_type as "mimeType",
              size_bytes as "sizeBytes", view_count as "viewCount", created_at as "createdAt", thumbnail_file_id as "thumbnailFileId", kind
          `;
        } catch (err) {
          if (err && err.code === '42703') return res.status(503).json({ error: SCHEMA_HINT });
          throw err;
        }
      } else {
        rows = await sql`
          insert into videos (user_id, title, description, drive_file_id, mime_type, size_bytes, thumbnail_file_id)
          values (${user.uid}, ${title.trim()}, ${String(description).slice(0, 2000)}, ${driveFileId}, ${mimeType}, ${size}, ${thumbnailFileId || null})
          returning id, title, description, drive_file_id as "driveFileId", mime_type as "mimeType",
            size_bytes as "sizeBytes", view_count as "viewCount", created_at as "createdAt", thumbnail_file_id as "thumbnailFileId"
        `;
      }
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

    // Message relay: drive.file permission me har user sirf apni banayi Drive files dekh sakta hai, isliye
    // doosre ke bheje messages restart ke baad gayab ho jaate the. Ab har message ki ek chhoti copy yahan
    // (video_messages) rehti hai; receiver chat kholta hai to wo apni Drive me move ho jaati hai (conversation-migrated).
    // Push notification bhi yahin se jaati hai (app band ho tab bhi).
    if (req.method === 'POST' && action === 'message') {
      if (!requireUser(user, res)) return;
      const { recipientId, message, id } = req.body || {};
      const text = typeof message === 'string' ? message.trim() : '';
      if (!UUID_RE.test(String(recipientId || '')) || recipientId === user.uid || !text || text.length > 2000 || (id && !UUID_RE.test(String(id)))) {
        return res.status(400).json({ error: 'Message details valid nahi hain.' });
      }
      const pair = [user.uid, recipientId].sort();
      const allowed = await sql`
        select 1 where exists(select 1 from video_follows where user_id = ${user.uid} and channel_id = ${recipientId})
          or exists(select 1 from video_follows where user_id = ${recipientId} and channel_id = ${user.uid})
          or exists(select 1 from video_conversations where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]})
      `;
      if (!allowed.length) return res.status(403).json({ error: 'Is chat ke liye channel follow hona chahiye.' });
      const inserted = await sql`
        insert into video_messages (id, sender_id, recipient_id, message)
        values (coalesce(${id || null}::uuid, gen_random_uuid()), ${user.uid}, ${recipientId}, ${text})
        on conflict (id) do nothing
        returning id, created_at as "createdAt"
      `;
      if (!inserted.length) return res.status(200).json({ ok: true, duplicate: true });
      const convo = await sql`
        update video_conversations set last_message_preview = ${text.slice(0, 160)}, last_sender_id = ${user.uid}, updated_at = now()
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]}
        returning id
      `;
      try {
        const who = await sql`select name from users where id = ${user.uid} limit 1`;
        const senderName = (who[0] && who[0].name) || user.name || 'Kisi ne';
        const push = await loadPush();
        if (push) await push.sendPushToUser(recipientId, {
          type: 'chat', title: senderName, body: text.slice(0, 140),
          senderId: user.uid, senderName, conversationId: convo[0] ? convo[0].id : null,
          url: '/?openChat=' + encodeURIComponent(user.uid) + '&name=' + encodeURIComponent(senderName), ts: Date.now(),
        });
      } catch (pushErr) { console.warn('Chat push failed:', pushErr && pushErr.message); }
      return res.status(201).json({ ok: true, id: inserted[0].id, createdAt: inserted[0].createdAt });
    }

    if (req.method === 'POST' && action === 'conversation-migrated') {
      if (!requireUser(user, res)) return;
      const otherId = String((req.body && req.body.otherId) || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid) return res.status(400).json({ error: 'Chat user valid nahi hai.' });
      const pair = [user.uid, otherId].sort();
      const rows = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      if (!rows.length) return res.status(404).json({ error: 'Drive conversation register nahi hui.' });
      const googleToken = String((req.body && req.body.googleToken) || '');
      if (!googleToken || googleToken.length > 4096) return res.status(400).json({ error: 'Drive verification token missing hai.' });
      const legacy = await sql`
        select id, sender_id as "senderId", message, created_at as "createdAt" from video_messages
        where (sender_id = ${user.uid} and recipient_id = ${otherId}) or (sender_id = ${otherId} and recipient_id = ${user.uid})
      `;
      const expected = new Map(legacy.map(message => ['learnx-message-' + message.id + '.json', message]));
      let pageToken = '';
      do {
        const query = "'" + rows[0].driveFolderId.replace(/'/g, "\\'") + "' in parents and trashed = false";
        const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&pageSize=1000&fields=nextPageToken,files(name,description)' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
        const response = await fetch(url, { headers: { Authorization: 'Bearer ' + googleToken } });
        if (!response.ok) return res.status(403).json({ error: 'Drive migration verify nahi ho paayi; database chat safe hai.' });
        const data = await response.json();
        (data.files || []).forEach(file => {
          const original = expected.get(file.name);
          if (!original) return;
          try {
            const saved = JSON.parse(file.description || '{}');
            if (saved.id === original.id && saved.senderId === original.senderId && saved.message === original.message && Date.parse(saved.createdAt) === new Date(original.createdAt).getTime()) expected.delete(file.name);
          } catch (e) {}
        });
        pageToken = data.nextPageToken || '';
      } while (pageToken && expected.size);
      if (expected.size) return res.status(409).json({ error: 'Saare messages Drive me nahi mile; database chat safe rakhi gayi.' });
      const latest = legacy.reduce((newest, message) => !newest || new Date(message.createdAt) > new Date(newest.createdAt) ? message : newest, null);
      if (latest) {
        await sql`
          update video_conversations set last_message_preview = ${String(latest.message).slice(0, 160)},
            last_sender_id = ${latest.senderId}, updated_at = ${latest.createdAt}
          where id = ${rows[0].id}
        `;
      }
      // Sirf wo messages hatao jo mujhe aaye the aur ab meri Drive me verify ho gaye. Meri bheji hui copy tab tak rahegi
      // jab tak samne wala chat khol kar apni Drive me na le le.
      await sql`delete from video_messages where recipient_id = ${user.uid} and id = any(${legacy.map(message => message.id)}::uuid[])`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'conversation-read') {
      if (!requireUser(user, res)) return;
      const conversationId = String((req.body && req.body.conversationId) || '');
      const rows = await sql`
        update video_conversations set
          last_read_one_at = case when participant_one_id = ${user.uid} then now() else last_read_one_at end,
          last_read_two_at = case when participant_two_id = ${user.uid} then now() else last_read_two_at end
        where id = ${conversationId} and (participant_one_id = ${user.uid} or participant_two_id = ${user.uid})
        returning id
      `;
      return res.status(rows.length ? 200 : 404).json(rows.length ? { ok: true } : { error: 'Conversation nahi mila.' });
    }

    if (req.method === 'POST' && action === 'conversation-preview') {
      if (!requireUser(user, res)) return;
      const { conversationId, messagePreview, senderId, messageCreatedAt } = req.body || {};
      if (typeof messagePreview !== 'string' || !messagePreview.trim() || !UUID_RE.test(String(senderId || '')) || !Number.isFinite(Date.parse(messageCreatedAt))) {
        return res.status(400).json({ error: 'Chat preview details valid nahi hain.' });
      }
      const rows = await sql`
        update video_conversations set
          last_message_preview = ${messagePreview.slice(0, 160)}, last_sender_id = ${senderId},
          updated_at = greatest(updated_at, ${new Date(messageCreatedAt)})
        where id = ${String(conversationId || '')}
          and (participant_one_id = ${user.uid} or participant_two_id = ${user.uid})
          and (last_message_preview is null or updated_at < ${new Date(messageCreatedAt)})
        returning id
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'conversation-activity') {
      if (!requireUser(user, res)) return;
      const { conversationId, messagePreview, senderId } = req.body || {};
      if (senderId !== user.uid || typeof messagePreview !== 'string' || !messagePreview.trim() || !UUID_RE.test(String(conversationId || ''))) {
        return res.status(400).json({ error: 'Chat preview details valid nahi hain.' });
      }
      const rows = await sql`
        update video_conversations set updated_at = now(), last_message_preview = ${messagePreview.slice(0, 160)},
          last_sender_id = ${user.uid}
        where id = ${conversationId} and (participant_one_id = ${user.uid} or participant_two_id = ${user.uid})
        returning id
      `;
      if (!rows.length) return res.status(404).json({ error: 'Conversation nahi mila.' });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET' && action === 'push-key') {
      const push = await loadPush();
      return res.status(200).json({ publicKey: push ? await push.pushPublicKey() : '' });
    }

    if (req.method === 'POST' && action === 'push-subscribe') {
      if (!requireUser(user, res)) return;
      const sub = (req.body && req.body.subscription) || {};
      const keys = sub.keys || {};
      let endpoint;
      try { endpoint = new URL(String(sub.endpoint || '')); } catch (e) { endpoint = null; }
      if (!endpoint || endpoint.protocol !== 'https:' || String(sub.endpoint).length > 1000 ||
          typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
        return res.status(400).json({ error: 'Push subscription valid nahi hai.' });
      }
      await sql`
        insert into push_subscriptions (endpoint, user_id, p256dh, auth)
        values (${String(sub.endpoint)}, ${user.uid}, ${keys.p256dh}, ${keys.auth})
        on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth
      `;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'push-test') {
      if (!requireUser(user, res)) return;
      const push = await loadPush();
      if (!push) return res.status(200).json({ ok: false, reason: 'module' });
      const status = await push.pushStatus();
      if (!status.packageLoaded) return res.status(200).json({ ok: false, reason: 'package' });
      if (!status.hasKeys) return res.status(200).json({ ok: false, reason: 'keys' });
      const result = await push.sendPushToUser(user.uid, { type: 'test', title: 'LearnX', body: 'Test notification aa gayi: push sahi chal raha hai', url: '/', ts: Date.now() });
      return res.status(200).json({ ok: result.sent > 0, sent: result.sent, reason: result.skipped || (result.sent > 0 ? 'sent' : 'failed') });
    }

    if (req.method === 'POST' && action === 'push-unsubscribe') {
      if (!requireUser(user, res)) return;
      const endpoint = String((req.body && req.body.endpoint) || '');
      await sql`delete from push_subscriptions where user_id = ${user.uid} and endpoint = ${endpoint}`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'message') {
      if (!requireUser(user, res)) return;
      const otherId = String(req.query.with || ''), messageId = String(req.query.id || ''), driveFileId = String(req.query.file || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid || !UUID_RE.test(messageId) || !/^[a-zA-Z0-9_-]{10,200}$/.test(driveFileId)) {
        return res.status(400).json({ error: 'Message delete details valid nahi hain.' });
      }
      const pair = [user.uid, otherId].sort();
      const conversations = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      if (!conversations.length) return res.status(404).json({ error: 'Drive conversation nahi mili.' });
      const googleToken = String(req.headers['x-google-drive-token'] || '');
      if (!googleToken || googleToken.length > 4096) return res.status(401).json({ error: 'Drive permission chahiye.' });
      const fileResponse = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFileId) + '?fields=id,name,parents', {
        headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!fileResponse.ok) return res.status(403).json({ error: 'Drive message verify nahi ho paaya.' });
      const file = await fileResponse.json();
      if (file.name !== 'learnx-message-' + messageId + '.json' || !(file.parents || []).includes(conversations[0].driveFolderId)) {
        return res.status(403).json({ error: 'Ye file is conversation ka message nahi hai.' });
      }
      const removed = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(driveFileId), {
        method: 'DELETE', headers: { Authorization: 'Bearer ' + googleToken },
      });
      if (!removed.ok && removed.status !== 404) return res.status(502).json({ error: 'Drive message delete nahi ho paaya.' });

      const folderUrl = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent("'" + String(conversations[0].driveFolderId).replace(/'/g, "\\'") + "' in parents and trashed = false") + '&pageSize=1000&fields=nextPageToken,files(id,description,createdTime)';
      const remainingResponse = await fetch(folderUrl, { headers: { Authorization: 'Bearer ' + googleToken } });
      if (!remainingResponse.ok) {
        await sql`update video_conversations set updated_at = now(), last_message_preview = null, last_sender_id = null where id = ${conversations[0].id}`;
        return res.status(200).json({ ok: true });
      }
      const remainingData = await remainingResponse.json();
      const remaining = (remainingData.files || []).map(file => {
        try {
          const payload = JSON.parse(file.description || '{}');
          const createdAt = payload.createdAt || file.createdTime || new Date().toISOString();
          if (!payload.message || !payload.id || payload.id === messageId) return null;
          return { id: payload.id, senderId: payload.senderId, message: String(payload.message || ''), createdAt };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      if (remaining.length) {
        const latest = remaining.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)).at(-1);
        await sql`
          update video_conversations set
            updated_at = ${new Date(latest.createdAt)},
            last_message_preview = ${String(latest.message).slice(0, 160)},
            last_sender_id = ${latest.senderId || null}
          where id = ${conversations[0].id}
        `;
      } else {
        await sql`update video_conversations set updated_at = now(), last_message_preview = null, last_sender_id = null where id = ${conversations[0].id}`;
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE' && action === 'conversation') {
      if (!requireUser(user, res)) return;
      const otherId = String(req.query.with || '');
      if (!UUID_RE.test(otherId) || otherId === user.uid) return res.status(400).json({ error: 'Chat user valid nahi hai.' });
      const pair = [user.uid, otherId].sort();
      const conversations = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
        where participant_one_id = ${pair[0]} and participant_two_id = ${pair[1]} limit 1
      `;
      if (conversations.length) {
        const googleToken = String(req.headers['x-google-drive-token'] || '');
        if (!googleToken || googleToken.length > 4096) return res.status(401).json({ error: 'Drive permission chahiye taaki chat files delete ho sakein.' });
        const folderId = conversations[0].driveFolderId;
        const files = [];
        let pageToken = '';
        do {
          const query = "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false";
          const url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(query) + '&pageSize=1000&fields=nextPageToken,files(id)&supportsAllDrives=true' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
          const listed = await fetch(url, { headers: { Authorization: 'Bearer ' + googleToken } });
          if (!listed.ok) return res.status(502).json({ error: 'Drive chat files ki list nahi mil paayi; chat database me safe hai.' });
          const data = await listed.json();
          files.push(...(data.files || []).map(file => file.id));
          pageToken = data.nextPageToken || '';
        } while (pageToken);
        for (let offset = 0; offset < files.length; offset += 10) {
          const removed = await Promise.all(files.slice(offset, offset + 10).map(fileId =>
            fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?supportsAllDrives=true', {
              method: 'DELETE', headers: { Authorization: 'Bearer ' + googleToken },
            })
          ));
          if (removed.some(response => !response.ok && response.status !== 404)) {
            return res.status(502).json({ error: 'Kuch Drive messages delete nahi hue; database reference safe rakha hai.' });
          }
        }
        const folderDelete = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) + '?supportsAllDrives=true', {
          method: 'DELETE', headers: { Authorization: 'Bearer ' + googleToken },
        });
        if (!folderDelete.ok && folderDelete.status !== 404 && folderDelete.status !== 403) {
          return res.status(502).json({ error: 'Drive chat folder delete nahi hua.' });
        }
        await sql`delete from video_conversations where id = ${conversations[0].id}`;
      }
      await sql`delete from video_messages where (sender_id = ${user.uid} and recipient_id = ${otherId}) or (sender_id = ${otherId} and recipient_id = ${user.uid})`;
      return res.status(200).json({ ok: true });
    }

    // ===== Origin Play: video stream (Range support) =====
    // Player pehle isi endpoint se video chalata hai. Drive iframe ab use nahi hota.
    if ((req.method === 'GET' || req.method === 'HEAD') && action === 'stream') {
      return await streamDriveFile(req, res, String(req.query.id || ''));
    }

    // ===== Origin Play: likes + comments (video ke owner ke Google Drive me save) =====
    if (action === 'activity' || action === 'activity-like' || action === 'activity-comment' || action === 'activity-comment-delete') {
      const videoId = String((req.method === 'GET' || req.method === 'DELETE' ? req.query.videoId : req.body && req.body.videoId) || '');
      if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'Video valid nahi hai.' });
      const owner = await sql`select user_id as "ownerId", title from videos where id = ${videoId} limit 1`;
      if (!owner.length) return res.status(404).json({ error: 'Video nahi mila.' });
      const ownerId = owner[0].ownerId;
      const NO_DRIVE = 'Is video ke creator ka Google Drive connected nahi hai, isliye like/comment abhi save nahi ho sakta.';
      try {
        if (req.method === 'GET' && action === 'activity') {
          try {
            const data = await readActivity(ownerId, videoId, user ? user.uid : null);
            return res.status(200).json(Object.assign({ ownerId, driveReady: true }, data));
          } catch (err) {
            if (err && err.code === 'NO_DRIVE') return res.status(200).json({ ownerId, driveReady: false, likeCount: 0, likedByMe: false, comments: [], commentCount: 0 });
            throw err;
          }
        }

        if (req.method === 'POST' && action === 'activity-like') {
          if (!requireUser(user, res)) return;
          const result = await toggleLike(ownerId, videoId, user.uid);
          return res.status(200).json(result);
        }

        if (req.method === 'POST' && action === 'activity-comment') {
          if (!requireUser(user, res)) return;
          const body = String((req.body && req.body.body) || '').trim();
          if (!body || body.length > 500) return res.status(400).json({ error: 'Comment 1 se 500 akshar ka hona chahiye.' });
          // Simple spam rok (server instance ke hisaab se): 30 second me max 6 comments
          global.__lxCommentHits = global.__lxCommentHits || new Map();
          const now = Date.now();
          const hits = (global.__lxCommentHits.get(user.uid) || []).filter(t => now - t < 30000);
          if (hits.length >= 6) return res.status(429).json({ error: 'Thoda ruk kar comment karein.' });
          hits.push(now); global.__lxCommentHits.set(user.uid, hits);
          const me = await sql`select name, avatar_url as "avatarUrl" from users where id = ${user.uid} limit 1`;
          const comment = await addComment(ownerId, videoId, { uid: user.uid, name: me[0] ? me[0].name : '', avatarUrl: me[0] ? me[0].avatarUrl : null }, body);
          try {
            if (ownerId !== user.uid) {
              const push = await loadPush();
              if (push) await push.sendPushToUser(ownerId, {
                type: 'comment', title: (comment.name || 'Kisi ne') + ' ne comment kiya', body: body.slice(0, 140),
                senderId: user.uid, url: '/', ts: Date.now(),
              });
            }
          } catch (pushErr) { console.warn('Comment push failed:', pushErr && pushErr.message); }
          return res.status(201).json({ comment });
        }

        if (req.method === 'DELETE' && action === 'activity-comment-delete') {
          if (!requireUser(user, res)) return;
          const result = await deleteComment(ownerId, videoId, String(req.query.id || ''), user.uid);
          if (!result.ok) return res.status(result.status || 400).json({ error: result.status === 403 ? 'Aap ye comment delete nahi kar sakte.' : 'Comment nahi mila.' });
          return res.status(200).json({ ok: true });
        }
      } catch (err) {
        if (err && err.code === 'NO_DRIVE') return res.status(503).json({ error: NO_DRIVE });
        throw err;
      }
      return res.status(405).json({ error: 'Method ya action valid nahi hai.' });
    }

    // ===== Reels: like / comments =====
    if (req.method === 'POST' && action === 'like') {
      if (!requireUser(user, res)) return;
      const videoId = String((req.body && req.body.videoId) || '');
      if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'Video valid nahi hai.' });
      try {
        const removed = await sql`delete from video_likes where video_id = ${videoId} and user_id = ${user.uid} returning video_id`;
        let liked = false;
        if (!removed.length) {
          await sql`insert into video_likes (video_id, user_id) values (${videoId}, ${user.uid}) on conflict do nothing`;
          liked = true;
        }
        const count = await sql`select count(*)::int as n from video_likes where video_id = ${videoId}`;
        return res.status(200).json({ liked, likeCount: count[0].n });
      } catch (err) {
        if (err && err.code === '23503') return res.status(404).json({ error: 'Video nahi mila.' });
        if (err && err.code === '42P01') return res.status(503).json({ error: SCHEMA_HINT });
        throw err;
      }
    }

    if (req.method === 'GET' && action === 'comments') {
      if (!requireUser(user, res)) return;
      const videoId = String(req.query.videoId || '');
      if (!UUID_RE.test(videoId)) return res.status(400).json({ error: 'Video valid nahi hai.' });
      try {
        const rows = await sql`
          select c.id, c.user_id as "userId", u.name, u.avatar_url as "avatarUrl", c.body, c.created_at as "createdAt"
          from video_comments c join users u on u.id = c.user_id
          where c.video_id = ${videoId} order by c.created_at desc limit 100
        `;
        const owner = await sql`select user_id as "ownerId" from videos where id = ${videoId} limit 1`;
        return res.status(200).json({ comments: rows, ownerId: owner[0] ? owner[0].ownerId : null });
      } catch (err) {
        if (err && err.code === '42P01') return res.status(503).json({ error: SCHEMA_HINT });
        throw err;
      }
    }

    if (req.method === 'POST' && action === 'comment') {
      if (!requireUser(user, res)) return;
      const videoId = String((req.body && req.body.videoId) || '');
      const body = String((req.body && req.body.body) || '').trim();
      if (!UUID_RE.test(videoId) || !body || body.length > 500) return res.status(400).json({ error: 'Comment 1 se 500 akshar ka hona chahiye.' });
      try {
        const recent = await sql`select count(*)::int as n from video_comments where user_id = ${user.uid} and created_at > now() - interval '30 seconds'`;
        if (recent[0].n >= 6) return res.status(429).json({ error: 'Thoda ruk kar comment karein.' });
        const rows = await sql`
          insert into video_comments (video_id, user_id, body) values (${videoId}, ${user.uid}, ${body})
          returning id, user_id as "userId", body, created_at as "createdAt"
        `;
        const me = await sql`select name, avatar_url as "avatarUrl" from users where id = ${user.uid} limit 1`;
        const comment = Object.assign({}, rows[0], { name: me[0] ? me[0].name : '', avatarUrl: me[0] ? me[0].avatarUrl : null });
        const count = await sql`select count(*)::int as n from video_comments where video_id = ${videoId}`;
        // Reel ke owner ko notification (khud ki reel par nahi). Fail hone par comment save rehta hai.
        try {
          const owner = await sql`select user_id as "ownerId", title from videos where id = ${videoId} limit 1`;
          if (owner[0] && owner[0].ownerId !== user.uid) {
            const push = await loadPush();
            if (push) await push.sendPushToUser(owner[0].ownerId, {
              type: 'comment', title: (comment.name || 'Kisi ne') + ' ne comment kiya', body: body.slice(0, 140),
              senderId: user.uid, url: '/', ts: Date.now(),
            });
          }
        } catch (pushErr) { console.warn('Comment push failed:', pushErr && pushErr.message); }
        return res.status(201).json({ comment, commentCount: count[0].n });
      } catch (err) {
        if (err && err.code === '23503') return res.status(404).json({ error: 'Video nahi mila.' });
        if (err && err.code === '42P01') return res.status(503).json({ error: SCHEMA_HINT });
        throw err;
      }
    }

    if (req.method === 'DELETE' && action === 'comment') {
      if (!requireUser(user, res)) return;
      const id = String(req.query.id || '');
      if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Comment valid nahi hai.' });
      // Comment likhne wala ya reel ka owner delete kar sakta hai.
      const rows = await sql`
        delete from video_comments c using videos v
        where c.id = ${id} and v.id = c.video_id and (c.user_id = ${user.uid} or v.user_id = ${user.uid})
        returning c.video_id as "videoId"
      `;
      if (!rows.length) return res.status(404).json({ error: 'Comment nahi mila ya aap delete nahi kar sakte.' });
      const count = await sql`select count(*)::int as n from video_comments where video_id = ${rows[0].videoId}`;
      return res.status(200).json({ ok: true, commentCount: count[0].n });
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
    console.error('Videos API error:', action, err && err.message, err);
    return res.status(500).json({ error: 'Video request poori nahi ho paayi.' });
  }
}
