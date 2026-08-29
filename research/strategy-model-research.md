# League-specific recommendation model

## Conclusion

Rebuild the recommendation engine around **expected roster utility after the
next turn**, not a larger collection of static position weights. The model must
solve the user's legal lineup, model every opponent's remaining demand, and
simulate which players survive the exact number of picks before slot 8 selects
again. A position run is useful evidence only when it consumes a valuable tier
faster than opponents' demand is being satisfied.

This follows three well-supported principles:

- Value must be measured above a league-specific positional/replacement
  baseline, not by raw projected points. League size, scoring, starters, draft
  length, and FLEX spots materially change that baseline
  ([Footballguys VBD](https://www.footballguys.com/article/bryant_vbd?article=bryant_vbd)).
- VOR and within-position drop-off answer different questions; uncertainty
  should favor dependable starters early and ceiling on the bench later
  ([Fantasy Football Analytics VOR/drop-off](https://fantasyfootballanalytics.net/2024/08/winning-fantasy-football-with-projections-value-over-replacement-and-value-based-drafting.html),
  [projection uncertainty](https://fantasyfootballanalytics.net/2024/09/fantasy-football-projections-and-uncertainty.html)).
- Next-pick availability should be probabilistic and conditioned on drafted
  players, opponent needs, and intervening picks, not treated as a fixed ADP
  cutoff ([FantasyPros Pick Predictor](https://support.fantasypros.com/hc/en-us/articles/115001315067-What-is-the-Pick-Predictor)). A peer-reviewed fantasy-football model likewise
  supports constrained roster optimization with anticipated opponent behavior
  ([Becker and Sun, 2016](https://doi.org/10.1515/jqas-2013-0009)).

## What this exact league changes

The app should use these rules exactly:

| Constraint | Count |
| --- | ---: |
| Teams / roster size | 8 / 16 |
| Starters | QB 1, RB 2, WR 2, TE 1, FLEX 2, K 1, D/ST 1 |
| Bench | 6 |
| Maximums | QB 4, RB 8, WR 8, TE 3, K 3, D/ST 3 |

Across the league, the two FLEX slots create 16 additional RB/WR/TE starts.
Each team can therefore start six RB/WR/TE players, subject to two-RB, two-WR,
and one-TE minima. That makes the current “I already have two WRs” logic too
aggressive, but it also means a fifth WR who cannot beat the existing WR4 is
only a bench option. Saturation must come from lineup assignment, not a fixed
position count.

RB and WR replacement levels are coupled by FLEX. For every hypothetical pick,
solve the best legal starting lineup and calculate the candidate's marginal
gain. A second TE should receive FLEX value only if it actually beats the best
RB/WR alternative. Position maximums are legality ceilings, not roster targets.

Slot 8 is also structurally special. The user picks 8/9, 24/25, 40/41, and so
on. At the first pick of a turn, recommend the best **two-player pair** because
the next pick is immediate. At the second pick, model 14 opponent selections
before the next turn. A single-pick score misses this discontinuity.

## Implementation contract

### 1. Hard gates

Before scoring, reject drafted/inactive/duplicate players, players above the
position maximum, and picks that make a legal final roster impossible. If one
roster slot remains and D/ST is the only unfilled mandatory position, only D/ST
can be recommended. Apply the same feasibility rule to every required slot.

### 2. Exact lineup utility

For candidate `p`:

```text
lineup_delta(p) = best_legal_lineup(roster + p) - best_legal_lineup(roster)
```

Use dynamic replacement production for missing starters rather than zero.
Bench value is smaller and should reflect probability of displacing a starter,
injury contingency, and ceiling. This prevents a fifth non-starting WR from
outranking an actual starter need while preserving a genuine elite-value fall.

### 3. Keep three baselines separate

- **Waiver replacement:** expected best free agent after all 128 selections;
  use for season-long VOR.
- **Next-turn alternative:** expected best role-equivalent player at the user's
  next pick; use for urgency.
- **Lineup threshold:** the current starter/FLEX the candidate would displace;
  use for roster fit and saturation.

### 4. Opponent-conditioned survival

Reconstruct all seven opponent rosters from drafting-slot pick history. For
each pick before the user's next turn, estimate position probabilities from:

- unfilled mandatory slots and remaining roster spots;
- FLEX-aware marginal lineup gain;
- legal position limits;
- available-board value and an ADP distribution;
- phase penalties for early K/D/ST and redundant QB/TE;
- a small room-tendency term only after enough observed picks.

Run deterministic-seeded simulations and report, per candidate:

```text
wait_cost = P(taken before next turn)
          * max(0, candidate utility - expected next-turn alternative utility)
```

At the first selection of the turn, enumerate candidate pairs. At the second,
simulate the 14 intervening selections. Start with the top 12–20 candidates and
2,000–10,000 simulations; measure latency before increasing the search.

### 5. Do not add a blind run multiplier

If picks 1–6 are RBs, supply has fallen, but six teams also filled one RB need.
Boost the top remaining RB only when:

- the player materially improves the user's legal lineup;
- a meaningful tier cliff follows;
- opponents selecting before pick 24 still have RB/FLEX demand; and
- the projected loss from waiting exceeds the best WR/TE/QB opportunity cost.

If the next RB tier is flat or an elite WR fell, fading the run can be correct.
ESPN's tier guidance supports counting acceptable remaining players against
opponents that still need the position
([ESPN Draft-Day Manifesto](https://www.espn.com/fantasy/football/ffl/story?page=NFLDK2K9_Manifesto)).

### 6. Explain every recommendation

Return the following typed terms to the UI: immediate lineup gain, assigned
role, season VOR/replacement rank, tier drop, player and tier survival
probability, expected positional selections before the next turn, opponents
with starter/FLEX demand, projection confidence/freshness, and any disabled
signal caused by incomplete pick mapping.

## Required red-team fixtures

1. Six-RB run plus a true last-in-tier RB: RB rises.
2. Six-RB run plus a flat RB tier and fallen elite WR: do not chase.
3. Opponents' RB demand is satisfied: recent RB count alone has no bonus.
4. Four starting WRs already: ordinary WR5 is bench-only; elite WR that
   displaces WR4 remains viable.
5. One slot left and only D/ST (or another mandatory position) missing: force
   the legal position.
6. Early QB run in this one-QB/eight-team league: wait when the same tier is
   likely to survive; act only at a genuine elite cliff.
7. Strong TE plus two non-FLEX-worthy backups: third TE near zero, fourth
   illegal.
8. Early K/D/ST run: preserve offensive value until roster feasibility forces
   the slots. Historical Expected VBD found K/D/ST draft order weakly related
   to realized value ([Footballguys Expected VBD](https://www.footballguys.com/article/stuart_expected_vbd_by_adp)).
9. Pick 8 pair optimization and pick 9 fourteen-pick survival produce visibly
   different urgency.
10. Missing team mapping, stale player status, parser duplicates, undo/replay,
    exact position caps, and a one-FLEX/two-FLEX configuration mismatch all
    fail safely and visibly.

No exact-format controlled study was found for an eight-team, full-PPR,
two-FLEX managed ESPN league. These structural conclusions are derived from the
league math and established VBD/survival methods; they should be validated with
the application's own deterministic draft simulations rather than presented as
universal fantasy doctrine.

