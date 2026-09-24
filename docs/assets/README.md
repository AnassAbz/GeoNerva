# Social cards

Two images for posts and talks, plus the HTML each was rendered from so they can be edited and
re-rendered rather than retouched.

| File | Size | Use |
| --- | --- | --- |
| `geonerva-social-square.png` | 2400 × 2400 | **Start here.** Square fills the LinkedIn mobile feed. Shows the pipeline and a sample answer, including the lines that refuse. |
| `geonerva-social-tall.png` | 2400 × 3000 | 4:5 portrait, the tallest LinkedIn renders. More text: the four properties spelled out. |

Both are rendered at `deviceScaleFactor: 2`, so the pixel dimensions are twice the CSS ones.

## Re-rendering

Any headless Chromium will do; Playwright is already a dev dependency of `apps/web`:

```js
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 1200 }, // 1200 x 1500 for the tall card
  deviceScaleFactor: 2,
});
await page.goto(pathToFileURL('docs/assets/geonerva-social-square.html').href);
await page.screenshot({ path: 'docs/assets/geonerva-social-square.png' });
await browser.close();
```

Check `document.documentElement.scrollHeight` against the viewport afterwards — content taller
than the frame is silently cropped, which is how a card loses its footer.

## One thing to keep honest

The sample answer in the square card is headed **"What one answer looks like"** rather than naming
a place and a time, because it is an illustration of the five availability states rather than a
screenshot of one reading. Each line is real behaviour, but that exact combination was not observed
at a single moment: when the release candidate was validated, cyclones read *nothing to report*
rather than *feed not read yet*. If the heading is ever changed to name a real place, the numbers
have to come from a real response.
