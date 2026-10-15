# Final ad screenshots (brief for Muse)

Anthony's clients review finished ads on clients.genvyd.com, on the **Ad review** tab.
That page shows screenshots of each ad exactly as people will see it on Facebook and
Instagram. Your job is to take those screenshots and save them in the right folder with
the right names. The portal picks them up on its own. You do not need to log in to the
portal or upload anything.

## Ground rules

- Look, do not change. In Meta Ads Manager, only open ads and their previews.
- Never click Publish, Review and publish, Turn on, or anything that makes an ad go live.
- Never change a budget, schedule, audience, payment method, ad text or creative. If the
  ad looks wrong (typo, wrong image, cut-off text), screenshot it anyway and tell Anthony
  what you saw. Do not fix it yourself.
- Never enter payment details or approve a charge.
- On the Synology: only add new files inside the client's `Final ads` folder. Do not
  rename, move or delete anything, and never overwrite an existing file (the one exception
  is updating an ad's `.copy.txt` text file, see 3b).

## 1. Find the ad preview

1. Open Meta Ads Manager in the browser on the Mac mini, in the client's ad account
   (Anthony tells you which client and which ads).
2. Open the ad (a draft or paused ad is fine) so the **Ad preview** panel shows on the right.
3. Use the placement switcher in the preview panel to step through the placements below.
   Skip any placement the ad does not run on.

Placements, in this order:

- Facebook Feed
- Instagram Feed
- Instagram Stories
- Instagram Reels
- Facebook Reels (only if the ad uses it)
- Facebook Stories (only if the ad uses it)

## 2. Take each screenshot

- Capture only the phone preview, from the top of the frame to the bottom, with nothing
  else around it (no side panels, menus or cursor). On macOS: Cmd + Shift + 4, then drag
  around the preview. Save as PNG.
- Make sure the whole ad is visible: headline, primary text (expand "See more" if the
  preview offers it), image or first frame of the video, and the button.
- For video ads, pause on a frame that shows the product clearly.

## 3. Name and save

Save each screenshot here (the Synology share is mounted on the Mac at /Volumes/GenvydClients):

```
/Volumes/GenvydClients/<client folder>/Final ads/<Ad name> - <Placement>.png
```

- `<client folder>` is the client's own folder in the GenvydClients share (for example
  `WYCOGA`). Create `Final ads` inside it if it is not there yet. Spell it exactly
  `Final ads`.
- `<Ad name>` is the ad's name, the same for every placement of one ad, so they show
  together. Keep it short and plain: `Golf Polo`, `Weekend Hoodie`.
- `<Placement>` is one of the names in the list above, spelled the same way.
- There is a space, a hyphen and a space between the two: `Golf Polo - Instagram Feed.png`.

Optional: to group a batch, put it in one subfolder, for example
`Final ads/Fall golf/Cart Bag - Facebook Feed.png`. Only one level of subfolders.

## 3b. Save the ad's text next to the screenshots

The client approves the wording too, and the portal shows it right under the screenshots.
For each ad, copy the text exactly as it appears in the ad (do not change anything) into a
plain text file in the same folder, named after the ad with no placement:

```
/Volumes/GenvydClients/<client folder>/Final ads/<Ad name>.copy.txt
```

For example `Golf Polo.copy.txt` next to `Golf Polo - Instagram Feed.png`. One line per piece,
starting with its label:

```
Headline: Polo that plays all 18
Primary text: Breathable, stretchy, made for the course.
Second paragraph of the primary text can go on the next lines.
CTA: Shop now
```

Labels: `Headline:`, `Primary text:`, `Tagline:`, `CTA:`, `Caption:`. Lines without a label
belong to the line above. If the ad has several text options (Meta lets an ad have up to 5
headlines and 5 primary texts), give each its own labelled line. The portal reads the file on
its own within about 15 minutes, or as soon as anyone opens Ad review.

When the ad is revised (v2), update the same `.copy.txt` file instead of making a new one. This
is the one file you may change: the portal keeps approved lines and sends changed lines back
to the client for approval.

## Carousel ads (several cards people swipe through)

Same steps, but one screenshot per card per placement. In the preview, swipe or click to each
card in turn and capture it. Put the card number right after the ad name, before " - ":

```
Holiday Hats card 1 - Facebook Feed.png
Holiday Hats card 2 - Facebook Feed.png
Holiday Hats card 3 - Facebook Feed.png
Holiday Hats card 1 - Instagram Feed.png
...
```

The portal shows them as one carousel ad, placement by placement, in card order. Keep the ad
name identical on every file. If only one card changes, add v2 after its card number and leave
the others alone: `Holiday Hats card 2 v2 - Instagram Feed.png`.

## 4. After the client asks for changes

When Anthony has fixed an ad and asks for new screenshots, do not replace the old ones.
Add a version number after the ad name and save new files next to the old ones:

```
Golf Polo v2 - Instagram Feed.png
Golf Polo v2 - Instagram Stories.png
```

The portal shows the newest version and sends it back to the client for approval.

## 5. Report back

Tell Anthony which ads and placements you saved and where, and anything that looked off
in the previews. Never paste passwords, codes or account numbers into your report.
