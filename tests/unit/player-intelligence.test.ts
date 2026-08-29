import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPlayerIntelligence } from '../../apps/cli/src/player-intelligence.ts';

describe('player intelligence v2', () => {
  it('uses weighted shares, position-specific opportunity, and differentiated rookie priors', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fda-intelligence-'));
    const statsPath = join(directory, 'stats.csv');
    const rosterPath = join(directory, 'roster.csv');
    writeFileSync(statsPath, [
      'player_id,player_display_name,position,season_type,game_id,week,team,fantasy_points_ppr,carries,targets,receptions,rushing_yards,receiving_yards,rushing_tds,receiving_tds,passing_tds,attempts,target_share,receiving_air_yards,air_yards_share,fg_att,pat_att',
      'wr-1,Weighted Receiver,WR,REG,g1,1,AAA,10,0,2,2,0,40,0,0,0,0,0.2,20,0.1,0,0',
      'wr-1,Weighted Receiver,WR,REG,g2,2,AAA,20,0,8,6,0,100,0,1,0,0,0.4,80,0.4,0,0',
      'qb-1,Volume Quarterback,QB,REG,g3,1,BBB,22,4,0,0,20,0,0,0,2,30,0,0,0,0,0',
      'qb-1,Volume Quarterback,QB,REG,g4,2,BBB,18,2,0,0,10,0,0,0,1,35,0,0,0,0,0',
    ].join('\n'));
    writeFileSync(rosterPath, [
      'team,position,status,full_name,birth_date,gsis_id,years_exp,entry_year,draft_number,status_description_abbr',
      'AAA,WR,ACT,Weighted Receiver,2000-01-01,wr-1,4,2022,90,ACT',
      'BBB,QB,ACT,Volume Quarterback,1998-01-01,qb-1,6,2020,12,ACT',
      'CCC,RB,ACT,First Round Rookie,2004-01-01,rookie-1,0,2026,18,ACT',
      'DDD,RB,ACT,Late Rookie,2004-01-01,rookie-2,0,2026,190,ACT',
    ].join('\n'));

    const { profiles } = readPlayerIntelligence(statsPath, rosterPath);
    const receiver = profiles.find((profile) => profile.nflverseId === 'wr-1')!;
    const quarterback = profiles.find((profile) => profile.nflverseId === 'qb-1')!;
    const firstRounder = profiles.find((profile) => profile.nflverseId === 'rookie-1')!;
    const lateRookie = profiles.find((profile) => profile.nflverseId === 'rookie-2')!;
    expect(receiver.profileVersion).toBe('usage-context-v2');
    expect(receiver.targetShare).toBe(33.3);
    expect(receiver.airYardsShare).toBe(25);
    expect(quarterback.opportunitiesPerGame).toBe(40);
    expect(firstRounder.ceilingScore).toBeGreaterThan(lateRookie.ceilingScore);
    expect(firstRounder.floorScore).not.toBe(lateRookie.floorScore);
  });
});
