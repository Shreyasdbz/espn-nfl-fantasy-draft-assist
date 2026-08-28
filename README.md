# Fourth Down

Fourth Down is a private, local, real-time decision companion for an ESPN fantasy-football draft. ESPN remains the place where every selection happens, including mock-draft practice. Fourth Down passively follows the ESPN room, materializes a local board in SQLite, and recomputes deterministic, inspectable recommendations without ever submitting a pick.

The bundled player pool is a fictional fallback fixture. Once the ESPN bridge observes a sufficiently complete player table, Fourth Down activates that passive ESPN catalog and excludes the fallback from recommendations.

## What works

- One read-only experience that begins only after an ESPN draft page is explicitly bound.
- A single persisted Practice/Live environment toggle in the footer. It selects environment-specific adapter/parser configuration and copy without branching the board, recommendation, reconciliation, or selection workflow.
- Synthetic practice observations use the same normalization and reconciliation path as ESPN observations; they cannot write picks directly.
- Revision-checked, idempotent commands and manual locks that outrank automation.
- Factorized recommendations with ADP value, positional scarcity, roster fit, tier, risk, uncertainty, and bye overlap.
- Revisioned SSE updates from the persistent engine to the same-origin web app.
- Board reset as archive-and-branch, with immediate undo and no player-data deletion; reset is disabled while ESPN observation is active.
- SQLite WAL, foreign-key checks, migration checksums, integrity diagnostics, and verified backups.
- A read-only ESPN adapter using sanitized rendered-state snapshots, with passive response/WebSocket support behind the same observation contract.
- A tiny tab bridge that runs inside the user's already-open, signed-in ESPN draft tab. It reads rendered draft facts and posts only sanitized picks/player rows to the loopback engine; it never exports cookies, headers, member IDs, or storage state.
- In-place bridge refreshes that replace the prior timer without opening, closing, or relaunching Chrome.

## Repository map

```text
apps/
  web/              Vinext/Next App Router UI and same-origin BFF
  engine/           Fastify engine, SQLite owner, SSE, and browser lifecycle
  cli/              local supervisor, locks, doctor, backup, and shutdown
packages/
  contracts/        Zod schemas and shared API/view-model types
  domain/           snake order, identity normalization, revision invariants
  db/               SQLite repository and migrations
  recommendation/   deterministic scoring and explanations
  adapter-sdk/      observation-only adapter boundary
  espn-adapter/     ESPN page detection and sanitized passive capture
  simulator/        seeded opponent drafting
  fixtures/         fictional player fixture for local development
tests/               integration, replay, and failure-path coverage
migrations/          reviewed SQL schema
```

Runtime data defaults to `~/Library/Application Support/Fantasy Draft Assistant` and is never stored in Git. It contains the SQLite database, a mode-0600 loopback bridge token, runtime locks, diagnostics, and backups. Fourth Down does not read or copy the user's normal Chrome profile.

## Run locally

Requirements: macOS, Node 22.13 or newer, pnpm 10, and Google Chrome.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open the exact URL printed by the supervisor, then leave the existing signed-in ESPN Chrome session alone:

1. Open the desired ESPN league-specific practice room or live draft in the normal signed-in tab.
2. In Fourth Down, choose **Copy ESPN tab bridge**.
3. In the ESPN address bar, type `java`, paste, and press Return once. Chrome intentionally strips a pasted `javascript:` prefix, so Fourth Down copies the remaining `script:` payload.
4. Keep making every selection yourself on ESPN. Fourth Down only reads the rendered room and updates its local board.

Use **Refresh ESPN bridge** after a local engine upgrade or if the bridge status becomes stale. Refreshing swaps the timer inside the same tab; do not close or relaunch Chrome. Closing the Fourth Down tab does not stop the engine or the ESPN bridge, while stopping the supervisor leaves Chrome untouched.

For a deterministic local validation dataset without writing to the default application directory:

```bash
FDA_DATA_DIR=/private/tmp/fourth-down-validation pnpm dev
```

## Verification and operations

```bash
pnpm verify
pnpm test:replay
pnpm app:doctor
pnpm app:backup
pnpm app:stop
```

`pnpm verify` runs TypeScript, the deterministic/unit/integration/replay/failure suite, ESLint, and the production web build. Live ESPN smoke tests are deliberately separate because they require a user login and a currently supported draft page.

Backups are created outside the repository and integrity-checked before success is reported. A backup may still contain locally imported player and draft data. The Chrome profile and credentials are never included.

## Safety boundary

Both local services bind to loopback. The Fourth Down UI talks only to the web BFF, and the engine bearer secret stays server-side. Mutations require same-origin JSON plus a CSRF marker; the engine separately validates `Host`, bearer authorization, request size, command IDs, and expected aggregate revisions. The ESPN bridge has one narrow exception: its text-only observation endpoint requires the exact `https://fantasy.espn.com` origin and a persisted loopback token, and request URLs are excluded from logs so the token is not printed.

ESPN pages are untrusted input. Unknown response shapes are quarantined, ambiguous player identities are not applied, and an explicitly labeled manual recovery path remains available when Chrome, login, the page, or capture is degraded. Live recommendations never gain a browser-input capability.

## Project status

This is a source-run personal project based on [system-design-v1.md](./system-design-v1.md). The ESPN adapter remains version-sensitive by nature; a sanitized live fixture and missed-event repair run are required before treating a newly observed ESPN page shape as supported. No open-source license has been selected yet.
