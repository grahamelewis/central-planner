// WS hub + event bus. Owns the ws.Server at path '/ws'.
import { WebSocketServer } from 'ws';

let wss = null;
const connectHandlers = [];

/**
 * Attach a WebSocketServer to an existing http server at path '/ws'.
 */
export function initWss(httpServer) {
  if (wss) return wss;
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (socket) => {
    socket.on('error', (err) => {
      console.error('[core] ws socket error:', err.message);
    });
    // Per-client send helper: socketSend(type, payload)
    const socketSend = (type, payload) => {
      try {
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type, payload }));
        }
      } catch (err) {
        console.error('[core] ws send error:', err.message);
      }
    };
    for (const fn of connectHandlers) {
      try {
        fn(socketSend);
      } catch (err) {
        console.error('[core] onClientConnect handler error:', err.message);
      }
    }
  });

  wss.on('error', (err) => {
    console.error('[core] wss error:', err.message);
  });

  return wss;
}

/**
 * Broadcast {type, payload} as JSON to every connected client.
 * Safe to call before initWss (no-op).
 */
export function broadcast(type, payload) {
  if (!wss) return;
  let msg;
  try {
    msg = JSON.stringify({ type, payload });
  } catch (err) {
    console.error('[core] broadcast serialize error:', err.message);
    return;
  }
  for (const client of wss.clients) {
    try {
      if (client.readyState !== client.OPEN) continue;
      // a stalled client (e.g. a backgrounded phone) buffers chatty
      // session:stream output unboundedly — terminate it rather than grow
      // memory without limit; it reconnects and re-fetches /api/state
      if (client.bufferedAmount > 8 * 1024 * 1024) { client.terminate(); continue; }
      client.send(msg);
    } catch (err) {
      console.error('[core] broadcast send error:', err.message);
    }
  }
}

/**
 * Register fn(socketSend) to be called for every new client connection.
 */
export function onClientConnect(fn) {
  if (typeof fn !== 'function') throw new Error('onClientConnect requires a function');
  connectHandlers.push(fn);
}
