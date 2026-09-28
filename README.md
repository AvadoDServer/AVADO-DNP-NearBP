# AVADO-DNP-NearBP

NEAR validator (`nearbp.avado.dnp.dappnode.eth`) for AVADO: nearcore on NEAR
mainnet, one package, one network.

| What | Where |
|---|---|
| nearcore version | `build/Dockerfile`: `FROM nearprotocol/nearcore:<version>@<digest>` (pinned by digest) and `upstream` in `dappnode_package.json` (the two must agree) |
| neard settings | `build/files/config.json` (copied over `/root/.near/config.json` on every start) |
| start script | `build/files/entrypoint.sh` (`neard init` on an empty volume, then `exec neard run`) |
| data and keys | volume `data:/root/.near` (`validator_key.json`, `node_key.json`, `data/`) |

## How releases work now

In plain words: **a robot prepares every nearcore update, our own checks test
it on NEAR mainnet, and a tested update goes to the staging store by itself.
Required updates go fast and you get an email with the deadline at once.
Customers only get it when you publish it to production in editstore, as
before.** Until you set `PIPELINE_MODE` to `on`, the robot only prepares and
comments; it never merges (see "Modes", and "Before you switch it on").

NEAR has no DAppNode package, so there is no DAppNode test to wait for: our
checks are the only test, and a normal release waits 72 hours instead.

1. **Bump** (every 4 hours, `bump.yml`). When nearcore publishes a new
   **mainnet** release on GitHub (a stable `X.Y.Z` tag whose release header
   says `CODE_COLOR: ..._MAINNET`; never an `-rc`, a pre-release or a
   testnet-only release) and its Docker image exists, the robot opens ONE pull
   request on branch `avado-bot/bump`: the nearcore version and digest in
   `build/Dockerfile`, `upstream` and `version` (one step up) in
   `dappnode_package.json`, and the image tag in `docker-compose.yml`. If an
   even newer release appears while the PR is open, the same PR is updated.
   If you close the PR without merging, that version is skipped and the robot
   waits for the next release (reopen the PR to undo).
   It reads the header at the top of every nearcore release:

   | Header | Meaning | What the robot does |
   |---|---|---|
   | `CODE_RED_MAINNET` or `SECURITY_UPGRADE: TRUE` | crash, DoS or security fix | **required**: fast track, email at once (deadline: release + 7 days) |
   | `PROTOCOL_UPGRADE: TRUE` | new protocol version; validators on the old version drop out after the vote | **required**: fast track, email at once (deadline: the voting date in the notes) |
   | `PROTOCOL_UPGRADE` or `DATABASE_UPGRADE: TRUE` | the database may migrate on first start | PR and email say it is **one-way** (see below) |
   | anything else (`CODE_GREEN`, `CODE_YELLOW` without an upgrade flag) | normal release | merges 72 h after nearcore published it |
   | no readable header on the version offered | unknown: maybe testnet only, maybe required | **never merged by the robot**: you get an email and decide |
   | no readable header on an older release the update includes | unknown | treated as normal; you get a "[check]" email |
2. **Checks** (`pr-checks.yml`, status `avado/checks`), on free GitHub machines:
   - the nearcore image digest is still what Docker Hub serves for that version;
   - the package name, volume, port and settings names are the same as on
     `main` and in production, the version goes up, and the Dockerfile,
     manifest and compose file name the same versions;
   - the package is built with the AVADOSDK exactly as before (files added to
     AVADO's IPFS node), and the image is loaded back from the uploaded file;
   - the neard inside is exactly the new version;
   - neard accepts **every key of our `config.json`** (no "unrecognized
     fields", no ignored top-level key, `neard validate-config` passes) and
     **every flag the entrypoint passes**;
   - the package **boots on NEAR mainnet** like a new install: the epoch sync
     proof is accepted, it finds peers, header sync moves, the RPC answers
     `mainnet` and the right version, port 24567 is published, and it stops
     cleanly;
   - the **upgrade in place**: the production image runs on a volume (with a
     validator key added the way an owner does it), finishes epoch sync,
     header-syncs until it is within 2 epochs of the chain head (like a synced
     box) and is stopped like a box does it; the new build starts on the same
     volume. It must keep `validator_key.json` and `node_key.json` byte for
     byte, **run as the validator** (its RPC names the account and public key
     of `validator_key.json`), not initialise the node again, open the
     existing database and go on syncing from where production stopped,
     without a new epoch sync.
     (nearcore itself deletes `data/` and syncs again when it starts more than
     2 epochs behind the head; a box that is in sync never is.)
   A fresh NEAR node asks one peer at a time for its first proof and busy
   peers often do not answer (3 to more than 60 minutes in the 0.0.76 tests).
   A boot or upgrade test that fails only on that (or on peers) is tried once
   more on the spot, and the gate runs it once more after that, without an
   email.
3. **Gate** (every 4 hours and after every check run, `gate.yml`, status
   `avado/gate`). It merges the PR (a merge commit) only when our checks are
   green, the branch contains `main`, nothing is held, **and**:
   - the release is **required** (header above, for the new version or one it
     skips): at once; or
   - any other release: **72 hours** after nearcore published it.

   It does **not** merge when our checks fail, when the version is not a
   mainnet release or its release header cannot be read, when nearcore would
   go down, when anything is unclear, or when a person pushed changes to the
   checks or the pipeline onto the robot's branch (those are yours to review
   and merge). Then it opens an issue for you (see "What the emails mean").
   A conflict on a branch only the robot wrote waits: the robot rebuilds it.
   It only counts check runs of this repo, and a check run started by hand
   only when it was started on `main`. The gate writes its reasoning in a
   comment on the PR, updated on every run. It also starts the release when a
   version on `main` never got a release run.
4. **Release** (`release.yml`, after the merge). If the version on `main` is
   new and nothing is held, it is published to the **staging** store: **only
   the exact build the checks tested for these files** (found by a content id;
   a merge commit, a squash and a re-run all find it), then
   `store.setPackageHash`, an empty commit `Release <name> <version>` with
   `Manifest hash: <hash>` (the format the release watcher and editstore know,
   as `ci-release-action` wrote it) and one `store.releaseStore`, with the
   `RPC_TOKEN` secret. It never builds anything itself. Without a tested build
   nothing is published and you get an issue that says what to do (below).
   Without `RPC_TOKEN` it only shows what it would do.
5. **Production**: unchanged. You publish it in editstore when you are happy
   with staging. For a required release, **before the deadline**.

**One-way step (protocol and database upgrades).** A nearcore release with
`PROTOCOL_UPGRADE` or `DATABASE_UPGRADE: TRUE` may migrate the node database on
its first start (2.14 migrates database version 49 to 51). After a box has
run it, older nearcore cannot open that database: there is no way back, and
every later fix must stay on that nearcore or newer. A migration cut short (a
reboot, or the disk watcher stopping the app after 10 s) cannot be undone. The
upgrade test only migrates a database that is minutes old, so before
promoting such a release to production, update a copy of a fully synced NEAR
database on the test box. The PR and the "[required]" email say this.

Human pull requests get the same checks. **Open them from a branch in this
repo** (not a fork) and merge them yourself with **"Create a merge commit"**
when the branch is up to date with `main`: the release then publishes the new
version from the build the checks tested. Pull requests from forks are checked
on a throwaway IPFS node and their builds are never released; after merging
one, run the checks for `main` (below).

**"Release: NOT published ... no tested build"**: `main` has files the checks
never tested (a merge while the branch was behind `main`, a fork PR, a direct
push). Actions → **PR checks** → Run workflow with `pr` = `main`; when it is
green, Actions → **Release** → Run workflow.

### Modes

Settings → Secrets and variables → Actions → **Variables** → repository
variable `PIPELINE_MODE`:

| Value | Effect |
|---|---|
| (not set) or `shadow` | The robot bumps and the checks run; the gate says what it *would* do (status and PR comment) but never merges. You still get the "[required]" emails; they tell you to merge by hand. This is the default. |
| `on` | Normal: bump, check, gate, merge, release to staging |
| `off` | The bump robot and the gate do nothing. Checks still run on pull requests, and a merge you make yourself is still released to staging |

A merge you make yourself is released to staging in every mode.

Other variables: `PIPELINE_OWNER` (who gets the issues, default `flisko`),
`IPFS_PROVIDER` (leave empty; `local` is only for a test copy of this repo, its
builds can never be released).

### Hold

A file `hold` at the top of the repo, whose first line says why, holds NEAR
back: the robot opens no PR, the gate merges nothing and the release
publishes nothing; boxes keep the version they have. A required nearcore
release is still reported to you (the email says NEAR is held). End the hold
by removing the file in a pull request you merge yourself. Use it, for
example, to keep a protocol upgrade away from staging until you have tested
its database migration on the test box.

### What the emails mean

GitHub emails the person an issue is assigned to (`PIPELINE_OWNER`). Keep
**Email** ticked for "Participating, @mentions and custom" in
github.com/settings/notifications.

- **"[required] nearcore <version> for NEAR: promote to production before
  <date>"**: nearcore marked the release as required. The robot fast-tracks
  it; the email says the deadline, whether it is a one-way database step, and
  what you must do (promote it in editstore once it is on staging; in shadow
  mode, merge the PR yourself first). You get one more email when it reaches
  staging, and **reminders 48 hours and 12 hours before the deadline and when
  it passes**, as long as production does not run it. If you close its PR
  without merging, the issue stays open and says so (reopen the PR, or ship it
  by hand). It closes by itself when production runs it.
- **"[needs fix] nearcore <version>: its release header could not be read, you
  decide"**: the robot cannot tell whether the version is meant for mainnet
  or required, so it does not merge. Read the release notes (the issue has a
  Claude Code prompt that does it): a mainnet release you merge yourself once
  `avado/checks` is green; anything else you close.
- **"[check] nearcore <version>: a release it includes has no readable
  header"**: an older release the update includes has no readable header; the
  robot goes by the headers it can read. Read the notes; if NEAR says it is
  urgent, merge the PR yourself.
- **"[needs fix] nearcore <version>: our checks failed ..."**: the new nearcore
  broke something (for example a config key was removed), and the automatic
  re-runs did not help. Nothing was merged or released. The issue has the
  failing check, its log lines, and a **ready-to-paste Claude Code prompt**:
  run `gh pr checkout <n>`, start `claude`, paste the prompt, review, push.
  The checks run again and the gate merges when they are green. The issue
  closes by itself.
- **"[needs fix] nearcore <version>: a person changed the checks or the
  pipeline ..."**: someone (or Claude Code) pushed changes to the checks or
  the pipeline onto the robot's PR. Read them, and merge the PR yourself if
  they are right.
- **"[pipeline broken] <workflow> workflow failed"**: the robot itself broke
  (GitHub, Docker Hub, AVADO's IPFS node or store did not answer, or a bug), or
  the release found no tested build. Nothing reaches any box. The issue shows
  the error, the run link and a prompt; it closes by itself after the next
  successful run.
- **"[pipeline] PAT_TOKEN was rejected: renew it"**: the personal token
  expired. The robot keeps working without it (see "Secrets").
- A comment on one of these issues means the situation changed. A problem that
  stays the same does not send more emails.

### Before you switch it on

1. Keep GitHub emails on (above).
2. **List the robots in the release watcher** (recommended): in
   `AvadoDServer/avado-release-control`, `packages.yml`, under `id: nearbp`,
   add
   ```yaml
       workflows:
         - {file: bump.yml, every_hours: 4}
         - {file: gate.yml, every_hours: 4}
         - {file: release.yml}
   ```
   The watcher already emails you ("workflows:stopped") when GitHub switches
   off any workflow of this repo for inactivity: GitHub does that to
   scheduled workflows in a public repo after 60 days without commits, and
   this repo had such a gap (22 July to 21 September 2026). Listed robots are
   also reported when they were switched off by hand, keep failing, or had
   no successful run for 12 hours. The fix for a switched-off robot is
   Actions → the workflow → **Enable workflow**.
3. Then set `PIPELINE_MODE` to `on`.

### Secrets

- `RPC_TOKEN` (organisation secret, as before): used only by `release.yml` for
  `store.setPackageHash` and `store.releaseStore`. The release job runs no build
  and no third-party code next to it.
- `PAT_TOKEN` (optional repository secret, not set today): the bump robot
  pushes and opens its PR with it, so the checks start by themselves (GitHub
  does not start workflows for changes made with the built-in token). Use a
  **fine-grained** token: resource owner AvadoDServer, only this repository,
  Contents and Pull requests read and write, with an expiry date. Without it
  the robot starts the checks itself through `workflow_dispatch` (the PR then
  also shows a "PR checks" run marked "action required" that can be ignored).

### Update nearcore by hand

In `build/Dockerfile`, set `FROM --platform=linux/amd64
nearprotocol/nearcore:<version>@<digest>` (the digest is the `digest` of
https://hub.docker.com/v2/repositories/nearprotocol/nearcore/tags/<version>);
set `upstream` to the same version and raise `version` in
`dappnode_package.json`; set the new package version in the `image:` line of
`docker-compose.yml`. Open a pull request from a branch in this repo and merge
it when `avado/checks` is green. (Or run the Bump nearcore workflow by hand.)

## Checks

The scripts the checks run also work on a Mac (Docker needed; an Apple Silicon
Mac runs the amd64 image emulated, slowly):

```bash
scripts/ci/check-identity.sh origin/main                  # name, volume, port, env keys, versions agree
scripts/ci/check-digest.sh                                 # the pinned digest is what Docker Hub serves
docker build --platform linux/amd64 -t nearbp:test build/  # or scripts/ci/sdk-build.sh <out> <ipfs api>
scripts/ci/check-version.sh nearbp:test 2.13.4             # the exact neard
scripts/ci/check-config.sh nearbp:test                     # every config key and flag is accepted
scripts/ci/boot-test.sh nearbp:test dappnode_package.json /tmp/boot
scripts/ci/production-image.sh nearbp.avado.dnp.dappnode.eth nearbp:production /tmp/prod
scripts/ci/upgrade-test.sh nearbp:production nearbp:test dappnode_package.json /tmp/upgrade
node --test ".github/pipeline/test/*.test.mjs"             # the gate's rules (Node 22)
```

`scripts/ci/sdk-build.sh <out> <ipfs api>` is the AVADOSDK build the checks use
(AVADOSDK pinned at commit 23d6757; it builds the files git tracks at HEAD).
`scripts/ci/content-id.sh` prints the content id the tested build is named
after. The boot and upgrade tests take `BOOT_EPOCH_SYNC_MINUTES` (default 45)
for the first proof; the upgrade test then gives production
`UPGRADE_CATCHUP_MINUTES` (default 45) to get within `UPGRADE_MAX_LEFT`
(default 80000) headers of the head. Exit code 2 means only the public
network failed.

## Test copy (dry run)

To try the pipeline without touching this repo or the store: push it to a
private repository, set the variable `IPFS_PROVIDER=local` there (builds go to a
throwaway IPFS node on the runner), do not add `RPC_TOKEN` (the release is a
dry run), set `PIPELINE_MODE=on` if the gate should merge, and tick Settings →
Actions → General → "Allow GitHub Actions to create and approve pull requests"
(needed without `PAT_TOKEN`). To exercise a real required release, make `main`
there pretend to be on an older nearcore (for example 2.13.3 with its digest):
the robot then offers 2.13.4, a CODE_RED security release. Run "Bump nearcore"
by hand with a `version` to simulate a release without an image; the checks
then fail, which exercises the issue path. Set `PIPELINE_MODE=off` there
afterwards. The first copy is `flisko/nearbp-pipeline-dryrun` (private,
paused: `PIPELINE_MODE=off`, bump and gate disabled).
