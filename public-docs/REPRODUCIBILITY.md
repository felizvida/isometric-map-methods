# Reproduce the methods

Use Node.js 22+ and Python 3.12+ with the pinned NumPy dependency. CI tests Node.js 22 and 24 with Python 3.12 and 3.13. Follow the root README commands.

Most checks create synthetic inputs; the tutorial and toolkit checks use the bundled open-data sample. Temporary-file contexts remove their files, and nothing is downloaded. The checks need neither the original application nor any site dataset. They reproduce the reference methods and the sample map, not the original map or its painting.

Tests cover:

- the tutorial: steps 1 to 4 reproduce `expected.json` and `preview.png`, and steps 5 to 7 report the documented results on the sample;
- the toolkit: grid-sized inputs (a 1.2 km² terrain, 300,000 lidar samples) without stack overflows; the download script keeps provenance through an interrupted run, reuses a file only when its recorded hash matches, and refuses service error bodies, non-TIFF elevation answers and a folder made for another box; a hand-downloaded `map.osm` + `dem.tif` folder builds; OSM and structures conversion drops names and addresses; a GeoTIFF becomes the terrain grid; robots.txt rules; the sample scene is deterministic, crack-free, and its walking network never crosses a wall; packs verify; `map.html` has no imports or remote resources;
- sun peak elevation and equinox sunrise, the equation of time, sidereal time, pole-star elevation, moon phase at known dates, the star rotation matrix against per-star positions, star limits and season weights;
- swept movement never escaping a closed room in 1,000 random long steps, sliding, joints between segments, push-out, fence openings, walls sliced from a mesh;
- graph welding, A*, the main network excluding islands and one-way dead ends, pruning by walls, pavement offsets;
- the oriented box, height priority, seating on a slope, every roof form covering its box and facing upward, bay layouts;
- lidar rasters ignoring noise, hole filling, two roof levels recovered, agreement and audit classes;
- canonical JSON, packs that fail closed on tampering, appearance versus label hashes;
- IDM, lane offsets, junction radii, U-turn end points and turn weights;
- terrain triangle area, coverage and paired interior edges across a coarse/fine boundary;
- projection/inverse agreement, isometric foreshortening and saddle winding;
- duplicate, old, future, stale, implausible and reduced-motion fixes;
- known shift recovery, ambiguous rejection and non-wrapping translation;
- semantic selection, alpha, bounded gains and transparent-colour isolation;
- coverage/context metrics, settings hashes, resume rejection, unsafe paths and links.

Tests do not establish large-scale performance, real-world geographic accuracy, image-model quality or operational readiness. `toolkit/fetch.mjs` talks to live public services, so it is not run in CI. It obeys `robots.txt` and fails closed; on 2026-11-15 all three services refused automated access, so build from hand-downloaded files instead (toolkit README). The tests cover the hand-download route with a synthetic `map.osm` and `dem.tif`.

## Record your own run privately

Record input checksums, CRS/datum/units, geometry revision, camera, dimensions, overlap, appearance direction, tool version, seed when supported, settings hash, attempts and accepted-frame hashes. A seed alone does not guarantee identical generated pixels.

On resume, verify settings and input hashes. Skip only outputs with accepted status and verified hashes. Preserve failed attempts separately. For a service usage limit, record the stop reason, wait for permitted availability and rerun the same immutable command. Do not silently change model, quality or parameters.

Report accepted-frame count, context flags, coverage flags, failures, mosaic location and replacement/backup verification. Keep actual run logs, outputs and paths in the private project outside the public methods tree.
