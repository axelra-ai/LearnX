// api/admin/levels.js
// GET    ?courseId=xxx -> us course ke saare levels (Class 9, Class 10, ...)
// POST   -> naya level banao ya update karo
// DELETE ?id=xxx -> level delete karo (uske lessons bhi chale jaayenge)

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  try {
    if (req.method === 'GET') {
      const { courseId } = req.query;
      if (!courseId) return res.status(400).json({ error: 'courseId zaroori hai.' });
      const rows = await sql`select * from course_levels where course_id = ${courseId} order by order_index, created_at`;
      return res.status(200).json({ levels: rows });
    }

    if (req.method === 'POST') {
      const { id, courseId, name, orderIndex } = req.body || {};
      if (!courseId || !name) return res.status(400).json({ error: 'courseId aur name zaroori hai.' });
      const levelId = id || courseId + '-lvl-' + Date.now().toString(36);
      const rows = await sql`
        insert into course_levels (id, course_id, name, order_index)
        values (${levelId}, ${courseId}, ${name}, ${orderIndex || 0})
        on conflict (id) do update set name = excluded.name, order_index = excluded.order_index
        returning *
      `;
      return res.status(200).json({ level: rows[0] });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id zaroori hai.' });
      await sql`delete from course_levels where id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin levels error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
