export type OmlxErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'conflict'
  | 'insufficient_memory'
  | 'unreachable'
  | 'invalid_url'
  | 'invalid_params'
  | 'timeout'
  | 'server'
  | 'bad_response'

export type ConnectionStatus = 'ok' | 'unauthorized' | 'unreachable' | 'invalid_url' | 'error'

export type JobKind = 'load' | 'unload' | 'rescan' | 'settings' | 'rotate-key' | 'restart'

export interface RpcSuccess<T> {
  ok: true
  data: T
}

export interface RpcFailure {
  ok: false
  code: string
  message: string
}

export type Rpc<T> = RpcSuccess<T> | RpcFailure

export interface AcceleratorStatus {
  state: string
  name: string | null
  nodeId: string | null
  layers: number | null
  held: number | null
  reason: string | null
  link: string | null
}

export interface AcceleratorCandidate {
  nodeId: string
  name: string
  online: boolean
  layersFit: number | null
  reason: string | null
  link: string | null
  versionOk: boolean | null
}

export interface ModelSummary {
  id: string
  displayName: string
  loaded: boolean
  loading: boolean
  pinned: boolean
  isDefault: boolean
  hidden: boolean
  helper: boolean
  virtual: boolean
  engineType: string
  modelType: string
  sizeLabel: string
  sizeBytes: number
  acceleratorSupported: boolean
  accelerator: AcceleratorStatus | null
  acceleratorNodeId: string | null
  acceleratorLayers: number | null
}

export interface ActivityRequest {
  id: string
  phase: 'waiting' | 'prefilling' | 'generating' | 'other'
  detail: string
  progress: number | null
  tokensPerSecond: number | null
}

export interface ActivityModel {
  id: string
  sizeLabel: string
  sizeBytes: number
  pinned: boolean
  loading: boolean
  activeRequests: number
  waitingRequests: number
  idleSeconds: number | null
  canAbort: boolean
  requests: ActivityRequest[]
}

export interface Activity {
  models: ActivityModel[]
  memoryUsedLabel: string
  memoryMaxLabel: string
  memoryUsedBytes: number
  memoryMaxBytes: number
}

export interface ServerInfo {
  host: string
  port: number
  aliases: string[]
}

export interface DeviceInfo {
  chipName: string
  chipVariant: string
  memoryGb: number
  gpuCores: number
}

export interface BaseSettings {
  host: string
  port: number
  logLevel: string
  modelDirs: string[]
  modelFallback: boolean
  maxConcurrentRequests: number
  chunkedPrefill: boolean
  prefillPriority: string
  concurrentPriority: string
  memoryGuardTier: string
  memoryGuardCustomCeilingGb: number | null
  cacheEnabled: boolean
  hotCacheMaxSize: string
  ssdCacheMaxSize: string
  temperature: number
  topP: number
  topK: number
  maxTokens: number
  maxContextWindow: number
  idleTimeoutSeconds: number | null
  apiKeySet: boolean
}

export interface SettingsDraft {
  host: string
  port: string
  logLevel: string
  modelDirs: string
  modelFallback: boolean
  maxConcurrentRequests: string
  chunkedPrefill: boolean
  prefillPriority: string
  concurrentPriority: string
  memoryGuardTier: string
  memoryGuardCustomCeilingGb: string
  cacheEnabled: boolean
  hotCacheMaxSize: string
  ssdCacheMaxSize: string
  temperature: string
  topP: string
  topK: string
  maxTokens: string
  maxContextWindow: string
  idleTimeoutSeconds: string
}

export interface SettingsPatch {
  host?: string
  port?: number
  logLevel?: string
  modelDirs?: string[]
  modelFallback?: boolean
  maxConcurrentRequests?: number
  chunkedPrefill?: boolean
  prefillPriority?: string
  concurrentPriority?: string
  memoryGuardTier?: string
  memoryGuardCustomCeilingGb?: number | null
  cacheEnabled?: boolean
  hotCacheMaxSize?: string
  ssdCacheMaxSize?: string
  temperature?: number
  topP?: number
  topK?: number
  maxTokens?: number
  maxContextWindow?: number
  idleTimeoutSeconds?: number | null
}

export interface SettingsUpdate {
  message: string
  runtimeApplied: string[]
}

export interface LogTail {
  text: string
  file: string
  totalLines: number
}

export interface Overview {
  baseUrl: string
  keySaved: boolean
  secretsAvailable: boolean
  pollSeconds: number
  status: ConnectionStatus
  message: string
  server: ServerInfo | null
  device: DeviceInfo | null
  loadedCount: number
}

export interface JobEvent {
  id: string
  kind: JobKind
  state: 'running' | 'done' | 'error'
  modelId?: string
  message: string
  clearSecretDraft?: boolean
}

export interface RefreshData {
  overview: Overview
  models: ModelSummary[]
  activity: Activity
  settings: BaseSettings | null
  settingsError: string | null
  jobs: JobEvent[]
}

export interface Started {
  jobId: string
}
