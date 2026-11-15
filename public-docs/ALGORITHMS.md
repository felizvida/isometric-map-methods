# Algorithms: everything needed to rebuild the map by hand

This is the complete technical reference for a terrain-aware isometric map with a ground-level walk. It covers the map's data, geometry, rendering, sky, simulation, measurement and quality checks. The original was built for one site; this description is general. It names no site, organisation, host or person, and it ships with no site data. A competent developer should be able to rebuild every part from this page, the reference code in `methods/` and `toolkit/`, and public data. No AI is needed at any step. The one optional step that used an image model, painting a hand-drawn look over the map, has a non-AI alternative (§16).

Each section says what the step is for, gives the method and its constants, and says where the code lives:

- **[code]** is a tested module in this repository.
- **[toolkit]** is used by the end-to-end toolkit.
- **[described]** is specified here only. The original implementation was tied to one site, so it is not published.

All lengths are metres, angles are degrees unless marked radians, and heights are orthometric (above a vertical datum such as NAVD88) unless stated.

Contents:

1. Coordinate frame
2. Terrain
3. Buildings
4. Ground surface: areas, roads, markings, bridges
5. Trees
6. Walls and collision
7. Walking and driving networks
8. Sky and lighting
9. Weather and seasons
10. Cameras and controls
11. Picking
12. Data packs and change tracking
13. Measuring buildings with lidar
14. Traffic and pedestrians
15. Matching GPS traces to roads
16. The painted look (optional) and its non-AI alternative
17. Tile pyramids
18. Quality checks

---

## 1. Coordinate frame [code: `toolkit/lib/terrain.mjs`, `tutorial/lib.mjs`]

**Purpose:** one metric frame for every layer, so distances and areas are plain arithmetic.

- **Local tangent plane.** Choose an origin (lon0, lat0) near the middle of the area. Then x = (lon − lon0)·kx and y = (lat − lat0)·ky, with x east, y north and z up. The constants are the WGS84 metres per degree at the origin's latitude φ0:
  - kx = a·cos φ0 / √(1 − e²·sin² φ0) · π/180;
  - ky = a·(1 − e²) / (1 − e²·sin² φ0)^1.5 · π/180;
  - a = 6378137 and e² = 0.00669437999014.
  - Over 2 km the error stays below a few centimetres. (A cheaper series form, kx = 111412.84·cos φ − 93.5·cos 3φ + 0.118·cos 5φ and ky = 111132.92 − 559.82·cos 2φ + 1.175·cos 4φ, agrees to millimetres.)
- **Height origin.** Store heights relative to a base, for example the floor of the lowest terrain node or the mean ground of the central area rounded to 1 m. Small numbers keep 32-bit GPU floats precise.
- **Datums.** Record the horizontal datum, the vertical datum and the geoid model of every source. OpenStreetMap is effectively WGS84; US elevation data is NAD83 horizontally, which differs by about 1 to 1.5 m in the conterminous US. Never mix ellipsoidal and orthometric heights without a documented geoid conversion.
- **Map disc (optional).** A round map clips polygons against a 256-sided polygon (Sutherland–Hodgman) and lines against the true circle (solve the quadratic for the segment parameter t).
- **Storage.** Coordinates in integer decimetres (scale 10) halve the data size and remove float noise.
- **Footprint clean-up.** Run Douglas–Peucker at 0.3 m on outlines and 0.5 m on lines. Drop vertices that are collinear within 0.12 m and duplicates closer than 0.05 m.

## 2. Terrain [code: `methods/terrain.mjs`; toolkit: quadtree leaves in `tutorial/lib.mjs`]

**Purpose:** a light terrain mesh that is exact where the ground changes, and never cracks where coarse and fine cells meet.

**Lattice.** Sample the bare-earth model (DTM; not a surface model, which includes trees and roofs) at regular nodes. The original used 1 m nodes, each the 3×3 box mean of a 0.3 m raster. The toolkit uses 2 m nodes sampled bilinearly from about 1 m USGS 3DEP pixels.

**Quadtree.** Start from one root square whose side is a power of two in cells, at least as large as the grid. Split a square into four while either:

- it overhangs the grid edge, or
- the bilinear surface through its four corners misses any node inside it by more than the tolerance.

The tolerances:

| Setting | Tolerance |
| --- | --- |
| Toolkit default | 0.25 m |
| Original, core area plus a 40 m margin | 0.15 m |
| Original, surroundings | 0.4 m |
| Original, low-power devices | 0.35 m, with cells of at least 4 m instead of 2 m |

Nodes more than one node inside a building footprint can be ignored, since nothing there is seen.

**Crack-free triangulation (T-junctions).** A big leaf next to small leaves has the small leaves' corners on its edges. Cutting the big leaf into two triangles leaves those mid-edge points out, and a crack opens as soon as heights are lifted or resampled. To avoid it:

1. Collect every leaf corner in a map keyed by exact coordinate.
2. For each leaf, walk its four edges and add every corner from the map that lies on the edge, in order.
3. Fan triangles from the leaf centre around that outline. The centre takes the bilinear height.

Both sides of every edge then share the same vertices. Check it by counting each undirected edge: interior edges must be used exactly twice. An edge used once inside the domain is a crack.

**Compact encoding (optional, for the web).**

- **Structure:** one bit per cell in pre-order (1 = split); 1 m cells have no bit.
- **Root heights:** centimetres, delta-coded row by row, as zigzag varints.
- **Finer levels:** each new node of a split cell (four edge midpoints and the centre) stores only its residual from the parent's bilinear prediction.
- **Hanging midpoints:** where the neighbour across an edge is not split, the midpoint stores nothing and takes the prediction. This is exactly what keeps the decoded mesh crack-free.
- **Verification:** the encoder decodes its own output the way the client will. It re-splits any leaf whose decoded surface misses tolerance by more than 2 mm, for up to 8 passes, and fails if any node is still out.

**Retaining walls (optional).** Find steep, short drops and draw them as walls instead of slopes.

- **Candidate node:** gradient ≥ 0.45; drop over ±1 m along the gradient ≥ 0.9 m; that drop ≥ 60 % of the drop over ±3 m; the steepest node across the line.
- **Exclusions:** within 2 m of a building or 6 m of water.
- **Chaining:** 8-neighbour components of at least 5 nodes, ordered along their principal axis, split at gaps over 2.5 m.
- **Line clean-up:**
  1. Douglas–Peucker at 0.5 m.
  2. Orient each line so the high side is on its left.
  3. Join ends ≤ 3.5 m apart whose directions agree (dot product ≥ 0.5).
  4. Densify to ≤ 1 m and smooth with three passes of a (1, 2, 1)/4 filter.
  5. Douglas–Peucker at 0.25 m, then resample every ≤ 3 m.
- **Keep rule:** length ≥ 4 m and mean height ≥ 0.8 m. Each vertex stores the top height 2 m out on the high side and the bottom height 2 m out on the low side, each median-of-3 filtered.

**Lifting on the GPU (optional).** Build meshes flat and add `k·h(x, y)` in the vertex shader, reading h from a 16-bit float height texture with manual bilinear `texelFetch`. With k = 1 the map is at true scale. Exaggeration was tried and rejected because it overstates exposed storeys.

- Features seated on a pad (§3) read their pad height from a second texture indexed by feature id instead.
- Ground normals come from the height gradient over max(2.5 m, node spacing), not from the mesh, so lighting stays smooth across leaf sizes.

**Grading before drawing** (in this order):

1. **Roads.** The centreline profile is the median ground across 0.9 of the road's width, sampled every 1 m and smoothed with a ±5 m moving average. A 3 m shoulder blends back to the natural ground with a smoothstep.
2. **Building pads** (§3). Level ground for 5 m around the walls, then a bank of slope 0.45 back to the natural ground. The bank distance field is a cut-only, 8-neighbour, two-pass chamfer sweep. Graded roads are never cut.
3. **Ponds.** Level water at the mean shore height minus 0.05 m.

## 3. Buildings [code: `methods/buildings.mjs`, `methods/roof.mjs`; toolkit]

**Purpose:** credible buildings from footprints, with heights whose source is always known.

### 3.1 Height, by source priority

The first rule that applies wins, and the building records which rule that was. Cards and reviews show it.

1. **A curated value:** checked by hand against lidar, drawings or photographs. A curated value is never overwritten by an automatic rule.
2. **A mapped `height` tag.**
3. **A national structures dataset** (for example USA Structures), matched by area overlap. Sample the footprint on a grid of step max(1, √area/22) m, or 0.5 m for small footprints. Use the best-overlapping structure only if:
   - it covers ≥ 60 % of the samples;
   - the area ratio is within 0.55 to 1.8;
   - its height is in [2.5, 150) m.

   With a flat roof, the height is max(3, h). With a pitched roof, the wall is max(2.8, h − 0.4·roof height) and the height is the wall plus the roof height.
4. **Levels × storey height + roof**, plus 0.6 m of parapet on flat roofs.

   | Building type | Storey height |
   | --- | --- |
   | Residential | 3.0 m |
   | Parking | 3.1 m |
   | Institutional (original core area) | 4.0 m |
   | Other | 3.5 m |

   Without levels, use a default by kind and area: the toolkit uses 1 level under 60 m², else 2.
5. **Lidar override (automatic, for buildings no one has curated).** If the lidar roof analysis (§13) finds one dominant flat level, the footprint takes that level when all of these hold:
   - the level holds ≥ 60 % of the samples;
   - coverage is ≥ 0.6;
   - canopy share is < 0.4;
   - the level is ≥ 2.2 m;
   - the current height disagrees (agreement < 0.8).

   Pitched roofs take the 90th percentile of the hard surface instead, if that is ≥ roof height + 2.2 m and within a factor of 1.4 of the old height.

Joining two independent sources catches errors in each. Machine-extracted structure footprints include tennis courts, decks and tanks. The tutorial sample has one, and a structure that also covers a neighbour fails the area-ratio test.

### 3.2 Roof forms

Pitched roofs are built on the footprint's **minimum-area oriented rectangle**. To find it, try each edge direction, project all points on that axis and its normal, and keep the smallest box. Call the long axis u.

- **When a pitched roof is allowed:** only if the footprint fills > 72 % of the box (> 60 % for pyramidal or dome roofs) and has no holes. Otherwise the roof becomes flat.
- **Roof height:** clamp(0.32·short side, 1.2, 4.5 for houses or 7 otherwise). Mansard roofs use min(3.5, 0.08·√area). A `roof:height` tag wins.
- **Tags:** accept flat, gabled, hipped, pyramidal, mansard, dome and skillion. Treat round as barrel, and gambrel and saltbox as gabled.

All forms use an overhang of 0.35 m, and the ridge runs along the long side unless told otherwise:

| Form | Construction |
| --- | --- |
| flat | ear-clipping triangulation of the footprint at the roof height |
| gabled | two planes from the eaves (z0) at ±v to the ridge (z1) on the centre line; gable triangles close the ends |
| hipped | ridge shortened by the hip run min(half span, half length) at each end; four planes |
| pyramidal | hip run = half the length (ridge becomes a point) |
| skillion | one plane from z0 on one side to z1 on the other |
| barrel | segmental arc across the short axis: R = (half² + rise²)/(2·rise), φmax = asin(half/R), N = clamp(round(24·φmax), 6, 20) segments; optional raised end rim min(0.9, 0.05·length) wide, 0.18 m proud |
| deck | slopes up to a flat top inset by (u0, v0, u1, v1), default 2 m each; an inset of 0 gives a vertical face |
| mansard | inset min(0.7·rh, 2.2) |
| zigzag (sawtooth) | a row of gables in bays of 6.5 m |
| cone / plane | z = z0 + (z1 − z0)·clamp((r − r0)/(r1 − r0)), or z = z + gx·dx + gy·dy; walls rise to the roof at each corner |
| hypar (saddle) | bilinear patch z = zc + k·s·t (`methods/roof.mjs`) |
| four-patch hypar | four bilinear patches with a high centre zc, high tips zt and low edge midpoints zm; shell 0.08 m thick, edge fascia 0.42 m deep and 0.3 m wide, 8×8 subdivision; optional glazed clerestory (1.6 m mullions) and square piers |
| tank | 28-sided cylinder plus a 5-ring dome, rise 0.18·r |
| canopy | thin shell (default 0.35 m) with no walls; optional curve top − droop·t^1.3 + lift·|2s − 1|^2.5 |

A cross vault is two crossing barrels.

### 3.3 Seating on sloping ground

Sample the ground every 3 m (1 m for small buildings) along the walls.

- **Pad (base of the roof's height):** the 90th percentile, so the building is not buried uphill. Raised structures such as canopies and decks use the median.
- **Walls:** they reach down to the lowest sample, so nothing floats downhill. The foundation drop is min(45, (pad − lowest)·k + 0.6), where k is the terrain multiplier.
- **Drape instead:** if (pad − lowest)·k > max(4, 0.75·height), cut the walls into 6 m pieces that each follow the ground, unless the building is hand-shaped.
- **Pads from lidar:** a measured pad can override all of this. The 90th percentile of bare-earth heights sampled every 1 m, 1.5 m outside the walls, is the most robust choice.

### 3.4 Hand-shaped buildings ("pieces")

Important buildings are modelled as a list of pieces fitted to lidar (§13) and photographs. Each piece is placed in one of these ways:

- in the footprint's oriented frame, by u and v ranges (a positive value from the low end, a negative value from the high end, or a percentage);
- by a world box;
- by a box in a rotated frame;
- by a free polygon;
- by a polygon clipped to the footprint as half-planes.

Each piece also has a vertical range [z0, z1] above the pad, which may be negative for parts below ground. It can carry:

- storey height and the storey count origin (so floors line up on a tall base), window style and bay width, material, colours;
- a roof form from the table above;
- flags: no parapet, floating (kept in the air below 2 m, with an underside), open (no end walls), and minimum-area exceptions for tiny parts.

A building's record can also set a frame rotation about a pivot, so all its pieces share the bearing measured from the lidar. Collision for such a building should come from its drawn walls (§6), not its footprint.

### 3.5 Walls and facades

Each footprint edge becomes one wall quad from the base to the wall top, with the right-hand normal. Its texture coordinates are u = distance along the edge and v = height above the pad. Each edge has a kind:

- **blank:** edges shorter than 2 m, too short for a bay;
- **windows:** every other edge;
- **entrance:** the edge with the best street score. March outward along the edge normal from d = 3 to 18 m in 3 m steps. Hitting a road scores min(length, 30)·(2.2 − d/15); hitting a footway scores 0.7 of that; hitting a building stops the march.

Flat roofs over 120 m² get a parapet 0.9 m tall (1.1 m on garages), inset 0.32 m with a mitre whose cosine is floored at 0.35. Windows stop below the wall top by the parapet height plus 0.5 m (0.4 m plus 0.9 m under pitched roofs).

**Window grid, drawn by the shader rather than modelled.**

- **Storey height:** max(storey, 2.5).
- **Corner piers:** 0 for curtain wall, 0.95 m historic, 0.45 m house, 0.7 m otherwise; never more than 0.2 × the edge length.
- **Bays:** the edge minus the piers is divided into ncol = max(1, round(inner/sp)) equal bays.
- **Windows:** each bay holds one window spanning fractions x0–x1 of the bay width and y0–y1 of the storey height:

| Style | sp (m) | x0–x1 | y0–y1 | Style | sp (m) | x0–x1 | y0–y1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| punched | 3.2 | .26–.74 | .30–.80 | church | 4.0 | .40–.60 | .16–.86 |
| ribbon | 1.6 | 0–1 | .36–.80 | slot | 2.4 | .44–.56 | .15–.85 |
| curtain wall | 1.5 | 0–1 | .06–.94 | frame | 6.1 | .07–.93 | .24–.93 |
| historic | 3.0 | .34–.66 | .26–.84 | deep | 6.5 | .11–.89 | .36–.86 |
| institutional | 2.8 | .17–.83 | .32–.80 | piers | 2.1 | .36–.64 | .03–.99 |
| house | 3.6 | .32–.68 | .36–.80 | banded | 7.0 | .08–.60 | .30–.80 |
| apartment | 3.2 | .22–.78 | .30–.82 | recess | 4.4 | .18–.82 | .18–.72 |
| parking | 7.5 | .05–.95 | .30–.86 | sparse | 4.9 | .37–.63 | .30–.75 |
| industrial | 6.0 | .20–.80 | .72–.86 | fins | 0.9 | .30–1 | .16–.93 |

Other styles: louvre (0.3 m slats), stone bands (no windows) and serrated glass (sp 1.5, 0–1, .02–.98). A per-building bay width can be packed into the style number as style + bay/100 (4.035 = style 4 with 3.5 m bays).

**Making the grid look right in the shader.**

- **Anti-aliasing:** draw window masks as box-filtered periodic pulses with filter width 1/(bay width × pixels per metre), so a facade fades to its mean colour when bays are smaller than a pixel instead of shimmering.
- **Door:** one bay chosen by a hash of the building seed and edge index, on the ground floor of the entrance edge. It is ±1.15 m wide (modern) or ±0.58 m, and min(2.6, storey − 0.5) tall, with a transom that glows at night.
- **Glass:** dark glass mixed towards the sky colour by 0.1 + 0.55·F, where F = (1 − |v·n|)² is a Fresnel term. About 20 % of windows have blinds. A room behind each window (an interior map 2–3 bays wide, 0.92 storeys tall, 1.55× deep, set back 0.12 m) is lit at night when hash > 1 − occupancy.
- **Masonry:** brick courses 0.42 × 0.2 m in running bond; siding 0.21 m; precast panels 1.5 m × half a storey; metal ribs 0.6 m. Soot streaks fade over 36 m of height. There is a 0.85 m base course, a cornice at the window top + 0.3 m, and belt courses at floor lines.

## 4. Ground surface [toolkit: `toolkit/lib/scene.mjs`]

**Purpose:** crisp paths, courts and markings on a coarse terrain mesh.

Two approaches work:

- **A ground texture** (toolkit). Rasterise the classes at 0.25 m per pixel or coarser, at most 2048 pixels a side, and drape the image over the terrain with UV = (x − x0)/width, (y − y0)/height. The CPU renderer in the tutorial does the same per pixel.
- **Ground polygons** (original). Stroke each line into polygons and draw them in order over the terrain with the depth test set to ALWAYS in the map view. At ground level, write the nearest-surface depth first with polygon offset (6, 64) and draw the layers with LEQUAL.

**Order.** Land cover first (grass, wood, park, parking, water, playground, pitch by sport), larger areas first within a rank. Then streams, footways, rail (3 m), road kerbs, road fills from wide to narrow, then markings. Narrow paths go on top of wide roads.

**Widths.**

- A tagged width wins.
- Roads: lanes × 3.3 + 1.2, or by class:

  | Class | Width |
  | --- | --- |
  | motorway | 14 m |
  | trunk | 12 m |
  | primary | 11 m |
  | secondary | 9 m |
  | tertiary | 7.5 m |
  | residential | 6.5 m |
  | unclassified | 6 m |
  | living street | 5 m |

- Other lines: service 4.5 m, cycleway 3 m, footway 2.4 m, path 2.2 m, sidewalk 2 m.
- A kerb of the road width + 0.6 m (+1.4 m for casings in the polygon approach) is drawn under each road.

**Stroking polylines.** Offset each vertex by half the width along the averaged normal. Limit the mitre to h/max(d, 0.5), where d is the cosine of the half-angle. A joint with d < 0.92 gets a 10-segment round disc, and line ends get round caps.

**Markings.**

- Two-way roads ≥ 6.5 m wide: a double yellow centre line, 0.13 m wide at ±0.16 m.
- One-way roads: dashed white lane lines 0.12 m wide, 3 m dash and 6 m gap, with round(w/3.4) lanes.
- Zebra crossings: bars 0.5 m wide every 0.9 m along the crossing.

**Bridges.**

- The deck runs in a straight line between the terrain heights at its two ends. It is cut into pieces of about 3 m, each seated at the deck height at its midpoint.
- The slab is 0.88 m thick, its top 0.02 m below the surface, and the width + 0.8 m. Railings are 0.22 × 1.05 m, set at w/2 + 0.25.
- Bridges are excluded from road grading. Walls within the road half-width + 1 m of a centreline are cut.

**Fences, walls and hedges.** Fences are 2.2 m tall and 0.08 m thick, drawn with alpha-cut bars every 0.16 m. Walls are 1.1 × 0.45 m. Hedges are 1.5 × 1.1 m.

**Colours (toolkit, sRGB).**

| Class | sRGB | Class | sRGB |
| --- | --- | --- | --- |
| lawn | 150 168 108 | park | 112 156 88 |
| wood | 84 122 70 | water | 104 148 176 |
| road | 92 94 100 | service | 124 124 128 |
| footway | 214 206 190 | sidewalk | 204 200 194 |
| kerb | 178 176 170 | yellow line | 222 186 74 |

## 5. Trees [toolkit]

- **Mapped trees.** Place a tree at every mapped tree point.
- **Scatter.** Then scatter trees on a jittered 4 m grid (jitter ±1.6 m). Keep a candidate with probability set by the land cover under it:

  | Land cover | Probability |
  | --- | --- |
  | wood | 0.5 |
  | scrub | 0.2 |
  | park | 0.08 |
  | grass | 0.03 |
  | lawn | 0.012 |

  The original modulated the park and lawn densities by 0.25 + 2.2·smoothstep(0.48, 0.72, fbm(x/85, y/85)) for natural clumping.
- **Rejection.** Reject a candidate inside a building, within 2.2 m of a paved class, or within 3 m of another tree.
- **Street trees.** Plant them w/2 + 2.6 m from road centrelines every 11–18 m, skipping 35 % at random.
- **Sizes, uniformly distributed:**

  | Kind | Height | Crown radius |
  | --- | --- | --- |
  | Deciduous | 8.5–15.5 m | 3–5.4 m |
  | Woodland | 13–20 m | 3.8–5.8 m |
  | Conifer (12 % of trees, 22 % in woods) | 10–19 m | 2.4–3.8 m |

- **Meshes.** A 6-sided trunk 0.42 h tall (0.25 h for conifers). Deciduous crowns are an icosahedron (subdivided once in the original) stretched to the remaining height. Conifers are two stacked 7-sided cones. Use instancing when there are thousands.
- **Wind.** Sway the crowns by (0.08 + 0.05·wind) m.
- **Seed.** Seed the pseudo-random generator (mulberry32) from the area's name, so the same inputs give the same trees.

## 6. Walls and collision [code: `methods/collision.mjs`; toolkit]

**Purpose:** nothing that moves can be inside a building or cross a fence, whatever its speed or the frame rate.

**Walls are zero-thickness segments.** Their sources:

- building outlines, or better, walls sliced from the drawn mesh (below);
- mapped fence, wall and retaining-wall lines;
- hedges, if they should be solid.

Water is a separate test: a land-cover raster where water and everything off the map count as blocked, and a move into it is reverted.

**Walls sliced from the drawn mesh** (`sliceWalls`). Hand-shaped buildings stand outside their mapped outlines in places, and colonnades should be passable. Slicing handles both:

- Skip near-horizontal triangles (|n_z| > 0.9).
- For each steep triangle, sample the ground 0.4 m outside it along its horizontal normal, and cut the triangle with the plane at ground + 1.0 m. If it does not reach that, cut at + 1.8 m.
- Each cut gives one wall segment. Columns and posts leave real gaps; solid walls give continuous lines.
- A building enters the "am I inside?" index only if its body-height walls total at least half its outline perimeter and it is not a canopy.

**Openings in fences** (`openingHalfWidth`, `cutOpenings`). OpenStreetMap opening nodes are gate, swing_gate, sliding_gate, lift_gate, kissing_gate, turnstile, full-height_turnstile, entrance, bollard, cycle_barrier and stile. Each one cuts a gap at its arc-length position s along the fence:

- **Half-width:** a tagged width/2 (or maxwidth/2). Otherwise, if a road passes through, road width/2 + 1.6 m, divided by max(0.35, |sin(crossing angle)|) for slanted crossings. Otherwise 0.9 m.
- **Cutting:** cut at s ± half-width before simplifying the line. Merge overlapping cuts and drop pieces shorter than 0.2 m. Then simplify the fence with Douglas–Peucker at 0.4 m.

A mapped path that crosses a fence with no gate is treated as closed. List such places for a person to check against imagery rather than guessing.

**Spatial hash** (`SegmentHash`). Use cells of 8 m for walls, 16 m for roads and 32 m for the building index. File a segment, padded by its half-width + 0.5 m, in each cell whose centre lies within cell·0.7072 + pad of it. Queries remove duplicates with a per-query stamp. File a large building's bounding box in every cell it touches. Filing only the cells along its diagonal misses corners, which was a real bug.

**Crossing test** (`crossing`). The move p → q crosses segment s at parameter t when t ∈ (1e−9, 1] along the move and u ∈ [−1e−7, 1 + 1e−7] along the wall. The tolerance on u stops a move slipping through the joint between two segments. The open lower bound on t lets a body standing exactly on a wall leave it.

**Swept movement** (`sweep`).

1. Find the first wall crossed.
2. Stop 1 cm short: tb = max(0, t − 0.01/L).
3. Slide the rest of the move along that wall: along = (d·û)(1 − tb).
4. Sweep the slide as well, again stopping 1 cm short.

Without the sweep, a step longer than the body radius (0.32 m per step at 10 frames per second when running) tunnels through a zero-thickness wall. In tests, 790 of 1,277 fast runs got through without it and none with it.

**Push-out** (`pushOut`). For each wall closer than the body radius r (0.3 m for the walker, 0.28 m for people), move out to r along the wall normal. If the point is still inside a building, move it to the nearest wall point plus r + 0.05. Sweep the push too, so it cannot carry the body through another wall.

**A small physics engine (original).** It works on oriented boxes and discs in a 10 m broad-phase grid.

- **Ranks decide who gives way:** player 0, car 1, bus 2, person 3, parked 5, fixed 9. The lower rank moves the whole overlap, equal ranks split it 0.5/0.5, and fixed bodies never move.
- **Separation by minimum translation:**
  - disc–disc along the centre line;
  - disc–box by clamping the disc centre into the box (from inside, out through the nearest side);
  - box–box by the separating-axis test on four axes.
- **Push size:** move by 1.02 × the overlap. People move at most 0.08 m per pass, so a deep overlap clears over a few frames instead of jumping.
- **Each step:** move kinematic bodies to their targets, apply the fixed constraints (kerbs, walls, water), rebuild the grid, then run two passes of pairwise separation.

**The engine's job, and the rules' job.** Let the engine decide where things can physically be: solidity, never inside a building, people not overlapping, getting unstuck by being pushed out rather than vanishing. Keep intent as rules: which side of the road to drive on, who goes first at a junction, speeds and routes.

## 7. Walking and driving networks [code: `methods/graph.mjs`, `methods/ground.mjs`; toolkit]

**Building the graph** (`buildGraph`).

- Weld nodes by rounding coordinates to 0.1 m.
- Each segment becomes two directed edges, or one for one-way streets.
- Bridge decks give their edges end heights.
- **Road graph:** drivable classes, without parking aisles, driveways, drive-throughs or emergency access.
- **Foot graph:** footway, path, pedestrian, steps, cycleway and living street.
- **Lanes:** the `lanes` tag; otherwise max(1, round(w/3.4)) on one-way streets and 2 on two-way streets.
- **Speeds (m/s):** motorway 25, trunk 20, primary 15, secondary 13, tertiary 12, unclassified and residential 9, service 6, living street 5.

**Walking graph** = the foot graph, plus every street as a pair of directed edges, plus links.

- Each street node is joined to its 2 nearest footpath nodes within 14 m, in both directions, with length max(0.5, d).
- Costs multiply length by 1.6 along main roads, 1.25 along service roads, 1.2 on links and 1 on footpaths, so walkers prefer paths.
- **Pavement offset:** an edge along a street is walked w/2 + 0.9 m to the right of its direction, so a two-way street has a pavement each side. Blend the offset over min(3, L/2) m at each node, so a walker never jumps sideways.

**Pruning** (`pruneGraph`). Remove every edge whose pavement line crosses a wall, or whose midpoint lies inside an indexed building. Routing then cannot disagree with the collision engine. Log each removed edge with its reason for review.

**The main network** (`mainNetwork`). Take the largest weakly connected component, its busiest node as the seed, and the nodes reachable both forward and backward from the seed. Spawning, street-view entry and routing use only these nodes, so nobody is placed where they cannot walk back from.

**Routing** (`aStar`). A* with a straight-line heuristic and a binary heap. Every cost multiplier must be ≥ 1 for the heuristic to stay admissible. `RouteGraph.shortest` in `methods/ground.mjs` is a simpler Dijkstra reference.

**Entering street view at a clicked point.**

- If the spot is standable (not in a building or water), snap to a path only when the path's attachment point is within 12 m. Otherwise start free-walking there.
- If it is not standable, search up to 150 m and 400 candidates for the nearest standable point that is reachable in a straight line, meaning the sweep returns no hit.
- **Nearest edge score:** distance + (1 − cos(edge direction, desired direction))·1.5 + a penalty for service roads. Skip edges outside the main network.
- **Areas no one may walk into** (for example a guarded compound): block all edges crossing their boundary, and move any entry point inside them to the nearest point outside.

## 8. Sky and lighting [code: `methods/sky.mjs`; toolkit viewer]

**Sun** (`sunPosition`, NOAA spreadsheet formulas, no refraction). With JC = (JD − 2451545)/36525:

| Quantity | Formula |
| --- | --- |
| mean longitude | L0 = 280.46646 + JC(36000.76983 + 0.0003032 JC) |
| mean anomaly | M = 357.52911 + JC(35999.05029 − 0.0001537 JC) |
| eccentricity | e = 0.016708634 − JC(0.000042037 + 0.0000001267 JC) |
| equation of centre | C = sin M (1.914602 − JC(0.004817 + 0.000014 JC)) + sin 2M (0.019993 − 0.000101 JC) + 0.000289 sin 3M |
| apparent longitude | λ = L0 + C − 0.00569 − 0.00478 sin Ω, with Ω = 125.04 − 1934.136 JC |
| obliquity | ε = 23 + (26 + (21.448 − JC(46.815 + JC(0.00059 − 0.001813 JC)))/60)/60 + 0.00256 cos Ω |
| declination | δ = asin(sin ε sin λ) |
| equation of time (min) | 4·deg(y sin 2L0 − 2e sin M + 4ey sin M cos 2L0 − ½y² sin 4L0 − 1.25e² sin 2M), y = tan²(ε/2) |

Then:

- true solar time = (UTC minutes + equation of time + 4·lon) mod 1440;
- hour angle H = true solar time/4 − 180;
- elevation = asin(sin φ sin δ + cos φ cos δ cos H);
- azimuth = atan2(sin H, cos H sin φ − tan δ cos φ) + 180, clockwise from north.

Check: the peak elevation equals 90 − |φ − δ|, and equinox sunrise is due east.

**Moon** (`moonPosition`, low-precision terms, about 0.3°). With d = JD − 2451545:

- L = 218.316 + 13.176396 d; M = 134.963 + 13.064993 d; F = 93.272 + 13.22935 d;
- ecliptic longitude l = L + 6.289 sin M; latitude b = 5.128 sin F; ε = 23.4397;
- convert to right ascension and declination, then use the hour angle 280.16 + 360.9856235 d + lon − ra;
- phase p = frac((JD − 2451550.1)/29.530588853), and the lit fraction is (1 − cos 2πp)/2.

**Drawing the moon.** Draw it as a point sprite with the terminator at x = (1 − 2·lit)·√(1 − y²), on the right for a waxing moon. Its apparent size is 0.0091·k/fovY × screen height. k grows from 1.3 overhead to 2.1 at the horizon, the "moon illusion": it should feel real rather than be photometric. Its visibility is clear-sky × (0.3 + 0.7·smoothstep(2, −6, sun elevation)).

**Stars** (`siderealTime`, `equatorialToLocal`, `starVisibility`).

- **Sidereal time:** GMST = 280.46061837 + 360.98564736629 d; LST = GMST + lon.
- **Rotation:** one 3×3 matrix per frame turns the whole catalogue from equatorial unit vectors to east-north-up. Its rows are:
  - east = (−sin θ, cos θ, 0);
  - north = (−sin φ cos θ, −sin φ sin θ, cos φ);
  - up = (cos φ cos θ, cos φ sin θ, sin φ);
  - with θ = LST and φ = latitude.
- **Limiting magnitude:** 3.5 + 0.8·late, where "late" ramps from 21:00 to 01:00 local time. A high, bright moon subtracts up to 1.6·lit·smoothstep(0, 0.4 rad, moon elevation). The floor is 1.5.
- **Twilight:** smoothstep(−4, −13, sun elevation).
- **Clear sky:** (1 − cloud)^1.6 × (1 − 1.5·fog), halved again under heavy wetness.
- **Size:** clamp(1.4 + 0.9·ln(1 + 10^(−0.4(V − limit))), 1.4, 4.2) pixels.
- **Horizon fade:** smoothstep(0, 0.16) of the up component.
- **Twinkle:** ±18 %.
- **Hidden by the scene:** draw the stars at the far plane (gl_Position.z = w) with the depth test LEQUAL, so buildings, trees and hills hide them for free.
- **Catalogue:** `sample/stars.json`, 1,564 stars to magnitude 5, CC0 from Wikidata. Precession since J2000 (about 0.4° by 2026) is ignored.

**Light weights** (`lightWeights`), with sun elevation e in degrees:

- sun = smoothstep(−3, 10, e);
- warm = (1 − smoothstep(4, 24, e))·smoothstep(−4, 2, e);
- night = 1 − smoothstep(−9, 1, e).

**Key light.**

- **Direction:** the sun's, with elevation clamped to ≥ 9° so shadows never become infinitely long.
- **Colour:** mix((1, .94, .84), (1, .6, .34), warm) × 0.78 to 0.86 × sun × (1 − 0.8·overcast) × (1 − 0.5·rain).
- **Moonlight:** when sun ≤ 0.04, moonlight (0.42, 0.52, 0.8) × 0.16 × (0.35 + 0.65·lit) takes over, from the moon if it is more than about 8.6° up, otherwise from a fixed key direction.

**Ambient and shading.**

- **Ambient:** hemispheric, mix(ground colour, sky colour, n_z·0.5 + 0.5), interpolated between day, dusk and night palettes:

  | Palette | Sky | Ground |
  | --- | --- | --- |
  | Day (toolkit) | (0.62, 0.67, 0.75) | (0.44, 0.42, 0.37) |
  | Night | (0.05, 0.07, 0.13) | (0.03, 0.035, 0.05) |

- **Diffuse:** lit = smoothstep(−0.02, 0.2, n·l)·(0.72 + 0.28·clamp(n·l)), a soft terminator that avoids a hard edge on curved roofs.
- **Specular:** Blinn, exponent 60.
- **Cloud shadows:** 1 − 0.6·smoothstep(th, th + 0.1, fbm(xy/380 + drift)), with th = mix(0.78, 0.36, cloud).

**Shadow map.**

- 4096² (2048² on low-power devices), 24-bit depth, hardware comparison (sampler2DShadow, LEQUAL, linear filtering).
- An orthographic light box: around the whole area, or around the view for large maps, with half-size min(hypot(halfW, halfH/sin el) + 70, R + 160) stepped to 40 m and snapped to whole texels so shadows do not swim.
- Polygon offset (1.5, 2.0) while drawing depth.
- **Lookup:** offset the point along its normal by 0.12 + 0.35·(1 − |n·l|), plus 0.15 m along the light, and use a bias of 0.00012. Filter with 5 taps: the centre weighted 2, four taps at ±(1.2, 0.4) texels, divided by 6.
- At ground level, use a fixed 420 m box centred 0.55 × its size ahead of the eye.

**Sky gradient (sRGB).**

| Time | Top | Bottom |
| --- | --- | --- |
| Day | #a7c3dc | #e6ece4 |
| Golden hour | #93a7c9 | #f2c79e |
| Night | #0b1120 | #1c2742 |
| Overcast | #b3bbc2 | #dcdedb |

Blend first by warm, then by night. At ground level, the blend factor is smoothstep(−0.05, 0.6, z) of the view ray.

**Fog and post-processing.**

- **Fog:** clamp(fog + 0.25·rain + 0.3·snow + 0.08·overcast, 0, 0.85). In the map view it scales with depth; at ground level, air = 1 − exp(−dist·(0.00032 + 0.0045·fog²)).
- **Tone mapping:** exposure × 0.58, cool-shadow and warm-highlight tint, contrast about 0.18, then the ACES fit x(2.51x + 0.03)/(x(2.43x + 0.59) + 0.14). Night exposure is 1 + 0.6·night.
- **Outlines** from depth differences, and **bloom** above a threshold of 0.75 + 0.9·(1 − night) (quarter resolution, 9-tap Gaussian, 2 iterations), are optional.

**Night lighting.**

- **Lamps:** brightness 1 − smoothstep(−5, 4, sun elevation), boosted by fog and rain, up to 1.4.
- **Street lamps:** every 34 m (42 m on residential streets, 30 m in parking aisles), 9 m tall on major roads and 6.5 m otherwise. Path lights every 26 m. Each lamp has a 9 m ground pool and a bulb sprite.
- **Occupancy schedule:** windows follow a piecewise-linear day schedule per activity. Offices empty in the evening; homes fill.

**Night at ground level.** It is a calm time: keep it soft and believable rather than physically exact. Keep the map view's night readable.

## 9. Weather and seasons [code: `seasonWeights` in `methods/sky.mjs`; described]

**Presets** (cloud, precipitation, intensity, fog, wind):

| Preset | Cloud | Precipitation | Fog |
| --- | --- | --- | --- |
| clear | 0.04 | none | 0 |
| cloudy | 0.8 | none | 0 |
| rain | 0.95 | intensity 0.65 | 0 |
| storm | 1 | intensity 1, thunder | 0 |
| snow | 0.92 | intensity 0.7 | 0 |
| fog | 0.6 | none | 0.72 |

Live weather maps the WMO weather codes onto these.

**Change over time.** Values move towards their target at 0.6/s.

- Snow cover grows at +0.08/s while snowing and melts at −0.03/s, up to 0.92.
- Wetness grows at +0.2/s and dries at −0.02/s, up to 0.8.
- Lightning flashes at 0.55 to 0.9 every 4 to 15 s.

**Particles (screen space, per 1280 × 800 at full intensity).**

- Rain: 760 streaks of 10–24 px, falling at 900–1600 px/s.
- Snow: 520 flakes falling at 40–90 px/s with ±18 px/s sway.

**Wet and snowy surfaces.** Wet = min(1, 1.3·rain + wetness).

- Asphalt albedo is multiplied by mix(1, 0.62, wet), with specular 0.9·wet.
- Snow blends towards (0.86, 0.89, 0.93), weighted by smoothstep(0.55, 0.85, n_z) and a per-material factor.

**Seasons** (`seasonWeights`), with s(a, b) = smoothstep over the day of year:

- leaf = s(80, 118)·(1 − s(305, 338));
- autumn = s(262, 292)·(1 − s(330, 345));
- brown = s(312, 335)·(1 − s(350, 365));
- bloom = s(84, 94)·(1 − s(104, 116)).

**Foliage colour.**

- Summer: mix((.30, .42, .19), (.42, .52, .23)) by seed.
- Autumn: a five-colour palette by seed, with onset smoothstep(0.15, 1, autumn·(0.45 + 0.75·rand)).
- Browning towards (.50, .38, .26).
- Bare branches (.47, .40, .34) as leaf falls. The toolkit thins winter crowns with a screen-space stipple; the original shrank crowns to mix(0.5, 1, leaf).
- 14 % of trees blossom pink or white in spring.
- Conifers stay green.

## 10. Cameras and controls [code: `methods/projection.mjs`; toolkit viewer]

**Map view.**

- **Projection:** orthographic. The view direction is (sin az·cos el, cos az·cos el, sin el), with the eye 2000 to 3000 m back from the target.
- **Tilt:** true isometric is atan(1/√2) = 35.264°. Use one projection contract for every layer (§16).
- **Zoom:** in CSS pixels per metre, so the half-extents are W/(2·zoom) and H/(2·zoom). Clamp from fit/1.25 (or 0.8 × fit) up to 14 pixels per metre.
- **Tilt and pan limits:** free tilt 24° to 72°. The pan target stays within the area (0.92·R on a disc map).
- **Quarter turn:** add 90° to the azimuth and ease over 700 ms with cubic in-out.
- **Pan:** grab the ground. Screen right on the ground is (−cos az, sin az) and screen up is (−sin az, −cos az)/sin el, both divided by the zoom.
- **Fling and keys:** fling inertia decays as 0.02^dt and stops below 0.0005. Arrow keys move 120/zoom m.
- **Wheel zoom:** factor exp(−deltaY·0.0016), or exp(−deltaY·0.012) for trackpad pinch. Keep the ground point under the cursor fixed by shifting the target by the before/after difference.
- **Rotate drag:** azimuth −= 0.006·dx and elevation += 0.004·dy.
- **Fly-to:** cubic in-out easing, zoom interpolated in log space, azimuth wrapped to ±π.
- **Centring on a raised point:** aim at the ground point on the same view ray, offset by z/tan(el) along the heading.
- **Inverse projection:** it needs a height. Two screen coordinates cannot identify an unknown 3D point. Unproject at a known elevation or keep a height or id per pixel.

**Ground-level view.**

- **Eye:** 1.70 m, with a 0.022 m step bob over a 0.75 m stride. The eye follows the ground with a 0.2 s time constant and never trails it by more than ±0.5 m.
- **Lens:** field of view 68°, zoomable 28° to 95°. Near plane 0.12 m: at 0.4 m, walls within about half a metre were cut open. Far plane 2600 m.
- **Look:** pitch −70° to +60°, resting at −2°.
- **Walking:** auto walking at 1.35 m/s × a speed factor of 0.35 to 2.5, with acceleration limited to ±2.5 m/s². Free walking at 1.4 m/s, × 2.3 when running, turning at 1.7 rad/s.
- **Head turns:** Q and E turn ±45° with a 0.18 s time constant.
- **Look-ahead:** the heading follows the route point 3.5 m ahead with a 0.35 s time constant. After the user looks around, the view recentres 2.5 s after the last look input, but only while following a path faster than 0.3 m/s.
- **Click to walk:** ray-march with step 0.5 + 0.02·t, then refine with 12 bisections. Route from the nearest main-network node to the node nearest the target (within 40 m). Otherwise walk straight, with physics.
- **Detail switching:** detailed vehicles within 45 m and detailed people within 32 m (at most 128).

## 11. Picking [toolkit viewer]

Render an id pass: each object writes rgb = (id mod 256, ⌊id/256⌋ mod 256, ⌊id/65536⌋)/255 with alpha 1, and the ground writes id 0. Read the pixel under the cursor and decode r + 256·g + 65536·b; alpha 0 means nothing was hit. The original rendered a single pixel with a projection that maps the cursor to a 1 × 1 viewport; the toolkit renders a full-size buffer on click, which is simpler and fast enough for small scenes.

- **Click versus drag:** treat a pointer movement under 5 px as a click.
- **What answers a click:** only named or important objects. For example, people answer only at ground level, and then show only their role.
- **Ground clicks:** suppress ground clicks by feature kind, never by a numeric id.

## 12. Data packs and change tracking [code: `methods/packs.mjs`; toolkit]

**Purpose:** a page that loads only verified data, and reviews that separate geometry changes from label changes.

**Layers.** Split the data by what changes together:

- structures (buildings and their appearance);
- site (areas, lines, points, routes, stars);
- information (cards);
- directory;
- terrain;
- life (people, vehicles).

Building ids are stable and only ever added: `b:<number>` for numbered buildings, `osm:<way id>` otherwise.

**Pack files.**

- **Content addressing:** serialise each pack as canonical JSON (keys sorted at every level) and name it `<layer>.<first 12 hex of SHA-256>.json`.
- **Manifest:** `meta.json` = {schema: 1, packs: {name: {file, sha256, bytes}}}. Pack files can be cached forever; only `meta.json` must be revalidated.
- **Never overwrite:** refuse to overwrite a different file under the same name.

**Reading packs, at build time and in the browser.**

- Reject unknown names and file names that do not match `^[a-z]+\.[0-9a-f]{12}\.json$`.
- Recompute the SHA-256 of the actual bytes and compare it with the manifest (`crypto.subtle` in a secure context).
- Fail closed on any mismatch.

**Appearance and label hashes** (`recordHashes`). Per building:

- g = SHA-256[:12] of its canonical appearance fields: geometry, heights, materials, colours, and the id if colour is seeded from it;
- l = the same over label-only fields: name, alternate name, operator, level text.

A painting (§16) or any cached rendering is stale for a building exactly when g changed (`diffRecords`, staleness report: stale, new, gone, current).

**A data-only release** changes packs but not the page. The release tool refuses one whose page differs byte for byte from the live page.

## 13. Measuring buildings with lidar [code: `methods/lidar.mjs`; described]

**Rasters** (`rasterize`, `fillHoles`). From classified airborne lidar (LAS/LAZ), build 0.3 to 0.5 m rasters:

- **DSM:** the highest return per cell, from all classes except noise (7, 18) and withheld points.
- **DSM1:** the highest *single* return (return 1 of 1). This keeps roofs and loses most tree canopy.
- **DTM:** the mean of ground returns (class 2).
- **Point count** per cell.

Fill holes within 2 cells of data with the 3 × 3 maximum (surfaces) or mean (ground). Record the survey's vertical datum and geoid. Many surveys have no building class.

**Per footprint (roof measurement).**

- **Pad:** the 90th percentile of the DTM sampled every 1 m, 1.5 m outside the walls.
- **Samples:** DSM pixels inside the outline at least 1 m from its edge. Fall back to 0.5 m if fewer than 20 qualify, and to 0 if fewer than 8.
- **Hard surface:** DSM1 where present, else the DSM.
- **Canopy share:** the share of pixels where DSM1 is missing or DSM − DSM1 > 1.5 m.
- **Roof levels** (`roofLevels`):
  1. Build a 0.25 m histogram of heights above the pad and smooth it with [0.25, 0.5, 0.25].
  2. A non-empty local maximum is a peak if ≥ 8 % of samples lie within ±0.75 m of it.
  3. Refine each peak to the mean of samples within 0.3 m.
  4. Merge peaks closer than 1 m and keep the 5 largest.
  5. The roof is the largest level above 2.5 m, else the median.
- **Alignment check (report only):** shift the outline by ±3 m in 0.5 m steps. Score each shift by the share of high points inside (≥ 2 m from the edge) minus the share outside (2 to 4 m out). A footprint whose best shift is not zero is probably offset; report it rather than moving it automatically.

**Comparing a model with the measurement** (`agreement`, `bestFlatHeight`, `auditClass`).

- **Model surface:** rasterise the model's tallest drawn surface at 0.5 m (1 m for whole-map audits), using the pitched, barrel, cone and hypar formulas. Parts take their parent's pad.
- **Exclusions:** skip pixels within one pixel of any drawn edge, and require ≥ 8 samples per building.
- **Shares:** agree = share with |d| < 2 m; over = model higher by > 3 m; under = model lower by > 3 m; ground = lidar < 1.5 m above the pad; canopy as above.
- **Best flat height:** the 0.5 m bin with the most samples within ±2 m, refined to their median.
- **Classes:**

  | Class | Rule |
  | --- | --- |
  | ok | agree ≥ 0.8 |
  | phantom (demolished or never built) | ≥ 70 % of the outline is bare ground in the lidar |
  | trees over the roof | canopy > 40 % |
  | single-height fix | one flat height explains ≥ 80 % |
  | multi-level | otherwise; needs pieces |

- **Bare-ground comparator:** where the model draws nothing inside an outline, compare with the DTM, but only where there are ground returns or |DSM1 − DTM| < 0.3 m.

**Fitting pieces.**

- **Rectangles from the height grid:** use 4 m cells holding the median of the 1 m grid, each needing ≥ 25 % filled pixels. Snap heights to 2 m, leave cells under 2.5 m open, and merge runs row by row into rectangles. This gives a starting set of pieces to refine by hand.
- **Signature roofs, for example a four-patch hypar:** compute residuals over 0.5 m cells inside the shell, minus a margin. Report bias, RMS, MAE, 95th percentile and maximum, overall, per quadrant and per 3.5 m distance ring. Check the plan by the intersection over union of the shell with cells above the clerestory base. Compare against a single least-squares saddle z = a + bu + cv + d·uv and against flat facets through the same corners.
- **Per-building score (roof compare):** the share of 0.5 m pixels within 2 m of the model. Fitted buildings in the original scored 0.91 to 1.00.
- **Evidence:** keep the evidence per building (survey dates, photographs, drawings) and mark anything unmeasured as guessed.

## 14. Traffic and pedestrians [code: `methods/traffic.mjs`, `methods/roles.mjs`; described]

**Fixed step.** Simulate at 1/30 s and interpolate between the last two states when drawing. Cap a frame at 0.25 s and at most 5 steps. Seed the generator (mulberry32), and use the seeded generator everywhere, including dwell times, so runs repeat.

**Population.**

- **Target cars:** round(max·(0.12 + 0.88·traffic level)), with max 460 (240 on low-power devices). Spawn at most 2 per step (40 when empty). Despawn 2 per step when the count is more than 5 over the target. Wet or snowy weather (> 0.3) multiplies speeds by 0.75.
- **Spawn edges:** chosen with weight length × class weight, from a cumulative table by binary search.

  | Class | Weight |
  | --- | --- |
  | motorway | 6 |
  | trunk | 7 |
  | primary | 10 |
  | secondary | 5 |
  | tertiary | 3 |
  | unclassified | 2.2 |
  | residential | 0.6 |
  | living street | 0.3 |
  | service | 0.45 |
  | links | 1–1.5 |
  | one-way traps | 0 |

- **Spawn checks:** edge length ≥ 14 m; at least r_junction + 2 m from junction zones, 14 + L from cars in the same lane and 9 m from anyone; out of sight at ground level.
- **Out of sight:** beyond 260 m always counts as hidden and within 60 m never does. In between, a point is hidden if cos(bearing − view direction) < 0.2.
- **Vehicle mix:** SUV 41 %, sedan 34 %, pickup 16 %, minivan 6 %, box truck 3 %. Each car's desired-speed factor is 0.82 + 0.3·U.

**Lanes** (`laneOffset`).

- One-way roads: (lane − (n − 1)/2)·min(3.2, w/n).
- Two-way roads: clamp(w/4, 1.35, 1.7) + 3.2·lane. Oncoming cars are therefore at least 2.7 m apart.
- When the lane count changes, keep the lane with the nearest offset.

**Pose.** Blend the direction and lane offset over 4 m either side of a vertex, with weight 0.5(1 − s/4). Take the heading from the points at s ± 1.2 m.

**Route choice** (`turnWeight`).

- w = (rank + 1)^1.6·(0.25 + 2.2·max(0, cos θ)²)·(1.4 if the rank is ≥ the current rank, else 0.7).
- × 0.35 when turning from a through road onto a service road.
- × 1e−6 into a one-way trap: nodes with no way out more than 120 m inside the map, closed backwards.
- A U-turn only when nothing else exists.
- Plan about 140 m ahead.

**Dead-end U-turn** (`uTurnPoint`). R = max(2, (offA + offB)/2), starting R before the node. Follow a half-ellipse from the arriving lane to the leaving lane, so cars no longer jump 3 m sideways.

**Car following** (`idmAcceleration`, the Intelligent Driver Model). With a = 1.5, b = 2.8, T = 1.25 s and s0 = 2 m:

- acc = a[1 − (v/v0)⁴ − (s*/gap)²], with s* = s0 + max(0, vT + v·Δv/(2√(ab)));
- clamped at ≥ −8.5 m/s²;
- never move more than gap − 0.3 m in a step.

**The gap** is the smallest of:

- the leader in the same lane;
- a car merging within 45 m (side by side, the lower id goes first);
- the first car on the route within 110 m;
- the end of a dead-end route;
- the junction stop line;
- a forward sensor: agents within 40 m (18 m for people) whose lateral offset is within the half-widths + 0.15 m. Oncoming cars (heading difference > 2.4 rad) and crossing cars further than (lenA + lenB)/2 + 4 m are ignored and left to the junctions.

**Desired speed.**

- v0 = speed limit × the car's factor × the weather factor; buses use min(limit, 11) × 0.9.
- Slow for a lower limit ahead: v0 ≤ √(v_lim² + 2·b·0.5·d) within 35 m.
- Slow for bends: × clamp(1 − maxTurn/1.8, 0.3, 1).

**Junctions.**

- **What counts:** a node with ≥ 3 distinct neighbours.
- **Zone radius** (`junctionRadius`): min(22, max(w_max/2 + 1.5, 2.6/(2 sin(max(θ_min, 0.12)/2)))).
- **Minor approaches:** those whose rank is below the highest arriving rank.
- **Conflicts:** each movement is a three-point lane path (zone entry, node with the lane offset, zone exit). Two movements conflict when their paths come within 2.6 m. Cache the result per pair.

**Reservations.**

- Consider junctions within 110 m. The stop distance is dist − r − len/2 − 0.4. Ignore a junction while stop > v²/(2b) + 12.
- Reserve junctions closer together than len + 2 m together, all or nothing.
- Release a reservation once past the zone by len/2 + 1 m.

**May I enter?** In order:

1. **Room on the far side:** no slow car (< 4 m/s) within r + len + 1.5 m beyond the zone.
2. **Occupancy:** a car from the same approach blocks unless it takes the same exit; the same exit or a conflicting path always blocks.
3. **Priority:**
   - a minor car waits while a major car's time to arrive, stop/max(v, 0.5), is < 4 s;
   - a major car yields while the minor road has its turn;
   - between minor cars, first come, first served (0.5 s).
4. **Stop sign:** a minor approach must slow below 1.3 m/s within 4 m of the line.

**Anti-deadlock.** A minor approach that waits more than 12 s gets a 6 s turn. A car waiting more than 25 s close to its line skips the priority checks.

**After the physics step.**

- A car pushed backwards loses that distance and speed.
- A standing car (< 0.5 m/s) becomes "parked" in rank, unless it is waiting for a person.
- A car stuck more than 45 s (or 4 s at the end of its route) is removed once out of sight.

**Buses.**

- Snap each line's polyline points to graph nodes within 25 m and join them with A* (slack 4). Keep the longest unbroken piece, at least 300 m.
- Run 2 buses on lines over 1500 m, else 1, from 05:00 to 24:00. A bus waits 8 s at each end.
- Run only what can be verified. If no source shows where real buses are, draw none.

**Pedestrians.**

- **Target:** round(max·walkers × 0.35 if wet × 0.5 if snowy), with max 240.
- **Spawning:** spawn edges weighted by length (× 6 in the core area), never on roads or outside the main network.
- **Per person:** speed 1.1 + 0.5·U m/s, a lateral offset of ±0.45 m and a height factor of 0.9 to 1.08. The body is a disc of r = 0.28 m that moves at most 0.08 m per pass.
- **Route choice:** w = (0.02 on roads, else 1)·(0.3 + 1.5·max(0, cos θ)).
- **Changing edges:** pick the pavement side whose start is nearest, and fade the jump at the node by at most max(0.6 × distance walked, 0.05·h) per step, so nobody jumps sideways.
- **Turning:** rate-limited to ±4.5 rad/s.
- **Walk cycle:** a 1.44 m stride. A move over 3 m counts as a respawn, not a step.
- **Avoiding the player:**
  - Blocked when within 1.6 m, ahead (cos > 0.3) and within 0.75 m laterally.
  - Side-step at 1.6 m/s up to ±1.3 m after 0.8 s; try the other side after 4 s; turn back after 8 s.
  - Make room early within 3.5 m.
  - Glance at the player for at most 2.5 s within 2.6 m.
- **Waiting at the kerb:** probe 1.2 m ahead. If that is road, wait while any car within 24 m faster than 1 m/s will arrive within 3.5 s.
- **Moves:** every move and every push is swept (§6). On a wall hit, halve the side-step and dodge and shrink the offset.

**Roles and schedules** (`methods/roles.mjs`).

- **Shifts:** each role has hours, with separate weekend hours. Off shift, a person standing still out of sight leaves; on shift, a person appears at one of their places, out of sight.
- **Next place:** drawn by weight from the role's places, excluding the current one (a Markov chain).
- **Dwell:** 5 to 65 s at spawn, 60 to 300 s after a planned walk, otherwise 30 to 120 s.
- **Place nodes:** footpath nodes on the main network within 40 m of the place's outline and outside it, one per 2 m, at most 24. Fall back to nodes up to 160 m away.
- **Assigning appearance to a cast:** use seeded tries that require each job group to include both sexes and a range of skin tones.

## 15. Matching GPS traces to roads [described]

Use this to replace inaccurate published route shapes with lines traced from vehicle positions over weeks.

**Tracks.**

- Split on a gap > 90 s, a route change, leaving the area, or a speed > 40 m/s.
- Thin to ≥ 20 m between fixes.
- Drop a spike fix when d(prev, fix) + d(fix, next) > 2·d(prev, next) + 40.

**Hidden Markov model (Newson and Krumm 2009).**

- **Candidates:** road positions within 35 m, at most 8.
- **Emission:** −0.5(d/σ)², σ = 8 m.
- **Transition:** −|network distance − straight distance|/β, β = 10 m.
- **Network distance bound:** min(max(2.5·straight, straight + 150), 25 m/s·dt + 30).
- **Routing:** edge-based Dijkstra with a binary heap. A U-turn costs 50 m, except at dead ends.
- **Decoding:** Viterbi picks the sequence. Up to 3 consecutive fixes with no drivable connection are skipped as glitches; then matching restarts.
- **Driven edges:** an edge counts as driven when ≥ 50 % or ≥ 25 m of it is covered.

**Support and clean-up.**

- **Support:** count passes as distinct (vehicle, 300 s window) pairs. Keep edges with ≥ max(3, ⌈0.2 × the busiest edge⌉) passes.
- **Pruning stubs** (2 passes): drop stubs < 30 m whose support is < 0.75 × the line they hang off. Drop a parallel line between the same junctions whose support is < 0.5 × the stronger one.

## 16. The painted look (optional) and its non-AI alternative [code: `methods/raster.py`, `methods/provenance.py`; described]

The original offered a hand-painted look as tiles over the 3D map. An image model painted overlapping frames of the 3D render. **The live 3D renderer described above is the complete map, and the default view.** The painting is optional, and no other step depends on an AI.

**Export (both routes).**

- **Camera:** orthographic, true isometric tilt, a fixed heading, 3.4 px/m.
- **Frames:** 1024 px on a 768 px step (256 px overlap), rendered at 2× and averaged down. Skip empty frames.
- **Per frame:** the beauty render, an object-id image, a surface-class image and a manifest of the camera and grid. Use one camera, datum, terrain multiplier and pixel origin for every layer.
- **Pinhole check:** count transparent pixels with 4 opaque neighbours; fail above a limit (default 100).

**Painting without AI:**

- **(a) By hand.** An illustrator paints over each exported frame in any raster editor, keeping its outline (alpha) and seeing the neighbours' painted overlap. The checks below accept or reject each frame exactly as for a model.
- **(b) By rule (non-photorealistic rendering).** A procedural stylisation of the beauty render, driven by the class image:
  - posterise and soften the colour per class;
  - add paper and brush-stroke texture by noise, oriented along the image gradient;
  - draw ink edges where depth or id changes;
  - add tree-crown stippling.

  This is deterministic and needs no review of layout.

**Painting with a model (original).**

- **Order:** frames go in a wavefront from the top left. Painted neighbours (left, top, top-left, top-right) are pasted into the overlap, fading out over the last 32 px.
- **Layout checks:**
  - flag a frame if phase-correlation strength is < 8 or the shift is > 8 px, or if the mean change is < 0.04 (a copied render);
  - edge correlation inside the render's outline must be ≥ 0.12 over at least 2000 px.
- **Translation repair:** allowed only if clean (the best shift within ±2 px of the peak, correlation ≥ 0.2 and ≥ 0.1 better than the next) and if it exposes no outline pixel. Otherwise repaint twice, then fail the frame.
- **Finishing:** undo shifts ≤ 8 px. Apply a per-channel gain towards the context, clamped to ±15 %, fitted over pixels with weight ≥ 0.5 (at least 2000 px). Feather into the context over 96 px. A context difference > 0.15 means the context was ignored, so repaint.
- **Spots first:** paint representative spots, show the owner the contact sheet, and get the look approved before the full grid. Freeze settings and hash them in each run record (`methods/provenance.py`).

**Stitching (any route; `methods/raster.py`).**

- Phase correlation on gradient magnitude with a Hann window; strength = (peak − mean)/std. Undo shifts ≤ 8 px when the strength is ≥ 8 (`alignment`, `translate`).
- Least squares on log gains so that shared overlap bands agree, with a regulariser of 0.25·I, gains clamped to ±15 % (`fit_overlap_gain`).
- Feather over half the overlap. The weight is the outer minimum of the 1-D ramps (`feather_blend`, straight RGBA).
- Ids and classes come from the frame whose centre is nearest.
- **Optional passes:** refill road classes painted as vegetation with the local mean road colour; take buildings from one look and landscape from another through the class mask, grown and feathered (`composite_landscape`).
- **Patch repaint:** when a few buildings change, repaint only their regions. The region is the old and new building pixels grown by a margin, minus every other building, chained onto the live mosaic, with its hash chain recorded.
- **Staleness:** the painting becomes stale building by building as appearance hashes change (§12). List stale buildings; never repaint automatically.

**Shading the painting.** A painting is lit once. To keep it consistent with the live time of day, divide out its reference light and multiply by the current one: (0.75·sun + 0.5·sky)/(0.845, 0.836, 0.83). Recolour per class for season and weather while keeping the painted luminance. Show the painting only within 0.35° of its camera's heading and tilt, and draw the 3D scene's depth beneath it, so cars and lamps are hidden behind painted buildings.

## 17. Tile pyramids [described]

- **Tiles:** 512 px with a 1 px border copied from the neighbours. Skip fully transparent tiles. Premultiply alpha.
- **Encoding:** WebP at quality 86 with alpha quality 100. Class tiles are lossless PNG, downsampled by nearest neighbour.
- **Levels:** halve with Lanczos down to a single tile.
- **`meta.json`:** format tag, tile size, pad, mosaic size, px/m, heading, tilt, ox, oy, a build fingerprint (SHA-256[:12] over all tile files, used as a cache-buster), and per-level sizes.
- **Placement:** px = X·pxPerMetre + ox, with ox = −iMin·step + frame/2 (oy likewise).
- **Choosing a level:** the wanted level is clamp(⌊log2(ppm/(zoom·renderScale)·1.4)⌋, 0, max). Draw from coarse to the wanted level, culled to the view.
- **Loading:** at most 8 concurrent loads and 160 cached textures, evicting least-recently-used down to 80 %.
- **Packaging:** package only the tiles `meta.json` lists. Tile folders collect stale files from earlier builds.

## 18. Quality checks [code: tests in `method-tests/`; described]

**Scorecard.** Before and after any change, compute a fixed set of measures:

- the lidar audit (§13) over the whole area, under both comparators;
- every test suite, with its key numbers;
- page and pack sizes, gzipped at level 9;
- scene-build time, as the median of 3 fresh processes;
- per-footprint ring hashes.

Determinism rules:

- Content-hash every input. Clear listed environment variables for child processes. Set timeouts.
- Exclude volatile fields (run id, durations, logs) from comparison.
- Two runs of an unchanged tree must show zero deterministic differences.
- A changed measurement input or method makes a comparison "not directly comparable" rather than an improvement.

**Browser captures that observe the drawing.**

- **Waiting:** wait with a predicate that never throws until the scene is built, nothing is loading and there is no error. With tiles, every tile the latest frame requested must be on the GPU; never use a fixed count. Then require 20 more frames over 3 healthy polls.
- **Shooting:** request two animation frames and call `gl.finish()`, then take the shot. Read the state after the shot, and write all metrics before any assertion.
- **Content gate:** count only textured cells (luminance standard deviation ≥ 2.5) in the central area, requiring at least 55 %. This fails blank, uniformly cleared and sky-only screens, and passes fog, snow and narrow phone views.
- **Rendering stopped:** at least one frame must arrive within 15 s.
- **Performance:** record frame rate and the WebGL renderer as evidence of the capture machine, not as a phone measurement.

**Walker patrols.** Simulate a whole day with several walkers and record each of these with a replay:

- passing through a wall;
- standing inside a building;
- jumping sideways;
- freezing in front of the player;
- piling up at one node;
- cars jumping or getting stuck.

**Release.** See [RELEASE_METHOD.md](RELEASE_METHOD.md).

---

The tested modules cover the parts that are general enough to publish: §2, 3, 6, 7, 8, 12, 13, 14 and 16 in part. The toolkit assembles §1–8, 10–12 into a working map. The remaining sections are specified completely enough to implement and test against the numbers given here.
