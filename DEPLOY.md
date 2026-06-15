# Deploying Run From Stalin to your domain (spectrumcmg.com)

Your Hostinger **Single Web Hosting** can't run a .NET / WebSocket app, so we run the
game free on **Render.com** and point a subdomain of your domain at it.

End result: friends play at **https://stalin.spectrumcmg.com** (or any subdomain you pick).
Your existing website and email on spectrumcmg.com are untouched.

---

## Step 1 — Put the code on GitHub

Render deploys from a Git repo. From this folder:

```powershell
cd "C:\Users\mcloc\Downloads\RunFromStalin"
git init
git add .
git commit -m "Run From Stalin"
```

Then create an empty repo on github.com (e.g. `run-from-stalin`) and push:

```powershell
git remote add origin https://github.com/<your-username>/run-from-stalin.git
git branch -M main
git push -u origin main
```

## Step 2 — Deploy on Render

1. Sign up / log in at **render.com** (free).
2. **New +  →  Web Service**.
3. Connect your GitHub and pick the `run-from-stalin` repo.
4. Render auto-detects the **Dockerfile**. Settings:
   - **Instance type:** Free
   - Leave build/start commands blank (the Dockerfile handles it).
5. Click **Create Web Service**. Wait for the build (~2–4 min).
6. You'll get a live URL like `https://run-from-stalin.onrender.com` — test it.

> Note: Render's free tier sleeps after ~15 min idle, so the first visit after a quiet
> spell takes ~30s to wake up. Fine for game nights. (Paid tier removes this.)

## Step 3 — Attach your subdomain

1. In Render: your service → **Settings → Custom Domains → Add**.
2. Enter `stalin.spectrumcmg.com`.
3. Render shows you a **CNAME target** like `run-from-stalin.onrender.com`. Copy it.

## Step 4 — Add the DNS record in Hostinger

1. Hostinger hPanel → **Domains → spectrumcmg.com → DNS / Nameservers** (DNS Zone editor).
2. Add a record:
   - **Type:** CNAME
   - **Name / Host:** `stalin`
   - **Target / Points to:** `run-from-stalin.onrender.com`  (the value Render gave you)
   - **TTL:** default
3. Save. DNS can take a few minutes to a couple hours to propagate.
4. Back in Render, the custom domain will flip to **Verified** and issue HTTPS automatically.

Done — open **https://stalin.spectrumcmg.com**.

---

## Updating the game later

Just push changes; Render redeploys automatically:

```powershell
git add .
git commit -m "tweak gameplay"
git push
```
