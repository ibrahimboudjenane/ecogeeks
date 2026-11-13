# Eco Geeks Club – Forest Fire Awareness site

Netlify site: static pages in `public/`, API in `netlify/functions/api.js`,
data stored in Netlify Blobs (one shared database for visitors and admin).

## Deploy (about 5 minutes)

1. Create a GitHub repo and upload this whole folder (or use Netlify Drop / `netlify deploy`).
2. In Netlify: **Add new site → Import an existing project** → pick the repo.
   Build settings can stay empty: publish directory `public`, functions `netlify/functions` (already in `netlify.toml`).
3. **Site configuration → Environment variables**, add two secrets:
   - `QR_SECRET` – a long random string (e.g. 64 hex characters). Keep it private; it signs every QR code.
   - `ADMIN_TOKEN` – the private password you type on the Admin tab. Use a long random string.
4. Deploy. Your public link is `https://<your-site>.netlify.app`.

Generate secrets with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

> Changing `QR_SECRET` invalidates all QR codes already printed, so set it once and do not change it.

## How it works

- **Visitors** create an account or log in, then scan a QR code with the camera
  (or paste the code text). Genuine codes create a *pending* win; fake or damaged codes show an error.
- **Admin** logs in with `ADMIN_TOKEN`, adds challenges (name + points), downloads each QR code as a PNG,
  and confirms or rejects pending wins. The list can be filtered by pending / confirmed / rejected.
- Each QR code holds `{"n": name, "p": points, "s": signature}`; the signature is an HMAC made with `QR_SECRET`,
  so visitors cannot forge codes.

## Endpoints (for reference)

| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/api/register` | visitor | create account |
| POST | `/api/login` | visitor | log in |
| POST | `/api/scan` | logged-in visitor | submit a scanned code |
| GET / POST | `/api/admin/challenges` | admin | list / add challenges |
| GET | `/api/admin/wins?status=` | admin | list wins |
| POST | `/api/admin/wins/:id` | admin | `{"status":"confirmed"}` or `"rejected"` |

## Local test

```
npm install
npx netlify dev
```
(Needs the Netlify CLI: `npm i -g netlify-cli`. Set `QR_SECRET` and `ADMIN_TOKEN` in a `.env` file first.)
