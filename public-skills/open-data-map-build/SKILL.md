---
name: open-data-map-build
description: Build an interactive isometric map of a small area from public data (OpenStreetMap, USA Structures, USGS 3DEP) with the repository's toolkit, check the result, and fix the usual data problems.
---

Work in a folder outside the repository's published tree (for example `work/<area>`). Never commit downloaded data to a methods repository. It keeps its publishers' licences, and the viewer shows their attribution.

1. **Choose a small box**, a few hundred metres to a kilometre or two. Write down W, S, E and N in degrees.
2. **Get the sources by hand** from the publishers' download pages (toolkit README, "Getting the source files"): `map.osm` from the OpenStreetMap Export page, a 3DEP elevation tile clipped and reprojected to EPSG:4326 float as `dem.tif`, and optionally a USA Structures extract as `structures-0.geojson`. Write down each file's source, date and licence. `toolkit/fetch.mjs` can do this by script only where each host's `robots.txt` allows it; it fails closed, and it stopped at all three services on 2026-11-15. Never work around a refusal or a bot wall.
3. **Build:** `node toolkit/build.mjs --source=work/<area>/source --bbox=W,S,E,N --out=work/<area>`. Outside the United States, use any bare-earth GeoTIFF and leave out the structures file.
4. **Read `summary.json` before looking at the map.**
   - Many "default" heights mean the structures data did not match. Check coverage and the area ratio, as the tutorial's step 5 does.
   - Many dropped walking links "crossing a wall" usually mean gates are missing from the mapped fences.
   - A terrain crack stops the build; it should never happen.
5. **Open `map.html` and check, in order:**
   - buildings stand on the ground at several places on slopes;
   - paths and roads match an orthophoto;
   - a building card names a sensible height source;
   - noon and night both read well;
   - at ground level (V), walking into a building or fence stops you, and clicking the ground walks you there.
6. **Fix data at its source when you can** (an OpenStreetMap edit, with care and its community rules). Otherwise, edit a copy of the layers and build with `--layers=`. Record every hand change with its evidence and date, and mark anything unmeasured as guessed.
7. **Compare builds pack by pack** (`methods/packs.mjs` `diffRecords`): geometry changes and label-only changes are different reviews.

Report the area, the source dates, the summary numbers, what you checked by eye, and every known gap. Do not claim survey accuracy: the heights are as published, and terrain and footprints come from different surveys.
