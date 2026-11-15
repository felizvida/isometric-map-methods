---
name: lidar-building-fitting
description: Check building heights against classified airborne lidar, classify the disagreements, and fit hand-shaped buildings (pieces and roof forms) until they agree, recording evidence and guesses.
---

Read `public-docs/ALGORITHMS.md` §3 and §13 first. Use lidar whose licence allows your use, and record its project, collection date, classes and vertical datum and geoid. Never mix datums silently.

1. **Rasterise** at 0.3 to 0.5 m: DSM (highest non-noise return), DSM1 (highest single return) and DTM (mean ground), with point counts (`methods/lidar.mjs` `rasterize`, `fillHoles`).
2. **Audit every footprint.**
   - Measure the pad from the DTM 1.5 m outside the walls, and take the roof levels from samples at least 1 m inside (`roofLevels`).
   - Compute agreement with the model's drawn surface, skipping edge pixels (`agreement`).
   - Sort the buildings by agreement.
3. **Classify** each building below 0.8 (`auditClass`) and act on its class:

   | Class | Action |
   | --- | --- |
   | phantom | remove the footprint after checking dated imagery |
   | trees | leave it and note it |
   | single-height | set the measured level (`bestFlatHeight`) |
   | multi-level | model it in pieces |

4. **Fit pieces.**
   - Start from rectangles of the 4 m median grid.
   - Set a frame bearing from the lidar edges if the building is turned.
   - Add roof forms from §3.2, checking profiles across ridges and vaults.
   - Use dated photos and drawings for what lidar cannot see (glazing, canopies, colonnades). Where the lidar and a photo disagree, the newer dated source wins; write the conflict down.
5. **Re-audit after every change.** Aim for 0.9 or better per building. Check that collision follows the drawn walls (`sliceWalls`), not the old outline, and that open structures (canopies, colonnades) stay passable.
6. **Treat every earlier assumption, including people's memories, as a lead.** Recheck outline, heights, wings, courtyards, roofs, entrances and materials. A remodel may be needed.

For each building, record the score before and after, the evidence list with dates, and every guessed element. Show visual changes side by side to whoever decides the look. Keep site evidence private unless its licence and owner allow publication.
