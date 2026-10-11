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

## Not needed now

Verifying a sending domain in Resend (so emails come from an @genvyd.com address)
is optional. If Anthony wants it later, use a subdomain such as `notify.genvyd.com`
so the DNS records never touch genvyd.com's existing email.
