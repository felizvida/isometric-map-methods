# End-to-end toolkit: from open data to an interactive map

Two steps take a small area from public data to a map you can open in a browser: get the source files, then build. The map can be turned and clicked, it can be lit for any date and time, and you can walk through it at eye level. Everything is plain Node.js 22+ with no packages. The map needs a browser with WebGL2, and nothing runs on a server.

```bash
node toolkit/build.mjs --sample --out=work/sample                                  # try it now: the bundled sample, offline
node toolkit/build.mjs --source=work/myarea/source --bbox=W,S,E,N --out=work/myarea   # your own area, from downloaded files
open work/myarea/map.html                                                           # (or double-click it)
node toolkit/render.mjs --layers=work/myarea/layers --out=work/myarea/preview.png   # optional still picture
```

| Script | Does | Reads | Writes |
| --- | --- | --- | --- |
| [`build.mjs`](build.mjs) | Converts sources to layers, builds the scene, writes content-addressed packs and a self-contained viewer | `--source` (with `--bbox`), `--layers` or `--sample` | `<out>/layers/`, `<out>/scene/` (packs and `meta.json`), `<out>/map.html`, `<out>/summary.json` |
| [`render.mjs`](render.mjs) | Software isometric render (the tutorial's z-buffer), no GPU | a layers folder | a PNG |
| [`viewer/`](viewer/) | The map: WebGL2, readable ES modules, bundled into `map.html` by `build.mjs` | the packs | nothing |
| [`fetch.mjs`](fetch.mjs) | Downloads the sources by script, only where each host's `robots.txt` allows it (see below) | the internet | `<out>/source/` with `provenance.json` |

## Getting the source files

A source folder holds three files. Download them by hand from the publishers' own download pages, which are meant for exactly this, and keep the areas small (a few hundred metres to a kilometre or two).

| File | Where from | How |
| --- | --- | --- |
| `map.osm` | OpenStreetMap, [openstreetmap.org](https://www.openstreetmap.org/) | Zoom to the area, choose **Export**, "Manually select a different area", draw a box slightly larger than your area, and **Export**. This saves `map.osm` (OSM XML; the page limits the size, so keep the box small). Write down the box as W,S,E,N. |
| `dem.tif` | USGS 3DEP, [The National Map Downloader](https://apps.nationalmap.gov/downloader/) | Choose Elevation Products (3DEP), the 1 meter DEM where available (else 1/3 arc-second), and download the GeoTIFF tile that covers the area. Clip it to the area plus about 30 m and reproject it to longitude/latitude (EPSG:4326), keeping 32-bit float values. In QGIS: Raster ▸ Projections ▸ Warp (Reproject), target EPSG:4326, with "clip to extent". With GDAL: `gdalwarp -t_srs EPSG:4326 -te W S E N -ot Float32 tile.tif dem.tif`. |
| `structures-0.geojson` (optional, US only) | [USA Structures](https://gis-fema.hub.arcgis.com/datasets/fedmaps::usa-structures/about) | Download your state's data, clip it to the area in a GIS, and export GeoJSON in EPSG:4326 keeping the fields `HEIGHT`, `OCC_CLS`, `SOURCE`, `IMAGE_DATE` and `VAL_METHOD`. Without it, heights come from OpenStreetMap tags or defaults. |

Then `node toolkit/build.mjs --source=work/myarea/source --bbox=W,S,E,N --out=work/myarea`. Outside the United States, use any bare-earth elevation GeoTIFF with the same preparation, and leave out the structures file. Keep a note of where and when you downloaded each file, and its licence: `build.mjs` copies the attribution into the map, but the record of dates is yours.

**Downloading by script.** `fetch.mjs --bbox=W,S,E,N --out=DIR` does the same downloads automatically from the publishers' services. It reads each host's `robots.txt` first and never requests a path it disallows. It fails closed: only a missing robots.txt (404 or 410) counts as no rules, and any other answer (403, 429, 5xx, no connection) stops all requests to that host. When we checked on 2026-11-15, all three services refused automated access this way: the Overpass API's robots.txt disallows `/api/interpreter`, and the USA Structures and 3DEP services answer robots.txt requests with 403. So the script stopped, as designed, and the hand download above is the supported route. The script stays because hosts change their rules and because it shows how to fetch politely: robots.txt first, an identifying User-Agent, small requests, polite retries, `--dry-run`, and a `provenance.json` with each file's time, size, SHA-256 and licence, written after every file. A rerun reuses a file only if `provenance.json` records it with the same hash, resumes structures pages where it stopped, and refuses a folder made for a different box. Never work around a refusal.

The data keeps its own licences, and anything you make from it must carry the attribution. The viewer shows the attribution line automatically.

| Source | Licence | Attribution |
| --- | --- | --- |
| OpenStreetMap | ODbL 1.0; a database you publish from it must be ODbL too | © OpenStreetMap contributors |
| USA Structures | CC BY 4.0 | USA Structures: Oak Ridge National Laboratory (ORNL) and FEMA Geospatial Response Office |
| USGS 3DEP | Public domain | Map services and data available from U.S. Geological Survey, National Geospatial Program. |

## What build does, in order

Each rule and constant is explained in [`../public-docs/ALGORITHMS.md`](../public-docs/ALGORITHMS.md). The section numbers below refer to it.

1. **Layers** (`lib/osm.mjs`, `lib/terrain.mjs`). OpenStreetMap XML (`map.osm`) and Overpass JSON (`osm.json`) are read alike; relations such as multipolygon buildings are skipped, as are ways cut by the export box.
   - OpenStreetMap elements get one generic `kind`: building, road, service, footway, sidewalk, crossing, path, cycleway, park, grass, wood, water, parking, pitch, playground, fence, wall, hedge, tree or opening. Names, addresses and all other tags are dropped.
   - Structures keep their height and four descriptive fields.
   - The elevation raster is sampled bilinearly at 2 m nodes in a local tangent plane centred on the box (§1). These are the tutorial's layer formats, so the tutorial scripts read them too.
2. **Terrain.** Adaptive quadtree leaves to 0.25 m tolerance, joined without cracks by `methods/terrain.mjs` (§2). The build stops if a crack is found.
3. **Buildings** (`methods/buildings.mjs`, §3). For each footprint:
   - the height comes from the priority list;
   - the roof form is built on its oriented box;
   - it is seated on the slope (pad = 90th percentile of the ground along the walls, walls down to the lowest point);
   - it gets per-vertex facade attributes for the window shader.
4. **Ground texture** (§4). Areas are filled, then roads, paths and markings are stroked at their widths into one image, at 0.25 m per pixel or coarser for large areas (at most 2048 pixels a side).
5. **Trees** (§5). Mapped trees, plus a jittered 4 m grid scatter by land cover, kept clear of buildings and paved surfaces. The pseudo-random generator is seeded by the area's name, so the same layers and name give the same trees.
6. **Walls and the walking network** (§6, §7).
   - Walls are building outlines plus fence, wall and hedge lines, with gaps cut at gates.
   - The network is built from footways and streets. Links that cross a wall or run inside a building are pruned, and the strongly connected core is marked.
7. **Packs** (`methods/packs.mjs`, §12): `info`, `terrain`, `ground`, `buildings`, `trees`, `walk` and `sky`. Each is saved as `<name>.<sha256[:12]>.json`, with `meta.json` listing the hashes. The same inputs always give the same bytes, so a later build can be compared pack by pack with `diffRecords`.
8. **map.html.** `lib/bundle.mjs` inlines the viewer's modules and the packs into one file. It loads nothing from the network.

`summary.json` records the numbers: buildings by height source, terrain triangles, trees, walls, gaps, and network links kept and dropped. Check it after every build: a jump in "default" heights or dropped links is the first sign of a data problem.

## The viewer

- **Map:** orthographic isometric view (tilt 35.264°). Drag to pan, scroll to zoom about the cursor, right-drag or Shift-drag to rotate. E turns a quarter. Click a building for a card with its height and where the height came from.
- **Light:**
  - The sun is placed by the NOAA formulas for the chosen date and time (your browser's time zone), with soft 5-tap shadow maps.
  - Sky colours blend between day, golden hour and night.
  - At night, moonlight replaces sunlight and windows glow by occupancy.
  - Daylight (L) shows noon today.
- **Seasons:** trees turn by day of year: leaves, autumn colours, browning, bare winter crowns and spring blossom.
- **Walk (V):** eye height 1.7 m, field of view 68°, near plane 0.12 m.
  - Move with W A S D or the arrows (Shift runs ×2.3) and drag to look.
  - Click the ground to be walked there along the network (A*).
  - Every move is swept against the walls and then pushed out to a 0.3 m body radius, so you cannot pass through a wall even at a low frame rate.
  - At night the stars from `sample/stars.json` are drawn where they are (local sidereal time), with the moon at its place and phase.
- **Links:** `map.html#time=2026-06-21T18:30&az=135&zoom=2` or `#walk=x,y,headingDeg` opens a given view. The same options can be set as `window.VIEWER_OPTIONS`.
- **Served instead of opened:** serve the repository with any static server and open `toolkit/viewer/index.html?scene=/work/myarea/scene/`. The viewer then fetches the packs and checks each SHA-256 against `meta.json` before use.

## Limits

This is a block model by rule: extruded footprints, simple roofs and windows drawn by a shader. It does not model hand-fitted building forms, interiors, traffic or people. [`ALGORITHMS.md`](../public-docs/ALGORITHMS.md) describes those methods. Heights are only as good as their source. The card says which source each one came from, and USA Structures marks most heights "Unverified". Terrain and footprints come from different surveys and can disagree by a metre or two. Large areas build slowly: the ground texture and tree scatter are simple loops written for clarity, not speed.
