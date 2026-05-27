import WebSocket from 'ws';
import type { StateBroadcast } from '../types';

export function connectOverlay(
  url: string,
  onState: (msg: StateBroadcast) => void,
  onError?: (err: Error) => void,
  onClose?: () => void,
): WebSocket {
  const ws = new WebSocket(url);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'state') onState(msg as StateBroadcast);
    } catch {
      // drop unparseable frames
    }
  });

  ws.on('error', (err) => {
    if (onError) onError(err);
    else process.stderr.write(`[overlay-client] error: ${err.message}\n`);
  });

  ws.on('close', () => {
    onClose?.();
  });

  return ws;
}
