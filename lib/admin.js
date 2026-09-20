// lib/admin.js
import { sql } from './db.js';
import { getUserFromReq } from './auth.js';

// Request se user nikalta hai AUR confirm karta hai ki wo admin hai.
// Return: { uid, email, name } agar admin hai, warna null.
export async function requireAdmin(req) {
  const user = getUserFromReq(req);
  if (!user) return null;
  const rows = await sql`select is_admin from users where id = ${user.uid}`;
  if (!rows[0] || !rows[0].is_admin) return null;
  return user;
}
