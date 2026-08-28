import type { Player, Position } from '@fda/contracts';

const names: Record<Position, string[]> = {
  QB: ['Marcus Vale', 'Eli Mercer', 'Dante Cross', 'Nolan Price', 'Theo Grant', 'Julian Banks', 'Caleb North', 'Owen Hayes', 'Mason Reed', 'Isaiah Cole', 'Roman Blake', 'Gavin Shaw'],
  RB: ['Andre Rivers', 'Malik Stone', 'Jonah Pierce', 'Ty Ellis', 'Devin Ward', 'Cam Porter', 'Rico James', 'Avery Brooks', 'Jalen Moss', 'Noah Wynn', 'Tre King', 'Kendrick Bell', 'Miles Dean', 'Zion Ford', 'Luca Hayes', 'Brennan Cole', 'Ari Knox', 'Darius Lane', 'Keenan Fox', 'Samir West', 'Jaylen Voss', 'Emmett Gray', 'Bryce Wells', 'Khalil Moon'],
  WR: ['Xavier Hart', 'Jordan Pace', 'Micah Quinn', 'Troy Sutton', 'Desmond Ray', 'Kobe Grant', 'Amari Vaughn', 'Jace Monroe', 'Quentin Lowe', 'Cameron Pike', 'Aiden Rush', 'Leon Briggs', 'Zayne York', 'Nico Fields', 'Terrence Boyd', 'Marcell Tate', 'Keon Drew', 'Rashad Miles', 'Javon Page', 'Cole Barrett', 'Dorian Nash', 'Wes Carter', 'Taj Green', 'Reese Holland'],
  TE: ['Grant Holloway', 'Cole Maddox', 'Tyson Webb', 'Landon Snow', 'Myles Cain', 'Parker Flynn', 'Drew Calloway', 'Hayden Fox', 'Austin Kemp', 'Rylan Boyd', 'Tanner Wells', 'Evan Knox'],
  K: ['Luis Ortega', 'Ben Rowe', 'Adam Holt', 'Chris Dale', 'Nate Fry', 'Evan Park', 'Sam Reed', 'Will Dean'],
  DST: ['Baltimore Defense', 'Pittsburgh Defense', 'Buffalo Defense', 'Houston Defense', 'Denver Defense', 'Kansas City Defense', 'Philadelphia Defense', 'Minnesota Defense'],
};

const teams = ['ARI', 'ATL', 'BAL', 'BUF', 'CAR', 'CHI', 'CIN', 'CLE', 'DAL', 'DEN', 'DET', 'GB', 'HOU', 'IND', 'JAX', 'KC', 'LAC', 'LAR', 'LV', 'MIA', 'MIN', 'NE', 'NO', 'NYG', 'NYJ', 'PHI', 'PIT', 'SEA', 'SF', 'TB', 'TEN', 'WAS'];
const positionBase: Record<Position, number> = { RB: 1, WR: 2, QB: 9, TE: 12, K: 90, DST: 88 };

export function demoPlayers(now = '2026-08-27T12:00:00.000Z'): Player[] {
  const rows: Player[] = [];
  for (const position of ['RB', 'WR', 'QB', 'TE', 'K', 'DST'] as Position[]) {
    names[position].forEach((name, index) => {
      const rank = positionBase[position] + index * (position === 'K' || position === 'DST' ? 3 : 4);
      rows.push({
        id: `demo-${position.toLowerCase()}-${String(index + 1).padStart(2, '0')}`,
        name,
        position,
        team: position === 'DST' ? name.split(' ')[0].slice(0, 3).toUpperCase() : teams[(index * 5 + position.length) % teams.length]!,
        byeWeek: 5 + ((index * 3 + position.length) % 10),
        overallRank: rank,
        positionalRank: index + 1,
        adp: Math.max(1, rank + ((index % 5) - 2) * 1.7),
        projection: Math.max(70, 315 - rank * 1.7 + (index % 3) * 4),
        upside: Math.max(35, 94 - index * 2.1 + (position === 'RB' || position === 'WR' ? 3 : 0)),
        reliability: Math.max(40, 91 - index * 1.55 - (position === 'RB' ? 3 : 0)),
        risk: Math.min(84, 18 + index * 2.4 + (position === 'RB' ? 7 : 0)),
        tier: Math.floor(index / 4) + 1,
        source: 'Bundled demo fixture — replace with your import',
        updatedAt: now,
        excluded: false,
      });
    });
  }
  return rows.sort((a, b) => a.overallRank - b.overallRank || a.position.localeCompare(b.position));
}
