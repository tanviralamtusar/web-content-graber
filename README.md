# Web Content Grabber

A Chrome / Edge extension (Manifest V3) that saves the page you are looking at, **as it is rendered right now** (after JavaScript, logins, lazy loading and translation), into a single file.

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Pin the extension from the puzzle-piece menu.

## Use

Click the toolbar icon, then choose:

| Button | Result |
| --- | --- |
| **Save complete page** | One `.html` file with all CSS, images, fonts, same-origin iframes and shadow DOM embedded. Opens offline and looks like the live page. |
| **Markdown** | `.md` of the main content: headings, tables, code blocks, lists, links and images. |
| **Text** | `.txt` of the main content. |
| **Images** | Downloads every image on the page into `<page title> - images/`. |

Also available: the right-click menu on any page, plus the keyboard shortcuts **Alt+Shift+S** (HTML) and **Alt+Shift+M** (Markdown). You can change these at `chrome://extensions/shortcuts`.

### Options

- **Content area**: *Auto* saves the whole page as HTML but only the main article as Markdown/Text. *Whole page* includes everything. *Pick an area* lets you click the part to save; use ↑/↓ to widen or narrow the selection and Esc to cancel.
- **Scroll page first**: scrolls to the bottom so lazy-loaded images and sections load, then puts you back where you were.
- **Embed images, fonts & CSS assets**: turn this off for a small file that still links to the site.
- **Skip CSS assets the page never loaded**: embeds only the background images and font files the page actually uses. Unused ones keep their online URL. This keeps files small, which matters most on sites with large CJK web fonts.
- **Remove scripts**: on by default. It produces a static, reliable snapshot that can't re-render or redirect.
- **Ask where to save**: shows the Save As dialog.

## How it works

- `content/capture.js` clones the live DOM and copies state that cloning loses: form values, canvas pixels, the image source actually chosen from `srcset`, CSS-in-JS rules, adopted stylesheets, shadow roots and iframes. It then inlines stylesheets (including `@import`) and turns asset URLs into `data:` URIs.
- `background.js` fetches cross-origin files (CDN CSS, images, fonts) on the page's behalf, since extensions aren't limited by page CORS. It also starts the downloads.
- `offscreen/` creates blob URLs for downloads, because service workers can't. Blob URLs avoid the 2 MB cap on `data:` URLs.

## Limitations

- Browser-internal pages (`chrome://`, the Web Store) can't be captured.
- Cross-origin iframes (for example, embedded videos or maps) are kept as links, not embedded.
- Closed shadow roots are not accessible to extensions.
- Video and audio files are linked, not embedded.
