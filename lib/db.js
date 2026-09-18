// lib/db.js
// Neon ka serverless Postgres driver use kar rahe hain kyunki ye HTTP-based hai —
// Vercel ke serverless functions ke saath perfectly fit baithta hai.
// Traditional "pg" pool serverless me connection-exhaustion cause karta hai jab
// bahut saare concurrent users aate hain (jaise 1000 log ek saath). Neon me
// har query ek independent HTTP request hoti hai, isliye ye scale karta hai
// bina kisi connection limit ke crash hue.

import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  // Function cold-start pe hi fail-fast karo taaki galti jaldi pata chale
  console.error('DATABASE_URL environment variable set nahi hai!');
}

export const sql = neon(process.env.DATABASE_URL);
