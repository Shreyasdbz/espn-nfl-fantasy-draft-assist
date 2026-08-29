# Fourth Down Runbook

Fourth Down is a local, read-only decision companion for ESPN fantasy drafts.
You make every pick on ESPN. The Chrome extension observes the rendered ESPN
draft and sends snapshots to the local engine.

Practice and real drafts use the same UI, database, recommendation engine, and
watcher. The mode switch changes only the local environment/adapters that are
allowed to run.

## Quick command reference

| Goal | Command |
| --- | --- |
| Start in league-specific practice mode | `pnpm app:setup:practice` |
| Start for the real league draft | `pnpm app:setup:real` |
| Check local services and database | `pnpm app:status` |
| Require a fresh, reconciled ESPN connection | `pnpm app:status:espn` |
| Validate desktop/mobile layout | `pnpm app:validate:visual` |
| Back up and stop Fourth Down | `pnpm app:teardown` |
| Run all code checks | `pnpm verify` |

The local portal is always [http://127.0.0.1:3000](http://127.0.0.1:3000).

## One-time setup

### 1. Install prerequisites

You need:

- macOS with Google Chrome
- Node.js 22.13 or newer
- pnpm 10 (`corepack enable` if `pnpm` is unavailable)

The setup scripts install the locked dependencies automatically when
`node_modules` is missing.

### 2. Load the watcher extension once

1. Keep your normal Chrome session open.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's `apps/chrome-extension` directory.
6. Leave the extension enabled.

The extension observes only `fantasy.espn.com` pages. It cannot click Draft,
queue a player, or alter ESPN.

Do not repeatedly close and relaunch Chrome. Reuse the existing browser session
and return to your normal ESPN league/team URL before beginning another draft.

## League-specific practice draft

Do not use ESPN's public mock-draft lobby. Practice against the league's actual
team count, roster rules, scoring, and draft slot.

### Start

1. In a terminal at the repository root, run:

   ```bash
   pnpm app:setup:practice
   ```

2. Open your normal ESPN league/team page in the existing Chrome session.
3. Open **League Specific Practice Draft**.
4. Select **Start Practice Draft**. ESPN may open the room in a new tab.
5. Leave that draft tab open.
6. Open Fourth Down at [http://127.0.0.1:3000](http://127.0.0.1:3000).
7. Confirm the footer says **Practice**.

### Confirm synchronization before drafting

Run:

```bash
pnpm app:status:espn
```

The command must end with:

```text
PASS: local services and live ESPN synchronization are healthy.
```

It checks more than the green connection badge. It requires:

- healthy engine and SQLite database;
- an authenticated, supported ESPN draft page;
- an attached read-only watcher;
- a recent ESPN observation;
- a recent board reconciliation when picks already exist.

### Validate the first pick

After the first ESPN selection:

1. Run `pnpm app:status:espn` again.
2. Confirm the reported revision and pick count advanced.
3. Confirm the drafted player is gray/hidden in Fourth Down.
4. Confirm the recommendation list and roster construction strip changed.

If any of these fail, stop making picks until the connection is healthy.

### During practice

- Make selections only on ESPN.
- Keep the ESPN draft tab open.
- Use Fourth Down to inspect recommendations, evidence, roster needs, and the
  remaining player pool.
- Run `pnpm app:status:espn` whenever the board appears stale.
- Do not reset the local board while ESPN observation is active.

### End practice

When the draft is complete or you want to stop:

```bash
pnpm app:teardown
```

This creates a timestamped SQLite backup and stops only the local Fourth Down
processes. It does not close Chrome, close ESPN tabs, unload the extension, or
delete any draft data.

## Real league draft

### Start

Start Fourth Down before entering the real draft room:

```bash
pnpm app:setup:real
```

Then:

1. Keep the existing Chrome session open.
2. Navigate to the league's normal waiting-room/team URL.
3. Enter the real draft room only when ESPN makes it available.
4. Leave the draft tab open.
5. Open [http://127.0.0.1:3000](http://127.0.0.1:3000).
6. Confirm the footer says **Live**.
7. Run `pnpm app:status:espn` and require a PASS before the draft begins.

Real mode never drafts for you. It only changes the local environment to
disallow practice-only synthetic observations and ensures the real ESPN draft
is treated as the source of truth.

### During the real draft

- Make every selection on ESPN.
- Never refresh, close, or replace the Chrome session merely to repair Fourth
  Down. First run the status command and use the troubleshooting steps below.
- After a suspicious pick, confirm the revision, pick count, drafted-player
  state, and recommendation refresh before relying on the next suggestion.
- Do not reset or archive the active board while the ESPN watcher is attached.

### End the real draft

```bash
pnpm app:teardown
```

The backup path is printed during teardown. Keep the browser session intact.

## Connection and validation commands

### Local-only health

```bash
pnpm app:status
```

Use this immediately after setup. It verifies the runtime, database integrity,
configured mode, and local HTTP endpoints. ESPN may still be unattached.

### Strict ESPN health

```bash
pnpm app:status:espn
```

By default, an observation or reconciliation older than 15 seconds is stale.
For a slower diagnostic window:

```bash
./scripts/validate-connections.sh --require-espn --max-age-seconds 30
```

### Full repository validation

```bash
pnpm verify
```

This runs TypeScript checking, the complete test suite, linting, and a
production web build. It does not contact or modify ESPN.

### Visual layout validation

```bash
pnpm app:validate:visual
```

This opens only the local portal in a temporary headless browser. It checks the
exact starter/bench rows, the ESPN position counts and limits, mobile overflow,
and writes desktop/mobile screenshots to
`/tmp/fourth-down-visual-validation`. It never opens ESPN or touches the
signed-in Chrome profile.

### Database backup without stopping

```bash
pnpm app:backup
```

Backups live under:

```text
~/Library/Application Support/Fantasy Draft Assistant/backups/
```

## Troubleshooting

### `ESPN is not attached`

1. Confirm the extension is enabled at `chrome://extensions`.
2. Confirm the open tab is the actual ESPN draft room, not the team page,
   waiting room, or public mock lobby.
3. Keep the draft tab focused for a few seconds.
4. Reload the extension from `chrome://extensions` only if it was updated.
5. Run `pnpm app:status:espn` again.

Do not solve this by repeatedly terminating Chrome or creating new browser
profiles.

### `last ESPN observation is stale`

The local engine is running, but fresh snapshots are not arriving.

1. Check that the ESPN draft tab is still open and rendered.
2. Open Chrome DevTools on that tab and inspect the `<html>` element's
   `data-fourth-down-extension` attribute:
   - `active`: the last snapshot posted successfully;
   - `waiting`: the page does not currently look like a supported draft room;
   - `error`: the extension could not reach the local engine.
3. If it says `error`, confirm `pnpm app:status` passes.
4. Reload the ESPN draft tab once, then rerun the strict status check.

### `board has never reconciled` or the pick count did not advance

A detected page is not enough. End-state synchronization requires the pick to
reach SQLite and change the local board.

1. Stop making ESPN picks temporarily.
2. Run `pnpm app:status:espn`.
3. In Fourth Down, open the tools menu and select **Reconcile now**.
4. Confirm the revision and pick count advance.
5. Confirm the drafted row grays/hides and recommendations change.

### Setup says the app did not become ready

Setup automatically removes stale `runtime.json` and `app.lock` files only when
their recorded supervisor process is confirmed dead. It never removes the
database, backups, extension state, or bridge token.

On macOS, setup runs Fourth Down as the user-scoped launchd job
`com.fourthdown.fantasy-draft-assistant`. This keeps the app alive after the
setup command exits. Teardown unloads that job.

Inspect the background log printed by the setup script:

```text
~/Library/Application Support/Fantasy Draft Assistant/runtime/fourth-down.log
```

Then run:

```bash
pnpm app:doctor
```

Do not delete the runtime directory or SQLite database as a first response.

### Switch modes without restarting

Use the small **Practice / Live** toggle in Fourth Down's footer. Then verify:

```bash
./scripts/validate-connections.sh --expect-mode practice
# or
./scripts/validate-connections.sh --expect-mode real
```

## Safety guarantees

- Fourth Down binds only to loopback addresses (`127.0.0.1`).
- The watcher is read-only and never selects players on ESPN.
- Bridge tokens stay in the local runtime directory and must never be copied
  into documentation, logs, screenshots, or commits.
- Teardown preserves the database and makes a backup by default.
- Practice and real mode share the same 1:1 product surfaces; the toggle changes
  only environment-specific behavior.
