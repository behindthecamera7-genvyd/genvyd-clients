# Results files (for Claude)

Each client has a **Results** tab on clients.genvyd.com showing how their ad campaigns are
doing, in plain language with traffic-light colors. The portal only reads files; Claude
writes them. Clients can't edit them.

## Where

One JSON file per campaign, in the client's `Results` folder on the Synology:

```
/Volumes/GenvydClients/<client folder>/Results/<Campaign name>.analytics.json
```

Example: `/Volumes/GenvydClients/Wycoga/Results/WYCOGA Sales Test 1.analytics.json`.
The portal makes the `Results` folder the first time Anthony opens the Results tab. Update
the same file each time (don't make a new one per day). The page re-reads it on every visit.

## Shape

```json
{
  "campaign": "WYCOGA Sales Test 1",
  "status": "Active",
  "start": "2026-10-27T08:00:00-07:00",
  "end": "2026-11-02T23:59:00-07:00",
  "budget": 250.00,
  "currency": "USD",
  "updated": "2026-10-28T09:00:00-07:00",
  "summary": "Plain-language note, 1 to 3 sentences.",
  "recommendation": "Optional next step, 1 sentence.",
  "benchmarks": {
    "ctr": { "good": 1.0, "ok": 0.5 },
    "cpc": { "good": 1.00, "ok": 2.00 },
    "cost_per_purchase": { "good": 25.00, "ok": 45.00 },
    "roas": { "good": 2.0, "ok": 1.0 }
  },
  "totals": { "spend": 84.12, "impressions": 9800, "reach": 7100, "link_clicks": 132,
              "ctr": 1.35, "cpc": 0.64, "add_to_cart": 9, "purchases": 2,
              "revenue": 76.00, "cost_per_purchase": 42.06, "roas": 0.9,
              "shopify_orders": 2, "shopify_revenue": 76.00 },
  "daily": [ { "date": "2026-10-27", "spend": 40.10, "impressions": 4700,
               "link_clicks": 61, "add_to_cart": 4, "purchases": 1, "revenue": 38.00 } ],
  "ads": [ { "name": "Static Golf", "preview": "Final ads/Static Golf - Facebook Feed.png",
             "status": "Active", "spend": 30.00, "impressions": 3500, "link_clicks": 51,
             "ctr": 1.46, "cpc": 0.59, "add_to_cart": 4, "purchases": 1, "revenue": 38.00,
             "daily": [ { "date": "2026-10-27", "spend": 14.00, "link_clicks": 22 } ] } ]
}
```

Rules:
- `status`: Active, Paused, Ended or Scheduled. Ended campaigns move to "Past campaigns".
- Dates are ISO 8601 with the time zone offset. `daily[].date` is `YYYY-MM-DD`.
- `ctr` is a percent (1.35 means 1.35%). `roas` is a multiple (2.0 means $2 back per $1).
- Use `null` for any number you don't have. Never write 0 for "unknown": the page shows
  "n/a" for null and a real 0 as 0.
- `preview` is a path inside the client's folder (the ad's image or video), so the
  thumbnail opens the ad in the portal.
- `ads[].daily` is optional. When present, the chart's "By ad" switch draws one line per ad.
- `benchmarks` is optional; the values above are the defaults.
- Copy the numbers from Meta Ads Manager (and Shopify for `shopify_orders` and
  `shopify_revenue`) exactly. Don't estimate. Write `summary` and `recommendation` in plain
  language for a small business owner. No jargon, no em-dashes.

## What the portal does with it

- Ratings: click rate and return (higher is better), cost per click and cost per sale
  (lower is better) against the benchmarks: green "Doing well", amber "Okay", red "Needs
  work". Gray "Too early to tell" while under $10 spent or under 500 impressions.
- "Leading" goes to the ad with the best click rate (not counting ads that are too early to
  rate). "Underperforming" goes to an ad that spent at least $10 and has a red click rate.
- Budget bar: green "On pace" within 15% of even spending, amber otherwise.
- An "Early days" note shows for the first 3 days or under 500 impressions.
- The client can download a one-page color PDF report and leave comments.

Claude sees who opened each campaign's results, and any comments, in
`_Claude feed/client-feedback.md` under "Campaign results".
