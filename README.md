# LearnX — Fully Working Setup Guide

Ye guide step-by-step batata hai ki LearnX website ko live kaise karna hai —
Gemini AI, Google-only login, Supabase Realtime, Google Drive storage aur
YouTube videos ke saath.

## Project me kya-kya hai

```
learnx/
  public/
    index.html      ← poori website (frontend)
      realtime-config.js ← Supabase Realtime URL/public key
    manifest.json    ← PWA icon/name info
    sw.js            ← offline caching
  api/
    chat.js          ← AI chat (Gemini ko safely call karta hai)
      auth.js          ← Google Sign-In verify karna
      realtime-token.js ← private Supabase channel JWT
      videos.js        ← videos, profiles, Drive chats
      state.js         ← user state sync
  lib/
    db.js            ← database connection
   auth.js          ← app login-token verification
    ratelimit.js     ← AI chat spam/abuse rokta hai
  schema.sql         ← database tables banane ka SQL
  package.json
  vercel.json
  .env.example
```

## Step 1 — Gemini API Key (tumhare paas already hai ✅)

Isko sambhal ke rakho, GEMINI_API_KEY ke naam se Vercel me daalna hai (Step 4).

## Step 2 — Supabase project banao

1. https://supabase.com par project banao.
2. **Project Settings → Database → Connection string → Transaction pooler** se
   `DATABASE_URL` lo (pooler port 6543).
3. Supabase **SQL Editor** me updated `schema.sql` run karo. Isme chat metadata,
   presence aur private Realtime broadcast RLS policies bhi hain.
4. **Project Settings → API** se Project URL aur anon/public key lekar
   `public/realtime-config.js` me placeholders replace karo.
5. Existing email/password users ke hashes schema run hote hi clear honge;
   account data rahega, sign-in ab sirf Google se hoga.

## Step 3 — Google Sign-In ka "Service ID" (OAuth Client ID) banao

1. https://console.cloud.google.com pe jaao, naya project banao.
2. **APIs & Services → OAuth consent screen** — "External" chuno, app ka
   naam "LearnX" daalo, save karo.
3. **APIs & Services → Credentials → Create Credentials → OAuth Client ID**
4. Application type: **Web application**
5. **Authorized JavaScript origins** me apni final website ka URL daalo
   (jaise `https://learnx.vercel.app`) — deploy karne ke baad ye milega,
   tab yahan wapas aake add kar dena.
6. Client ID milega jaisa `123456-abc.apps.googleusercontent.com` — yahi
   tumhara **service ID / GOOGLE_CLIENT_ID** hai.
7. `public/index.html` me dhoondo:
   ```js
   window.GOOGLE_CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
   ```
   apna real Client ID yahan paste kar do.

Google Cloud Console me **Google Drive API** enable karo. Google sign-in
required hai; app first use par
`drive.appdata` aur `drive.file` permission maangega. Pehli consent ke baad
app Drive token silently renew karne ki koshish karega.

## Step 4 — Vercel pe deploy karo

1. Is poore `learnx` folder ko GitHub pe ek naye repo me push karo.
2. https://vercel.com pe jaake **Add New → Project**, apna GitHub repo select karo.
3. Deploy se pehle **Environment Variables** set karo:

   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | tumhari Gemini API key |
   | `GEMINI_MODEL` | pehla Gemini model, jaise `gemini-3.8-flash` |
   | `GEMINI_MODEL_2` | pehla model quota/error de to doosra model |
   | `GEMINI_MODEL_3` | teesra fallback model (optional; aage `_4` se `_10` tak bhi set kar sakte ho) |
   | `YOUTUBE_API_KEY` | YouTube Data API v3 key (playlist import ke liye) |
   | `YOUTUBE_API_REFERER` | optional; site origin, default `https://learnxtech.vercel.app/` |
   | `DATABASE_URL` | Supabase transaction pooler connection string |
   | `JWT_SECRET` | koi bhi lamba random string (neeche kaise banaye) |
   | `GOOGLE_CLIENT_ID` | Required Google OAuth Client ID |
   | `SUPABASE_JWT_SECRET` | Supabase Project Settings → API ka legacy JWT secret; server-only |

`SUPABASE_JWT_SECRET` ko kabhi `public/realtime-config.js` me mat daalna. Wahan
sirf Supabase URL aur anon/public key honi chahiye.

   `JWT_SECRET` banane ke liye terminal/PowerShell me:
   ```
   openssl rand -hex 32
   ```
   (Ya koi bhi 40+ characters ka random string bhi chalega.)

4. **Deploy** dabao. 1-2 minute me website live ho jaayegi
   (`https://your-project.vercel.app`).
5. Ab wapas Google Cloud Console jaake is real URL ko **Authorized
   JavaScript origins** me add karo (Step 3.5).

## Step 5 — YouTube videos daalna

`public/index.html` me `COURSES` array me har lesson ke andar ek line
hoti hai:
```js
{ title: 'Python for AI — Setup & Basics', duration: '18 min', video: 'https://www.youtube.com/embed/rfscVS0vtbw' }
```
Bas `rfscVS0vtbw` jaisa **video ID** apne YouTube video ke ID se badal do
(jo bhi tumne apne channel pe upload kiya hai). Video ID YouTube URL ke
`v=` ke baad wala part hota hai:
`https://youtube.com/watch?v=rfscVS0vtbw` → ID hai `rfscVS0vtbw`.

Video dikhega seedha website ke andar embed ho ke — user ko kabhi YouTube
pe jaana nahi padega.

## Origin Play — user video uploads

LearnX accounts now use Google sign-in only. Google Drive access is required
before the app opens; after initial consent the app tries to renew access
silently, and asks the user to reconnect only if Google cannot renew it.

Origin Play account holders ko channel, video feed, channel search, follow aur
follower chat deta hai. Video bytes browser se seedhe upload karne wale user ke
Google Drive me jaate hain; database me video metadata, follows, temporary
presence aur Drive conversation references jaise chhote records rehte hain.

1. Google Cloud Console me isi OAuth project ke liye **Google Drive API** enable
   karo. Existing `GOOGLE_CLIENT_ID` Origin Play ke liye bhi use hota hai.
2. Video upload ya profile photo save karte waqt app `drive.file` permission
   maangta hai. User ki Drive me files upload/delete karne ke liye ye permission
   zaroori hai.
3. Public feed playback ke liye uploaded video par `Anyone with the link` ka
   viewer access set hota hai. Iska matlab video link public hai; private video
   uploads abhi supported nahi hain. Google Drive ki storage aur playback
   limits apply hoti hain. Upload size limit 2 GB hai.
4. Existing database par updated `schema.sql` dobara run karo. Isse
   `video_conversations`, `video_presence`, chat indexes aur private Realtime
   policies add hongi; purana data delete nahi hota.
5. `public/realtime-config.js` me apne Supabase project ka URL aur anon key
   set karo. Anon key browser me public hoti hai; access ko SQL RLS policies
   restrict karti hain.
6. Vercel environment variable `SUPABASE_JWT_SECRET` me Supabase project ka
   JWT secret set karo. Ye secret server-only hai; ise frontend/config file me
   mat rakho.

Upload karne wala user apne Profile → Videos tab se apni video delete kar sakta
hai. Deletion database metadata ke saath uski Google Drive file bhi delete karti
hai. `api/videos.js` video file ko server ya database se pass nahi karta.

Direct-message content ek shared Google Drive folder me rehta hai; har chat ke
dono participants ko folder access diya jata hai. Database me sirf participant
IDs, Drive folder ID aur last-activity time rehta hai. Existing database chats
Drive permission milne par chat kholte hi batches me migrate hoti hain; Chats
page ke cloud-upload button se purani conversations bulk migrate kar sakte hain. Saare
message files verify hone ke baad hi purane message rows delete hote hain.
Private Supabase Realtime broadcasts new messages immediately; Drive upload then
persists them. If Realtime configuration is missing/unavailable, the UI falls
back to polling. Long-press (or right-click) a message to delete its Drive file
and broadcast removal to the other participant.
Active chat lagbhag har 2.2 seconds me refresh hoti hai; online/typing state
short-lived database presence se aati hai. Chat delete karne par Drive ke message
files aur database reference delete hote hain. Profile photos `drive.file`
permission se user ke Google Drive me upload hoti hain aur profile display ke
liye `Anyone with the link` reader access leti hain. Photo content Drive me hai;
database me sirf uska URL rehta hai. Purani database photo ko Drive me move karne
ke liye nayi profile photo upload karein.

## AI identity aur formatting

Gemini model fallback ka order Vercel Environment Variables me `GEMINI_MODEL`,
`GEMINI_MODEL_2`, `GEMINI_MODEL_3` ... se set hota hai. Model quota/rate limit
(`429`), unavailable (`404`), ya temporary provider error (`5xx`) ho to server
agla model try karta hai. Configured models ke baad built-in defaults bhi try
hote hain; duplicate model names repeat nahi hote.
Variables add/change karne ke baad Vercel par redeploy karo. Agar model vars set
nahi hain, built-in default sequence use hoti hai.

`api/chat.js` me system instruction already set hai ki AI hamesha khud ko
**"LearnX AI"** bataye (kabhi Gemini/Google ka naam reveal nahi karega),
aur hamesha achhe se formatted jawab de — code ke liye code blocks,
steps ke liye numbered lists, wagera — sirf plain paragraph text nahi.

## 1000 users ek saath aayein to server crash na ho — kaise handle hua

- **Vercel serverless functions** har request ke liye automatically scale
  hoti hain — ek function crash nahi karwa sakta doosre users ko affect.
- **Supabase Postgres** connection pooler aur Realtime private broadcasts use hote hain.
- **Per-user rate limit** (`lib/ratelimit.js`) — har user max 15 AI
  messages/minute bhej sakta hai, taaki koi spam na kar sake aur Gemini
  quota surakshit rahe.
- Agar traffic bahut zyada badh jaaye (jaise real 1000+ concurrent users
  daily), 2 cheezein upgrade karna:
  1. Gemini API ka **paid tier** lena (free tier ki request-per-minute
     limit kam hoti hai).
  2. Rate-limiting ko [Upstash Redis](https://upstash.com) (free tier)
     me shift karna — `lib/ratelimit.js` me comment likha hai kaise.

## Local testing (optional)

```
npm install
npx vercel dev
```
Ye local server chalayega jahan `/api/*` routes bhi kaam karenge (Vercel CLI install karna padega: `npm i -g vercel`).
