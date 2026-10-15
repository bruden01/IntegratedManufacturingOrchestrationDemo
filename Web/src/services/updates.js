/**
 * Live UI updates from Vantiq.
 *
 * Every service publishes its UI updates to com.vantiqse.imo.UIUpdates, so the web app holds one
 * subscription to its UIUpdatePayload event. Each payload carries a `kind` that says what happened.
 * Plain WebSocket protocol, see the `websockets` doc on the vantiq-vite MCP server.
 */
import Vantiq from './vantiq.js';

// A service's outbound event is subscribed to as an `events` resource at /services/<service>/<event>,
// persistent, the same way the AirQualityDemo client does it.
const UPDATES_EVENT = '/services/com.vantiqse.imo.UIUpdates/UIUpdatePayload';
const RECONNECT_MS = 3000;
const MAX_RECONNECT_MS = 30000;

const frameText = async (data) => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return data.text();
};

/** Opens the subscription and calls onUpdate(payload) for each UI update. Returns a function that closes it. */
export function subscribeToUIUpdates(onUpdate) {
  let ws = null;
  let closed = false;
  let timer = null;
  let retryMs = RECONNECT_MS;

  const connect = async () => {
    if (closed) return;
    await Vantiq.ensureFreshToken();
    const base = Vantiq.baseUrl || window.location.origin;
    ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/v1/wsock/websocket`);
    ws.binaryType = 'arraybuffer';
    let authed = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'validate', resourceName: 'system.credentials', object: Vantiq.accessToken }));
    };
    ws.onmessage = async (evt) => {
      let msg;
      try { msg = JSON.parse(await frameText(evt.data)); } catch { return; }
      if (!authed && msg.status === 200) {
        authed = true;
        retryMs = RECONNECT_MS;
        ws.send(JSON.stringify({
          op: 'subscribe',
          resourceName: 'events',
          resourceId: UPDATES_EVENT,
          parameters: { requestId: 'ui-updates', persistent: true },
          targetNamespace: Vantiq.namespace,
        }));
        return;
      }
      if (msg.status === 100 && msg.body) {
        // Pushed events carry the payload under body.value (types, topics) or, for some event kinds, as the body itself.
        const value = msg.body.value ?? msg.body;
        onUpdate(value);
      } else if (msg.status === 410) {
        // The subscription was terminated server-side: drop the socket so the reconnect resubscribes.
        console.warn('[ui-updates] subscription terminated, reconnecting');
        ws.close();
      } else if (msg.status >= 400) {
        console.warn('[ui-updates] server replied', msg.status, JSON.stringify(msg.body));
      }
    };
    ws.onclose = () => {
      if (closed) return;
      console.warn(`[ui-updates] socket closed, retrying in ${retryMs} ms`);
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  };

  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    if (ws) ws.close();
  };
}
