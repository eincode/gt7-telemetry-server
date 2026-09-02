---
name: add-overlay-module
description: Step-by-step procedure to add a new overlay visibility toggle module to gt7-telemetry-server
source: auto-skill
extracted_at: '2026-06-22T10:29:08.031Z'
---

# Add a new overlay visibility toggle module

Use this procedure when adding a new overlay type (e.g. `driverTelemetry`) to the server.

## Steps (in order)

### 1. Define the overlay interface — `src/types.ts`

Add the interface after the existing overlay interfaces, before `OverlayState`. Follow the pattern:

```ts
export interface NewOverlay {
  visible:  boolean;
  // add mode-specific fields below
  driverId: number | null;   // example
}
```

Then add the field to `OverlayState`:

```ts
export interface OverlayState {
  standings:      StandingsOverlay;
  sector:         SectorOverlay;
  carTelemetry:   CarTelemetryOverlay;
  driverShowcase: DriverShowcaseOverlay;
  newOverlay:     NewOverlay;   // add here
}
```

### 2. Wire into overlay-state.ts

**Import** the new interface at the top.

**Default state:** Add a default entry in `_state`:

```ts
let _state: OverlayState = {
  // ... existing entries ...
  newOverlay: { visible: false, driverId: null },
};
```

**Deep-copy in getter:** Add shallow copy in `getOverlayState()`. For simple scalar fields use spread; for arrays use slice:

```ts
export function getOverlayState(): OverlayState {
  return {
    // ... existing entries ...
    newOverlay: { ..._state.newOverlay },
  };
}
```

**Setter function:** Add a `set*()` function following the existing pattern (partial-patch merge, returns full state):

```ts
export function setNewOverlay(patch: Partial<NewOverlay>): OverlayState {
  _state.newOverlay = { ..._state.newOverlay, ...patch };
  return getOverlayState();
}
```

### 3. Add REST route — `src/server.ts`

Add a `POST /overlay/<route-name>` handler after the existing overlay routes. Validate fields according to their types (boolean for `visible`, number-or-null for `driverId`, array-of-numbers for `driverIds`). Return `{ ok: true, overlayState: <updated state> }` on success, `{ error: ... }` with 400 on validation failure.

### 4. Add startup console entry

Add a line to the server startup banner in the `httpServer.listen` callback:

```ts
console.log(`    POST /overlay/<route-name>  description  (+ driverId)`);
```

### 5. Verify

Run `npx tsc --noEmit` — the compilation will catch any missing imports, type mismatches, or missing fields in `OverlayState`.

## Validation rules (standard)

| Field type | Validation |
|---|---|
| `visible: boolean` | `typeof visible !== 'boolean'` when present |
| `driverId: number \| null` | `typeof driverId !== 'number'` when present and not `null` |
| `driverIds: number[]` | Must be array, length ≤ 2, every element is `typeof === 'number'` |
