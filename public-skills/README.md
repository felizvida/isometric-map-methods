# Reusable workflows (skills)

Each folder holds one `SKILL.md`: a short, self-contained procedure with its trigger and constraints. They are written two ways at once:

- **A person can follow one as a checklist**, so nothing in them needs an AI.
- **An agent can load one as a skill**: copy the folder to your agent's skill location.

They are freshly written, not exports of private agent instructions or conversation history.

| Skill | Use it to |
| --- | --- |
| [open-data-map-build](open-data-map-build/SKILL.md) | build a map of a small area from public data with the toolkit, and check it |
| [lidar-building-fitting](lidar-building-fitting/SKILL.md) | audit heights against lidar and fit hand-shaped buildings until they agree |
| [walkable-world](walkable-world/SKILL.md) | make the ground level solid and walkable, and prove it with a patrol |
| [terrain-map-review](terrain-map-review/SKILL.md) | review terrain, geometry and projection consistency |
| [guarded-map-painting](guarded-map-painting/SKILL.md) | run an optional painted layer with spot review, immutable runs and layout checks |
| [gated-release](gated-release/SKILL.md) | release with recorded approvals, pinned hashes, drift refusal and a generated review |
| [methods-only-publication](methods-only-publication/SKILL.md) | publish methods and public data without local datasets or operational traces |

The skills contain no credentials, production setup or permission to publish data. Follow the actual owner's scope and approval conditions.
