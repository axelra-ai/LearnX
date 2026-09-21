// api/admin/quiz.js
// GET    ?lessonId=xxx      -> us lesson ka current quiz dikhao (edit karne ke liye)
// POST   { lessonId, regenerate:true } -> AI se 20 naye sawaal banao (Gemini)
// PUT    { lessonId, questions:[...] } -> manually edit kiya hua quiz save karo

import { GoogleGenerativeAI } from '@google/generative-ai';
import { sql } from '../../lib/db.js';
import { requireAdmin } from '../../lib/admin.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const MODEL_FALLBACK_LIST = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
const QUESTION_COUNT = 20;

async function generateQuestions(lessonTitle, moduleTitle, courseTitle, catName) {
  const prompt = `Tum ek strict, subject-aware quiz-question generator ho.

COURSE: "${courseTitle}" (subject area: "${catName}")
MODULE: "${moduleTitle}"
LESSON/TOPIC: "${lessonTitle}"

Bilkul ${QUESTION_COUNT} multiple-choice questions banao — SIRF is exact lesson/topic ke baare me, jo upar diye COURSE aur MODULE ke subject area ke andar hi ho. Beginner-to-intermediate learner ke liye.

BAHUT ZAROORI RULES:
- Agar lesson title generic/adhoora lage (jaise "Lecture 2", "Part 1"), to use COURSE ke subject ("${catName}") ke context me samjho — kabhi bhi kisi doosre, alag subject (jaise agar course Computer Science/${catName} hai to Biology, History, ya kisi bhi unrelated field) ke sawaal mat banao.
- Har sawaal directly is course/subject se related hona chahiye. Koi bhi off-topic ya random general-knowledge sawaal mat daalna.
- Agar tumhe lesson ka exact content pata nahi (sirf title se), to us COURSE ke us MODULE ke liye ek typical, sensible curriculum topic assume karo — lekin subject area kabhi mat badlo.

Sirf ek JSON array return karo, kuch aur text nahi, koi markdown fence nahi. Har item is format me ho:
{"question": "...", "options": ["...","...","...","..."], "correctIndex": 0}
"correctIndex" 0 se 3 ke beech ek number ho (options array me sahi jawab ka index).`;

  let lastErr = null;
  for (const modelName of MODEL_FALLBACK_LIST) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();
      text = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.length) throw new Error('AI ne khaali/galat format diya');
      return parsed.slice(0, QUESTION_COUNT).map((q, i) => ({
        question: String(q.question || '').slice(0, 500),
        options: Array.isArray(q.options) ? q.options.slice(0, 4).map(String) : ['A', 'B', 'C', 'D'],
        correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
        orderIndex: i,
      }));
    } catch (err) {
      lastErr = err;
      const status = err && (err.status || (err.message && err.message.match(/\[(\d+)/) && Number(err.message.match(/\[(\d+)/)[1])));
      if (status === 429 || status === 404) continue;
      if (err instanceof SyntaxError) continue; // is model ne bura JSON diya, agla try karo
      throw err;
    }
  }
  throw lastErr || new Error('Sab models fail ho gaye');
}

export default async function handler(req, res) {
  const admin = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Sirf admin hi ye kar sakta hai.' });

  try {
    if (req.method === 'GET') {
      const { lessonId } = req.query;
      if (!lessonId) return res.status(400).json({ error: 'lessonId zaroori hai.' });
      const rows = await sql`select * from quiz_questions where lesson_id = ${lessonId} order by order_index`;
      return res.status(200).json({ questions: rows });
    }

    if (req.method === 'POST') {
      const { lessonId } = req.body || {};
      if (!lessonId) return res.status(400).json({ error: 'lessonId zaroori hai.' });

      const lessonRows = await sql`
        select l.title, l.module_title, c.title as course_title, c.cat_name
        from lessons l
        join courses c on c.id = l.course_id
        where l.id = ${lessonId}
      `;
      if (!lessonRows[0]) return res.status(404).json({ error: 'Lesson nahi mila.' });

      const lr = lessonRows[0];
      const questions = await generateQuestions(lr.title, lr.module_title, lr.course_title, lr.cat_name);

      await sql`delete from quiz_questions where lesson_id = ${lessonId}`;
      for (const q of questions) {
        await sql`
          insert into quiz_questions (lesson_id, question, options, correct_index, order_index, source)
          values (${lessonId}, ${q.question}, ${JSON.stringify(q.options)}, ${q.correctIndex}, ${q.orderIndex}, 'ai')
        `;
      }
      const saved = await sql`select * from quiz_questions where lesson_id = ${lessonId} order by order_index`;
      return res.status(200).json({ questions: saved });
    }

    if (req.method === 'PUT') {
      const { lessonId, questions } = req.body || {};
      if (!lessonId || !Array.isArray(questions)) {
        return res.status(400).json({ error: 'lessonId aur questions zaroori hai.' });
      }
      await sql`delete from quiz_questions where lesson_id = ${lessonId}`;
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await sql`
          insert into quiz_questions (lesson_id, question, options, correct_index, order_index, source)
          values (${lessonId}, ${q.question}, ${JSON.stringify(q.options)}, ${q.correctIndex}, ${i}, 'manual')
        `;
      }
      const saved = await sql`select * from quiz_questions where lesson_id = ${lessonId} order by order_index`;
      return res.status(200).json({ questions: saved });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Admin quiz error:', err);
    return res.status(500).json({ error: 'Quiz banane/save karne me dikkat aayi. Dobara try karo.' });
  }
}
