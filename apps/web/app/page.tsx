'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DraftPick, DraftState, Player, Recommendation } from '@fda/contracts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

type View = 'draft' | 'players' | 'board';
type Notice = { kind: 'error' | 'success'; text: string } | null;
const positions = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DST'] as const;

function commandId(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/engine${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-fda-csrf': 'local-ui-v1', ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload as T;
}

function StatusPip({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return <Tooltip><TooltipTrigger asChild><Badge variant="outline" className="status-pip"><span className={`status-dot ${ok ? 'ok' : ''}`} aria-hidden="true" /><span>{label}</span></Badge></TooltipTrigger><TooltipContent>{detail}</TooltipContent></Tooltip>;
}

function PositionMark({ position }: { position: Player['position'] }) {
  return <Badge className={`position-mark position-${position.toLowerCase()}`}>{position}</Badge>;
}

function RecommendationCard({ recommendation, active, onSelect }: { recommendation: Recommendation; active: boolean; onSelect: () => void }) {
  const positive = recommendation.factors.filter((factor) => factor.contribution > 0).sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  return (
    <Card className={`recommendation-card ${active ? 'featured' : ''}`} onClick={onSelect}>
      <div className="recommendation-rank">0{recommendation.rank}</div>
      <div className="recommendation-main">
        <div className="recommendation-title-row"><PositionMark position={recommendation.position} /><div><h3>{recommendation.playerName}</h3><p>{recommendation.team ?? 'FA'} · score {recommendation.score.toFixed(1)}</p></div></div>
        <p className="recommendation-copy">{recommendation.explanation}</p>
        <div className="factor-chips">{positive.map((factor) => <Badge key={factor.key} variant="secondary">{factor.label} +{factor.contribution.toFixed(1)}</Badge>)}</div>
        <div className="recommendation-footer"><Badge variant="outline" className={`survival survival-${recommendation.survivalBand.replace(' ', '-')}`}>{recommendation.survivalBand} to return</Badge><Button type="button" size="sm" className="draft-button" variant="outline" onClick={(event) => { event.stopPropagation(); onSelect(); }}>Inspect</Button></div>
      </div>
    </Card>
  );
}

function Roster({ picks }: { picks: DraftPick[] }) {
  const slots = [
    { label: 'QB', accept: ['QB'] }, { label: 'RB', accept: ['RB'] }, { label: 'RB', accept: ['RB'] },
    { label: 'WR', accept: ['WR'] }, { label: 'WR', accept: ['WR'] }, { label: 'TE', accept: ['TE'] },
    { label: 'FLEX', accept: ['RB', 'WR', 'TE'] }, { label: 'K', accept: ['K'] }, { label: 'DST', accept: ['DST'] },
  ];
  const remaining = [...picks];
  return <div className="roster-list">{slots.map((slot, index) => {
    const playerIndex = remaining.findIndex((pick) => slot.accept.includes(pick.position));
    const player = playerIndex >= 0 ? remaining.splice(playerIndex, 1)[0] : undefined;
    return <div className={`roster-slot ${player ? 'filled' : ''}`} key={`${slot.label}-${index}`}><span className="slot-label">{slot.label}</span><span className="slot-player">{player?.playerName ?? 'Open slot'}</span><span className="slot-badge">{player?.team ?? '—'}</span></div>;
  })}{remaining.map((pick, index) => <div className="roster-slot filled bench" key={pick.overallPick}><span className="slot-label">B{index + 1}</span><span className="slot-player">{pick.playerName}</span><span className="slot-badge">{pick.position}</span></div>)}</div>;
}

export default function Home() {
  const [state, setState] = useState<DraftState | null>(null);
  const [view, setView] = useState<View>('draft');
  const [position, setPosition] = useState<(typeof positions)[number]>('ALL');
  const [query, setQuery] = useState('');
  const [hideDrafted, setHideDrafted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [detail, setDetail] = useState<Player | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [factorsOpen, setFactorsOpen] = useState<string | null>(null);

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
  const observedLabel = health.lastObservationAt ? `ESPN ${new Date(health.lastObservationAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'No ESPN snapshot';
  const reconciledLabel = health.lastReconciledAt ? `Board ${new Date(health.lastReconciledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Board not synced';
  const currentPickLabel = `${state.session.currentRound}.${String(((state.session.currentOverallPick - 1) % state.session.teamCount) + 1).padStart(2, '0')}`;
  const hasObservedCatalog = state.players.some((player) => player.source.startsWith('ESPN passive'));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><span className="brand-badge">4D</span><div><strong>FOURTH DOWN</strong><small>LIVE DECISION COMPANION</small></div></div>
        <Tabs value={view} onValueChange={(value) => setView(value as View)} className="primary-nav"><TabsList><TabsTrigger value="draft">Draft room</TabsTrigger><TabsTrigger value="players">Players</TabsTrigger><TabsTrigger value="board">Board</TabsTrigger></TabsList></Tabs>
        <div className="header-actions"><Button variant="outline" className="secondary-button" onClick={() => void copyTabBridge()} disabled={busy === 'bridge'}>{health.pageAttached ? 'Refresh ESPN bridge' : 'Copy ESPN tab bridge'}</Button><Button variant="outline" size="icon" className="icon-button" aria-label="Open reset session dialog" onClick={() => setResetOpen(true)}>•••</Button></div>
      </header>

      <section className="health-strip" aria-label="Connection status"><StatusPip label="Engine" ok={health.engine === 'healthy'} detail={`Engine ${health.engine}`} /><StatusPip label="ESPN link" ok={health.espnAuth === 'authenticated'} detail={`Read-only ESPN connection ${health.espnAuth}`} /><StatusPip label="Draft detected" ok={health.pageDetected} detail={health.pageDetected ? 'Supported ESPN draft page detected' : 'No supported ESPN draft page detected'} /><StatusPip label="Following" ok={health.pageAttached} detail={health.pageAttached ? 'Read-only observation is active' : 'ESPN page is not bound to the board'} /><StatusPip label="Capture" ok={health.capture === 'healthy'} detail={`Capture ${health.capture}`} /><StatusPip label={observedLabel} ok={!!health.lastObservationAt} detail={health.lastObservationAt ? `Last passive ESPN observation at ${health.lastObservationAt}` : 'No ESPN observation has been received'} /><StatusPip label={reconciledLabel} ok={!!health.lastReconciledAt} detail={health.lastReconciledAt ? `Last committed board reconciliation at ${health.lastReconciledAt}` : 'The board has not reconciled with ESPN yet'} /><span className="health-spacer" /><Badge variant="outline" className="fixture-label">ESPN · READ ONLY</Badge>{health.pageDetected && !health.pageAttached && <Button size="sm" className="secondary-button" onClick={() => void mutate('bind', '/v1/browser/bind-page', { commandId: commandId('bind-page'), expectedRevision: state.session.revision, body: {} }, 'POST', 'Following this ESPN draft read-only.')} disabled={busy === 'bind'}>Follow this ESPN draft</Button>}<Button variant="link" size="sm" className="text-button" onClick={() => void mutate('reconcile', `/v1/draft-sessions/${state.session.id}/reconcile`, {}, 'POST', 'Reconciliation completed.')} disabled={!health.pageAttached || busy === 'reconcile'}>Reconcile now</Button></section>
      {notice && <div className={`notice ${notice.kind}`} role="status"><span>{notice.text}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}>×</button></div>}

      {view === 'draft' && <div className="draft-layout"><section className="draft-main">
        <div className="turn-banner"><div className="pick-number"><small>ON THE CLOCK</small><strong>{currentPickLabel}</strong><span>Overall {state.session.currentOverallPick}</span></div><div className="turn-copy"><p>{environmentCopy.context}</p><h1>{state.session.isUserTurn ? environmentCopy.turn : 'Recommendations update after every ESPN pick.'}</h1><span>{state.session.nextUserPick ? `Next selection: ${state.session.nextUserPick} overall` : 'Final round'}</span></div></div>
        <div className="section-heading"><div><span className="eyebrow">DECISION BOARD</span><h2>Best available, with receipts</h2></div><Badge variant="outline" className="algorithm-tag">DETERMINISTIC V1</Badge></div>
        <div className="recommendation-grid">{state.recommendations.slice(0, 3).map((recommendation, index) => <RecommendationCard key={recommendation.playerId} recommendation={recommendation} active={index === 0} onSelect={() => setFactorsOpen(factorsOpen === recommendation.playerId ? null : recommendation.playerId)} />)}</div>
        {factorsOpen && (() => { const recommendation = state.recommendations.find((item) => item.playerId === factorsOpen); return recommendation ? <Card className="factor-panel"><div><span className="eyebrow">FULL SCORECARD</span><h3>{recommendation.playerName}</h3></div><div className="factor-bars">{recommendation.factors.map((factor) => <Tooltip key={factor.key}><TooltipTrigger asChild><div className="factor-row"><span>{factor.label}</span><Progress value={Math.min(100, Math.abs(factor.contribution) * 5)} className={factor.contribution < 0 ? 'negative' : ''} /><strong>{factor.contribution > 0 ? '+' : ''}{factor.contribution.toFixed(1)}</strong></div></TooltipTrigger><TooltipContent>{factor.detail}</TooltipContent></Tooltip>)}</div></Card> : null; })()}
        <div className="section-heading table-heading"><div><span className="eyebrow">AVAILABLE POOL</span><h2>Player board</h2></div><Button variant="link" className="text-button" onClick={() => setView('players')}>Open full table →</Button></div><PlayerTable players={filteredPlayers.slice(0, 12)} onDetail={setDetail} compact />
      </section><aside className="right-rail"><div className="rail-heading"><div><span className="eyebrow">SLOT {state.session.userSlot}</span><h2>Your roster</h2></div><span>{state.roster.length}/{state.session.rounds}</span></div><Roster picks={state.roster} /><div className="bye-card"><span className="eyebrow">BYE EXPOSURE</span><div className="bye-weeks">{[5,6,7,8,9,10,11,12,13,14].map((week) => { const count = state.roster.filter((pick) => state.players.find((player) => player.id === pick.playerId)?.byeWeek === week).length; return <span key={week} className={count >= 2 ? 'hot' : count === 1 ? 'warm' : ''}><b>{week}</b><small>{count || '—'}</small></span>; })}</div></div><div className="recent-card"><div className="rail-heading"><h3>Recent picks</h3><span>REV {state.session.revision}</span></div>{state.picks.slice(-5).reverse().map((pick) => <div className="recent-pick" key={pick.overallPick}><b>{pick.overallPick}</b><span>{pick.playerName}<small>{pick.position} · {pick.team}</small></span><em>{pick.authority}</em></div>)}</div></aside></div>}

      {view === 'players' && <section className="full-page"><div className="page-title"><div><span className="eyebrow">PLAYER INTELLIGENCE</span><h1>Build your board</h1><p>{hasObservedCatalog ? 'ESPN identities are fresh from the attached page; local scoring remains explicitly provisional.' : 'Every row shows the effective local value. The bundled fixture is intentionally replaceable.'}</p></div><Badge variant="outline" className="revision-stamp">{hasObservedCatalog ? 'ESPN CATALOG · PASSIVE' : 'DATASET · DEMO'}</Badge></div><div className="filter-bar"><label className="search-box"><span aria-hidden="true">⌕</span><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search player, team, position…" aria-label="Search players" /></label><Tabs value={position} onValueChange={(value) => setPosition(value as typeof position)} className="position-tabs"><TabsList>{positions.map((item) => <TabsTrigger key={item} value={item}>{item}</TabsTrigger>)}</TabsList></Tabs><label className="toggle"><Switch checked={hideDrafted} onCheckedChange={setHideDrafted} />Hide drafted</label></div><PlayerTable players={filteredPlayers} onDetail={setDetail} /></section>}

      {view === 'board' && <section className="full-page"><div className="page-title"><div><span className="eyebrow">SESSION EVIDENCE</span><h1>The board, pick by pick</h1><p>Manual locks remain authoritative until you explicitly return them to automation.</p></div><span className="revision-stamp">REVISION {state.session.revision}</span></div><div className="pick-grid">{Array.from({ length: state.session.teamCount * Math.min(state.session.rounds, 6) }, (_, index) => { const overall = index + 1; const pick = state.picks.find((item) => item.overallPick === overall); return <div key={overall} className={`pick-cell ${pick ? 'selected' : ''} ${pick?.draftingSlot === state.session.userSlot ? 'mine' : ''}`}><span>{Math.ceil(overall / state.session.teamCount)}.{String(((overall - 1) % state.session.teamCount) + 1).padStart(2, '0')}</span><strong>{pick?.playerName ?? '—'}</strong><small>{pick ? `${pick.position} · ${pick.authority}` : `Slot ${((overall - 1) % state.session.teamCount) + 1}`}</small></div>; })}</div></section>}

      <Sheet open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}><SheetContent className="player-drawer">{detail && <PlayerDrawer player={detail} recommendation={state.recommendations.find((item) => item.playerId === detail.id)} onCopy={async () => { await navigator.clipboard.writeText(detail.name); toast.success(`${detail.name} copied. Make the selection on ESPN.`); }} />}</SheetContent></Sheet>
      <Dialog open={resetOpen} onOpenChange={setResetOpen}><DialogContent className="modal"><DialogHeader><span className="danger-kicker">SAFE BOARD RESET</span><DialogTitle id="reset-title">Archive this board and start clean?</DialogTitle><DialogDescription>The current session is preserved in full. A new empty child becomes active; player intelligence is untouched.</DialogDescription></DialogHeader><dl><div><dt>Session</dt><dd>{state.session.name}</dd></div><div><dt>Environment</dt><dd>{state.environment}</dd></div><div><dt>Picks preserved</dt><dd>{state.picks.length}</dd></div><div><dt>Session ID</dt><dd>{state.session.id.slice(0, 8)}</dd></div></dl><DialogFooter className="modal-actions"><Button variant="outline" className="secondary-button" onClick={() => setResetOpen(false)}>Keep drafting</Button><Button variant="destructive" className="danger-button" disabled={busy === 'reset' || health.pageAttached} title={health.pageAttached ? 'Stop following ESPN before resetting the local board' : undefined} onClick={async () => { await mutate('reset', `/v1/draft-sessions/${state.session.id}/reset`, { commandId: commandId('reset'), expectedRevision: state.session.revision, body: { confirmation: { sessionId: state.session.id, mode: state.session.mode, pickCount: state.picks.length } } }, 'POST', 'Prior board archived. A new empty board is active.'); setResetOpen(false); }}>Archive & reset</Button></DialogFooter></DialogContent></Dialog>
      {state.lastOperation?.undoable && <Button className="undo-toast" onClick={() => void mutate('undo', `/v1/operations/${state.lastOperation!.id}/undo`, {}, 'POST', 'Reset undone; the prior session is active again.')}>Undo last reset</Button>}
      <footer className="environment-footer"><span>{environmentCopy.status}</span><ToggleGroup type="single" variant="outline" size="sm" value={state.environment} onValueChange={(value) => { if (value === 'PRACTICE' || value === 'LIVE') void mutate('environment', '/v1/settings/draft-environment', { environment: value }, 'PUT', `${value === 'PRACTICE' ? 'Practice' : 'Live'} environment active.`); }} aria-label="Draft environment"><ToggleGroupItem value="PRACTICE" aria-label="Use practice environment">Practice</ToggleGroupItem><ToggleGroupItem value="LIVE" aria-label="Use live environment">Live</ToggleGroupItem></ToggleGroup></footer>
    </main>
  );
}

function PlayerTable({ players, onDetail, compact = false }: { players: Array<Player & { drafted: boolean }>; onDetail: (player: Player) => void; compact?: boolean }) {
  return <div className="table-shell"><Table className="player-table"><TableHeader><TableRow><TableHead>RK</TableHead><TableHead>Player</TableHead><TableHead>Tier</TableHead><TableHead>ADP</TableHead><TableHead>Proj</TableHead>{!compact && <><TableHead>Upside</TableHead><TableHead>Reliability</TableHead><TableHead>Risk</TableHead></>}<TableHead>Bye</TableHead><TableHead><span className="sr-only">Actions</span></TableHead></TableRow></TableHeader><TableBody>{players.map((player) => <TableRow key={player.id} className={player.drafted ? 'drafted' : ''}><TableCell className="rank-cell">{player.overallRank}</TableCell><TableCell><Button variant="ghost" className="player-name" onClick={() => onDetail(player)}><PositionMark position={player.position} /><span><strong>{player.name}</strong><small>{player.team ?? 'FA'} · {player.position}{player.positionalRank}</small></span></Button></TableCell><TableCell><Badge variant="secondary" className="tier-pill">T{player.tier}</Badge></TableCell><TableCell>{player.adp?.toFixed(1) ?? '—'}</TableCell><TableCell>{player.projection.toFixed(1)}</TableCell>{!compact && <><TableCell><MetricBar value={player.upside} tone="green" /></TableCell><TableCell><MetricBar value={player.reliability} tone="blue" /></TableCell><TableCell><MetricBar value={player.risk} tone="red" /></TableCell></>}<TableCell>{player.byeWeek ?? '?'}</TableCell><TableCell>{player.drafted ? <Badge variant="outline" className="drafted-label">DRAFTED</Badge> : <Button size="sm" variant="outline" className="row-draft" onClick={() => onDetail(player)}>Details</Button>}</TableCell></TableRow>)}</TableBody></Table>{!players.length && <div className="empty-table">No players match these filters.</div>}</div>;
}

function MetricBar({ value, tone }: { value: number; tone: string }) { return <span className="metric"><Progress value={value} className={tone} /><em>{value.toFixed(0)}</em></span>; }

function PlayerDrawer({ player, recommendation, onCopy }: { player: Player; recommendation?: Recommendation; onCopy: () => void }) {
  return <><SheetHeader className="drawer-hero"><PositionMark position={player.position} /><span className="eyebrow">{player.team ?? 'FREE AGENT'} · BYE {player.byeWeek ?? '?'}</span><SheetTitle>{player.name}</SheetTitle><SheetDescription>{player.position}{player.positionalRank} · Overall rank {player.overallRank}</SheetDescription></SheetHeader><div className="drawer-score"><span>Draft score</span><strong>{recommendation?.score.toFixed(1) ?? '—'}</strong><small>{recommendation ? `Ranked #${recommendation.rank} right now` : 'Outside the current top recommendations'}</small></div><div className="drawer-metrics"><Card><small>PROJECTION</small><strong>{player.projection.toFixed(1)}</strong></Card><Card><small>ADP</small><strong>{player.adp?.toFixed(1) ?? '—'}</strong></Card><Card><small>TIER</small><strong>{player.tier}</strong></Card></div>{recommendation && <div className="drawer-factors"><h3>Why this score</h3>{recommendation.factors.map((factor) => <div key={factor.key}><span>{factor.label}<small>{factor.detail}</small></span><strong className={factor.contribution < 0 ? 'negative-text' : ''}>{factor.contribution > 0 ? '+' : ''}{factor.contribution.toFixed(1)}</strong></div>)}</div>}<Card className="provenance"><span className="eyebrow">EFFECTIVE VALUE</span><p>{player.source}</p><small>Updated {new Date(player.updatedAt).toLocaleDateString()}</small></Card><Card className="provenance"><span className="eyebrow">ESPN REMAINS IN CONTROL</span><p>Make the selection on ESPN. Fourth Down observes the result and refreshes this board.</p></Card><Button className="drawer-draft" variant="outline" onClick={onCopy}>Copy player name</Button></>;
}
