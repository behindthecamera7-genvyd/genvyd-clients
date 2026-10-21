# Campaign summary files (for Claude and Muse)

Before a campaign launches, the client approves a written summary on clients.genvyd.com.
The portal shows it as a card pinned at the top of the folder it is in, with a big
"NEEDS YOUR APPROVAL" badge, plus a banner on the client's home page. The client ticks a
box, types their name, and confirms. That approval is the record that they accepted the
campaign exactly as shown.

## Where and how to save it

Save one plain Markdown file per campaign in the client's folder on the Synology:

```
/Volumes/GenvydClients/<client folder>/<any folder>/<Campaign name>.summary.md
```

Example: `/Volumes/GenvydClients/Wycoga/Final ads/WYCOGA Sales Test 1.summary.md`

The file name (without `.summary.md`) is the campaign name the client sees.

## What goes in it

Optional front matter at the very top, then the summary in Markdown:

```
---
ads:
  - Final ads/Golf Polo - Facebook Feed.png
  - Final ads/Golf Polo - Instagram Stories.png
  - October Ads/WYCOGA Ponytail motion ad 4x5 feed.mp4
budget: "$500 lifetime"
start: "On approval"
end: "2026-11-06"
---
# WYCOGA Sales Test 1

What runs, the price and link for each product, the audience, the budget and the dates.
```

- `ads`: paths inside the client's folder (as above), or just a file name if the ad is in
  the same folder as the summary. Each one shows as a thumbnail under the summary, with the
  text of its `.copy.txt` file underneath (found the same way the portal always matches
  copy files to ads). If a listed file is missing, the client cannot approve until it is fixed.
- `budget`, `start`, `end`: shown as labels at the top of the card.
- The body can use headings, **bold**, *italics*, numbered and bulleted lists, `> quotes`,
  links and simple tables. Write in plain language. No em-dashes.

Write out everything the client is agreeing to: every ad, each product's price and link,
the audience, the budget, and the dates.

## After approval

Do not edit the summary, the listed ads or their copy files once the client has approved.
Any change (even re-saving a file) cancels the approval: the portal records
"Changed since approval, needs re-approval" and asks the client again. That is on purpose.
If something must change, change it, and the client approves the new version.

If the client asks for changes, update the file. The card then tells them it was updated
and asks them to review it again.

## Where the record lives

The portal keeps every approval, change request and reset (who, typed name, time in UTC and
Phoenix, IP address, device, a SHA-256 of the summary and copy files, each ad's name, size
and date, and a frozen copy of the text). Records cannot be edited or deleted. Anthony can
download any approval as a PDF from "Approval history" on the card.

Claude can see the status of every campaign in `_Claude feed/client-feedback.md` (section
"Campaign approvals") and one line per approval in `_Claude feed/approvals-log.md`. Never
write approval notes or records inside client folders.
