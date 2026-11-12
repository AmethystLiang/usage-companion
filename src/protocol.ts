// The panel ↔ worker contract, declared once: src/panel.tsx and worker/main.mjs both follow it.
import type { LimitsSnapshot } from './limits'

export {}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** Current Claude usage windows, read from Orca's account file. */
    'limits.read': { input: Record<string, never>; output: LimitsSnapshot }
  }
}
