# Recreating the map without AI: the whole workflow

The original map was built by a small team: one owner who decided and approved, and two AI coding agents that wrote code, researched sources, reviewed each other and painted an optional illustrated layer. Every one of those jobs can be done by people with ordinary tools. This page gives the order of work, the decisions to make, and the checks that tell you each stage is done. The algorithms and their constants are in [ALGORITHMS.md](ALGORITHMS.md), and the runnable starting point is the [toolkit](../toolkit/README.md).

## What the agents did, and who does it instead

| Job in the original | Done by | Instead, without AI |
| --- | --- | --- |
| Writing the renderer, data build and tools | coding agents | a developer, starting from `toolkit/` and `methods/` |
| Finding sources: building records, photos, survey dates, licences | a research agent | a person reading public records, imagery and data catalogues, logging each source with its date and licence |
| Fitting hand-shaped buildings to lidar | agents, with lidar tools | a modeller using the lidar rasters and the audit in §13, in any 3D tool or by editing the piece lists |
| Reviewing each change | the other agent | a second person, using the same checklists and test numbers |
| Painting the illustrated tiles | an image model | optional: an illustrator, a procedural style (§16), or no painting at all; the live 3D map is the default view |
| Approving looks, deployments and publication | the owner | the owner (unchanged) |

## Tools

- **For the map:** Node.js 22+, Python 3.12+ with NumPy, and a browser with WebGL2.
- **For lidar:** a LAS/LAZ reader (for example laspy with lazrs, or PDAL).
- **Optional:** a GIS (for example QGIS) for looking at layers, and an image editor if you paint by hand.
- **For releases:** git, and a static web server or container host.

Nothing needs an account, an API key or a GPU beyond the browser's.

## Stage 1: scope and sources (a day)

1. Draw the area: the core where you will model carefully, plus a margin of surroundings that get automatic rules only. Keep the margin simple; effort spent outside the core rarely pays.
2. List the sources and check each one's terms before downloading:
   - footprints and roads (OpenStreetMap, ODbL);
   - structure heights (USA Structures, CC BY 4.0, in the US);
   - bare-earth elevation (USGS 3DEP, public domain);
   - classified lidar for roof measurement (3DEP point clouds, or a local survey if its licence allows your use);
   - orthophotos for checking.

   Local-government data that is free to view is often not free to redistribute. Read [DATA_SOURCES.md](DATA_SOURCES.md).
3. Fix the frame: an origin, the vertical datum and the geoid (§1). Write them down once and never mix them.
4. Download the three source files for a small test box by hand (toolkit README, "Getting the source files"), run `node toolkit/build.mjs --source=... --bbox=...`, and open the map. You now have a working baseline to improve. (The download script `toolkit/fetch.mjs` obeys `robots.txt` and fails closed; on 2026-11-15 all three services refused automated access, so the hand download is the supported route.)

**Done when:** the map opens, buildings stand on the terrain, and `summary.json` shows where every height came from.

## Stage 2: terrain and ground (a few days)

1. Build the terrain mesh from the DTM (§2). Check with the edge count that it is crack-free, and look at it flat-shaded under a low sun to find spikes or holes.
2. Grade roads and building pads (§2, grading). Look at kerbs and slopes at ground level. Roads should not climb kerbs, and buildings should neither float nor sink.
3. Draw the ground (§4): land cover, roads by width, paths on top, markings. Compare with an orthophoto at a few places.

**Done when:** at ground level, paths stay on the ground, kerbs are sensible, and no building floats or is buried.

## Stage 3: buildings (most of the work)

1. **Automatic heights for everything** (§3.1).
   - Review the "default" heights first: they have no source.
   - Then run the lidar audit (§13) over every footprint and sort by agreement.
2. **Classify each disagreeing building**:
   - phantom (remove it);
   - single height (fix it with the measured level);
   - trees over the roof (leave it, note it);
   - multi-level (it needs pieces).
3. **Model the important buildings as pieces** (§3.4).
   - Work from the lidar height grid, its roof levels and profiles, plus dated photos or drawings.
   - Use the rectangle extraction as a starting point, then shape roofs from the table in §3.2.
   - Aim for a roof-compare score of 0.9 or better, and record what is measured and what is guessed for each building.
4. **Treat every earlier assumption as a lead.**
   - Recheck each building against the data: outline, heights, wings, courtyards, roofs, entrances and materials.
   - An owner's or visitor's memory is a lead to check, not a fact. Where data and memory conflict, the data wins, and the conflict is written down.
5. **Facades** (§3.5). Pick a window style per building or piece and check the storey heights. The 2 m windowless rule and the 2.5 m minimum storey height prevent most odd results.

**Done when:** the audit shows the core area agreeing (≥ 0.8) except for documented cases, and each hand-shaped building has its evidence list.

## Stage 4: the live map (a few weeks of development)

Build the renderer in this order, checking each step in a browser before the next:

1. cameras and controls (§10);
2. lighting with the real sun and shadows (§8);
3. sky gradient and night;
4. trees and seasons (§5, §9);
5. picking and cards (§11);
6. data packs (§12);
7. weather (§9), optional.

`toolkit/viewer/` is a compact working version of items 1 to 6 to extend.

**Done when:** the browser capture checks in §18 pass on desktop and phone sizes, at noon and at night.

## Stage 5: ground level (optional, a few weeks)

1. **Walls** (§6): building walls sliced from the drawn mesh, fences with their gates cut open, and the swept collision.
2. **Walking network** (§7): built, pruned by the walls, reduced to its main network. Write the list of pruned links and check a sample against imagery: some are real openings missing from the map, and people need to look at them.
3. **The walker** (§10, ground-level view).
4. **Night sky** (§8): the moon, then stars from a CC0 catalogue.
5. **People and traffic** (§14). Add them only if they help.
6. **A walker patrol** (§18): simulate a day with several walkers, rank the problems, fix the worst, and patrol again.

**Done when:** a day-long patrol shows nobody inside a building, no pass through a wall, and no sideways jumps.

## Stage 6: the painted look (optional)

Decide first whether you want it at all. The live map is complete without it, and a painting goes stale with every model change (§12, §16).

If you do want one:

1. export frames with ids and classes;
2. paint representative spots by hand or by a procedural style;
3. let the owner choose the look from the contact sheet;
4. paint the grid, check every frame (§16), stitch, and build tiles (§17).

## Stage 7: releases

Release with the gated method in [RELEASE_METHOD.md](RELEASE_METHOD.md). Freeze and rebuild from a clean copy, package with pinned hashes, check locally in a browser, get the owner's direct approval, promote, verify live, and record. People can run every step. The tool's job is to make the steps identical every time and to refuse when anything has drifted.

## Working rules that saved time

- **Measure before and after** every change with the same scorecard (§18). A change without numbers is an opinion.
- **Test the real entry point**, not only the functions behind it.
- **Show visual choices side by side and let the owner pick.** The owner more than once preferred the existing look over a "stronger" new one.
- **Never edit live sources during a release freeze.** Work on a copy until the freeze lifts.
- **Keep probes and experiments outside evidence folders**, so a release record holds only what the release made.
- **Name what is guessed.** A model that marks its guesses can be improved, and one that hides them cannot.
- **Keep the public repository free of site data.** Publish methods and a small, licensed open-data sample, nothing else ([PUBLICATION.md](PUBLICATION.md)).
