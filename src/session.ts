import { v4 as uuidv4 } from 'uuid';
import type { Session, RosterEntry } from './types';

let currentSession: Session | null = null;

export function createSession(roster: RosterEntry[]): Session {
  currentSession = {
    id: uuidv4(),
    roster,
    status: 'waiting',
    createdAt: Date.now(),
  };
  return currentSession;
}

export function getSession(): Session | null {
  return currentSession;
}

export function endSession(): void {
  currentSession = null;
}

export function setStatus(status: Session['status']): void {
  if (currentSession) currentSession.status = status;
}
