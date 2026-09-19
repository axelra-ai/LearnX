// lib/db.js
// Supabase Postgres ka connection — "Transaction pooler" (port 6543) use
// kar rahe hain kyunki serverless functions (Vercel) ke saath yahi sahi
// tareeka hai. Har function invocation apna khud ka halka connection
// leta hai aur pooler ke through jaata hai, isliye 1000 users ek saath
// aayein to bhi database connections khatam (exhaust) nahi hote.

import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL environment variable set nahi hai!');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 1, // serverless me har invocation ke liye ek hi connection kaafi hai
  idleTimeoutMillis: 10000,
});

// Neon wale code me hum `sql\`...\`` tagged-template style use kar rahe the.
// Yahan bhi wahi style chalti rahe isliye ek chhota helper bana diya —
// baaki saari api/*.js files bina badle kaam karengi.
export async function sql(strings, ...values) {
  let text = strings[0];
  const params = [];
  values.forEach((v, i) => {
    params.push(v);
    text += `$${i + 1}` + strings[i + 1];
  });
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res.rows;
  } finally {
    client.release();
  }
}
