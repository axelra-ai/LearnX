// api/courses.js
// Public endpoint — website ke liye saare courses, unke levels (agar hain), aur
// lessons ek saath, nested structure me deta hai. Login zaroori nahi (courses
// dekhna free hona chahiye).

import { sql } from '../lib/db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const courses = await sql`select * from courses order by order_index, created_at`;
    const levels = await sql`select * from course_levels order by order_index, created_at`;
    const lessons = await sql`select * from lessons order by order_index, created_at`;

    const levelsByCourse = {};
    for (const lv of levels) {
      (levelsByCourse[lv.course_id] ||= []).push({ id: lv.id, name: lv.name });
    }
    const lessonsByCourse = {};
    for (const l of lessons) {
      (lessonsByCourse[l.course_id] ||= []).push({
        id: l.id, levelId: l.level_id, moduleTitle: l.module_title,
        title: l.title, duration: l.duration, video: l.video_url,
      });
    }

    const result = courses.map((c) => ({
      id: c.id, catId: c.cat_id, catName: c.cat_name, title: c.title,
      desc: c.description, instructor: c.instructor, level: c.level,
      icon: c.icon, grad: c.gradient, levelType: c.level_type,
      levels: levelsByCourse[c.id] || [],
      lessons: lessonsByCourse[c.id] || [],
    }));

    return res.status(200).json({ courses: result });
  } catch (err) {
    console.error('Courses fetch error:', err);
    return res.status(500).json({ error: 'Courses load nahi ho paaye.' });
  }
}
