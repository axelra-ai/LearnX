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

// Ek user ki saari devices (subscriptions) par notification bhejo.
// Kabhi throw nahi karta — notification fail hone se message send fail nahi hona chahiye.
export async function sendPushToUser(userId, payload) {
  if (!(await configure())) return { sent: 0, skipped: 'not-configured' };
  let subs;
  try {
    subs = await sql`select endpoint, p256dh, auth from push_subscriptions where user_id = ${userId}`;
  } catch (err) {
    console.warn('Push subscriptions load nahi hui:', err && err.message);
    return { sent: 0, skipped: 'db-error' };
  }
  if (!subs.length) return { sent: 0, skipped: 'no-subscriptions' };
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { TTL: 60 * 60 * 24, urgency: 'high', timeout: 8000 }
      );
      sent++;
    } catch (err) {
      // 404/410 = subscription expire ho gayi / user ne permission hata di
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await sql`delete from push_subscriptions where endpoint = ${sub.endpoint}`; } catch (e) {}
      } else {
        console.warn('Push send fail:', err && (err.statusCode || err.message));
      }
    }
  }));
  return { sent };
}

// Diagnosis ke liye: package aur keys sahi se set hain ya nahi.
export async function pushStatus() {
  const packageLoaded = !!(await loadWebPush());
  return { packageLoaded, hasKeys: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) };
}
