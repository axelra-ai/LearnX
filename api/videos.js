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
      const url = 'https://drive.google.com/uc?export=view&id=' + encodeURIComponent(driveFileId);
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
      const conversation = await sql`
        select id, drive_folder_id as "driveFolderId" from video_conversations
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

    if (req.method === 'GET' && action === 'inbox') {
      if (!requireUser(user, res)) return;
      const inboxLimit = req.query.all === '1' ? 10000 : 500;
      const driveRows = await sql`
        select c.id as "conversationId", c.drive_folder_id as "driveFolderId",
          case when c.participant_one_id = ${user.uid} then c.participant_two_id else c.participant_one_id end as "channelId",
          u.name as "channelName", u.email as "channelEmail", u.avatar_url as "avatarUrl", null::uuid as "senderId",
          'Open to view messages'::text as message, c.updated_at as "createdAt",
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
      return res.status(410).json({ error: 'Chat storage Drive par move ho gaya hai. Page refresh karke dobara try karein.' });
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
      await sql`delete from video_messages where (sender_id = ${user.uid} and recipient_id = ${otherId}) or (sender_id = ${otherId} and recipient_id = ${user.uid})`;
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'POST' && action === 'conversation-activity') {
      if (!requireUser(user, res)) return;
      const conversationId = String((req.body && req.body.conversationId) || '');
      const rows = await sql`
        update video_conversations set updated_at = now()
        where id = ${conversationId} and (participant_one_id = ${user.uid} or participant_two_id = ${user.uid})
        returning id
      `;
      return res.status(rows.length ? 200 : 404).json(rows.length ? { ok: true } : { error: 'Conversation nahi mila.' });
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
      await sql`update video_conversations set updated_at = now() where id = ${conversations[0].id}`;
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
