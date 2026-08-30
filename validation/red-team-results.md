# Fourth Down red-team acceptance record

Validated on 2026-08-29 against the working tree. This record deliberately
separates deterministic localhost evidence from the final ESPN practice-room
journey. The signed-in Chrome session was not restarted or replaced.

## Gate status

| Gate | Status | Evidence and exit criterion |
| --- | --- | --- |
| Repository | PASS | `pnpm verify`: 9 test files, 60 tests, typecheck, lint, and production build; `git diff --check` clean. |
| Recommendation legality | PASS | 21 focused cases plus 10,000 deterministic scenarios / 787,333 returned recommendations; zero illegal, duplicate, non-finite, drafted, excluded, or capped candidates. |
| Recommendation counterfactuals | PASS WITH GAP | Four-WR suppression, forced DST, zero-slot K/DST, stale evidence decay, full-PPR projection, sequential opponent demand, tier exhaustion, duplicate IDs, and no-future-turn behavior pass. Conditional two-player optimization for the slot-8 turn is not implemented. |
| Reconciliation and persistence | PASS | Repeated snapshot, newer correction, stale rollback, stale config rollback, atomic player swap, first missing pick, manual-lock idempotence, reset/undo scoping, catalog activation, and shrink-conflict preservation pass against disposable SQLite databases. |
| Connection truth | PASS LOCALLY | Invalid/future timestamps are rejected; empty quarantined and shrink-conflict observations degrade capture; strict status rejects missing reconciliation, pick gaps, and open conflicts. A valid zero-pick board with a real catalog can reconcile. |
| Extension isolation | PASS WITH LIVE LIMIT | Exact extension origin enforced; concurrent tab claims serialized; a reload preserves the run ID and a new same-tab document navigation rotates it. ESPN same-document SPA navigation remains for the live journey. |
| API security | PASS | Isolated engine: unauthenticated health 401, bad Host 400, missing/fake extension origin 403, exact extension origin 200, wrong token 403, malformed/future observation 422, and no state mutation. BFF missing-CSRF and cross-origin mutations returned 403. |
| Lifecycle and recovery | PASS WITH HARDENING GAP | Practice setup passed twice with the same `startedAt`; foreign-port ownership was refused; backup integrity passed; teardown stopped only Fourth Down and explicitly preserved Chrome/ESPN. PID ownership still relies on runtime metadata rather than executable/start-time identity. |
| UI behavior | PASS | `pnpm app:validate:red-team-ui`: six states across 1440/1024/768/390 plus freshness boundary, 25/25. Search, filters, expansion, drawer, board, watcher dialog, keyboard close/focus, forced-position purity, dedupe, offline/stale action blocking, ARIA targets, and overflow passed. |
| Accessibility | PASS AUTOMATED | Independent axe pass: zero violations on Live and Players at desktop/mobile. Mobile nav contrast: 17.89:1 active and 7.38:1 inactive. Manual VoiceOver, zoom/reflow, and non-Chromium checks remain unverified. |
| Performance | PASS | 1,000 recommendation recalculations: 0.111 ms median, 0.181 ms p95, 1.559 ms max. 100 sequential state reads: 35.63 ms median, 53.80 ms p95, 105.13 ms max. A 100-request parallel burst had no errors and 1.13 s p95. |
| Production dependencies | FAIL | `pnpm audit --prod` reported 14 high, 8 moderate, and 1 low advisory. Directly relevant items include unpatched `xlsx@0.18.5`; Fastify, Kysely, Next, Sharp, and PostCSS also require disposition or upgrade. |
| Preserved ESPN practice draft | BLOCKED | Requires the updated unpacked extension to be reloaded, then a league-specific simulated practice draft in the existing Chrome session. Strict status must pass and real picks must gray rows/recompute roster and recommendations. |

## Defects found and corrected during this pass

- An older observation could roll a newer board or observed league config back.
- Full-snapshot swaps failed under the unique-player constraint; shrinking
  snapshots could silently leave a wrong board looking current.
- Malformed/future timestamps could poison freshness checks.
- Manual conflicts and reset undo were not correctly idempotent/scoped.
- An arbitrary extension origin and two concurrent ESPN tabs could write to the
  bridge.
- Declared catalog counts could retire the fallback catalog without containing
  that many player rows.
- Slot 8 still received an actionable recommendation after its final pick 121.
- Entirely stale catalogs received full evidence confidence, and repeated
  opponent turns used static rather than sequential position demand.
- Active offline and timed-out states left advice looking actionable.
- Mobile navigation was transparent; ARIA references, contrast, tiny text,
  forced-position leakage, and next-tier duplication failed the first UI pass.

## Preserved-session live procedure

1. Reload the unpacked extension from `chrome://extensions`; do not restart
   Chrome.
2. Return to the normal league/team page in the existing tab/session.
3. Open **League Specific Practice Draft** and select **Start Practice Draft**.
   Do not enter ESPN's public mock-draft lobby.
4. Run `pnpm app:status:espn` and require its PASS before relying on advice.
5. Capture the pre-pick revision and recommendations. Make the pick manually on
   ESPN, then require a fresh observation/reconciliation, one board update, a
   gray/hidden drafted player, roster change, and recommendation recomputation.
6. Exercise at least picks 1-9 so the slot-8/9 turn is observed. If ESPN permits
   a safe correction or reconnect, require the local board to converge without
   duplicate revisions or an unresolved conflict.

Until step 6 passes, the project is not described as end-to-end validated.
