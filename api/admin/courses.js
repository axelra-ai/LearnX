// api/admin/courses.js
// GET  -> saare courses ki list (admin panel ke liye)
// POST -> naya course banao ya purana update karo (id same do to update ho jaata hai)
// DELETE -> ?id=xxx se course delete karo (uske levels/lessons/quiz sab apne aap delete ho jaayenge)

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  try {
    if (req.method === 'GET') {
      const rows = await sql`select * from courses order by order_index, created_at`;
      return res.status(200).json({ courses: rows });
    }

    if (req.method === 'POST') {
      const {
        id, catId, catName, title, description, instructor, level,
        icon, gradient, levelType, orderIndex,
      } = req.body || {};

      if (!catId || !catName || !title) {
        return res.status(400).json({ error: 'catId, catName aur title zaroori hai.' });
      }
      const courseId = id || slugify(title) + '-' + Date.now().toString(36);

      const rows = await sql`
        insert into courses (id, cat_id, cat_name, title, description, instructor, level, icon, gradient, level_type, order_index)
        values (${courseId}, ${catId}, ${catName}, ${title}, ${description || ''}, ${instructor || 'LearnX Curated'}, ${level || 'Beginner'}, ${icon || 'book-open'}, ${gradient || 'linear-gradient(135deg,#d4a574,#c96442)'}, ${levelType || 'none'}, ${orderIndex || 0})
        on conflict (id) do update set
          cat_id = excluded.cat_id, cat_name = excluded.cat_name, title = excluded.title,
          description = excluded.description, instructor = excluded.instructor, level = excluded.level,
          icon = excluded.icon, gradient = excluded.gradient, level_type = excluded.level_type,
          order_index = excluded.order_index
        returning *
      `;
      return res.status(200).json({ course: rows[0] });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id zaroori hai.' });
      await sql`delete from courses where id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin courses error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
