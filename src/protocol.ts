import type {
  AcceleratorCandidate,
  Activity,
  JobEvent,
  LogTail,
  Overview,
  RefreshData,
  Rpc,
  SettingsPatch,
  Started
} from './types.ts'

export type {}

declare module 'orca' {
  interface PluginRequests {
    'omlx.refresh': { input: Record<string, never>; output: Rpc<RefreshData> }
    'omlx.logs': { input: Record<string, never>; output: Rpc<LogTail> }
    'omlx.load': { input: { modelId: string }; output: Rpc<Started> }
    'omlx.unload': { input: { modelId: string }; output: Rpc<Started> }
    'omlx.pin': { input: { modelId: string; pinned: boolean }; output: Rpc<{ message: string }> }
    'omlx.default': { input: { modelId: string; isDefault: boolean }; output: Rpc<{ message: string }> }
    'omlx.acceleratorCandidates': { input: { modelId: string }; output: Rpc<AcceleratorCandidate[]> }
    'omlx.accelerator': {
      input: { modelId: string; nodeId: string | null; layers: number | null }
      output: Rpc<{ message: string }>
    }
    'omlx.rescan': { input: Record<string, never>; output: Rpc<Started> }
    'omlx.abort': { input: { modelId: string; requestId: string }; output: Rpc<{ message: string }> }
    'omlx.saveSettings': { input: { patch: SettingsPatch }; output: Rpc<Started> }
    'omlx.rotateKey': { input: { apiKey: string }; output: Rpc<Started> }
    'omlx.restart': { input: Record<string, never>; output: Rpc<Started> }
    'omlx.jobs': { input: Record<string, never>; output: Rpc<JobEvent[]> }
  }

  interface PluginPanelEvents {
    'omlx.job': JobEvent
    'omlx.activity': Activity
    'omlx.status': Pick<Overview, 'status' | 'message' | 'loadedCount'>
  }
}
