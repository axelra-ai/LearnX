// api/admin/manage.js
// courses.js + levels.js + lessons.js ko ek file me combine kiya gaya hai
// (Vercel Hobby plan ki 12-function limit ke wajah se). ?type=courses|levels|lessons
// se route hota hai, method (GET/POST/DELETE) pehle jaisa hi kaam karta hai.

import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/* ---------- COURSES ---------- */
async function coursesHandler(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`select * from courses order by order_index, created_at`;
    return res.status(200).json({ courses: rows });
  }
  if (req.method === 'POST') {
    const { id, catId, catName, title, description, instructor, level, icon, gradient, levelType, orderIndex } = req.body || {};
    if (!catId || !catName || !title) return res.status(400).json({ error: 'catId, catName aur title zaroori hai.' });
    const courseId = id || slugify(title) + '-' + Date.now().toString(36);
    const rows = await sql`
      insert into courses (id, cat_id, cat_name, title, description, instructor, level, icon, gradient, level_type, order_index)
      values (${courseId}, ${catId}, ${catName}, ${title}, ${description || ''}, ${instructor || 'LearnX Curated'}, ${level || 'Beginner'}, ${icon || 'book-open'}, ${gradient || 'linear-gradient(135deg,#d4a574,#c96442)'}, ${levelType || 'none'}, ${orderIndex || 0})
      on conflict (id) do update set
        cat_id = excluded.cat_id, cat_name = excluded.cat_name, title = excluded.title,
        description = excluded.description, instructor = excluded.instructor, level = excluded.level,
        icon = excluded.icon, gradient = excluded.gradient, level_type = excluded.level_type, order_index = excluded.order_index
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
}

/* ---------- LEVELS ---------- */
async function levelsHandler(req, res) {
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
}

/* ---------- LESSONS ---------- */
async function lessonsHandler(req, res) {
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
    if (!courseId || !title || !videoUrl) return res.status(400).json({ error: 'courseId, title aur videoUrl zaroori hai.' });
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
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  try {
    const { type } = req.query;
    if (type === 'courses') return coursesHandler(req, res);
    if (type === 'levels') return levelsHandler(req, res);
    if (type === 'lessons') return lessonsHandler(req, res);
    return res.status(400).json({ error: 'Invalid type (courses/levels/lessons chahiye).' });
  } catch (err) {
    console.error('Admin manage error:', err);
    return res.status(500).json({ error: 'Kuch galat ho gaya. Dobara try karo.' });
  }
}
