import type { Request, Response } from "express";

export default function handler(_req: Request, res: Response) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GT7 Recorder</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #0f0f0f;
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 2.5rem 3rem;
      max-width: 440px;
      width: 100%;
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.375rem; }
    p.sub { font-size: 0.875rem; color: #888; margin-bottom: 1.75rem; }
    label { display: block; font-size: 0.8125rem; color: #aaa; margin-bottom: 0.375rem; }
    input[type="text"] {
      width: 100%;
      background: #111;
      border: 1px solid #333;
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
      font-size: 0.9375rem;
      color: #e0e0e0;
      outline: none;
      margin-bottom: 1rem;
    }
    input[type="text"]:focus { border-color: #555; }
    .row { display: flex; gap: 0.625rem; }
    button {
      background: #e8e8e8;
      color: #111;
      border: none;
      border-radius: 8px;
      padding: 0.7rem 1.25rem;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      flex: 1;
      transition: background 0.15s;
    }
    button.secondary {
      background: #2a2a2a;
      color: #e0e0e0;
      border: 1px solid #3a3a3a;
    }
    button:hover:not(:disabled) { filter: brightness(1.12); }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 1.5rem 0; }
    .status {
      margin-top: 1rem;
      font-size: 0.8125rem;
      min-height: 1.1rem;
      color: #888;
    }
    .status.ok  { color: #4ade80; }
    .status.err { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <h1>GT7 Track Recorder</h1>
    <p class="sub">Creates a single-driver session so the recorder client can connect.</p>

    <label for="trackId">Track ID</label>
    <input id="trackId" type="text" placeholder="e.g. tsukuba" autocomplete="off" spellcheck="false" />

    <button id="startBtn" onclick="startSession()">Start recording session</button>
    <div id="startStatus" class="status"></div>

    <hr class="divider" />

    <div class="row">
      <button class="secondary" onclick="updateTrack()">Update track</button>
    </div>
    <div id="trackStatus" class="status"></div>
  </div>

  <script>
    function trackIdValue() {
      return document.getElementById('trackId').value.trim();
    }

    function setStatus(id, type, msg) {
      const el = document.getElementById(id);
      el.className = 'status ' + type;
      el.textContent = msg;
    }

    async function startSession() {
      const trackId = trackIdValue();
      if (!trackId) { setStatus('startStatus', 'err', 'Enter a track ID first.'); return; }

      const btn = document.getElementById('startBtn');
      btn.disabled = true;
      setStatus('startStatus', '', 'Creating session…');

      try {
        const res = await fetch('/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trackId,
            isRecording: true,
            roster: [{ id: 1, name: 'Recorder', country: 'ID' }]
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setStatus('startStatus', 'ok', 'Session started — id: ' + data.session.id);
      } catch (err) {
        setStatus('startStatus', 'err', 'Error: ' + err.message);
        btn.disabled = false;
      }
    }

    async function updateTrack() {
      const trackId = trackIdValue();
      if (!trackId) { setStatus('trackStatus', 'err', 'Enter a track ID first.'); return; }

      setStatus('trackStatus', '', 'Updating track…');

      try {
        const res = await fetch('/session/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? res.statusText);
        setStatus('trackStatus', 'ok', 'Track updated to "' + data.trackId + '"');
      } catch (err) {
        setStatus('trackStatus', 'err', 'Error: ' + err.message);
      }
    }
  </script>
</body>
</html>`);
}
