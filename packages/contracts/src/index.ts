import { z } from 'zod';

export const PositionSchema = z.enum(['QB', 'RB', 'WR', 'TE', 'K', 'DST']);
export type Position = z.infer<typeof PositionSchema>;

export const SessionModeSchema = z.enum(['PRACTICE', 'REAL', 'SIMULATED', 'REPLAY']);
export type SessionMode = z.infer<typeof SessionModeSchema>;

export const DraftEnvironmentSchema = z.enum(['PRACTICE', 'LIVE']);
export type DraftEnvironment = z.infer<typeof DraftEnvironmentSchema>;

export const AuthoritySchema = z.enum(['manual', 'snapshot', 'structured', 'dom', 'simulator']);
export type Authority = z.infer<typeof AuthoritySchema>;

export const PlayerResearchSchema = z.object({
  espnRank: z.number().int().positive(),
  recommendedRound: z.number().int().positive().nullable(),
  plannedPick: z.number().int().positive().nullable(),
  phase: z.string(),
  archetype: z.string(),
  opportunity: z.number().min(0).max(10),
  roleClarity: z.number().min(0).max(10),
  visionScore: z.number(),
  modelSignal: z.string(),
  userTag: z.string(),
  injuryNews: z.string(),
  whyFits: z.string(),
  failureCase: z.string(),
  alternatives: z.string(),
  pairingConstruction: z.string(),
  earliestPick: z.number().int().positive().nullable(),
  targetPick: z.number().int().positive().nullable(),
  latestPick: z.number().int().positive().nullable(),
  espnSource: z.string(),
  adpSource: z.string(),
  analysisSource: z.string(),
  importedDraftStatus: z.string(),
  researchedAt: z.string(),
});
export type PlayerResearch = z.infer<typeof PlayerResearchSchema>;

export const PlayerEvidenceSchema = z.object({
  source: z.string().url(),
  kind: z.string(),
  claim: z.string(),
});

export const PlayerIntelligenceSchema = z.object({
  profileVersion: z.string(),
  sampleSeason: z.number().int(),
  games: z.number().int().nonnegative(),
  age: z.number().nullable(),
  rosterStatus: z.string().nullable(),
  priorTeam: z.string().nullable(),
  currentTeam: z.string().nullable(),
  fantasyPointsPpr: z.number().nullable(),
  fantasyPpgPpr: z.number().nullable(),
  lateSeasonPpgPpr: z.number().nullable(),
  carries: z.number().int().nullable(),
  targets: z.number().int().nullable(),
  receptions: z.number().int().nullable(),
  scrimmageYards: z.number().int().nullable(),
  totalTouchdowns: z.number().int().nullable(),
  opportunitiesPerGame: z.number().nullable(),
  targetShare: z.number().nullable(),
  airYardsShare: z.number().nullable(),
  trendScore: z.number().nullable(),
  floorScore: z.number().min(0).max(100),
  ceilingScore: z.number().min(0).max(100),
  roleSummary: z.string(),
  floorCase: z.string(),
  ceilingCase: z.string(),
  riskNote: z.string(),
  evidence: z.array(PlayerEvidenceSchema),
  sourceCount: z.number().int().positive(),
  dataQuality: z.enum(['strong', 'partial', 'context-only']),
  researchedAt: z.string(),
});
export type PlayerIntelligence = z.infer<typeof PlayerIntelligenceSchema>;

export const PlayerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: PositionSchema,
  team: z.string().nullable(),
  byeWeek: z.number().int().min(4).max(15).nullable(),
  overallRank: z.number().int().positive(),
  positionalRank: z.number().int().positive(),
  adp: z.number().positive().nullable(),
  projection: z.number(),
  upside: z.number().min(0).max(100),
  reliability: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
  tier: z.number().int().positive(),
  source: z.string(),
  updatedAt: z.string(),
  excluded: z.boolean(),
  research: PlayerResearchSchema.nullable().optional(),
  intelligence: PlayerIntelligenceSchema.nullable().optional(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const DraftPickSchema = z.object({
  overallPick: z.number().int().positive(),
  round: z.number().int().positive(),
  pickInRound: z.number().int().positive(),
  draftingSlot: z.number().int().positive(),
  playerId: z.string(),
  playerName: z.string(),
  position: PositionSchema,
  team: z.string().nullable(),
  authority: AuthoritySchema,
  lockedManual: z.boolean(),
  selectedAt: z.string(),
});
export type DraftPick = z.infer<typeof DraftPickSchema>;

export const ScoreFactorSchema = z.object({
  key: z.string(),
  label: z.string(),
  raw: z.number(),
  normalized: z.number(),
  weight: z.number(),
  contribution: z.number(),
  detail: z.string(),
});
export type ScoreFactor = z.infer<typeof ScoreFactorSchema>;

export const RecommendationSchema = z.object({
  rank: z.number().int().positive(),
  playerId: z.string(),
  playerName: z.string(),
  position: PositionSchema,
  team: z.string().nullable(),
  score: z.number(),
  survivalBand: z.enum(['unlikely', 'coin flip', 'likely']),
  warnings: z.array(z.string()),
  factors: z.array(ScoreFactorSchema),
  explanation: z.string(),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const RosterRulesSchema = z.object({
  QB: z.number().int().nonnegative(), RB: z.number().int().nonnegative(), WR: z.number().int().nonnegative(),
  TE: z.number().int().nonnegative(), FLEX: z.number().int().nonnegative(), K: z.number().int().nonnegative(),
  DST: z.number().int().nonnegative(), BENCH: z.number().int().nonnegative(),
});
export type RosterRules = z.infer<typeof RosterRulesSchema>;

export const PositionLimitsSchema = z.object({
  QB: z.number().int().nonnegative(), RB: z.number().int().nonnegative(), WR: z.number().int().nonnegative(),
  TE: z.number().int().nonnegative(), K: z.number().int().nonnegative(), DST: z.number().int().nonnegative(),
});
export type PositionLimits = z.infer<typeof PositionLimitsSchema>;

export const MarketSignalSchema = z.object({
  position: PositionSchema,
  recentPicks: z.number().int().nonnegative(),
  upcomingDemand: z.number().min(-1).max(1),
  availableInTier: z.number().int().nonnegative(),
  tierDrop: z.number(),
  pressure: z.number().min(-1).max(1),
  label: z.enum(['cool', 'stable', 'watch', 'run']),
  detail: z.string(),
});
export type MarketSignal = z.infer<typeof MarketSignalSchema>;

export const RosterContextSchema = z.object({
  phase: z.enum(['foundation', 'balance', 'endgame']),
  picksRemaining: z.number().int().nonnegative(),
  startersOpen: z.number().int().nonnegative(),
  gate: z.enum(['none', 'forced-needs']),
  positionCounts: z.record(PositionSchema, z.number().int().nonnegative()),
  rosterRules: RosterRulesSchema,
  positionLimits: PositionLimitsSchema,
  openSlots: RosterRulesSchema,
  requiredPositions: z.array(PositionSchema),
  saturatedPositions: z.array(PositionSchema),
  marketSignals: z.array(MarketSignalSchema),
});
export type RosterContext = z.infer<typeof RosterContextSchema>;

export const HealthSchema = z.object({
  engine: z.enum(['healthy', 'degraded']),
  database: z.enum(['healthy', 'degraded']),
  chrome: z.enum(['stopped', 'launching', 'login_required', 'ready', 'observing', 'disconnected', 'incompatible']),
  espnAuth: z.enum(['unknown', 'required', 'authenticated']),
  pageDetected: z.boolean(),
  pageAttached: z.boolean(),
  capture: z.enum(['idle', 'healthy', 'degraded']),
  lastObservationAt: z.string().nullable(),
  lastReconciledAt: z.string().nullable(),
  schemaVersion: z.string(),
  engineInstanceId: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

export const DraftStateSchema = z.object({
  environment: DraftEnvironmentSchema,
  session: z.object({
    id: z.string(),
    name: z.string(),
    mode: SessionModeSchema,
    state: z.string(),
    revision: z.number().int().nonnegative(),
    userSlot: z.number().int().positive(),
    teamCount: z.number().int().positive(),
    rounds: z.number().int().positive(),
    currentOverallPick: z.number().int().positive(),
    currentRound: z.number().int().positive(),
    nextUserPick: z.number().int().positive().nullable(),
    isUserTurn: z.boolean(),
  }),
  picks: z.array(DraftPickSchema),
  players: z.array(PlayerSchema.extend({ drafted: z.boolean() })),
  recommendations: z.array(RecommendationSchema),
  recommendationContext: RosterContextSchema,
  roster: z.array(DraftPickSchema),
  conflicts: z.array(z.object({ id: z.string(), overallPick: z.number(), summary: z.string() })),
  lastOperation: z.object({ id: z.string(), type: z.string(), undoable: z.boolean() }).nullable(),
  health: HealthSchema,
});
export type DraftState = z.infer<typeof DraftStateSchema>;

export const CommandEnvelopeSchema = <T extends z.ZodType>(body: T) => z.object({
  commandId: z.string().min(8).max(128),
  expectedRevision: z.number().int().nonnegative(),
  body,
});

export const ManualPickCommandSchema = CommandEnvelopeSchema(z.object({
  playerId: z.string().min(1),
  overallPick: z.number().int().positive().optional(),
  reason: z.string().max(240).optional(),
}));

export const ResetCommandSchema = CommandEnvelopeSchema(z.object({
  confirmation: z.object({
    sessionId: z.string(),
    mode: SessionModeSchema,
    pickCount: z.number().int().nonnegative(),
  }),
}));

export const SimulateCommandSchema = CommandEnvelopeSchema(z.object({
  count: z.number().int().min(1).max(24).default(1),
  seed: z.number().int().default(2026),
}));

export const BindPageCommandSchema = CommandEnvelopeSchema(z.object({
  pageIndex: z.number().int().nonnegative().optional(),
  externalDraftId: z.string().max(120).optional(),
}));

export const DraftEnvironmentCommandSchema = z.object({ environment: DraftEnvironmentSchema });

export const TabBridgeObservationSchema = z.object({
  externalDraftId: z.string().min(1).max(120),
  teamCount: z.number().int().min(2).max(20),
  rounds: z.number().int().min(1).max(30),
  userSlot: z.number().int().min(1).max(20).nullable().optional(),
  leagueSettings: z.object({
    roster: RosterRulesSchema.partial().optional(),
    positionLimits: PositionLimitsSchema.partial().optional(),
  }).optional(),
  observedAt: z.string(),
  picks: z.array(z.object({
    overallPick: z.number().int().positive(),
    externalPlayerId: z.string().max(160).optional(),
    playerName: z.string().min(1).max(120).optional(),
    draftingSlot: z.number().int().positive().optional(),
  })).max(600),
  players: z.array(z.object({
    externalPlayerId: z.string().min(1).max(160),
    playerName: z.string().min(1).max(120),
    position: PositionSchema,
    team: z.string().max(4).nullable(),
    adp: z.number().positive().nullable(),
    projection: z.number().nonnegative().nullable(),
    overallRank: z.number().positive().nullable(),
    positionalRank: z.number().positive().nullable(),
  })).max(500),
});
export type TabBridgeObservation = z.infer<typeof TabBridgeObservationSchema>;

export type RawObservation = {
  mechanism: 'structured' | 'websocket' | 'snapshot' | 'dom';
  kind: 'incremental' | 'full_snapshot' | 'health';
  adapterSchemaVersion: string;
  externalDraftId?: string;
  observedAt: string;
  dedupeKey: string;
  payload: unknown;
};

export type ObservationPick = {
  overallPick: number;
  externalPlayerId?: string;
  playerName?: string;
  draftingSlot?: number;
};

export type ObservationPlayer = {
  externalPlayerId: string;
  playerName: string;
  position: Position;
  team: string | null;
  adp: number | null;
  projection: number | null;
  overallRank: number | null;
  positionalRank: number | null;
};

export type DomainEvent = {
  engineInstanceId: string;
  sequence: number;
  type: 'draft.state.changed' | 'recommendations.changed' | 'observer.health.changed' | 'conflict.changed';
  aggregateId: string;
  aggregateRevision: number;
  cause: string;
  changedIds?: string[];
  occurredAt: string;
};
