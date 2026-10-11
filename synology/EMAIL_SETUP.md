# Turn on email alerts for clients.genvyd.com (brief for Muse)

The portal can email Anthony a short summary whenever clients approve, request
changes, comment, favorite or pick ads for a campaign (at most one email every
15 minutes, only when something happened). It sends through Resend (free plan).
Do only these steps.

Ground rules: never enter payment details or pick a paid plan. The API key is a
password: paste it only into the Cloudflare secret in step 3, never into a chat,
file or report.

## 1. Create the Resend account

1. Go to resend.com and sign up with **behindthecamera7@gmail.com** (this exact
   email matters: until a domain is verified, Resend only delivers to the address
   the account was created with).
2. Stay on the **Free** plan.

## 2. Create an API key

1. Resend dashboard > **API Keys** > **Create API Key**.
2. Name `genvyd-clients`, permission **Sending access**, domain **All domains**.
3. Copy the key (it starts with `re_` and is shown once).

## 3. Give the key to the portal

1. Cloudflare dashboard > Workers & Pages > **genvyd-clients** > Settings >
   **Variables and Secrets** > **Add**.
2. Type **Secret**, name `RESEND_API_KEY`, value = the key from step 2. Save and deploy.

## 4. Test

1. Anthony opens clients.genvyd.com > **Admin**. The **Email alerts** card should
   say "On".
2. Click **Send test email**. Anthony checks his Gmail (and the spam folder the
   first time; mark it "Not spam").
3. Report back: whether the card says On and whether the test email arrived.

## 5. Emails to clients about new work (needed for client alerts)

Resend only lets the shared test address email Anthony himself. To email clients,
verify a sending subdomain. Use a SUBDOMAIN so genvyd.com's existing email is never
touched.

1. Resend > **Domains** > **Add Domain** > `notify.genvyd.com`.
2. Resend shows a few DNS records (TXT and MX, all on `notify.genvyd.com` or names
   under it). In Cloudflare > genvyd.com > **DNS** > **Records**, add each one exactly as
   shown. Do NOT change or delete any existing record, and do not touch records for
   the bare `genvyd.com`. For any record Cloudflare offers to proxy, choose **DNS only**.
3. Back in Resend click **Verify**. Wait until it says Verified (can take a few minutes).
4. Report the verified domain to Anthony. Claude then sets
   `CLIENT_NOTIFY_FROM` to `Genvyd <studio@notify.genvyd.com>` in the code and pushes.
