---
name: walkable-world
description: Make a map's ground level walkable and solid - walls from the drawn mesh, gaps at gates, swept collision, a pruned walking network - and prove it with a day-long walker patrol.
---

Read `public-docs/ALGORITHMS.md` §6, §7, §10 and §14. The rule to enforce is simple: nothing is ever inside a building or crosses a wall, whatever moves it (walking, clicks, teleports, entry points, simulated people).

1. **Walls.**
   - Slice building walls from the drawn mesh at 1.0 m (or 1.8 m) above the ground outside them (`sliceWalls`), so hand-shaped parts are solid and colonnades are open.
   - Add fence and wall lines, with gaps cut at mapped gates and entrances (`openingHalfWidth`, `cutOpenings`).
   - List every place where a mapped path crosses a fence with no gate, for a person to check against imagery. Do not guess.
2. **Movement.** Every move goes through `sweep` (stop 1 cm short, slide), then `pushOut` to the body radius, and the push is swept too. Test with steps longer than the radius, as at a low frame rate.
3. **Network.**
   - Build it from footways and streets (`buildGraph`), walking streets on the pavement offset.
   - Prune every link that crosses a wall or runs inside a building (`pruneGraph`), and keep the strongly connected core (`mainNetwork`).
   - Route, spawn and enter only on the core. Write the pruned links to a review list.
4. **Entry and forbidden areas.** Entering at a clicked point snaps to a path within 12 m, or starts free-walking if the spot is standable. Otherwise search for the nearest reachable standable point. An area nobody may enter gets its boundary in the walls, and entry points inside it move outside.
5. **Patrol.**
   - Simulate a full day with several walkers. Record each case with a replay: passing through a wall, standing inside a building, sideways jumps, freezing in front of the player, pile-ups at one node, cars jumping or stuck.
   - Rank the problems, fix the worst, and patrol again.
   - Report counts before and after.

At night, ground level should feel calm and believable rather than physically exact. Keep the map view's night readable. Never add behaviour you cannot verify against a source, such as vehicle positions without a real feed.
