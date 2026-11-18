# Invoice files (for Anthony, Claude and Muse)

Clients see their invoices on the **Invoices** tab of clients.genvyd.com, with a banner on their
home page for anything unpaid. The portal only reads the PDFs. It never changes or deletes them.

## Where and how to save one

Save the invoice PDF in the client's `Invoices` folder on the Synology:

```
/Volumes/GenvydClients/<client folder>/Invoices/<name>.pdf
```

The folder is made the first time Anthony opens the client's Invoices tab. It never shows as a
project, and invoices never trigger "new work" badges or emails.

Put the number, amount and due date in the file name so nothing has to be typed in:

```
INV-1001 Website build $1,250 due 2026-12-01.pdf
INV-1002 November ads $480.00 issued 2026-11-18 due 2026-12-02.pdf
```

- `INV-1001` or `Invoice 1001`: the invoice number.
- `$1,250` or `$1,250.00`: the amount.
- `due 2026-12-01`: the due date (year-month-day). `issued 2026-11-18` is optional; without it
  the file's date is used.
- Whatever is left ("Website build") is shown as what the invoice is for.

Anything missing can be filled in on the portal with **Edit details**, which also overrides the file
name. No em-dashes.

## Getting paid

Each unpaid invoice shows the ways to pay:

1. **Pay by check (no fee)**: who to make it out to and the mailing address, from **Payment details**
   on any Invoices tab (shared by every client).
2. **Pay by card**: the client presses the button and the portal opens a Stripe checkout for that
   invoice with the card service fee as its own line. When Stripe confirms the payment the invoice
   marks itself paid and Anthony gets it in the email digest. Nothing to do in Stripe per invoice.
   The fee is worked out so that, after Stripe's 2.9% + 30 cents, Genvyd receives the invoice amount,
   and it is never more than 3% of the invoice. It can be switched off in Payment details.
3. **Pay from your bank account (no fee)**: optional, switched on in Payment details. Stripe charges
   Genvyd 0.8% (at most $5). It takes about 4 business days to clear; the invoice shows "Payment on
   its way" until it does.

Setting up Stripe once: add the `STRIPE_SECRET_KEY` secret in Cloudflare (Workers & Pages,
genvyd-clients, Settings, Variables and Secrets), add a Cloudflare Access Bypass for
`clients.genvyd.com/api/stripe/webhook`, then press **Connect Stripe** in Payment details.
Without Stripe connected, a payment link pasted in Edit details still works as before.

Checks and anything paid outside Stripe: press **Mark paid** (check, card, bank transfer, cash or
other, plus the date and an optional note only Anthony sees). **Void** cancels an invoice; the
client sees it as cancelled. Both can be undone.

## Renaming

Paid status, links and typed-in details are stored by file name. Renaming a PDF in Finder makes it
look like a new, unpaid invoice, so rename only before it is marked paid, or mark it again after.

## For Claude

`_Claude feed/client-feedback.md` has an "Invoices" section per client: open invoices (overdue
first), whether the client has opened each one, and anything paid in the last 90 days.
