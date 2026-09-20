// api/quiz-take.js
// Logged-in user ke liye — kisi lesson ka quiz laata hai taaki wo attempt kar sake.
// Correct answer chhupa ke deta hai (sirf options), aur alag se ek "check" action
// hai jisse ek-ek jawab verify ho sake bina poora answer-key frontend ko diye.

import { sql } from '../lib/db.js';
import { getUserFromReq } from '../lib/auth.js';

export default async function handler(req, res) {
  const user = getUserFromReq(req);
  if (!user) return res.status(401).json({ error: 'Login karo pehle.' });

  try {
    if (req.method === 'GET') {
      const { lessonId } = req.query;
      if (!lessonId) return res.status(400).json({ error: 'lessonId zaroori hai.' });
      const rows = await sql`select id, question, options, order_index from quiz_questions where lesson_id = ${lessonId} order by order_index`;
      return res.status(200).json({
        questions: rows.map((r) => ({ id: r.id, question: r.question, options: r.options })),
      });
    }

    if (req.method === 'POST') {
      // Body: { lessonId, answers: { [questionId]: selectedIndex } }
      const { lessonId, answers } = req.body || {};
      if (!lessonId || !answers) return res.status(400).json({ error: 'lessonId aur answers zaroori hai.' });

      const rows = await sql`select id, correct_index from quiz_questions where lesson_id = ${lessonId}`;
      let correct = 0;
      const results = {};
      for (const r of rows) {
        const isCorrect = Number(answers[r.id]) === r.correct_index;
        results[r.id] = { correct: isCorrect, correctIndex: r.correct_index };
        if (isCorrect) correct++;
      }
      return res.status(200).json({ score: correct, total: rows.length, results });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Quiz take error:', err);
    return res.status(500).json({ error: 'Quiz load/check nahi ho paaya.' });
  }
}
