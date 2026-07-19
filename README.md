# Issy & Billy — wedding websites

Static sites for Issy and Billy's wedding (Saturday 12th September 2026, Walthamstow Wetlands Engine House, London). Implemented from the claude.ai/design project "Wedding Site.dc.html".

Three sites share one design (CSS/JS/assets) and deploy as one Vercel project, with each domain routed to its page by the host-based rewrites in `vercel.json`:

- `/index.html` — the main (London) wedding site, served on the primary domain
- `/north/index.html` — the northern wedding
- `/party/index.html` — the evening party (reduced schedule, no gifting/parking)

To wire up the new domains: replace the placeholder hosts in `vercel.json`, add all domains to the Vercel project, and point their DNS at Vercel. Any page can be previewed on any deployment by path (`/north/`, `/party/`).

## Run

Any static file server works:

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## Confetti

The oversized confetti pieces are rendered with Three.js and fold/flip over like paper when you move the cursor across them (flat shading — the two faces differ only by a slight tint). The canvas is anchored to the page and scrolls with it: dense scatter over the hero, green rectangles on the sides alongside the yellow-dot schedule, mixed shapes on the sides further down.

## Structure

- `index.html` — all content; the schedule staggers down the page on yellow dots
- `css/styles.css` — design tokens (colors, type) + page layout
- `js/confetti.js` — the fold/flip confetti (mode selection, Three.js scene, fold shader)
- `vendor/three.min.js` — Three.js r128, vendored
- `assets/fonts/` — Moulin Regular (Trial), TT Commons Medium

## Font licensing

Moulin is a **trial** font (Commercial Type) and TT Commons is a licensed font (TypeType). Confirm licensing before pointing a public domain at this.
