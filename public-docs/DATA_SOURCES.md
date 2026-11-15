# Public source references

References only, apart from one deliberately small tutorial sample: [`sample/`](../sample/README.md) holds a 130 × 132 m extract from OpenStreetMap (ODbL), USA Structures (CC BY 4.0) and USGS 3DEP (public domain), plus a list of 1,564 bright stars from Wikidata (CC0), with provenance, changes and required attribution. No other source records, geographic extracts, point clouds, photographs, directory data, route shapes or model weights are distributed. Tests do not download from these sources. The [toolkit README](../toolkit/README.md) explains how to download the first three by hand for an area you choose, from the publishers' own download pages; the data stays under its own licence. Its download script, `fetch.mjs`, obeys each host's `robots.txt` and fails closed; on 2026-11-15 all three services refused automated access, so it stops by design.

| Public source | Potential role | Record before use |
| --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org/) | Footprints, roads, paths and land-use context | Retrieval date, feature version, completeness and terms |
| [OSM copyright and licence](https://www.openstreetmap.org/copyright) | Contributor attribution and ODbL requirements | Obligations for databases and produced works |
| [USGS 3D Elevation Program](https://www.usgs.gov/3d-elevation-program) | Ground elevation and classified point-cloud discovery | Collection date, CRS, vertical datum, resolution and quality |
| [USGS elevation and lidar specifications](https://www.usgs.gov/ngp-standards-and-specifications/3d-elevation-program-standards-and-specifications) | Classification, terrain and surface product interpretation | Specification and metadata for the selected collection |
| [The National Map](https://apps.nationalmap.gov/downloader/) | Discover public elevation products for an independently selected area | Dataset identifier, publisher, date, terms and checksum |
| [USA Structures](https://gis-fema.hub.arcgis.com/datasets/fedmaps::usa-structures/about) | Structure footprints with heights (ORNL and FEMA Geospatial Response Office) | Licence (CC BY 4.0 attribution), production and image dates, validation status |
| [3DEP point clouds](https://www.usgs.gov/3d-elevation-program) | Classified lidar for roof levels and model checks (ALGORITHMS.md §13) | Project, collection date, classes present, vertical datum and geoid |
| [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) | Queries of current OpenStreetMap data for a bounding box | Server usage policy; keep queries small and identify your client |
| [Wikidata](https://www.wikidata.org/) | Star positions and magnitudes (CC0) for a night sky | Query date, the properties used, and how duplicates were merged |

USGS explains the [difference between lidar and bare-earth elevation models](https://www.usgs.gov/faqs/what-difference-between-lidar-data-and-a-digital-elevation-model-dem). Keep that distinction when combining terrain and building heights.

Public availability is not a blanket redistribution licence. Read each publisher's current terms. Some local-government elevation and planimetric products are copyrighted and may not be redistributed without written permission even when they can be viewed or downloaded freely; the tutorial sample therefore uses public-domain USGS 3DEP terrain. OSM-derived outputs require applicable attribution and may have database share-alike obligations; consult [OSM's licence page](https://www.openstreetmap.org/copyright). Apache-2.0 covers this repository's methods, not external datasets.

For independently obtained photos, retain creator, permission, date, direction and uncertainty. Search visibility is not permission to redistribute. For a live feed, review access and reuse terms and keep provider configuration and keys outside public examples. No feed, agency, route or building is encoded here.
