# MLBIE Dashboard — Setup

Concise guide to getting the web dashboard running locally and on Railway.

---

## 1. Google Cloud project

1. Go to <https://console.cloud.google.com/> and create (or select) a project for MLBIE.
2. Enable the **Google Identity Services API** (formerly Google+ API):
   - APIs & Services → Library → search "Google Identity" → Enable.
   - No separate OAuth API needs to be toggled on — the `openid`/`email`/`profile` scopes work with the default identity endpoints.

## 2. OAuth 2.0 credentials

APIs & Services → **Credentials** → Create Credentials → **OAuth client ID**.

- Application type: **Web application**
- Name: `MLBIE Dashboard`
- **Authorized JavaScript origins**:
  - `http://localhost:3001`
  - Your Railway origin, e.g. `https://mlbie.up.railway.app`
- **Authorized redirect URIs**:
  - `http://localhost:3001/auth/callback`
  - `https://mlbie.up.railway.app/auth/callback`

Click **Create**. Copy the **Client ID** and **Client secret**.

Under **OAuth consent screen** (if not already set up):
- User Type: **External**
- Publishing status can stay in **Testing** — just add both whitelisted Gmail addresses as Test users.

## 3. .env

Copy `.env.example` to `.env` and fill in:

```
GOOGLE_CLIENT_ID=<paste from step 2>
GOOGLE_CLIENT_SECRET=<paste from step 2>
GOOGLE_REDIRECT_URI=http://localhost:3001/auth/callback
SESSION_SECRET=<random 32+ char string, e.g. `openssl rand -hex 32`>
ALLOWED_EMAILS=adam.standridge@gmail.com,isblackhawk07@gmail.com
PORT=3001
```

Plus Turso / Odds API keys for the pipeline (see `.env.example` for the full list).

## 4. Install + migrate + serve

```bash
npm install
node cli.js migrate     # idempotent — creates schema + seeds venues
node cli.js serve       # launches dashboard on http://localhost:3001
```

Open <http://localhost:3001>, click **Sign in with Google**, authenticate with a whitelisted address. You should land on the dashboard.

Non-whitelisted accounts get a generic "Not authorized" page with no leaked info.

## 5. Railway deploy

- Add the same `.env` vars in the Railway service's **Variables** tab.
- Set `NODE_ENV=production` — this flips `cookie.secure = true` so sessions require HTTPS.
- Make sure `GOOGLE_REDIRECT_URI` matches the Railway origin exactly, and that redirect URI is registered in Google Cloud Console.
- Start command: `node cli.js serve`

## 6. Data flow

The dashboard only reads the Turso DB. To populate it, run the pipeline:

```bash
mlbie fetch --date today     # ingest schedule, starters, lines
mlbie signal --date today    # run 6 agents + XGBoost + Judge
mlbie trade --dry-run        # log paper trades for TRADE-decision games
mlbie settle                 # pull outcomes for open trades
```

Reload the dashboard — new signals appear on the current date's pill.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Redirected back to `/login?error=oauth_failed` | Redirect URI mismatch. Copy the exact Railway origin into Google Cloud Console. |
| "Not authorized" after sign-in | Your email isn't in `ALLOWED_EMAILS`. Add it and restart. |
| Dashboard loads but everything is "—" | DB is empty. Run `mlbie fetch` + `mlbie signal`. |
| Cookies not persisting on Railway | Confirm `NODE_ENV=production` and `trust proxy` is on (it is by default in `server/index.js`). |
