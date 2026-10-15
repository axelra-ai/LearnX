// lib/push.js
// Web Push notifications — app band ho tab bhi phone/PC par notification dikhane ke liye.
//
// Setup (README me bhi likha hai):
//   npx web-push generate-vapid-keys
//   Vercel env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (jaise mailto:you@gmail.com)
// Keys set nahi hain to push chupchaap skip hota hai, chat kaam karta rehta hai.

import { sql } from './db.js';

// web-push ko lazily load karte hain: package install na ho to bhi baaki app (videos/chats) na toote.
let webpush = null;
async function loadWebPush() {
  if (webpush) return webpush;
  try { webpush = (await import('web-push')).default; }
  catch (err) { console.error('web-push package load nahi hua (npm install / package.json check karo):', err && err.message); }
  return webpush;
}

let configured = null;
async function configure() {
  if (configured !== null) return configured;
  if (!(await loadWebPush())) { configured = false; return false; }
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { configured = false; return false; }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@learnx.app', pub, priv);
    configured = true;
  } catch (err) {
    console.error('VAPID keys invalid hain:', err && err.message);
    configured = false;
  }
  return configured;
}

export async function pushPublicKey() {
  return (await configure()) ? process.env.VAPID_PUBLIC_KEY : '';
}
