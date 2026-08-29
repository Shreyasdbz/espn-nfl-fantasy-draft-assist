const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=');
  return [argument.slice(2, separator), argument.slice(separator + 1)];
}));

const requireEspn = options['require-espn'] === 'true';
const expectedMode = options['expect-mode'] === 'practice' ? 'PRACTICE' : options['expect-mode'] === 'real' || options['expect-mode'] === 'live' ? 'LIVE' : null;
const maxAgeSeconds = Number(options['max-age-seconds'] ?? 15);
if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds < 1) {
  console.error('max-age-seconds must be a positive number.');
  process.exit(2);
}

async function get(path) {
  const response = await fetch(`http://127.0.0.1:3000/api/engine${path}`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function ageSeconds(value) {
  if (!value) return null;
  return Math.max(0, (Date.now() - new Date(value).getTime()) / 1_000);
}

try {
  const [health, state] = await Promise.all([get('/v1/health'), get('/v1/state')]);
  const errors = [];
  const warnings = [];
  if (health.engine !== 'healthy') errors.push(`engine is ${health.engine}`);
  if (health.database !== 'healthy') errors.push(`database is ${health.database}`);
  if (expectedMode && state.environment !== expectedMode) errors.push(`expected ${expectedMode} mode, found ${state.environment}`);

  const observationAge = ageSeconds(health.lastObservationAt);
  const reconciliationAge = ageSeconds(health.lastReconciledAt);
  if (requireEspn) {
    if (!health.pageDetected) errors.push('no supported ESPN draft page detected');
    if (!health.pageAttached) errors.push('ESPN draft page is not attached');
    if (health.espnAuth !== 'authenticated') errors.push(`ESPN authentication is ${health.espnAuth}`);
    if (health.capture !== 'healthy') errors.push(`capture is ${health.capture}`);
    if (observationAge === null) errors.push('no ESPN observation has been received');
    else if (observationAge > maxAgeSeconds) errors.push(`last ESPN observation is stale (${observationAge.toFixed(1)}s old)`);
    if (state.picks.length > 0 && reconciliationAge === null) errors.push('picks exist but the board has never reconciled');
    else if (reconciliationAge !== null && reconciliationAge > maxAgeSeconds) errors.push(`last board reconciliation is stale (${reconciliationAge.toFixed(1)}s old)`);
  } else if (!health.pageAttached) {
    warnings.push('ESPN is not attached; run the strict check after opening the draft tab');
  }

  console.log('Connection report');
  console.log(`  App/database:  ${health.engine}/${health.database}`);
  console.log(`  Mode:          ${state.environment}`);
  console.log(`  ESPN:          ${health.espnAuth} · detected=${health.pageDetected} · attached=${health.pageAttached}`);
  console.log(`  Capture:       ${health.capture}`);
  console.log(`  Observation:   ${health.lastObservationAt ?? 'none'}${observationAge === null ? '' : ` (${observationAge.toFixed(1)}s ago)`}`);
  console.log(`  Reconciled:    ${health.lastReconciledAt ?? 'none'}${reconciliationAge === null ? '' : ` (${reconciliationAge.toFixed(1)}s ago)`}`);
  console.log(`  Draft state:   revision ${state.session.revision} · ${state.picks.length} picks · ${state.roster.length}/${state.session.rounds} rostered`);
  for (const warning of warnings) console.log(`  WARN:          ${warning}`);
  for (const error of errors) console.error(`  FAIL:          ${error}`);
  if (errors.length) process.exit(1);
  console.log(requireEspn ? 'PASS: local services and live ESPN synchronization are healthy.' : 'PASS: local services and database are healthy.');
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  console.error('Run ./scripts/setup.sh practice or ./scripts/setup.sh real first.');
  process.exit(1);
}
