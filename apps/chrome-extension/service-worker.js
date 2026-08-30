importScripts('pairing.local.js');
const OBSERVE_URL = 'http://127.0.0.1:4317/v1/bridge/observe';
const PAIRING_TOKEN = self.FOURTH_DOWN_PAIRING_TOKEN;
const TAB_LEASE_MS = 10_000;
let observationQueue = Promise.resolve();

async function claimDraftTab(sender, snapshot) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) throw new Error('Fourth Down observation did not come from an ESPN tab');
  const now = Date.now();
  const { draftTabLease } = await chrome.storage.session.get('draftTabLease');
  if (draftTabLease && draftTabLease.tabId !== tabId && now - draftTabLease.lastSeenAt < TAB_LEASE_MS) {
    throw new Error('Another ESPN draft tab is already paired with Fourth Down');
  }
  await chrome.storage.session.set({ draftTabLease: { tabId, externalDraftId: snapshot.externalDraftId, lastSeenAt: now } });
}

async function postObservation(snapshot) {
  if (!PAIRING_TOKEN) throw new Error('Fourth Down extension pairing is missing; run app setup and reload the extension');
  const response = await fetch(OBSERVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-fourth-down-pairing-token': PAIRING_TOKEN },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(`Fourth Down observation returned ${response.status}`);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'FOURTH_DOWN_OBSERVATION') return false;
  const operation = observationQueue.then(async () => {
    await claimDraftTab(sender, message.snapshot);
    return postObservation(message.snapshot);
  });
  observationQueue = operation.catch(() => undefined);
  operation.then(sendResponse).catch((error) => sendResponse({ ok: false, message: String(error) }));
  return true;
});
