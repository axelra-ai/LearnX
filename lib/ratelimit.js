// lib/ratelimit.js
// Simple per-user, per-minute rate limit — har user ek minute me sirf itni
// AI chat requests bhej sakta hai. Ye do cheezein protect karta hai:
//  1) Tumhara Gemini API quota/bill — agar koi script se spam kare
//  2) User experience — server kabhi crash nahi hota, bas 429 error deta hai
//     aur frontend "thoda ruk jao" jaisa message dikhata hai.
//
// Isse aur strong banana ho (jaise real production traffic ke liye) to
// Upstash Redis (serverless, free tier hai) add kar sakte ho — README me
// likha hai kaise.

import { sql } from './db.js';

const MAX_REQUESTS_PER_MINUTE = 15;

export async function checkRateLimit(userId) {
  try {
    const rows = await sql`
      insert into rate_limits (user_id, window_start, count)
      values (${userId}, date_trunc('minute', now()), 1)
      on conflict (user_id, window_start)
      do update set count = rate_limits.count + 1
      returning count
    `;
    return rows[0].count <= MAX_REQUESTS_PER_MINUTE;
  } catch (err) {
    console.error('Rate limit check fail hua:', err);
    // DB hiccup ki wajah se pura chat feature block na ho, isliye fail-open
    return true;
  }
}
