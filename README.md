# AT Section Tracker

A single-file web app for Appalachian Trail section hikers to track every mile they've hiked.

Live demo: _(GitHub Pages URL after deployment)_

## What it does

- All 14 AT states with **road-crossing-granularity** breakpoints (662 sections, ~2,115 mi)
- 322 named shelters as additional breakpoints
- Click to mark a section hiked; pick a date; add notes
- Shift-click a range to bulk-mark with one shared date
- Mark sections as **next planned hike** (flag icon) — separate state from hiked
- Planned-hike summary: total miles, elevation gain/loss, road access points, shelters along the way, estimated trip days
- Stats modal: longest unbroken stretch, hike days, miles per trip, year-by-year breakdown
- Multiple hiker profiles
- GPX export of hiked sections; GPX import to auto-match a recorded track
- Print-friendly trail journal mode
- Light/dark theme
- Save / share via URL fragment (no backend)
- Zoomable Leaflet map with OpenStreetMap and OpenTopoMap basemaps

## Files

- `index.html` + `app.js` — the webapp (open `index.html` over HTTP)
- `at_data.json` — bundled trail geometry, shelters, road crossings (~700 KB)
- `build_data.py` — regenerates `at_data.json` from OpenStreetMap + Open-Elevation

## Local development

```sh
python3 -m http.server 8765
# open http://localhost:8765
```

## Rebuilding the data

```sh
python3 build_data.py
```

OSM data is fetched per state via Overpass API (cached in `.cache/`). Elevation gain/loss is fetched from Open-Elevation per segment vertex (also cached). Re-running is fast after the first build.

## Data sources

- Trail geometry, shelters, road crossings: [OpenStreetMap](https://www.openstreetmap.org) (ODbL)
- Elevations: [Open-Elevation](https://open-elevation.com/) (CC-BY-SA, derived from public DEMs)
- Tiles: OpenStreetMap, OpenTopoMap

## License

MIT for the code. Underlying data carries the licenses of the upstream providers.
