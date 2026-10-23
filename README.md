# Ravi Devarakonda - Portfolio

Personal portfolio and resume site, served by GitHub Pages at [portfolio.rssda.dev](https://portfolio.rssda.dev).

Plain HTML, CSS and JavaScript with no build step. Open `index.html` in a browser to preview changes.

When you change `assets/css/style.css`, `assets/js/script.js` or an image, bump its `?v=` number in `index.html`. GitHub Pages caches assets for 4 hours.

## Checks

`tests/check.mjs` drives headless Chrome at five widths in light and dark mode and checks layout, copy, links, theme colours and the section dots.

```bash
python3 -m http.server 8765 --bind 127.0.0.1
node tests/check.mjs http://127.0.0.1:8765/ --shots /tmp/shots
```

Needs Node 22+ and Google Chrome. Set `CHROME` to the browser binary if it isn't at the macOS default path.
