const CONFIG_URL = 'http://127.0.0.1:4317/v1/bridge/extension-config';

async function postObservation(snapshot) {
  const configResponse = await fetch(CONFIG_URL, { cache: 'no-store' });
  if (!configResponse.ok) throw new Error(`Fourth Down config returned ${configResponse.status}`);
  const { endpoint } = await configResponse.json();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(snapshot),
  });
  if (!response.ok) throw new Error(`Fourth Down observation returned ${response.status}`);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'FOURTH_DOWN_OBSERVATION') return false;
  postObservation(message.snapshot).then(sendResponse).catch((error) => sendResponse({ ok: false, message: String(error) }));
  return true;
});
