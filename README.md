# LearnX — Fully Working Setup Guide

Ye guide step-by-step batata hai ki LearnX website ko live kaise karna hai —
Gemini AI, real login (email + Google), database, aur YouTube videos ke saath.

## Project me kya-kya hai

```
learnx/
  public/
    index.html      ← poori website (frontend)
    manifest.json    ← PWA icon/name info
    sw.js            ← offline caching
  api/
    chat.js          ← AI chat (Gemini ko safely call karta hai)
    auth/
      signup.js      ← naya account banana
      login.js       ← email/password se login
      google.js      ← Google Sign-In verify karna
    state/
      get.js         ← user ka progress/notes/chats DB se laana
      save.js         ← user ka progress/notes/chats DB me save karna
  lib/
    db.js            ← database connection
    auth.js          ← password hashing + login tokens (JWT)
    ratelimit.js     ← AI chat spam/abuse rokta hai
  schema.sql         ← database tables banane ka SQL
  package.json
  vercel.json
  .env.example
```

## Step 1 — Gemini API Key (tumhare paas already hai ✅)

Isko sambhal ke rakho, GEMINI_API_KEY ke naam se Vercel me daalna hai (Step 4).

## Step 2 — Database banao (Neon — free hai)

1. https://neon.tech pe jaake free account banao.
2. "New Project" banao (koi bhi naam, region India/Singapore chuno for speed).
3. Project khulte hi ek **Connection string** milega, jaisa:
   `postgresql://user:pass@ep-xxxx.neon.tech/dbname?sslmode=require`
   Ise copy karke rakho — yahi `DATABASE_URL` hai.
4. Neon dashboard me **SQL Editor** kholo, is repo ki `schema.sql` file ka
   pura content paste karke **Run** karo. Isse 4 tables ban jaayengi:
   `users`, `user_state`, `chats`, `rate_limits`.

> Neon serverless hai isliye Vercel ke saath best fit hai — 1000 users ek
> saath aane pe bhi traditional database connection pool khatam nahi hota,
> kyunki har query ek independent HTTP request ki tarah jaati hai.

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

(Agar abhi Google login skip karna ho, koi baat nahi — email/password login
already pura kaam karega. Baad me bhi ye step kar sakte ho.)

## Step 4 — Vercel pe deploy karo

1. Is poore `learnx` folder ko GitHub pe ek naye repo me push karo.
2. https://vercel.com pe jaake **Add New → Project**, apna GitHub repo select karo.
3. Deploy se pehle **Environment Variables** me ye 4 cheezein daalo:

   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | tumhari Gemini API key |
   | `YOUTUBE_API_KEY` | YouTube Data API v3 key (playlist import ke liye) |
   | `YOUTUBE_API_REFERER` | optional; site origin, default `https://learnxtech.vercel.app/` |
   | `DATABASE_URL` | Step 2 wala Neon connection string |
   | `JWT_SECRET` | koi bhi lamba random string (neeche kaise banaye) |
   | `GOOGLE_CLIENT_ID` | Step 3 wala Client ID (optional, agar Google login chahiye) |

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

## AI identity aur formatting

`api/chat.js` me system instruction already set hai ki AI hamesha khud ko
**"LearnX AI"** bataye (kabhi Gemini/Google ka naam reveal nahi karega),
aur hamesha achhe se formatted jawab de — code ke liye code blocks,
steps ke liye numbered lists, wagera — sirf plain paragraph text nahi.

## 1000 users ek saath aayein to server crash na ho — kaise handle hua

- **Vercel serverless functions** har request ke liye automatically scale
  hoti hain — ek function crash nahi karwa sakta doosre users ko affect.
- **Neon serverless Postgres** connection-pool exhaustion se bachata hai.
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
