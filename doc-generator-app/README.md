# Document Generator — PO / Quotation / Proforma / Tax Invoice

Your document generator (`public/index.html`), served by a small Express backend (`server.js`)
that also gives you free PDF text-extraction and optional AI scan-to-fill.

## Deploying on Railway (you already have an account)

1. Push this folder to the GitHub repo / Railway project you deploy from — or, if you prefer,
   use the Railway CLI from inside this folder:
   ```bash
   railway up
   ```
2. Railway detects `package.json` and runs `npm install` then `npm start` automatically.
   No extra config needed.
3. (Optional) In your service → **Variables**, add `ANTHROPIC_API_KEY` if you want the
   "Upload Document (Auto-Fill)" feature to also handle scanned photos/handwriting, or PDFs with
   an unusual layout. Plain digital PDFs already work without it.

## Connecting your existing domain

1. In the Railway dashboard, open your service → **Settings** → **Networking** → **Custom Domain**.
2. Click **Add Domain** and enter your domain (e.g. `invoices.yourdomain.com` or your root domain).
3. Railway gives you a **CNAME** (or sometimes an A record) to add.
4. Go to wherever your domain's DNS is managed (your domain registrar, or wherever you point
   your existing site's DNS) and add that record:
   - **Type:** CNAME
   - **Host/Name:** whatever subdomain you chose (e.g. `invoices`), or `@` for the root domain
     if Railway gives you an A record instead
   - **Value/Target:** the value Railway shows you
5. DNS changes can take a few minutes to a few hours to go live. Once it does, your domain will
   load this generator directly — Railway also issues the HTTPS certificate for you automatically.

If your domain currently points to a different site (e.g. your existing company website), using
a subdomain (`invoices.yourdomain.com` or `docs.yourdomain.com`) rather than the root domain is
usually simplest, since it won't touch your existing site's DNS records.

## What's pre-filled vs. blank
To keep this safe to put on a public URL, only your own company details are pre-filled by default
(company name, address, GSTIN, bank details) — reasonable since every document you create uses
them. Buyer, item, and document-number fields are blank, ready for a fresh document each time.

## How the auto-fill works (and why the API key is optional)
- **Digital PDFs** (e.g. from Tally) have real embedded text — `server.js` extracts and parses
  it for free, no API key needed.
- **Scanned photos / handwriting** have no embedded text — these need `ANTHROPIC_API_KEY` set,
  since there's nothing to read without AI or OCR.
- If a PDF's layout is too unusual for the free parser, it falls back to AI automatically
  (only if the key is set) — using just the extracted text, which is cheap.

## Other notes
- "Save Document Data" / "Load Saved Document" (buttons in the generator) save/load a `.json`
  file locally in the browser — no server involved, works regardless of hosting.
- File size for uploads is capped at 15 MB in `server.js`.
- Check `/health` on your deployed URL to confirm the server is running and whether the API key is configured.
