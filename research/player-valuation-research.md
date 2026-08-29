# 2026 player valuation: evidence and implementation blueprint

Research date: 2026-08-29

League target: 8 teams, full PPR, 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX
(RB/WR/TE), 1 K, 1 D/ST, 6 bench. The valuation layer described here is
player-centric; the recommendation layer must convert it into league-specific
value over replacement and live-draft value.

## Conclusion

The application should not try to produce better rankings by adding more prose
or another analyst list. It should replace `usage-context-v1` with a
reproducible valuation snapshot built from four separately inspectable layers:

1. **Market and projection prior.** Use a projection consensus when licensing
   permits, ESPN's visible projection as a platform prior, and ESPN/platform ADP
   as the price at which the player is likely to disappear. A ranking is not a
   projection, and ADP is not player quality.
2. **Position-specific role and opportunity.** Model the inputs that create
   points: dropbacks and designed rushes for QBs; carries, routes, targets and
   goal-line work for RBs; routes, target earning, air yards and end-zone work
   for WRs/TEs. Use expected fantasy points to value opportunities before
   rewarding observed efficiency.
3. **Current context and availability.** Apply timestamped 2026 depth-chart,
   roster, injury, transaction, quarterback, coordinator, offensive-line and
   team-play-volume facts as explicit scenario adjustments. Do not silently
   assume that a 2025 role transfers to a new team.
4. **Uncertainty distribution.** Emit P10/P50/P90 fantasy outcomes,
   probability of holding the projected role and probability of playing a full
   season. “Floor” and “ceiling” should be outcome quantiles, not percentiles of
   a hand-built score.

For this shallow two-FLEX league, the draft value should then be based on
projected **starter advantage above a replacement player generated from the
actual remaining pool**. The two FLEX slots make the best RB/WR/TE outcomes
valuable, but eight teams leave strong waiver replacements. This increases the
premium on elite weekly ceilings and decreases the value of low-ceiling bench
depth. A fixed positional-rank replacement table is the wrong abstraction.

## What the current implementation actually does

### Findings from the repository

- The importer reads only one 2025 weekly player-stat CSV and one 2026 roster
  CSV (`apps/cli/src/player-intelligence.ts:8-9,74-81`). It does not ingest
  snaps, participation, routes, expected points, injuries, depth charts,
  schedules, transactions, offensive-line context, team projections or rookie
  college production.
- A player's “games” is the number of stat rows (`:91-104`). Consequently the
  late split is the last six *appearances with a stat row*, not necessarily the
  last six team games, and PPG is conditional on appearing. Missed-game and
  availability risk are not modeled.
- QB opportunity is only rushing attempts per appearance. RB/WR/TE opportunity
  is raw carries plus targets (`:105-114`). Pass attempts, dropbacks, routes,
  snap share, high-value touches, red-zone work and expected points do not enter
  the model.
- Weekly target share and air-yards share are averaged without weighting by the
  week's team pass volume (`:100-114`). A three-target low-volume week has the
  same influence as a 12-target high-volume week.
- The comparison population is every player at a position with four stat rows
  (`:118-123`), not the draftable pool or the league-specific replacement pool.
- “Floor” is 65% position PPG percentile plus 35% opportunity percentile.
  “Ceiling” is a similar score plus 10 and up to three points for each positive
  late-season PPG point (`:125-131`). These are 0-100 ranks, not projected
  fantasy outcomes or probability bounds. The ceiling cannot fall below the
  floor by construction, and a noisy six-appearance split can dominate it.
- Data quality is “strong” when a player has eight rows and a current-team
  match (`:159`). It does not measure source coverage, freshness, role transfer,
  injury uncertainty, sample reliability or identity-match confidence.
- Players without 2025 statistics receive the same 45 floor/70 ceiling
  defaults (`:163-181`). This collapses materially different rookies, backups
  and injured veterans into one profile.
- D/ST is a manually hard-coded list and rank-to-score conversion (`:19-32,
  185-200`). Kicker context is only prior PPG (`:70`). Neither position has a
  reproducible schedule/opponent model.
- The database can store only the above fields (`migrations/0004_player_intelligence.sql:1-31`),
  and the contract exposes the same shape (`packages/contracts/src/index.ts:48-78`).
- The recommendation engine substitutes `floorScore` for reliability and
  `ceilingScore` for upside (`packages/recommendation/src/index.ts:175-176`),
  even though those values are positional percentiles. It also uses fixed
  replacement ranks QB14/RB44/WR48/TE14/K10/DST10 (`:42-44`) and independently
  scores tier, ADP, risk and those intelligence scores (`:177-210`). This can
  double-count the same prior rank while failing to represent projected points
  above this league's replacement level.

### Searched for and not found

Repository searches for `load_participation`, `load_snap_counts`,
`load_injuries`, `load_depth_charts`, `load_ff_opportunity`, routes, red-zone
usage and NGS imports returned no pipeline code. Searches for
`readPlayerIntelligence` and `usage-context-v1` found no focused importer or
calibration tests. This means the current profile formula and data joins are
effectively untested apart from downstream repository behavior.

## Evidence sources to use

### Primary or reproducible public data

| Source | Use | Important constraint |
| --- | --- | --- |
| [nflverse player-level stats](https://nflreadr.nflverse.com/reference/load_player_stats.html) | Weekly and seasonal official-style passing, rushing, receiving and kicking box-score facts; current output exposes roughly 145 columns | A box-score row is not proof of route participation or availability. Build a complete player-team-week calendar before calculating rates. |
| [nflverse players](https://nflreadr.nflverse.com/reference/load_players.html) | Canonical GSIS ID plus ESPN/PFR/PFF IDs, draft round/pick, age and immutable player identity | Use GSIS ID as the join key. Name matching must remain a logged fallback. |
| [nflverse releases](https://github.com/nflverse/nflverse-data/releases) | Machine-readable rosters, weekly rosters, schedules, player/team stats, trades and other versioned datasets | Persist exact URL, retrieval time and checksum. A moving `latest` URL alone is not reproducible. |
| [weekly depth charts](https://nflreadr.nflverse.com/reference/load_depth_charts.html) | Current team, listed position and depth ordering by week | Treat as a context signal, not truth about future usage. Preserve the as-of week. |
| [injury and practice reports](https://nflreadr.nflverse.com/reference/load_injuries.html) | Injury type, report status, practice status and modification time | Official reporting is structured but does not supply a universal probability of playing. Map statuses to calibrated historical rates rather than fixed opinions. |
| [snap counts](https://nflreadr.nflverse.com/reference/load_snap_counts.html) | Game-level offensive snap count and percentage | Snaps do not equal routes or valuable touches. Use as role participation and injury-return evidence. |
| [play participation](https://github.com/nflverse/nflreadr/blob/main/R/load_participation.R) | Player participation joined at play level, enabling routes/dropbacks and personnel-role features | From 2023 onward this is FTN Data via nflverse under CC-BY-SA 4.0 and requires attribution. It is released after the postseason, not live in-season. |
| [FTN charting via nflverse](https://nflreadr.nflverse.com/reference/load_ftn_charting.html) | Catchability, read thrown, play action, motion, screens and other play context | Also requires FTN Data via nflverse attribution. Use for prior-season skill/context features, not as a guaranteed live feed. |
| [ffopportunity expected fantasy points](https://nflreadr.nflverse.com/reference/load_ff_opportunity.html) | Situation-adjusted expected fantasy points for each rushing/receiving opportunity and weekly aggregation | The public model is an XGBoost model trained on 2006-2020 play-by-play. Pin its model version and backtest recent calibration before relying on it. |
| [NFL Next Gen Stats through nflverse](https://nflreadr.nflverse.com/reference/load_nextgen_stats.html) | QB CPOE; RB rush yards over expected; receiver air yards, expected YAC and related player-level measures | NGS applies minimum-attempt thresholds, so missing values are not zeros. Efficiency is secondary to projected role. |
| [official NFL description of NGS](https://operations.nfl.com/game-operations-logistics/technology/performance-tracking-data-next-gen-stats) | Provenance for tracking/route/expected metrics | The NFL says the system tracks player/ball movement and derives route detection, completion probability and expected rushing yards. Do not imply access to raw club tracking data. |
| [nflverse update schedule](https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html) | Establishes refresh expectations per source | Roster and schedule data can refresh during the year, but post-2023 participation data does not update during the season. The UI must expose source freshness. |

The nflverse package index also lists schedules, trades, contracts, QBR,
advanced stats and FantasyPros ranking loaders in one place:
[nflreadr reference index](https://nflreadr.nflverse.com/reference/). These are
useful discovery points, but each imported dataset still needs its own manifest
and license/provenance record.

### Established analysis used for feature selection, not copied rankings

- Fantasy Points' 2026 review of predictive WR statistics concludes that prior
  production and contextualized volume lead; per-route efficiency is useful;
  and per-target efficiency is materially worse because it controls away target
  earning. It identifies target share, routes, first reads, air-yards share,
  end-zone targets and route quality as the useful groups. See
  [WR Stats: What Matters](https://newsletter.fantasypoints.com/p/2026-values-roundup),
  especially the “WR Stats” section.
- Fantasy Life's utilization tool explicitly tracks snap share, rush share,
  route participation, targets per route run, target share, air yards and
  end-zone/short-down usage at weekly and seasonal windows:
  [Utilization Game Log](https://www.fantasylife.com/nfl/utilization-report/game-log).
  This supports the feature taxonomy. It does not authorize copying proprietary
  values into the database.
- Fantasy Life's 2026 rookie model uses draft capital plus position-specific,
  age/context-adjusted college production. Its reported RB inputs include
  adjusted yards per team attempt and receiving yards per team pass attempt;
  its WR inputs emphasize age-adjusted receiving yards per team pass attempt:
  [2026 Rookie Super Model](https://www.fantasylife.com/articles/nfl-draft/2026-rookie-super-model-a-data-centric-approach-to-grading-rooki).
  Use the concepts with licensed/public college data; do not copy its scores.
- A broad empirical review of fantasy projections found crowd-averaged
  projections more accurate than individual sources, but still moderately
  predictive and often overconfident; kicker and defense projections performed
  especially poorly:
  [Fantasy Football Analytics, projection accuracy](https://isaactpetersen.github.io/Fantasy-Football-Analytics-Textbook/evaluating-prediction-accuracy.html).
  This is a strong reason to preserve uncertainty and retain a market/consensus
  prior rather than presenting the feature model as certainty.
- A current 8-team PPR draft guide explicitly centers league settings,
  opponent rosters, ADP, current news, upside and injury risk, and its player
  analysis uses route rate, target share, aDOT and PPG:
  [DraftSharks 8-Team PPR Strategy](https://www.draftsharks.com/article/fantasy-football-draft-strategy-guide/8-team).
  Its example lineup differs from this league, so its specific player order is
  not portable. The transferable point is that shallow-league decisions require
  the actual lineup and pool.
- FantasyPros' own draft-accuracy methodology excludes K and D/ST because of
  uneven coverage/scoring and greater luck:
  [FantasyPros accuracy methodology](https://www.fantasypros.com/about/faq/football-draft-accuracy-methodology/).
  That supports aggressive regression and late-round/streaming treatment for
  these positions.

## Position-specific feature design

All rates below need two forms: full prior season and recent role window. The
recent window should be both the last four *team games* and the last four
*active appearances* so injury/bench absences do not disappear. For share
metrics, aggregate numerator and denominator first; never average weekly
percentages without weighting.

### Quarterback

Primary projection features:

- start probability and projected team dropbacks;
- attempts/dropbacks per active game, neutral-situation pass rate and team play
  volume;
- designed rushes plus scrambles per active game, team rush share and red-zone
  rush share;
- expected passing fantasy points or EPA/dropback and CPOE, regressed by sample;
- sack rate and pressure-to-sack susceptibility where licensed/available;
- projected offensive points, receiver quality, coordinator continuity and
  offensive-line continuity/injury context.

Why: in 1-QB eight-team formats, ordinary pocket production is replaceable.
Rushing provides a recurring fantasy mechanism and separates elite outcomes,
but job security and team scoring must cap a small-sample rushing projection.
Passing efficiency should not overwhelm volume and rushing.

### Running back

Primary projection features:

- team carry share, backfield carry share and carries per active game;
- route participation, target share, targets per route run and two-minute/
  long-down role;
- inside-the-5 and red-zone opportunity share;
- expected PPR points from opportunities, plus actual-minus-expected as a
  heavily regressed efficiency residual;
- snap share and recent changes in backfield split;
- team rushing volume, projected scoring, offensive-line context and teammate
  role competition;
- role-holding probability and injury/availability probability.

Targets and routes deserve extra weight in full PPR. Yards per carry and raw
touchdowns are outcomes, not stable role variables; goal-line opportunity is
more transferable than prior conversion rate. RYOE can inform talent but must
not override a poor route/goal-line role.

### Wide receiver

Primary projection features:

- route participation and routes per team dropback;
- target share and targets per route run;
- first-read/designed-target share when legally licensed;
- air-yards share, weighted opportunity (target share plus air-yards share),
  aDOT and end-zone target share;
- expected PPR points, YPRR and actual-minus-expected efficiency with
  shrinkage;
- split by personnel/alignment only when sample sizes are displayed;
- quarterback attempt volume/quality, competition for routes and targets,
  coordinator continuity and injury-return trajectory.

Do not elevate catch rate or yards per target over target-earning and routes.
Those denominators discard the ability to earn a target, exactly the concern
identified by the Fantasy Points analysis above.

### Tight end

Use the WR feature family, but add:

- route participation per team dropback rather than raw snap rate, because
  blocking snaps do not create targets;
- slot/wide alignment share if licensed;
- red-zone/end-zone target share;
- target share and TPRR versus other TEs, not WRs;
- an explicit elite-tier probability. In an eight-team league, replaceable TE
  outcomes have little advantage; a true top-tier receiving role matters much
  more than safe low-end volume.

### Rookies and players without an NFL sample

Never assign a universal 45/70 profile. Use a separate rookie model and keep it
visibly less certain:

- actual NFL draft round/pick and draft-age curve;
- age/class-adjusted share of team receiving yards or yards per team pass
  attempt for WR/TE;
- rushing plus double-weighted receiving yards per team attempt and receiving
  yards per team pass attempt for RB;
- college target earning, early-declare/breakout age and teammate/competition
  context where the underlying dataset is licensed;
- landing spot: current depth chart, route/carry path, quarterback, offense and
  team investment;
- preseason depth/usage evidence with a short expiration date.

Blend a rookie prior with landing-spot scenarios. Draft capital is not a proxy
for PPR receiving ability, and college production is not a guarantee of an
immediate NFL role.

### Team changes and role changes

A changed team, coordinator, starting QB or major teammate must create a
scenario split, not a generic warning. For example:

- `role_retained`: prior shares mostly transfer;
- `role_expands`: projected route/carry share rises because competition left;
- `role_contracts`: committee/target competition grows;
- `role_lost`: depth-chart or injury evidence makes the player a contingent
  option.

Each scenario gets a probability, volume assumptions and a source. The median
and quantiles come from the mixture. This makes a late depth-chart change
auditable without rewriting historical facts.

### Kicker

The draft model should regress kickers strongly toward the position mean and
avoid paying for last year's rank. Use:

- probability of retaining the kicking job;
- projected team drives and points;
- field-goal attempts per scoring opportunity;
- coaching fourth-down aggressiveness and red-zone TD rate, both regressed;
- kicker accuracy by distance with strong sample shrinkage;
- dome/home/early schedule context only as a small tiebreaker.

Because empirical projection accuracy is poor, K should normally be a final
roster-completion choice. Do not call prior K PPG a “role profile.”

### D/ST

Build team-defense profiles from data rather than a hard-coded rank list:

- pressure and sack rate, with personnel continuity;
- opponent-adjusted defensive EPA/success rate and points per drive;
- expected opponent dropbacks and opponent sack susceptibility;
- first three weeks' opponent quality and market-implied points when available;
- turnovers, fumble recoveries and defensive touchdowns regressed heavily;
- injuries/personnel changes and home/road context.

Season-long D/ST PPG is less valuable than a usable opening streaming window.
Store a “Weeks 1-3 stream score” and season uncertainty separately. Never let a
volatile prior defensive touchdown total create a high floor.

## Concrete data model

Do not keep adding unrelated nullable columns to `player_intelligence`. Add
versioned, timestamped fact and output tables. A practical migration is:

```sql
CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  as_of TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  license TEXT,
  status TEXT NOT NULL,
  UNIQUE(source_key, sha256)
);

CREATE TABLE player_usage_features (
  player_id TEXT NOT NULL REFERENCES players(id),
  season INTEGER NOT NULL,
  window TEXT NOT NULL,                -- season, last_4_team, last_4_active
  position TEXT NOT NULL,
  team TEXT,
  team_games INTEGER NOT NULL,
  active_games INTEGER NOT NULL,
  snaps INTEGER,
  snap_share REAL,
  routes INTEGER,
  route_participation REAL,
  carries INTEGER,
  carry_share REAL,
  targets INTEGER,
  target_share REAL,
  targets_per_route REAL,
  air_yards_share REAL,
  red_zone_opportunities INTEGER,
  inside_five_opportunities INTEGER,
  expected_ppr REAL,
  actual_ppr REAL,
  source_snapshot_ids_json TEXT NOT NULL,
  PRIMARY KEY(player_id, season, window)
);

CREATE TABLE player_context_events (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  event_type TEXT NOT NULL,             -- injury, team, depth, teammate, scheme
  effective_at TEXT NOT NULL,
  expires_at TEXT,
  direction REAL NOT NULL,              -- -1 to +1, not fantasy points
  confidence REAL NOT NULL,             -- 0 to 1
  summary TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id)
);

CREATE TABLE player_valuation_snapshots (
  player_id TEXT NOT NULL REFERENCES players(id),
  model_version TEXT NOT NULL,
  data_cutoff TEXT NOT NULL,
  scoring_hash TEXT NOT NULL,
  league_config_hash TEXT NOT NULL,
  season INTEGER NOT NULL,
  p10_points REAL NOT NULL,
  p50_points REAL NOT NULL,
  p90_points REAL NOT NULL,
  p10_ppg_active REAL NOT NULL,
  p50_ppg_active REAL NOT NULL,
  p90_ppg_active REAL NOT NULL,
  games_played_mean REAL NOT NULL,
  role_probability REAL NOT NULL,
  availability_probability REAL NOT NULL,
  role_score REAL NOT NULL,
  talent_score REAL NOT NULL,
  context_score REAL NOT NULL,
  uncertainty_score REAL NOT NULL,
  input_snapshot_ids_json TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY(player_id, model_version, data_cutoff, scoring_hash, league_config_hash)
);
```

Add a field-level evidence relation (or JSON array if migration speed matters)
with `metric`, `value`, `source_snapshot_id`, `computed_by` and `as_of`. The
current evidence array repeats the same three URLs for most players; a user
cannot tell which claim a source actually supports.

Keep `players.projection`, `upside`, `reliability`, `risk` only as a backwards-
compatibility view. New code should read a single selected
`player_valuation_snapshot`; it should not mix old and new semantics.

## Reproducible pipeline

### 1. Acquire and pin

Create a CLI command such as:

```text
pnpm intelligence:refresh --season 2026 --through 2026-08-29
```

It should:

1. download to a temporary import directory;
2. validate content type, required columns, row-count bounds and unique keys;
3. calculate SHA-256 before parsing;
4. insert `source_snapshots` metadata;
5. retain the source files in an ignored local cache keyed by checksum;
6. abort the whole import if a mandatory source is stale or malformed;
7. import into staging tables and publish one valuation version atomically.

Required baseline sources: players/ID map, 2024-2025 player stats, 2025 snaps,
2025 participation, 2025 expected points, 2025 NGS, 2026 rosters, latest 2026
depth chart/injury/transaction context and 2026 schedule. Two seasons reduce
the brittleness of one-year efficiency while recent usage still receives more
weight.

The import manifest must record CC-BY-SA attribution for FTN-derived
participation/charting. Do not scrape a paywalled analyst database. Curated
analyst observations are allowable only as manually entered context events with
a URL, date, author/source and explicit confidence.

### 2. Normalize identities and team weeks

- Key all facts by GSIS ID from nflverse players; map ESPN ID through the same
  identity table.
- Generate every team-week, then every rostered player-team-week. Missing stats
  become either an inactive/zero week or unknown according to roster and injury
  evidence. They must not silently vanish.
- Normalize team abbreviations and log every fallback name match.
- Quarantine one-to-many or team-conflicting matches. Do not import them with a
  plausible-looking profile.

### 3. Build position features

Aggregate season, last four team weeks and last four active games. Calculate
shares from summed denominators. Winsorize small-sample efficiency by position
and shrink it toward age/position priors. Preserve sample count for every rate.

Expected points should represent opportunity quality. Actual-minus-expected
can contribute to talent only after shrinkage. A starting implementation can
use these feature families as prior weights before backtesting:

| Position | Projection/market prior | Role and usage | Opportunity quality | Efficiency/talent | 2026 context |
| --- | ---: | ---: | ---: | ---: | ---: |
| QB | 35% | 25% (dropbacks + rushes) | 10% | 15% (CPOE/EPA, regressed) | 15% |
| RB | 25% | 35% (carries + routes + targets) | 20% (xFP/high-value work) | 5% (RYOE, regressed) | 15% |
| WR | 25% | 35% (routes + target earning) | 15% (air/end-zone/xFP) | 10% (per-route, regressed) | 15% |
| TE | 25% | 40% (routes + target earning) | 15% (end-zone/xFP) | 5% | 15% |

These are **initial hypotheses, not validated truth**. Store them as a versioned
configuration and tune only through rolling-origin backtests. The model should
never alter historical rows to make a current player look better.

### 4. Generate outcome scenarios

For each player, model:

```text
season points = games played
              × team plays per game
              × role share
              × points per opportunity
```

Sample each component from a position- and sample-aware distribution. Apply
discrete scenario mixtures for job/role outcomes. For example, an RB might have
55% lead, 35% committee and 10% backup probabilities, each with different carry,
route and goal-line shares. Output P10/P50/P90 and the scenario probabilities.

Keep injury/availability uncertainty separate from per-active-game output. A
player can have a high weekly ceiling and a low season P10; the current single
0-100 ceiling cannot express that distinction.

### 5. Convert valuation to this league

At each recommendation refresh:

1. optimize eight legal starting lineups from the undrafted pool under the
   actual 1/2/2/1/2-FLEX rules;
2. calculate the marginal P50 and P90 points a candidate adds over the best
   available replacement that could fill the same dedicated/FLEX path;
3. use current ESPN/platform ADP only to estimate survival until pick 9/24/etc.;
4. apply roster limits and current roster construction outside the player model;
5. show separate values: `median starter advantage`, `ceiling advantage`,
   `role confidence`, `market price` and `survival probability`.

The player valuation must not react when six opponents draft RBs; the **market
and recommendation layer** should. A run changes the remaining supply,
opponent demand and survival probability, not the underlying projection for an
individual RB.

## Calibration and validation gates

### Historical rolling-origin backtest

For each available season, build features using only facts available before
that season, then predict the season. Never use final-season participation,
injury or depth evidence in a preseason snapshot. Report by position and draft
band:

- MAE and RMSE for P50 season points and active-game PPG;
- rank correlation and top-8/top-16 hit rate;
- P10/P90 interval coverage (target approximately 80%, not the narrowest band);
- calibration of role probability and games-played probability;
- value over replacement error under this exact lineup;
- comparison with simple baselines: prior PPG, ESPN projection, ADP and a
  projection/ADP blend.

The new model ships only if it improves a league-relevant metric or adds honest
calibration without materially degrading the baseline. A complex model that
ties the market should expose its uncertainty and stay a second opinion.

### Required unit and data-quality tests

- weighted target share differs correctly from the unweighted weekly average;
- last-four-team-games includes zero/inactive weeks while last-four-active does
  not;
- NGS threshold missingness remains `null`, never zero;
- a team change lowers role confidence until current context exists;
- rookies never inherit the universal veteran default;
- P10 <= P50 <= P90 and interval coverage is measured historically;
- source checksum or required-column changes fail closed;
- player identity conflicts are quarantined;
- exact model/data-cutoff/scoring/league hashes reproduce identical output;
- K and D/ST uncertainty remains wider than comparable offensive positions;
- no current-year or post-cutoff fact leaks into a historical backtest.

### Adversarial player cases

The red-team fixture set should include:

1. high prior PPG on low route participation;
2. high targets per route on a tiny route sample;
3. high RB yards per carry but no receiving or goal-line role;
4. veteran changing teams with a nominally open depth chart;
5. injured player whose active-game PPG is elite but availability is poor;
6. rookie with strong draft capital but weak age-adjusted production;
7. late-round rookie with strong production but no immediate route/carry path;
8. QB with weak passing but elite designed rushing;
9. TE with high snap share dominated by blocking;
10. D/ST inflated by prior defensive touchdowns;
11. kicker on a high-scoring but aggressive fourth-down offense;
12. player whose name maps to two IDs or whose team conflicts across sources.

For every fixture, assert not only the final order but the intended reason and
the confidence/uncertainty response.

## Recommended implementation order

1. Add source manifests, identity validation and 2024-2025 player/snap/xFP/NGS
   ingestion. Fix weighted shares and full team-week calendars first.
2. Add usage/context/output tables and contracts. Keep the old table readable
   during migration, but do not feed both models into one score.
3. Implement QB/RB/WR/TE position feature builders and deterministic scenario
   quantiles. Add fixture-based tests before importing the live database.
4. Add 2026 roster/depth/injury/transaction context and rookie-specific paths.
5. Replace hard-coded K/D/ST profiles with regressed opportunity/schedule
   models, while retaining the late-draft gate.
6. Backtest, compare against simple baselines, version the winning model and
   atomically publish one valuation snapshot.
7. Rebuild the recommendation layer on dynamic replacement and remaining-pool
   supply. Do not let recommendation-market behavior mutate player facts.

The minimal high-quality first cut is not “more fields everywhere.” It is a
pinned multi-source import, correct denominators, position-specific opportunity,
explicit current-role scenarios, honest quantiles and a baseline comparison.
That would materially improve the database while keeping every recommendation
explainable during a live draft.
