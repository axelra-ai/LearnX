// api/state/save.js
// Frontend har State change ke baad (debounced) yahan poora state bhejta hai
// aur hum database me upsert kar dete hain. JSONB columns use kiye hain isliye
// ye simple aur fast hai — 1000 users ke liye bhi har user ki ek hi row hai,
// koi bhaari joins nahi.

import { sql } from '../../lib/db.js';
import { getUserFromReq } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login karo pehle.' });

  try {
    const {
      progress, notes, bookmarks, flashcards, quizScores, xp, streak, settings, chats,
    } = req.body || {};

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
        progress = excluded.progress,
        notes = excluded.notes,
        bookmarks = excluded.bookmarks,
        flashcards = excluded.flashcards,
        quiz_scores = excluded.quiz_scores,
        xp = excluded.xp,
        streak = excluded.streak,
        settings = excluded.settings,
        updated_at = now()
    `;

    // Chats alag table me — har chat ko upsert karo (id client se aata hai)
    if (Array.isArray(chats)) {
      for (const chat of chats.slice(0, 50)) {
        if (!chat.id) continue;
        await sql`
          insert into chats (id, user_id, title, messages, updated_at)
          values (${chat.id}, ${user.uid}, ${chat.title || 'New conversation'}, ${JSON.stringify(chat.messages || [])}, now())
          on conflict (id) do update set
            title = excluded.title,
            messages = excluded.messages,
            updated_at = now()
        `;
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('State save error:', err);
    return res.status(500).json({ error: 'Data save nahi ho paaya.' });
  }
}
