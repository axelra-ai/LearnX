// api/admin/import-playlist.js
// Ek YouTube playlist ka URL doge, ye uski saari videos fetch karke
// automatically lessons bana deta hai (title + duration + video, sab
// YouTube se hi aata hai, kuch type nahi karna).

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

const YOUTUBE_API_REFERER = process.env.YOUTUBE_API_REFERER || 'https://learnxtech.vercel.app/';

function extractPlaylistId(url) {
  const m = String(url || '').match(/[?&]list=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (/^[a-zA-Z0-9_-]{10,}$/.test(url) ? url : null);
}

// "PT1H10M30S" jaisa ISO 8601 duration ko "1h 10m" jaisa readable banata hai
function formatDuration(iso) {
  const m = String(iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return '';
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const sec = parseInt(m[3] || '0', 10);
  if (h > 0) return `${h}h ${min}m`;
  if (min > 0) return `${min} min${sec > 30 ? '+' : ''}`;
  return `${sec} sec`;
}

async function fetchAllPlaylistVideos(playlistId, apiKey) {
  let videos = [];
  let pageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fetch(url, { headers: { Referer: YOUTUBE_API_REFERER } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'YouTube API error');
    for (const item of data.items || []) {
      const videoId = item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title;
      if (videoId && title && title !== 'Deleted video' && title !== 'Private video') {
        videos.push({ videoId, title, position: item.snippet.position ?? videos.length });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return videos;
}

async function fetchDurations(videoIds, apiKey) {
  const durations = {};
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${batch.join(',')}&key=${apiKey}`;
    const res = await fetch(url, { headers: { Referer: YOUTUBE_API_REFERER } });
    const data = await res.json();
    if (!res.ok) continue;
    for (const item of data.items || []) {
      durations[item.id] = formatDuration(item.contentDetails?.duration);
    }
  }
  return durations;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YOUTUBE_API_KEY set nahi hai Vercel environment variables me.' });
  }

  try {
    const { courseId, levelId, moduleTitle, playlistUrl } = req.body || {};
    if (!courseId || !playlistUrl) return res.status(400).json({ error: 'courseId aur playlistUrl zaroori hai.' });

    const playlistId = extractPlaylistId(playlistUrl);
    if (!playlistId) return res.status(400).json({ error: 'Playlist URL me se ID nahi mila. Poora playlist link paste karo.' });

    const videos = await fetchAllPlaylistVideos(playlistId, process.env.YOUTUBE_API_KEY);
    if (!videos.length) return res.status(404).json({ error: 'Is playlist me koi video nahi mila (private/khaali ho sakti hai).' });

    const durations = await fetchDurations(videos.map(v => v.videoId), process.env.YOUTUBE_API_KEY);

    let added = 0;
    for (const v of videos) {
      const lessonId = courseId + '-lsn-' + Date.now().toString(36) + '-' + added;
      const videoUrl = `https://www.youtube.com/embed/${v.videoId}`;
      const duration = durations[v.videoId] || '';
      await sql`
        insert into lessons (id, course_id, level_id, module_title, title, duration, video_url, order_index)
        values (${lessonId}, ${courseId}, ${levelId || null}, ${moduleTitle || 'Module 1'}, ${v.title}, ${duration}, ${videoUrl}, ${v.position})
      `;
      added++;
    }

    return res.status(200).json({ added, total: videos.length });
  } catch (err) {
    console.error('Playlist import error:', err);
    if (String(err.message || '').toLowerCase().includes('requests from referer')) {
      return res.status(500).json({
        error: `YouTube API key referrer restriction mismatch. Google Cloud Console me ${YOUTUBE_API_REFERER} ko allowed website referrer add karo, ya YOUTUBE_API_REFERER ko apne live domain par set karo.`,
      });
    }
    return res.status(500).json({ error: err.message || 'Playlist import nahi ho paayi.' });
  }
}
