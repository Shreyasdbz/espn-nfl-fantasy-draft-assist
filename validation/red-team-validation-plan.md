# Fourth Down red-team validation plan

This plan treats a plausible but wrong draft state as the primary failure. A
green build is necessary, but it is not sufficient. Every release candidate
must pass the isolated gates below and then one preserved-session ESPN practice
draft without restarting Chrome.

## Release-stopping invariants

1. **Draft truth:** one player per overall pick, one active pick per player, no
   stale snapshot may roll a newer pick backward, and manual locks always win.
2. **League truth:** the active session uses the observed 8-team, 16-round
   roster and position limits. A partial observation cannot erase previously
   verified rules.
3. **Decision truth:** recommendations never include drafted, excluded,
   position-capped, or impossible-to-roster players. Mandatory remaining slots
   dominate value, and market pressure cannot justify a severe reach.
4. **Freshness truth:** the UI cannot present an old board as synchronized.
   Strict status requires a detected, authenticated, attached ESPN draft page,
   a recent observation, and a recent successful reconciliation.
5. **Safety:** validation never submits an ESPN pick, copies credentials, opens
   repeated browser sessions, or mutates the preserved draft database unless a
   step explicitly uses a temporary data directory.
6. **Operability:** setup is idempotent, teardown preserves Chrome and data,
   backups pass SQLite integrity checks, and a foreign process is never killed
   to claim a successful setup.

## Failure-oriented matrix

| Boundary | Adversarial cases | Required oracle | Evidence |
| --- | --- | --- | --- |
| League parser | two FLEX rows; six bench rows; `D/ST` aliases; partial/missing limits; duplicate surrounding text; malformed totals | exact roster/limits or no update; never a guessed hybrid | parser replay tests with sanitized ESPN-shaped DOM |
| Observation stream | duplicate snapshots; out-of-order pick rows; later correction; older snapshot after correction; changing player catalog; unresolved identity; duplicate player | idempotent revision; correction advances once; stale evidence cannot revert; ambiguity quarantined/conflicted | isolated controller/repository tests and observation rows |
| Repository | stale revision; duplicate player; correction; manual lock conflict; reset confirmation drift; reset/undo; backup; migration rerun; concurrent readers | transactional rejection, preserved prior state, `quick_check=ok`, no FK violations | temp SQLite integration tests |
| Recommendation | empty roster; slot-8 turn; true and fake RB runs; capped opponent rosters; four WRs; position maximums; forced DST/K; no required player available; null evidence/ADP/bye; ties; shuffled inputs | deterministic finite scores, legal candidates only, correct forced gate, capped market boost | table tests plus deterministic property sweep |
| Recommendation counterfactuals | hold player constant while changing roster, scarcity, opponent runs, scoring format, and distance to the next turn; compare adjacent picks at the 8/9 turn | only the intended factors move the score; the two-pick plan beats two independent greedy picks | paired fixtures with factor-level score traces |
| Player intelligence | stale profiles; conflicting sources; missing projections; injuries/suspensions; duplicate IDs/names; changed teams; DST aliases | source dates and confidence remain visible; stale or ambiguous evidence is penalized or quarantined, never silently promoted | catalog validation report and sampled profile audit |
| Lifecycle | setup twice; practice/live mode switch; stale metadata; foreign port; teardown and restore | same process/data on idempotent setup; explicit refusal on foreign owner; Chrome untouched | isolated data-dir smoke plus status output |
| API security | direct engine without bearer; bad Host; cross-origin mutation; missing CSRF; wrong bridge token/origin; oversized/malformed body | 400/401/403/413/422; no state change | HTTP contract smoke against localhost/temp engine |
| Extension/session isolation | two ESPN tabs for one league; stale service worker; extension reload; forged extension origin; practice restart | only the pinned active draft can write; a new draft receives a new external ID; old observations cannot cross sessions | extension unit tests plus one controlled two-tab practice exercise |
| UI behavior | 1440, 1024, 768, 390 widths; early/active/forced/active-offline/completed/stale states; filters; recommendation expansion; player drawer; board sheet; sync popover; keyboard escape/tab | no viewport overflow, actionable controls work, offline/stale decisions are blocked, correct drafted styling and state labels, no uncaught errors | Playwright screenshots, DOM assertions, console/page-error capture |
| Accessibility | keyboard-only path; focus return; visible focus; dialog names; valid ARIA references; contrast; 200% zoom/reflow; reduced motion | no serious automated violations and every core decision path works without a pointer | axe/DOM audit plus keyboard and zoom captures |
| Supply chain | production dependency audit; lockfile integrity; known vulnerable transitive dependencies; extension permissions | no unexplained high/critical advisory; least-privilege permissions documented | `pnpm audit --prod`, lockfile diff, manifest review |
| Performance/endurance | 128-pick replay; rapid duplicate snapshots; correction storm; long-open page; reconnect after sleep | no unbounded revision/conflict growth; recommendation and reconciliation stay inside the pick-time budget | timed replay, memory sample, event-count assertions |
| Live ESPN gate | league-specific simulated practice draft only; picks 1-9 minimum; slot-8 turn pair; one correction/reload if safe | pick appears locally within freshness budget, row grays, roster and recommendations recompute, no pick is submitted by Fourth Down | strict connection report, timestamps/revisions, before/after screenshots |

## Execution order and containment

1. Snapshot `git status`, local service health, database integrity, active
   session/revision, and Chrome attachment state.
2. Run deterministic tests and all adversarial/property tests. Fail fast on any
   illegal candidate, non-finite score, nondeterminism, or state rollback.
3. Exercise parser, reconciliation, API, lifecycle, backup, and recovery only
   against temporary databases and alternate ports. The saved 128-pick draft is
   read-only evidence.
4. Run mocked-state Playwright journeys for every UI state and breakpoint, then
   run a read-only smoke against the real local state. Store screenshots under
   `/tmp/fourth-down-red-team/`.
5. Run the full repository gate: typecheck, tests, lint, production build, and
   diff checks.
6. Only then ask the user to open the league-specific **Start Practice Draft**
   flow in the existing Chrome session. Reload the unpacked extension if its
   code changed; do not restart Chrome.

## Final acceptance record

The handoff must list each gate as `PASS`, `FAIL`, or `BLOCKED`, link every
repository artifact, give exact commands and observed counts/timings, and state
what was not verified. A blocked live ESPN gate means the overall result is not
called end-to-end complete.
