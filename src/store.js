/**
 * dsh-network-proxy — plugin-owned settings file.
 *
 * A plain JSON document under the harness home rather than a kernel settings
 * seam, on purpose: the seam changed shape between kernel lines (the older one
 * exposed a registrable namespace, the current one projects plugin entry
 * config), and a file the plugin owns behaves identically on every line. The
 * plugin's settings row talks to the plugin's own API, so the file stays the
 * single source of truth for mode and URL.
 *
 * Writes land through a temp file + rename so a crash mid-write cannot leave a
 * truncated store behind.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export const DATA_DIR_NAME = 'network-proxy'

/** The plugin's persisted selection; `url` is only meaningful for `manual`. */
export const SETTINGS_INITIAL = { mode: 'system', url: '' }

export class SettingsStore {
  /**
   * @param {string} file - absolute path
   * @param {object} initial - value used when the file does not exist yet
   */
  constructor(file, initial = SETTINGS_INITIAL) {
    this.file = file
    this.value = { ...initial }
    this.disposed = false
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch {
      // Absent is the normal cold start. Keep a damaged file in place: without
      // this the next write would rename a fresh default over the user's last
      // selection with nothing on disk to recover from.
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch { /* a home we cannot write to is not this file's problem */ }
    }
  }

  get() {
    return this.value
  }

  /** Merge a patch in and persist it immediately. Returns the new value. */
  update(patch) {
    if (this.disposed) return this.value
    this.value = { ...this.value, ...patch }
    this.flush()
    return this.value
  }

  flush() {
    if (this.disposed) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch {
      // fail-soft: the next mutation retries; the in-memory value is authoritative
    }
  }

  dispose() {
    this.flush()
    this.disposed = true
  }
}
