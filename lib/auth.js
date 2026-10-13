// lib/auth.js
// App JWT tokens ke liye helper functions.

import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_EXPIRY = '30d';

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Request ke Authorization header se logged-in user nikalta hai.
// Return: { uid, email, name } ya null agar valid token nahi hai.
export function getUserFromReq(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  return verifyToken(token);
}

