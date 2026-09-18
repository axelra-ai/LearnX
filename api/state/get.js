// api/state/get.js
// Login ke baad frontend yahan se user ka saara data (progress, notes,
// bookmarks, xp, streak, chats) laata hai — taaki wo kisi bhi device pe
// login kare, uska data wahi rahe (sirf ek browser tak simit na ho).

import { sql } from '../../lib/db.js';
import { getUserFromReq } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login karo pehle.' });

  try {
    const stateRows = await sql`select * from user_state where user_id = ${user.uid}`;
    const chatRows = await sql`
      select id, title, messages, created_at as date
      from chats where user_id = ${user.uid}
      order by updated_at desc
      limit 50
    `;

    const state = stateRows[0] || {};

    return res.status(200).json({
      progress: state.progress || {},
      notes: state.notes || {},
      bookmarks: state.bookmarks || [],
      flashcards: state.flashcards || [],
      quizScores: state.quiz_scores || {},
      xp: state.xp || 0,
      streak: state.streak || { count: 0, lastDate: null, days: {} },
      settings: state.settings || {},
      chats: chatRows.map((c) => ({
        id: c.id,
        title: c.title,
        messages: c.messages || [],
        date: new Date(c.date).getTime(),
      })),
    });
  } catch (err) {
    console.error('State fetch error:', err);
    return res.status(500).json({ error: 'Data load nahi ho paaya.' });
  }
}
