// src/gap/history-buffer.ts

const LAPS_TO_KEEP = 2;
const HARD_CAP = 40_000;

export class HistoryBuffer {
  private timestamps: Float64Array;
  private distances: Float64Array;
  private start = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(
    private readonly trackLength: number,
    capacity = HARD_CAP,
  ) {
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.distances = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  private indexAt(i: number): number {
    return (this.start + i) % this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  append(timestamp: number, distance: number): void {
    // Keep strictly increasing in distance. A car that spins, reverses, or is
    // pushed backwards would otherwise leave the buffer unsorted — and binary
    // search on unsorted data does not throw, it silently returns wrong answers.
    while (
      this.count > 0 &&
      this.distances[this.indexAt(this.count - 1)] >= distance
    ) {
      this.count--;
    }

    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.count--;
    }

    const i = this.indexAt(this.count);
    this.timestamps[i] = timestamp;
    this.distances[i] = distance;
    this.count++;

    // Trim by DISTANCE, not time. A time window breaks under a safety car,
    // when a lap takes longer than the window.
    const cutoff = distance - LAPS_TO_KEEP * this.trackLength;
    while (this.count > 1 && this.distances[this.start] < cutoff) {
      this.start = (this.start + 1) % this.capacity;
      this.count--;
    }
  }

  /**
   * When was this car at `distance`?
   * Returns null if the buffer does not cover it — never an approximation.
   */
  timeAt(distance: number): number | null {
    if (this.count < 2) return null;

    const oldest = this.distances[this.indexAt(0)];
    const newest = this.distances[this.indexAt(this.count - 1)];

    if (distance > newest) return null; // hasn't reached there yet
    if (distance < oldest) return null; // fell off the back of the buffer

    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.distances[this.indexAt(mid)] <= distance) lo = mid;
      else hi = mid;
    }

    const dLo = this.distances[this.indexAt(lo)];
    const dHi = this.distances[this.indexAt(hi)];
    const tLo = this.timestamps[this.indexAt(lo)];
    const tHi = this.timestamps[this.indexAt(hi)];

    const span = dHi - dLo;
    if (span <= 1e-9) return tLo;

    return tLo + ((distance - dLo) / span) * (tHi - tLo);
  }

  /** Debug only. */
  isSorted(): boolean {
    for (let i = 1; i < this.count; i++) {
      if (
        this.distances[this.indexAt(i)] <= this.distances[this.indexAt(i - 1)]
      ) {
        return false;
      }
    }
    return true;
  }
}
