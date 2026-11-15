# A gated, reproducible release method

This note describes how a small static web map is released with one tool. It covers three kinds of release: deploying the site, regenerating its painted base layer, and publishing this methods repository. The method suits any project where:

- a person must approve risky steps;
- several agents or people do the work;
- each release should leave a complete, checkable record.

It is written from a working implementation, which stays private because it is tied to one site. Nothing here names a host, account, path or organisation.

## Why

Hand-made releases fail in familiar ways:

- scripts copied from the last release and edited in place;
- hashes typed by hand;
- checkers that are first run during the real deployment;
- approvals carried in chat messages;
- review notes written after the fact.

Each step can be right on its own, yet the release as a whole is hard to repeat or audit.

The aim is one command per step that:

- runs the same verified checks every time;
- stops at the approval points;
- refuses to continue when anything has changed underneath it;
- writes the review record itself.

## One folder per release

```text
releases/<id>/
  release.json     inputs: version, notes, checks; plus "pins" that only the tool writes
  state.json       each step: status, attempts, input and output hashes, who ran it, when, tool version
  approvals.json   each gate: the approver's exact words, who gave it, who received it, the subject approved
  evidence/<step>/attempt-N/   logs, results, screenshots
  REVIEW.md        generated from the above after every step; never edited by hand
```

**Pins never change.** The tool records values such as the page hash, the asset build, the previous live release and the archive hash. If a re-run computes a different value, it refuses, and you start a new release id. A release that has quietly changed is no longer the one that was reviewed.

**Steps can be repeated and resumed.** A step that has passed re-hashes the files it recorded and does nothing more. A failed, refused or interrupted step can be rerun; each attempt gets its own evidence folder.

**Drift refuses.** Before a step runs, the files recorded by its prerequisite steps are hashed again. After the package step, the release inputs themselves are frozen.

**Outputs are created once.** Packages, archives, records and evidence are written with exclusive create; nothing is ever overwritten.

**Dry runs print the exact commands.** A dry run shows every remote or state-changing command without running it, and leaves the step's status unchanged.

## Gates are recorded approvals

Some steps need a person's approval:

- the look of a regenerated layer, approved from the actual contact sheet;
- a production deployment;
- a rollback;
- the exact commit to publish.

The tool never skips a gate; it records approvals and checks them.

- **Owner approvals must reach the acting agent directly.** The agent that will run the step records the approval on its own machine, with the approver's exact words. An approval passed on through another agent is kept for the record but never satisfies the gate. A peer's note is context, not authority.
- **An approval names what was approved.** The approver confirms a prefix of the archive hash, commit id or contact-sheet hash. An approval for a superseded package of the same version cannot be reused by accident.
- **A reviewer gate binds to the exact commit and tree.** For publication, the designated reviewer records their own approval of the concrete candidate. If anything changes, the candidate gets a new id and a new review.

## The baseline comes from records, never memory

When a release goes live, its record (version, image identity, page hash, asset build) is appended to an append-only history. The next release reads its baseline from that history: the live version it replaces, and the container to roll back to. A rollback appends an event naming the restored release. Releases made before the tool existed can be imported once, with values read from their frozen packages and saved deployment results.

## Freeze, package, verify

1. **Freeze.** Build the page. Then rebuild it from a clean copy of only its build inputs, and require the two builds to be byte-identical. Pin the page, its data and the assets. Never copy large datasets into a scratch area: list the build inputs explicitly.
2. **Pin derived assets through their audit chain.** Example: audit → build record → hash of every file. Package only the files the asset index lists. Asset folders accumulate stale files from earlier builds.
3. **Package with one generic deployment script plus a per-release configuration file.** The configuration holds the identity, the baseline and the content checks. There is no per-release editing of code. Run the project's tests on the frozen copy. Write a manifest of every file's hash and an archive with normalised ownership and modes.
4. **Verify.** Re-extract the archive into a scratch folder. Require the manifest to be exact. Reject links, special files and path traversal. Compare the kept release folder with the archive.

**A replay fixture is the acceptance test for the tool itself.** Run freeze, package and verify against a release that has already shipped, and require the same site bytes. Once the sources move on, require the frozen source snapshot of that release to still rebuild its page byte for byte.

## Server phases

The production host runs a short sequence under a shared lock:

1. **Prepare.** Build the image offline, test a pilot container, and create the replacement container stopped. Production is unchanged.
2. **Promote.** Swap only the application container. On any failure, roll back automatically.
3. **Roll back.** Restore the container that promote parked.

Before and after each phase, a read-only fingerprint covers everything the release must not touch: the shared proxy, other applications, and recovery copies. The fingerprints must match.

Two lessons from building it:

- **A success summary is not proof that something is still live.** Promote leaves a summary file, and a later rollback leaves it in place. After every promotion, and before accepting a retried one, a read-only verification checks that the running container is this release's candidate, that the baseline is parked, that there is no rollback evidence, that the served page is the candidate's, and that the protected fingerprint is unchanged.
- **A dropped connection should not stop a swap halfway.** A phase can run detached:
  - It runs in its own session and ignores the hang-up signal.
  - Its output goes to a durable log.
  - When it ends, it writes an exit record once, atomically.
  - The tool polls the log, tolerates lost polls, and resumes polling on rerun instead of starting the phase again.
  - A launch that fails, or a child that dies without an exit record, is recorded as failed, so it can be restarted deliberately.

**Test the real entry point.** One defect in an early version dispatched through an undefined name: every server phase would have failed on the host, and no test of the phase functions could see it. Test the command-line entry point as the host runs it, in a scratch release folder, and add a static check for undefined names.

## Browser checks that observe the drawing

A screenshot is evidence only once the map has drawn. In software-rendered headless browsers, readiness flags arrive long before pixels. The capture routine:

1. Closes any earlier WebGL page and brings the capture page to the front.
2. Waits with a predicate that never throws, however early it is called. It treats the view as complete only when every tile the latest frame requested is on the GPU. The page itself marks those tiles. A fixed minimum count fails: a phone's opening view may need only two tiles. After that, the frame counter must advance by 20 frames, with nothing loading on three consecutive polls.
3. Requests two animation frames and calls `gl.finish()`, then takes the screenshot.
4. Reads the renderer state *after* the shot.
5. Writes all metrics *before* any assertion, so a failure still leaves evidence.
6. Applies a content gate. The gate counts only textured cells in the centre of the image, and requires a minimum share of them plus some spread in brightness.
   - It fails a blank page, a uniform clear colour, labels over an empty canvas, and an untextured sky.
   - It passes fog, snow and a small map in a narrow viewport.
   - Calibrate it on real captures, including a capture that was correctly rejected.

## Data releases, live views and patches

The method grew with the map. Five additions matter for anyone building their own:

- **Data in packs, and data-only releases.** The page loads its data as content-addressed packs (ALGORITHMS.md §12). Freeze rebuilds the page and every pack from the clean copy and pins each one. Marker checks search the page and all packs, because card text and ids live in the packs. Package, verify, local checks and the live check compare every pack with its pin. A *data-only* release changes packs but not code: freeze refuses unless the page is byte for byte the live one. Review the change first with a pack diff (added, removed, shape or label-only, per record) and a staleness list for any painted layer.
- **Live views as well as painted ones.** A view now has a kind.
  - **Live** captures, of the 3D map drawn every frame, settle on frames that actually return. They need the scene built, no painting wanted, and no error, error banner or lost context. They count 20 frames over 3 healthy polls, and any unhealthy poll restarts the count. At least one frame must arrive within 15 s, or the check reports that rendering stopped.
  - Frame rate, first-frame delay and the WebGL renderer are recorded as evidence of the capture machine. A minimum frame rate fails a view only if that view asks for one, and it is reported as a policy failure, not a broken page.
  - **Painted** views keep the tile-based settle described above.
- **Test inputs travel with the snapshot.** A test suite that reads a data file beyond the page's own inputs needs that file in the package's source snapshot, or the frozen tests fail. Declare such files with the suites that use them. Copy them in only after the snapshot has reproduced the page without them, and record them in the review. A unit test fails when a configured suite reads a data file that is neither in the snapshot nor declared.
- **Patch repaints.** When a few buildings change, repaint their regions instead of the whole grid. Each region is the old and new building pixels grown by a margin, minus every other building. The regions are chained onto the live mosaic in order, with a hash chain from the base mosaic to the final one, and the alpha must equal the base's. Nothing outside the regions may change, so the rim and road passes are skipped.
- **A fixed scorecard before and after** (ALGORITHMS.md §18) turns "it looks better" into numbers. Two runs of an unchanged tree must agree exactly, and a changed measurement method makes runs "not directly comparable" rather than better or worse.

Everything in this method can be run by people. The tool exists so that the steps are identical every time and so that it refuses when anything has drifted, not to replace the owner, the operator or the reviewer.

## Publishing a methods repository

1. **Candidate.** Copy only allowlisted files into an isolated clean clone of the published branch, with no remote back to the private workspace. Run the publication check on the index, commit, and run it again on the commit. Organisation-specific disclosure patterns (internal domains, hostnames, project names) come from a private file the tool passes to the check, so the public check names no organisation.
2. **Audit pack.** Assemble everything the reviewer needs:
   - the extracted `git archive` tree with a hash manifest;
   - history, refs, stashes and remotes;
   - the tree listing and reachable objects;
   - test results;
   - secret-scan results for the tree and the history;
   - metadata checks for every pinned binary;
   - the exact push command.
3. **Reviewer approval** of that exact commit and tree.
4. **Push** only the pinned commit, as a fast-forward of a single branch, without tags. Refuse if the remote has moved.
5. **Post-push.** Verify that the remote commit, tree, blob ids and modes equal the approved ones; that every CI job is green; and that the repository settings match the plan.

A publication check stops at its first failure, so one fix can expose the next problem. Before handing over a candidate, run the check yourself on a fresh repository that holds exactly the allowlisted files.

## Testing the tool

- Unit tests use fakes only: a fake shell transport called by absolute path, a fake browser worker, a stand-in image service, a local bare repository and temporary folders. There is no server, no hosted repository and no paid call. A fake reached through `PATH` can silently fall back to the real program if its executable bit is lost.
- Check "nothing was written" with before-and-after snapshots of the folder. Each snapshot records the path, kind, link target, or size and hash of every entry, read without following links. Don't rely on glob searches, whose treatment of dangling links varies between language versions.
- Every bug fixed in review gets a regression test. Each review round names the changed files and their hashes.

## Roles

| Role | Does |
| --- | --- |
| Owner | Approves the look, deployments, rollbacks and publication, directly to the agent that acts |
| Operator | Runs the steps that need the build machine or the host |
| Reviewer | Reads each step's evidence and posts a pass or blockers; records the review gate for publication |

The tool records and checks these roles; it does not replace them.
