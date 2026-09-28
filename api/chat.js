// api/chat.js
// Frontend yahan message bhejta hai, hum Gemini API ko server-side se call
// karte hain (API key kabhi browser me expose nahi hoti — bahut zaroori hai
// warna koi bhi chura kar tumhara quota/bill khatam kar dega).
//
// Response ko Markdown se HTML me convert karte hain (marked) aur sanitize
// karte hain (sanitize-html) taaki AI ki reply hamesha achhe se formatted
// dikhe — headings, bullet points, code blocks — sirf plain text nahi.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { getUserFromReq } from '../lib/auth.js';
import { checkRateLimit } from '../lib/ratelimit.js';
import { sql } from '../lib/db.js';

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

// Vercel env vars GEMINI_MODEL, GEMINI_MODEL_2, ... order define karte hain.
// Agar koi model env var set nahi hai, existing defaults use hote hain.
const DEFAULT_MODEL_FALLBACK_LIST = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
];
function getModelFallbackList() {
  const configured = [];
  for (let index = 1; index <= 10; index++) {
    const key = index === 1 ? 'GEMINI_MODEL' : `GEMINI_MODEL_${index}`;
    const model = process.env[key] && process.env[key].trim();
    if (model && !configured.includes(model)) configured.push(model);
  }
  return [...configured, ...DEFAULT_MODEL_FALLBACK_LIST.filter(model => !configured.includes(model))];
}

// Chhota, dependency-free Markdown → safe HTML converter.
// (Ek external library "marked" use ki thi pehle, lekin uska naya version
// Vercel ke build system ke saath clash kar raha tha — isliye apna khud ka,
// zero-dependency converter likh diya. Isse fenced code blocks, bold,
// headings, aur bullet/numbered lists sab format ho jaate hain.)
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineFormat(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return t;
}

function mdToHtml(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inCode = false, codeBuf = [];
  let listType = null; // 'ul' | 'ol' | null
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) { html += `<p>${paraBuf.join(' ')}</p>`; paraBuf = []; }
  };
  const closeList = () => {
    if (listType) { html += listType === 'ul' ? '</ul>' : '</ol>'; listType = null; }
  };

  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      if (!inCode) { flushPara(); closeList(); inCode = true; codeBuf = []; }
      else { html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`; inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushPara(); closeList();
      const level = Math.min(heading[1].length + 1, 4);
      html += `<h${level}>${inlineFormat(heading[2])}</h${level}>`;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (listType !== type) { closeList(); html += type === 'ul' ? '<ul>' : '<ol>'; listType = type; }
      html += `<li>${inlineFormat(bullet ? bullet[1] : numbered[1])}</li>`;
      continue;
    }

    if (line.trim() === '') { flushPara(); closeList(); continue; }

    paraBuf.push(inlineFormat(line.trim()));
  }
  flushPara(); closeList();
  if (inCode && codeBuf.length) html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`;
  return html;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let failureStage = 'authentication';
  try {
    const user = getUserFromReq(req);
    if (!user) {
      return res.status(401).json({ error: 'Pehle login karo, phir AI se baat karo.' });
    }

    failureStage = 'database';
    const banRows = await sql`select is_banned from users where id = ${user.uid}`;
    if (banRows[0] && banRows[0].is_banned) {
      return res.status(403).json({ error: 'Ye account suspend kiya gaya hai.' });
    }

    const allowed = await checkRateLimit(user.uid);
    if (!allowed) {
      return res.status(429).json({ error: 'Thoda ruk jao — bahut zyada messages bhej diye. Ek minute me dobara try karo.' });
    }

    failureStage = 'Gemini';
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

    let rawText = null;
    let lastErr = null;
    let lastModelName = '';
    const modelAttempts = [];

    for (const modelName of getModelFallbackList()) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction: SYSTEM_INSTRUCTION,
        });
        const chat = model.startChat({
          history,
          generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
        });
        const result = await chat.sendMessage(stripHtml(last.content));
        rawText = result.response.text();
        break; // is model se jawab mil gaya, aage koi aur try karne ki zaroorat nahi
      } catch (err) {
        lastErr = err;
        lastModelName = modelName;
        const status = Number(err && (err.status || (err.message && err.message.match(/\[(\d+)/) && err.message.match(/\[(\d+)/)[1])));
        modelAttempts.push(`${modelName}: HTTP ${status || 'unknown'}`);
        // Quota, missing model, ya temporary provider outage ho to agla model try karo.
        if ([404, 429, 500, 502, 503, 504].includes(status)) { continue; }
        err.modelName = modelName;
        err.modelStatus = status;
        err.modelAttempts = modelAttempts;
        throw err; // koi aur (jaise auth) error ho to turant band karo, aage try mat karo
      }
    }

    if (rawText === null) {
      console.error('Sab models fail ho gaye:', lastErr);
      const status = lastErr && (lastErr.status || (lastErr.message && lastErr.message.match(/\[(\d+)/) && Number(lastErr.message.match(/\[(\d+)/)[1])));
      return res.status(500).json({
        error: `Gemini fallback attempts: ${modelAttempts.join('; ')}. Last model: ${lastModelName || 'unknown'}${status ? ` (HTTP ${status})` : ''}.`,
      });
    }

    const html = mdToHtml(rawText);

    return res.status(200).json({ reply: html });
  } catch (err) {
    console.error(`Chat ${failureStage} error:`, err);
    const status = err && (err.status || (err.message && err.message.match(/\[(\d+)/) && Number(err.message.match(/\[(\d+)/)[1])));
    if (failureStage === 'database') {
      return res.status(500).json({ error: 'Chat database check failed. Vercel me DATABASE_URL aur users table connection check karo.' });
    }
    if (failureStage === 'Gemini' && err && err.modelAttempts) {
      return res.status(500).json({
        error: `Gemini stopped at ${err.modelName || 'unknown model'} (HTTP ${err.modelStatus || status || 'unknown'}). Attempts: ${err.modelAttempts.join('; ')}.`,
      });
    }
    return res.status(500).json({
      error: `${failureStage} request failed${status ? ` (HTTP ${status})` : ''}. Check the Vercel function logs and API configuration.`,
    });
  }
}
