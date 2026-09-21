// api/state.js
// get.js + save.js ko ek file me combine kiya gaya hai (Vercel Hobby plan
// ki 12-function limit ke wajah se). GET = data laana, POST = data save karna.

import { sql } from '../lib/db.js';
import { getUserFromReq } from '../lib/auth.js';

export default async function handler(req, res) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login karo pehle.' });

  try {
    if (req.method === 'GET') {
      const stateRows = await sql`select * from user_state where user_id = ${user.uid}`;
      const userRows = await sql`select is_admin from users where id = ${user.uid}`;
      const chatRows = await sql`
        select id, title, messages, created_at as date
        from chats where user_id = ${user.uid}
        order by updated_at desc
        limit 50
      `;
      const state = stateRows[0] || {};

      return res.status(200).json({
        isAdmin: !!(userRows[0] && userRows[0].is_admin),
        progress: state.progress || {},
        notes: state.notes || {},
        bookmarks: state.bookmarks || [],
        flashcards: state.flashcards || [],
        quizScores: state.quiz_scores || {},
        xp: state.xp || 0,
        streak: state.streak || { count: 0, lastDate: null, days: {} },
        settings: state.settings || {},
        chats: chatRows.map((c) => ({
          id: c.id, title: c.title, messages: c.messages || [], date: new Date(c.date).getTime(),
        })),
      });
    }

    if (req.method === 'POST') {
      const { progress, notes, bookmarks, flashcards, quizScores, xp, streak, settings, chats } = req.body || {};

      await sql`
        insert into user_state (user_id, progress, notes, bookmarks, flashcards, quiz_scores, xp, streak, settings, updated_at)
        values (
          ${user.uid},
          ${JSON.stringify(progress || {})},
          ${JSON.stringify(notes || {})},
          ${JSON.stringify(bookmarks || [])},
          ${JSON.stringify(flashcards || [])},
          ${JSON.stringify(quizScores || {})},
          ${xp || 0},
          ${JSON.stringify(streak || { count: 0, lastDate: null, days: {} })},
          ${JSON.stringify(settings || {})},
          now()
        )
        on conflict (user_id) do update set
          progress = excluded.progress, notes = excluded.notes, bookmarks = excluded.bookmarks,
          flashcards = excluded.flashcards, quiz_scores = excluded.quiz_scores, xp = excluded.xp,
          streak = excluded.streak, settings = excluded.settings, updated_at = now()
      `;

      if (Array.isArray(chats)) {
        for (const chat of chats.slice(0, 50)) {
          if (!chat.id) continue;
          await sql`
            insert into chats (id, user_id, title, messages, updated_at)
            values (${chat.id}, ${user.uid}, ${chat.title || 'New conversation'}, ${JSON.stringify(chat.messages || [])}, now())
            on conflict (id) do update set title = excluded.title, messages = excluded.messages, updated_at = now()
          `;
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('State error:', err);
    return res.status(500).json({ error: 'Data load/save nahi ho paaya.' });
  }
}
