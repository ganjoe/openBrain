/**
 * ws_client.js — WebSocket client for chart tabs.
 * Handles connection, auto-reconnect, and incoming command dispatch.
 * Uses BroadcastChannel for cross-tab synchronisation (crosshair, ticker changes).
 */

const PCA_WS_URL = `ws://${location.hostname}:8791/ws`;

class PcaWsClient {
  constructor(onTicker, onCrosshair) {
    this._onTicker    = onTicker;    // callback(symbol: string)
    this._onCrosshair = onCrosshair; // callback(barIndex: number)
    this._ws          = null;
    this._bc          = new BroadcastChannel('pca_sync');
    this._reconnectMs = 2000;

    // Listen to BroadcastChannel messages from master or sibling tabs
    this._bc.onmessage = (e) => this._handleMessage(e.data);

    this._connect();
  }

  _connect() {
    this._ws = new WebSocket(PCA_WS_URL);

    this._ws.onopen = () => {
      console.log('[WS] Connected to PCA service');
      document.dispatchEvent(new CustomEvent('pca:ws:connected'));
    };

    this._ws.onclose = () => {
      console.warn('[WS] Disconnected. Reconnecting in', this._reconnectMs, 'ms');
      document.dispatchEvent(new CustomEvent('pca:ws:disconnected'));
      setTimeout(() => this._connect(), this._reconnectMs);
    };

    this._ws.onerror = (e) => {
      console.error('[WS] Error:', e);
    };

    this._ws.onmessage = (e) => {
      try {
        this._handleMessage(JSON.parse(e.data));
      } catch (err) {
        console.error('[WS] Bad message:', e.data);
      }
    };
  }

  _handleMessage(msg) {
    if (!msg || !msg.action) return;

    switch (msg.action) {
      case 'load_ticker':
        if (this._onTicker && msg.symbol) {
          this._onTicker(msg.symbol);
        }
        break;

      case 'crosshair_move':
        if (this._onCrosshair && msg.barIndex !== undefined) {
          this._onCrosshair(msg.barIndex);
        }
        break;

      default:
        console.log('[WS] Unhandled action:', msg.action);
    }
  }

  /**
   * Broadcast crosshair position to all sibling tabs (BroadcastChannel only, no server round-trip).
   */
  broadcastCrosshair(barIndex) {
    this._bc.postMessage({ action: 'crosshair_move', barIndex });
  }

  /**
   * Send a navigation command to the server (mobile remote).
   */
  sendCommand(command, extra = {}) {
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ command, ...extra }));
    }
  }

  destroy() {
    this._bc.close();
    this._ws?.close();
  }
}
