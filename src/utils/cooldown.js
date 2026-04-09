export class CooldownManager {
  constructor(ms) {
    this.ms = ms
    this.map = new Map()
    this._cleanup = setInterval(() => {
      const now = Date.now()
      for (const [id, ts] of this.map) {
        if (now - ts > this.ms) this.map.delete(id)
      }
    }, 5 * 60_000).unref()
  }

  check(id) {
    const ts = this.map.get(id)
    if (!ts) return 0
    const remaining = this.ms - (Date.now() - ts)
    if (remaining <= 0) { this.map.delete(id); return 0 }
    return remaining
  }

  set(id) { this.map.set(id, Date.now()) }
}
