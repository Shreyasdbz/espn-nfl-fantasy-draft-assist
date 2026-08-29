'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DraftPick, DraftState, Player, Recommendation } from '@fda/contracts';
import { Activity, ChevronDown, CircleCheckBig, Ellipsis, History, Radio, Search, Settings2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type View = 'live' | 'players';
type Notice = { kind: 'error' | 'success'; text: string } | null;
const positions = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

function commandId(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/engine${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-fda-csrf': 'local-ui-v1', ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as { message?: string } & T;
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload as T;
}

function StatusPip({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return <Tooltip><TooltipTrigger asChild><Badge variant="outline" className="status-pip"><span className={`status-dot ${ok ? 'ok' : ''}`} aria-hidden="true" /><span>{label}</span></Badge></TooltipTrigger><TooltipContent>{detail}</TooltipContent></Tooltip>;
}

function PositionMark({ position }: { position: Player['position'] }) {
  return <Badge className={`position-mark position-${position.toLowerCase()}`}>{position}</Badge>;
}

function RecommendationRow({ recommendation, player, open, onOpen, onInspect }: { recommendation: Recommendation; player?: Player; open: boolean; onOpen: () => void; onInspect: () => void }) {
  const positive = recommendation.factors.filter((factor) => factor.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  return (
    <Collapsible open={open} onOpenChange={onOpen} className={`recommendation-row ${recommendation.rank === 1 ? 'featured' : ''}`}>
      <div className="recommendation-summary">
        <span className="rec-rank">{recommendation.rank}</span>
        <PositionMark position={recommendation.position} />
        <button className="rec-player" onClick={onInspect}><strong>{recommendation.playerName}</strong><small>{recommendation.team ?? 'FA'} · {player?.research?.archetype ?? 'profile'} </small></button>
        <span className="rec-score"><strong>{recommendation.score.toFixed(1)}</strong><small>score</small></span>
        <Badge variant="outline" className={`survival survival-${recommendation.survivalBand.replace(' ', '-')}`}>{recommendation.survivalBand}</Badge>
        <CollapsibleTrigger asChild><Button variant="ghost" size="icon" aria-label={`Explain ${recommendation.playerName}`}><ChevronDown className={open ? 'rotate' : ''} /></Button></CollapsibleTrigger>
      </div>
      <CollapsibleContent className="recommendation-detail">
        <p>{recommendation.explanation}</p>
        <div className="factor-chips">{positive.map((factor) => <Badge key={factor.key} variant="secondary">{factor.label} +{factor.contribution.toFixed(1)}</Badge>)}</div>
        <div className="compact-factor-list">{recommendation.factors.map((factor) => <Tooltip key={factor.key}><TooltipTrigger asChild><span><b>{factor.label}</b><em className={factor.contribution < 0 ? 'negative-text' : ''}>{factor.contribution > 0 ? '+' : ''}{factor.contribution.toFixed(1)}</em></span></TooltipTrigger><TooltipContent>{factor.detail}</TooltipContent></Tooltip>)}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ConstructionStrip({ state }: { state: DraftState }) {
  const context = state.recommendationContext;
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;
  const hottest = [...context.marketSignals].sort((left, right) => right.pressure - left.pressure)[0];
  return <div className="construction-strip"><div className="construction-copy"><span className="eyebrow">ROSTER PLAN · {context.phase}</span><strong>{context.gate === 'forced-needs' ? `Must fill ${context.requiredPositions.join(' / ')}` : context.requiredPositions.length ? `Open: ${context.requiredPositions.join(' · ')}` : 'Starters covered'}</strong></div><div className="construction-counts">{positions.map((item) => <span key={item} className={context.requiredPositions.includes(item) ? 'needed' : context.saturatedPositions.includes(item) ? 'saturated' : ''}><b>{item}</b><small>{context.positionCounts[item]}/{context.positionLimits[item]}</small></span>)}</div><div className="construction-badges">{hottest && hottest.label !== 'cool' && <Badge variant="outline" title={hottest.detail}>{hottest.position} {hottest.label.toUpperCase()}</Badge>}<Badge variant="outline">{context.startersOpen} starter{context.startersOpen === 1 ? '' : 's'} open</Badge></div></div>;
}

function Roster({ picks, context }: { picks: DraftPick[]; context: DraftState['recommendationContext'] }) {
  const rules = context.rosterRules;
  const dedicated = (['QB', 'RB', 'WR', 'TE'] as const).flatMap((position) => Array.from({ length: rules[position] }, () => ({ label: position, accept: [position] as string[] })));
  const flex = Array.from({ length: rules.FLEX }, () => ({ label: 'FLEX', accept: ['RB', 'WR', 'TE'] }));
  const specialists = (['DST', 'K'] as const).flatMap((position) => Array.from({ length: rules[position] }, () => ({ label: position, accept: [position] as string[] })));
  const bench = Array.from({ length: rules.BENCH }, (_, index) => ({ label: `B${index + 1}`, accept: ['QB', 'RB', 'WR', 'TE', 'K', 'DST'], bench: true }));
  const slots = [...dedicated, ...flex, ...specialists, ...bench];
  const remaining = [...picks];
  return <div className="roster-list">{slots.map((slot, index) => {
    const playerIndex = remaining.findIndex((pick) => slot.accept.includes(pick.position));
    const player = playerIndex >= 0 ? remaining.splice(playerIndex, 1)[0] : undefined;
    return <div className={`roster-slot ${player ? 'filled' : ''} ${'bench' in slot && slot.bench ? 'bench' : ''}`} key={`${slot.label}-${index}`}><span className="slot-label">{slot.label}</span><span className="slot-player">{player?.playerName ?? 'Open slot'}</span><span className="slot-badge">{player ? `${player.position} · ${player.team ?? 'FA'}` : '—'}</span></div>;
  })}</div>;
}

export default function Home() {
  const [state, setState] = useState<DraftState | null>(null);
  const [view, setView] = useState<View>('live');
  const [position, setPosition] = useState<(typeof positions)[number]>('ALL');
  const [query, setQuery] = useState('');
  const [hideDrafted, setHideDrafted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [detail, setDetail] = useState<Player | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [watcherOpen, setWatcherOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [factorsOpen, setFactorsOpen] = useState<string | null>(null);
  const [preparedBridgeSource, setPreparedBridgeSource] = useState('');

  const loadState = useCallback(async () => {
    try { setState(await requestJson<DraftState>('/v1/state')); }
    catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'The local engine is unavailable.' }); }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadState(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [loadState]);
  useEffect(() => {
    const events = new EventSource('/api/engine/v1/events');
    const refresh = () => void loadState();
    let retry: ReturnType<typeof setTimeout> | undefined;
    events.addEventListener('draft.state.changed', refresh); events.addEventListener('recommendations.changed', refresh); events.addEventListener('observer.health.changed', refresh);
    events.onerror = () => { if (!retry) retry = setTimeout(() => { retry = undefined; void loadState(); }, 1_000); };
    return () => { if (retry) clearTimeout(retry); events.close(); };
  }, [loadState]);

  const mutate = async (key: string, path: string, body: unknown, method = 'POST', success?: string) => {
    setBusy(key); setNotice(null);
    try { await requestJson(path, { method, body: JSON.stringify(body) }); await loadState(); if (success) toast.success(success); }
    catch (error) { const message = error instanceof Error ? error.message : 'Action failed'; setNotice({ kind: 'error', text: message }); }
    finally { setBusy(null); }
  };

  const copyTabBridge = async () => {
    setBusy('bridge'); setNotice(null);
    try {
      const { bookmarklet } = await requestJson<{ bookmarklet: string }>('/v1/browser/tab-bridge');
      setPreparedBridgeSource(bookmarklet.slice('javascript:'.length));
      await navigator.clipboard.writeText(bookmarklet.slice(4));
      toast.success('Bridge copied. In the ESPN address bar, type “java”, paste, then press Return once.');
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Could not copy the ESPN tab bridge.' });
    } finally { setBusy(null); }
  };

  const filteredPlayers = useMemo(() => {
    if (!state) return [];
    const needle = query.trim().toLowerCase();
    return state.players.filter((player) => (position === 'ALL' || player.position === position) && (!hideDrafted || !player.drafted) && (!needle || `${player.name} ${player.team ?? ''} ${player.position}`.toLowerCase().includes(needle)));
  }, [state, query, position, hideDrafted]);

  if (!state) return <main className="loading-screen"><div className="brand-lockup"><span className="brand-badge">4D</span><strong>FOURTH DOWN</strong></div><p>Opening the local draft room…</p>{notice && <div className="notice error">{notice.text}</div>}</main>;

  const health = state.health;
  const environmentCopy = state.environment === 'PRACTICE'
    ? { status: 'Practice environment', context: 'Following the ESPN practice room.', turn: 'Choose in the ESPN mock draft with confidence.' }
    : { status: 'Live environment', context: 'Following the ESPN league draft.', turn: 'Choose on ESPN with confidence.' };
  const currentPickLabel = `${state.session.currentRound}.${String(((state.session.currentOverallPick - 1) % state.session.teamCount) + 1).padStart(2, '0')}`;
  const hasObservedCatalog = state.players.some((player) => player.source.startsWith('ESPN passive'));
  const hasResearchCatalog = state.players.some((player) => !!player.research);
  const catalogCopy = hasResearchCatalog
    ? { description: 'The researched 2026 model is loaded; ESPN observations update availability without overwriting its local intelligence.', badge: 'SAQUON MY BARK · 2026' }
    : hasObservedCatalog
      ? { description: 'ESPN identities are fresh from the attached page; local scoring remains explicitly provisional.', badge: 'ESPN CATALOG · PASSIVE' }
      : { description: 'Every row shows the effective local value. The bundled fixture is intentionally replaceable.', badge: 'DATASET · DEMO' };

  return (
    <main className="app-shell">
      <header className="topbar">
        <button className="brand-lockup" onClick={() => setView('live')}><span className="brand-badge">4D</span><div><strong>FOURTH DOWN</strong><small>{state.environment} · SLOT {state.session.userSlot}</small></div></button>
        <Tabs value={view} onValueChange={(value) => setView(value as View)} className="primary-nav"><TabsList><TabsTrigger value="live"><Radio />Live</TabsTrigger><TabsTrigger value="players"><Users />Players</TabsTrigger></TabsList></Tabs>
        <div className="header-actions">
          <Popover><PopoverTrigger asChild><Button variant="ghost" size="sm" className="sync-button"><span className={`status-dot ${health.pageAttached && health.capture === 'healthy' ? 'ok' : ''}`} />{health.pageAttached ? 'Synced' : 'Offline'}<ChevronDown /></Button></PopoverTrigger><PopoverContent align="end" className="sync-popover"><div><strong>ESPN watcher</strong><Badge variant="outline">READ ONLY</Badge></div><p>{health.pageAttached ? `Last board update ${health.lastReconciledAt ? new Date(health.lastReconciledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'pending'}` : 'No ESPN draft is currently attached.'}</p><div className="sync-grid"><StatusPip label="Engine" ok={health.engine === 'healthy'} detail={`Engine ${health.engine}`} /><StatusPip label="Capture" ok={health.capture === 'healthy'} detail={`Capture ${health.capture}`} /><StatusPip label="Draft" ok={health.pageDetected} detail={health.pageDetected ? 'Draft page detected' : 'No draft page'} /></div><Button variant="outline" size="sm" onClick={() => setWatcherOpen(true)}>Connection details</Button>{health.pageDetected && !health.pageAttached && <Button size="sm" onClick={() => void mutate('bind', '/v1/browser/bind-page', { commandId: commandId('bind-page'), expectedRevision: state.session.revision, body: {} }, 'POST', 'Following this ESPN draft read-only.')}>Follow draft</Button>}</PopoverContent></Popover>
          <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" aria-label="Open tools"><Ellipsis /></Button></PopoverTrigger><PopoverContent align="end" className="tools-popover"><Button variant="ghost" onClick={() => setBoardOpen(true)}><History />Draft board</Button><Button variant="ghost" disabled={!health.pageAttached || busy === 'reconcile'} onClick={() => void mutate('reconcile', `/v1/draft-sessions/${state.session.id}/reconcile`, {}, 'POST', 'Reconciliation completed.')}><Activity />Reconcile now</Button><Button variant="ghost" onClick={() => setResetOpen(true)}><Settings2 />Session settings</Button></PopoverContent></Popover>
        </div>
      </header>
      <textarea aria-label="Prepared ESPN bridge source" className="sr-only" readOnly tabIndex={-1} value={preparedBridgeSource} />
      {notice && <div className={`notice ${notice.kind}`} role="status"><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}

      {view === 'live' && <section className="live-page">
        <div className="live-command"><div className="pick-chip"><small>{state.recommendationContext.picksRemaining === 0 ? 'FINAL' : state.session.isUserTurn ? 'YOUR PICK' : 'LIVE PICK'}</small><strong>{currentPickLabel}</strong></div><div><h1>{state.recommendationContext.picksRemaining === 0 ? 'Draft captured' : state.session.isUserTurn ? 'Choose now' : `Pick ${state.session.currentOverallPick} in progress`}</h1><p>{state.recommendationContext.picksRemaining === 0 ? `${state.picks.length} league picks synchronized` : state.session.nextUserPick ? `You pick at ${state.session.nextUserPick} · ${Math.max(0, state.session.nextUserPick - state.session.currentOverallPick)} picks away` : 'Final selection'}</p></div><Badge variant="outline" className="algorithm-tag">MARKET V3</Badge></div>
        <ConstructionStrip state={state} />
        <div className="live-grid"><div className="decision-column"><div className="compact-heading"><div><span className="eyebrow">{state.recommendationContext.picksRemaining ? 'PICK NOW' : 'DRAFT COMPLETE'}</span><h2>{state.recommendationContext.picksRemaining ? 'Best fits for this roster' : 'Roster construction complete'}</h2></div><span>{state.recommendationContext.picksRemaining ? 'updates after every pick' : `${state.roster.length} selections captured`}</span></div>{state.recommendations.length ? <div className="recommendation-list">{state.recommendations.slice(0, 6).map((recommendation) => <RecommendationRow key={recommendation.playerId} recommendation={recommendation} player={state.players.find((player) => player.id === recommendation.playerId)} open={factorsOpen === recommendation.playerId} onOpen={() => setFactorsOpen(factorsOpen === recommendation.playerId ? null : recommendation.playerId)} onInspect={() => setDetail(state.players.find((player) => player.id === recommendation.playerId) ?? null)} />)}</div> : <Card className="draft-complete"><CircleCheckBig /><div><strong>No more picks required</strong><p>The watcher captured a full roster. Review the remaining pool or open Draft board from the tools menu.</p></div></Card>}<div className="compact-heading board-heading"><div><span className="eyebrow">NEXT TIER</span><h2>Available players</h2></div><Button variant="ghost" size="sm" onClick={() => setView('players')}>All players →</Button></div><PlayerTable players={filteredPlayers.filter((player) => !player.drafted).slice(0, 9)} onDetail={setDetail} compact /></div>
          <aside className="context-rail"><Accordion type="multiple" defaultValue={['roster']}><AccordionItem value="roster"><AccordionTrigger><span><Users />Your roster</span><Badge variant="outline">{state.roster.length}/{state.session.rounds}</Badge></AccordionTrigger><AccordionContent><Roster picks={state.roster} context={state.recommendationContext} /></AccordionContent></AccordionItem><AccordionItem value="market"><AccordionTrigger><span><Activity />Draft market</span><small>LIVE</small></AccordionTrigger><AccordionContent>{[...state.recommendationContext.marketSignals].sort((left, right) => right.pressure - left.pressure).map((signal) => <div className="recent-pick" key={signal.position}><b>{signal.position}</b><span>{signal.label}<small>{signal.recentPicks} recent · {signal.availableInTier} in tier · pressure {signal.pressure.toFixed(2)}</small></span></div>)}</AccordionContent></AccordionItem><AccordionItem value="recent"><AccordionTrigger><span><History />Recent picks</span><small>REV {state.session.revision}</small></AccordionTrigger><AccordionContent>{state.picks.slice(-6).reverse().map((pick) => <div className="recent-pick" key={pick.overallPick}><b>{pick.overallPick}</b><span>{pick.playerName}<small>{pick.position} · {pick.team}</small></span></div>)}</AccordionContent></AccordionItem></Accordion></aside>
        </div>
      </section>}

      {view === 'players' && <section className="full-page players-page"><div className="page-title"><div><span className="eyebrow">PLAYER INTELLIGENCE</span><h1>Available player pool</h1><p>{catalogCopy.description}</p></div><Badge variant="outline" className="revision-stamp">{catalogCopy.badge}</Badge></div><div className="filter-bar"><label className="search-box"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search players" aria-label="Search players" /></label><Tabs value={position} onValueChange={(value) => setPosition(value as typeof position)} className="position-tabs"><TabsList>{positions.map((item) => <TabsTrigger key={item} value={item}>{item}</TabsTrigger>)}</TabsList></Tabs><label className="toggle"><Switch checked={hideDrafted} onCheckedChange={setHideDrafted} />Available only</label></div><PlayerTable players={filteredPlayers} onDetail={setDetail} /></section>}

      <Sheet open={boardOpen} onOpenChange={setBoardOpen}><SheetContent className="board-sheet"><SheetHeader><SheetTitle>Draft board</SheetTitle><SheetDescription>{state.picks.length} selections · revision {state.session.revision}</SheetDescription></SheetHeader><div className="pick-grid">{Array.from({ length: state.session.teamCount * state.session.rounds }, (_, index) => { const overall = index + 1; const pick = state.picks.find((item) => item.overallPick === overall); return <div key={overall} className={`pick-cell ${pick ? 'selected' : ''} ${pick?.draftingSlot === state.session.userSlot ? 'mine' : ''}`}><span>{Math.ceil(overall / state.session.teamCount)}.{String(((overall - 1) % state.session.teamCount) + 1).padStart(2, '0')}</span><strong>{pick?.playerName ?? '—'}</strong><small>{pick ? `${pick.position} · ${pick.authority}` : `Slot ${((overall - 1) % state.session.teamCount) + 1}`}</small></div>; })}</div></SheetContent></Sheet>

      <Sheet open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}><SheetContent className="player-drawer">{detail && <PlayerDrawer player={detail} recommendation={state.recommendations.find((item) => item.playerId === detail.id)} onCopy={async () => { await navigator.clipboard.writeText(detail.name); toast.success(`${detail.name} copied. Make the selection on ESPN.`); }} />}</SheetContent></Sheet>
      <Dialog open={watcherOpen} onOpenChange={setWatcherOpen}><DialogContent className="modal"><DialogHeader><span className="eyebrow">READ-ONLY ESPN CONNECTION</span><DialogTitle>Fourth Down ESPN Watcher</DialogTitle><DialogDescription>The Chrome extension observes rendered draft picks and relays them to this local engine. It cannot queue players or make selections.</DialogDescription></DialogHeader><dl><div><dt>Status</dt><dd><Badge variant="outline" className={health.pageAttached ? 'drafted-label' : ''}>{health.pageAttached ? 'CONNECTED' : 'NOT DETECTED'}</Badge></dd></div><div><dt>Capture</dt><dd>{health.capture}</dd></div><div><dt>Last snapshot</dt><dd>{health.lastObservationAt ? new Date(health.lastObservationAt).toLocaleTimeString() : 'None'}</dd></div><div><dt>Extension folder</dt><dd><code>apps/chrome-extension</code></dd></div></dl><DialogDescription>Install once from <code>chrome://extensions</code> using Developer mode → Load unpacked. The legacy bridge remains available only as a diagnostic fallback.</DialogDescription><DialogFooter className="modal-actions"><Button variant="outline" className="secondary-button" onClick={() => void copyTabBridge()} disabled={busy === 'bridge'}>Copy fallback bridge</Button><Button onClick={() => setWatcherOpen(false)}>Done</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="modal"><DialogHeader><span className="danger-kicker">SAFE BOARD RESET</span><DialogTitle id="reset-title">Archive this board and start clean?</DialogTitle><DialogDescription>The current session is preserved in full. A new empty child becomes active; player intelligence is untouched.</DialogDescription></DialogHeader><dl><div><dt>Session</dt><dd>{state.session.name}</dd></div><div><dt>Environment</dt><dd>{state.environment}</dd></div><div><dt>Picks preserved</dt><dd>{state.picks.length}</dd></div><div><dt>Session ID</dt><dd>{state.session.id.slice(0, 8)}</dd></div></dl><DialogFooter className="modal-actions"><Button variant="outline" className="secondary-button" onClick={() => setResetOpen(false)}>Keep drafting</Button><Button variant="destructive" className="danger-button" disabled={busy === 'reset' || health.pageAttached} title={health.pageAttached ? 'Stop following ESPN before resetting the local board' : undefined} onClick={async () => { await mutate('reset', `/v1/draft-sessions/${state.session.id}/reset`, { commandId: commandId('reset'), expectedRevision: state.session.revision, body: { confirmation: { sessionId: state.session.id, mode: state.session.mode, pickCount: state.picks.length } } }, 'POST', 'Prior board archived. A new empty board is active.'); setResetOpen(false); }}>Archive & reset</Button></DialogFooter></DialogContent></Dialog>
      {state.lastOperation?.undoable && <Button className="undo-toast" onClick={() => void mutate('undo', `/v1/operations/${state.lastOperation!.id}/undo`, {}, 'POST', 'Reset undone; the prior session is active again.')}>Undo last reset</Button>}
      <footer className="environment-footer"><span>{environmentCopy.status}</span><ToggleGroup type="single" variant="outline" size="sm" value={state.environment} onValueChange={(value) => { if (value === 'PRACTICE' || value === 'LIVE') void mutate('environment', '/v1/settings/draft-environment', { environment: value }, 'PUT', `${value === 'PRACTICE' ? 'Practice' : 'Live'} environment active.`); }} aria-label="Draft environment"><ToggleGroupItem value="PRACTICE" aria-label="Use practice environment">Practice</ToggleGroupItem><ToggleGroupItem value="LIVE" aria-label="Use live environment">Live</ToggleGroupItem></ToggleGroup></footer>
    </main>
  );
}

function PlayerTable({ players, onDetail, compact = false }: { players: Array<Player & { drafted: boolean }>; onDetail: (player: Player) => void; compact?: boolean }) {
  return <div className="table-shell"><Table className="player-table"><TableHeader><TableRow><TableHead>RK</TableHead><TableHead>Player</TableHead><TableHead>ADP</TableHead><TableHead>2025 PPG</TableHead>{!compact && <><TableHead>Late Δ</TableHead><TableHead>Opp/G</TableHead><TableHead>Floor</TableHead><TableHead>Ceiling</TableHead></>}<TableHead>Bye</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{players.map((player) => <TableRow key={player.id} className={player.drafted ? 'drafted' : ''}><TableCell className="rank-cell">{player.overallRank}</TableCell><TableCell><Button variant="ghost" className="player-name" onClick={() => onDetail(player)}><PositionMark position={player.position} /><span><strong>{player.name}</strong><small>{player.team ?? 'FA'} · {player.position}{player.positionalRank}{player.intelligence ? ` · ${player.intelligence.dataQuality}` : ''}</small></span></Button></TableCell><TableCell>{player.adp?.toFixed(1) ?? '—'}</TableCell><TableCell>{player.intelligence?.fantasyPpgPpr?.toFixed(1) ?? '—'}</TableCell>{!compact && <><TableCell className={(player.intelligence?.trendScore ?? 0) < 0 ? 'negative-text' : 'positive-text'}>{player.intelligence?.trendScore != null ? `${player.intelligence.trendScore > 0 ? '+' : ''}${player.intelligence.trendScore.toFixed(1)}` : '—'}</TableCell><TableCell>{player.intelligence?.opportunitiesPerGame?.toFixed(1) ?? '—'}</TableCell><TableCell>{player.intelligence?.floorScore.toFixed(0) ?? '—'}</TableCell><TableCell>{player.intelligence?.ceilingScore.toFixed(0) ?? '—'}</TableCell></>}<TableCell>{player.byeWeek ?? '?'}</TableCell><TableCell>{player.drafted ? <Badge variant="outline" className="drafted-label">DRAFTED</Badge> : <Button size="sm" variant="ghost" className="row-draft" onClick={() => onDetail(player)}>Open</Button>}</TableCell></TableRow>)}</TableBody></Table>{!players.length && <div className="empty-table">No players match these filters.</div>}</div>;
}

function PlayerDrawer({ player, recommendation, onCopy }: { player: Player; recommendation?: Recommendation; onCopy: () => void }) {
  const research = player.research;
  const intelligence = player.intelligence;
  return <><SheetHeader className="drawer-hero"><PositionMark position={player.position} /><span className="eyebrow">{player.team ?? 'FREE AGENT'} · BYE {player.byeWeek ?? '?'}</span><SheetTitle>{player.name}</SheetTitle><SheetDescription>{player.position}{player.positionalRank} · Model rank {player.overallRank}{research ? ` · ESPN rank ${research.espnRank}` : ''}</SheetDescription></SheetHeader><div className="drawer-score"><span>Draft score</span><strong>{recommendation?.score.toFixed(1) ?? '—'}</strong><small>{recommendation ? `Ranked #${recommendation.rank} for this roster` : 'Outside the current recommendations'}</small></div><div className="drawer-metrics"><Card><small>2025 PPG</small><strong>{intelligence?.fantasyPpgPpr?.toFixed(1) ?? '—'}</strong></Card><Card><small>FLOOR</small><strong>{intelligence?.floorScore.toFixed(0) ?? '—'}</strong></Card><Card><small>CEILING</small><strong>{intelligence?.ceilingScore.toFixed(0) ?? '—'}</strong></Card></div>{intelligence && <Accordion type="multiple" defaultValue={['role', 'cases']} className="drawer-accordion"><AccordionItem value="role"><AccordionTrigger>Observed role</AccordionTrigger><AccordionContent><p>{intelligence.roleSummary}</p><div className="intel-grid"><span><b>{intelligence.opportunitiesPerGame?.toFixed(1) ?? '—'}</b><small>opp / game</small></span><span><b>{intelligence.targetShare?.toFixed(1) ?? '—'}%</b><small>target share</small></span><span><b>{intelligence.airYardsShare?.toFixed(1) ?? '—'}%</b><small>air yards</small></span><span><b>{intelligence.trendScore != null ? `${intelligence.trendScore > 0 ? '+' : ''}${intelligence.trendScore.toFixed(1)}` : '—'}</b><small>late-season Δ</small></span></div></AccordionContent></AccordionItem><AccordionItem value="cases"><AccordionTrigger>Floor, ceiling & risk</AccordionTrigger><AccordionContent><dl className="case-list"><div><dt>Floor</dt><dd>{intelligence.floorCase}</dd></div><div><dt>Ceiling</dt><dd>{intelligence.ceilingCase}</dd></div><div><dt>Risk</dt><dd>{intelligence.riskNote}</dd></div></dl></AccordionContent></AccordionItem><AccordionItem value="sources"><AccordionTrigger>{intelligence.sourceCount} evidence sources</AccordionTrigger><AccordionContent><div className="evidence-list">{intelligence.evidence.map((item) => <a key={`${item.source}-${item.kind}`} href={item.source} target="_blank" rel="noreferrer"><span>{item.kind}</span><small>{item.claim}</small></a>)}</div></AccordionContent></AccordionItem></Accordion>}{!intelligence && research && <Card className="provenance"><span className="eyebrow">LEGACY RESEARCH NOTE</span><p>{research.whyFits}</p><small>{research.archetype} · {research.modelSignal}</small></Card>}{recommendation && <Accordion type="single" collapsible className="drawer-accordion"><AccordionItem value="score"><AccordionTrigger>Why this score</AccordionTrigger><AccordionContent><div className="drawer-factors">{recommendation.factors.map((factor) => <div key={factor.key}><span>{factor.label}<small>{factor.detail}</small></span><strong className={factor.contribution < 0 ? 'negative-text' : ''}>{factor.contribution > 0 ? '+' : ''}{factor.contribution.toFixed(1)}</strong></div>)}</div></AccordionContent></AccordionItem></Accordion>}<Card className="provenance"><span className="eyebrow">ESPN REMAINS IN CONTROL</span><p>Copy the name, make the pick on ESPN, and the watcher refreshes this board.</p></Card><Button className="drawer-draft" variant="outline" onClick={onCopy}>Copy player name</Button></>;
}
