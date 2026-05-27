import WebSocket from 'ws';
import type { OverlayMessage } from './types';

const clients = new Set<WebSocket>();

export function addClient(ws: WebSocket): void {
  clients.add(ws);
}

export function removeClient(ws: WebSocket): void {
  clients.delete(ws);
}

export function clientCount(): number {
  return clients.size;
}

export function broadcast(message: OverlayMessage): void {
  if (clients.size === 0) return;
  const payload = JSON.stringify(message);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}
