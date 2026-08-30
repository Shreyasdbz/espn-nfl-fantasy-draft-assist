(function fourthDownEspnWatcher() {
  if (window.__fourthDownExtensionWatcher) clearInterval(window.__fourthDownExtensionWatcher);
  const runStorageKey = 'fourth-down-draft-run-id';
  let draftRunId;
  try {
    const storedRunId = sessionStorage.getItem(runStorageKey);
    const navigationType = performance.getEntriesByType('navigation')[0]?.type;
    draftRunId = storedRunId && navigationType === 'reload' ? storedRunId : crypto.randomUUID();
    sessionStorage.setItem(runStorageKey, draftRunId);
  } catch {
    draftRunId = window.__fourthDownDraftRunId || `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.__fourthDownDraftRunId = draftRunId;
  }

  function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function playerId(name) { return `dom:${clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`; }
  function position(value) { return value === 'D/ST' ? 'DST' : value; }
  function leagueSettings(rendered, rounds) {
    const lines = rendered.split(/\n+/).map(clean).filter(Boolean);
    const rosterStart = lines.findIndex((line) => /^Roster$/i.test(line));
    const limitsStart = lines.findIndex((line, index) => index > rosterStart && /^Roster Limits$/i.test(line));
    const rosterLines = rosterStart >= 0 && limitsStart > rosterStart ? lines.slice(rosterStart + 1, limitsStart) : [];
    const count = (label) => rosterLines.filter((line) => new RegExp(`^${label}(?:\\s|$)`, 'i').test(line)).length;
    const roster = {
      QB: count('QB'), RB: count('RB'), WR: count('WR'), TE: count('TE'), FLEX: count('FLEX'),
      K: count('K'), DST: count('D\\/ST|DST'), BENCH: count('BE|B\\d+'),
    };
    const rosterTotal = Object.values(roster).reduce((sum, value) => sum + value, 0);
    const limitsText = clean(rosterStart >= 0 ? lines.slice(Math.max(0, limitsStart)).join(' ') : rendered);
    const maximum = (label) => Number((limitsText.match(new RegExp(`\\b(?:${label})\\s+\\d+\\s*\\/\\s*(\\d+)`, 'i')) || [])[1] || 0);
    const positionLimits = { QB: maximum('QB'), RB: maximum('RB'), WR: maximum('WR'), TE: maximum('TE'), K: maximum('K'), DST: maximum('D\\/ST|DST') };
    const hasRoster = rosterTotal === rounds && roster.FLEX > 0;
    const hasLimits = Object.values(positionLimits).every((value) => value > 0);
    return hasRoster || hasLimits ? { ...(hasRoster ? { roster } : {}), ...(hasLimits ? { positionLimits } : {}) } : undefined;
  }

  function collect() {
    const rendered = document.body?.innerText || '';
    const body = clean(rendered);
    const rounds = Number((body.match(/RND \d+ OF (\d+)/i) || [])[1] || 16);
    const roundTwoStart = Number((body.match(/Round\s+2\s+PICK\s+(\d+)/i) || [])[1] || 0);
    const picksByNumber = new Map();
    const pickPattern = /^(.+?)\s*\/\s*([A-Z]{2,3})\s+(QB|RB|WR|TE|K|D\/ST)(?:,\s*[A-Z]{1,3})?\s+R(\d+),\s*P(\d+)\s*-\s*(.+)$/i;
    document.querySelectorAll('li,div').forEach((element) => {
      const text = clean(element.innerText);
      if (!text || text.length > 220) return;
      const match = text.match(pickPattern);
      if (!match) return;
      const round = Number(match[4]);
      const pickInRound = Number(match[5]);
      picksByNumber.set(`${round}:${pickInRound}`, {
        round,
        pickInRound,
        playerName: clean(match[1]),
        team: match[2].toUpperCase(),
        position: position(match[3].toUpperCase()),
        draftingTeam: clean(match[6]),
      });
    });
    const rawPicks = Array.from(picksByNumber.values());
    const teamCount = roundTwoStart > 2
      ? roundTwoStart - 1
      : rawPicks.reduce((maximum, pick) => Math.max(maximum, pick.pickInRound), 0);
    if (teamCount < 2) return null;
    const picks = rawPicks.map((pick) => ({
      overallPick: (pick.round - 1) * teamCount + pick.pickInRound,
      externalPlayerId: playerId(pick.playerName),
      playerName: pick.playerName,
    })).sort((left, right) => left.overallPick - right.overallPick);
    const playerMap = new Map();
    document.querySelectorAll('[role=row],tr').forEach((row) => {
      const text = clean(row.innerText);
      if (!/\b(?:DRAFT|QUEUE)\b/.test(text)) return;
      const teamPosition = text.match(/\b([A-Z]{2,3})\s+(QB|RB|WR|TE|K|D\/ST)\s+(?:DRAFT|QUEUE)\b/);
      if (!teamPosition) return;
      const anchors = Array.from(row.querySelectorAll('a')).map((anchor) => clean(anchor.textContent));
      const name = anchors.find((value) => value && value.length > 2 && !/^news about/i.test(value));
      if (!name) return;
      const rankMatch = text.match(/^(\d+)\s/);
      const projectionMatch = text.match(/\b(?:DRAFT|QUEUE)\s+\d+\s+([\d.]+)/);
      const rank = rankMatch ? Number(rankMatch[1]) : null;
      playerMap.set(playerId(name), {
        externalPlayerId: playerId(name),
        playerName: name,
        position: position(teamPosition[2].toUpperCase()),
        team: teamPosition[1].toUpperCase(),
        adp: rank,
        projection: projectionMatch ? Number(projectionMatch[1]) : null,
        overallRank: rank,
        positionalRank: rank,
      });
    });
    const catalogPlayerCount = playerMap.size;
    rawPicks.forEach((pick) => {
      if (!playerMap.has(playerId(pick.playerName))) {
        playerMap.set(playerId(pick.playerName), {
          externalPlayerId: playerId(pick.playerName), playerName: pick.playerName,
          position: pick.position, team: pick.team, adp: null, projection: null,
          overallRank: null, positionalRank: null,
        });
      }
    });
    const draftingTeams = Array.from(new Set(rawPicks.map((pick) => pick.draftingTeam)));
    const lowerBody = body.toLowerCase();
    const scheduledUserTeam = draftingTeams.map((team) => {
      let count = 0;
      let cursor = 0;
      const needle = team.toLowerCase();
      while ((cursor = lowerBody.indexOf(needle, cursor)) >= 0) {
        if (/pick\s+\d+\s+$/.test(lowerBody.slice(Math.max(0, cursor - 28), cursor))) count += 1;
        cursor += needle.length;
      }
      return { team, count };
    }).sort((left, right) => right.count - left.count).find((candidate) => candidate.count >= 2);
    const ownPick = rawPicks.find((pick) => scheduledUserTeam && pick.draftingTeam.toLowerCase() === scheduledUserTeam.team.toLowerCase());
    const userSlot = ownPick ? (ownPick.round % 2 ? ownPick.pickInRound : teamCount - ownPick.pickInRound + 1) : null;
    const leagueKey = new URL(location.href).searchParams.get('leagueId') || location.pathname;
    const externalDraftId = `${leagueKey}:run:${draftRunId}`;
    return {
      externalDraftId, teamCount, rounds, userSlot, leagueSettings: leagueSettings(rendered, rounds), observedAt: new Date().toISOString(),
      picks, players: Array.from(playerMap.values()), catalogPlayerCount,
    };
  }

  async function tick() {
    try {
      const snapshot = collect();
      if (!snapshot) {
        document.documentElement.setAttribute('data-fourth-down-extension', 'waiting');
        return;
      }
      document.documentElement.setAttribute('data-fourth-down-extension', 'posting');
      const response = await chrome.runtime.sendMessage({ type: 'FOURTH_DOWN_OBSERVATION', snapshot });
      document.documentElement.setAttribute('data-fourth-down-extension', response?.ok ? 'active' : 'error');
    } catch (error) {
      document.documentElement.setAttribute('data-fourth-down-extension', 'error');
      console.warn('Fourth Down ESPN watcher', error);
    }
  }

  window.__fourthDownExtensionWatcher = setInterval(tick, 2_000);
  void tick();
})();
