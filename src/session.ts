import { v4 as uuidv4 } from "uuid";
import type { RosterEntry, Session, SessionMode } from "./types";

let currentSession: Session | null = null;

export function createSession(
  roster: RosterEntry[],
  mode: SessionMode = "practice",
  trackId = "",
  isRecording = false,
): Session {
  currentSession = {
    id: uuidv4(),
    roster,
    status: "waiting",
    mode,
    trackId,
    isRecording,
    createdAt: Date.now(),
  };
  return currentSession;
}

export function addDriver(newDriver: RosterEntry) {
  if (currentSession) currentSession.roster.push(newDriver);
}

export function removeDriver(driverId: number) {
  if (currentSession)
    currentSession.roster = currentSession.roster.filter(
      (driver) => driver.id !== driverId,
    );
}

export function getSession(): Session | null {
  return currentSession;
}

export function endSession(): void {
  currentSession = null;
}

export function setStatus(status: Session["status"]): void {
  if (currentSession) currentSession.status = status;
}

export function setMode(mode: SessionMode): void {
  if (currentSession) currentSession.mode = mode;
}

export function setTrackId(trackId: string): void {
  if (currentSession) currentSession.trackId = trackId;
}
