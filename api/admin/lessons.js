// api/admin/lessons.js
// GET    ?courseId=xxx&levelId=yyy -> lessons list (levelId optional agar course levels use nahi karta)
// POST   -> naya lesson (class) banao ya update karo
// DELETE ?id=xxx -> lesson delete karo (uska quiz bhi chala jaayega)

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  try {
    if (req.method === 'GET') {
      const { courseId, levelId } = req.query;
      if (!courseId) return res.status(400).json({ error: 'courseId zaroori hai.' });
      const rows = levelId
        ? await sql`select * from lessons where course_id = ${courseId} and level_id = ${levelId} order by order_index, created_at`
        : await sql`select * from lessons where course_id = ${courseId} order by order_index, created_at`;
      return res.status(200).json({ lessons: rows });
    }

    if (req.method === 'POST') {
      const { id, courseId, levelId, moduleTitle, title, duration, videoUrl, orderIndex } = req.body || {};
      if (!courseId || !title || !videoUrl) {
        return res.status(400).json({ error: 'courseId, title aur videoUrl zaroori hai.' });
      }
      const lessonId = id || courseId + '-lsn-' + Date.now().toString(36);
      const rows = await sql`
        insert into lessons (id, course_id, level_id, module_title, title, duration, video_url, order_index)
        values (${lessonId}, ${courseId}, ${levelId || null}, ${moduleTitle || 'Module 1'}, ${title}, ${duration || '20 min'}, ${videoUrl}, ${orderIndex || 0})
        on conflict (id) do update set
          level_id = excluded.level_id, module_title = excluded.module_title, title = excluded.title,
          duration = excluded.duration, video_url = excluded.video_url, order_index = excluded.order_index
        returning *
      `;
      return res.status(200).json({ lesson: rows[0] });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id zaroori hai.' });
      await sql`delete from lessons where id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin lessons error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
