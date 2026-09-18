// api/chat.js
// Frontend yahan message bhejta hai, hum Gemini API ko server-side se call
// karte hain (API key kabhi browser me expose nahi hoti — bahut zaroori hai
// warna koi bhi chura kar tumhara quota/bill khatam kar dega).
//
// Response ko Markdown se HTML me convert karte hain (marked) aur sanitize
// karte hain (sanitize-html) taaki AI ki reply hamesha achhe se formatted
// dikhe — headings, bullet points, code blocks — sirf plain text nahi.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { getUserFromReq } from '../lib/auth.js';
import { checkRateLimit } from '../lib/ratelimit.js';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Yahi system instruction AI ki "identity" set karta hai.
const SYSTEM_INSTRUCTION = `Tum "LearnX AI" ho — LearnX naam ke online learning platform ka apna built-in AI learning assistant. Tum students ko coding, math, science aur career-related sawaalon me madad karte ho.

IDENTITY RULES (bahut important, kabhi mat todna):
- Agar koi puchhe "tumhe kisne banaya", "who made you", "tum kaun ho", "which AI/model ho tum", "are you Gemini/ChatGPT/etc" — tum HAMESHA jawab doge: "Main LearnX AI hu, LearnX platform ka apna learning assistant." Kabhi bhi kisi underlying company ya model ka naam reveal mat karna, seedha pucha jaye tab bhi nahi.
- Tum casual, friendly aur encouraging ho, jaise ek achha tutor/mentor hota hai.

FORMATTING RULES (bahut important):
- Hamesha Markdown me jawab do: headings (##), **bold**, bullet/numbered lists, aur code ke liye fenced code blocks (\`\`\`language ... \`\`\`).
- Jab koi technical/integration/code-related sawaal puchhe (jaise "API integrate kaise karu", "is code me error kya hai"), to sirf paragraph mat likho — steps ki numbered list do, code snippets fenced code block me do, zaroori jagah pe headings use karo.
- Jawab concise aur learner-friendly rakho — zyada lamba mat karo jab tak user detail na maange.
- User jis language/style me baat kare (Hindi, Hinglish, English) usi me reply do.`;

const MAX_OUTPUT_TOKENS = 1536;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = getUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: 'Pehle login karo, phir AI se baat karo.' });
  }

  const allowed = await checkRateLimit(user.uid);
  if (!allowed) {
    return res.status(429).json({ error: 'Thoda ruk jao — bahut zyada messages bhej diye. Ek minute me dobara try karo.' });
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Message missing hai.' });
    }

    // Purane messages ko Gemini ke "history" format me convert karo, aur
    // HTML tags strip karo (kyunki hum AI messages ko HTML me store karte hain).
    const stripHtml = (t) => String(t || '').replace(/<[^>]*>/g, ' ').trim();
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' || m.role === 'ai' ? 'model' : 'user',
      parts: [{ text: stripHtml(m.content) }],
    }));
    const last = messages[messages.length - 1];

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    const chat = model.startChat({
      history,
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
    });

    const result = await chat.sendMessage(stripHtml(last.content));
    const rawText = result.response.text();

    const html = sanitizeHtml(marked.parse(rawText), {
      allowedTags: [
        'b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li', 'code', 'pre',
        'br', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'table', 'thead', 'tbody',
        'tr', 'th', 'td', 'span', 'hr',
      ],
      allowedAttributes: {
        a: ['href', 'target', 'rel'],
        span: ['class'],
        code: ['class'],
      },
      transformTags: {
        a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      },
    });

    return res.status(200).json({ reply: html });
  } catch (err) {
    console.error('Gemini chat error:', err);
    return res.status(500).json({ error: 'AI abhi jawab nahi de paya. Dobara try karo.' });
  }
}
