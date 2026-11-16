import type {
  Activity,
  ActivityModel,
  ActivityRequest,
  BaseSettings,
  DeviceInfo,
  LogTail,
  ModelSummary,
  OmlxErrorCode,
  ServerInfo,
  SettingsDraft,
  SettingsPatch,
  SettingsUpdate
} from './types.ts'

export class OmlxError extends Error {
  readonly code: OmlxErrorCode
  readonly status?: number

  constructor(code: OmlxErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'OmlxError'
    this.code = code
    this.status = status
  }
}

export interface Connection {
  baseUrl: string
  apiKey: string | null
}

export interface OmlxClient {
  models(): Promise<ModelSummary[]>
  load(modelId: string, timeoutMs?: number): Promise<{ status: string; message: string }>
  unload(modelId: string, timeoutMs?: number): Promise<{ status: string; message: string }>
  setModelFlags(
    modelId: string,
    flags: { is_pinned?: boolean; is_default?: boolean }
  ): Promise<{ message: string }>
  rescan(timeoutMs?: number): Promise<{ message: string }>
  abort(modelId: string, requestId: string): Promise<{ message: string }>
  activity(): Promise<Activity>
  serverInfo(): Promise<ServerInfo>
  deviceInfo(): Promise<DeviceInfo>
  settings(): Promise<BaseSettings>
  updateSettings(patch: SettingsPatch, timeoutMs?: number): Promise<SettingsUpdate>
  rotateApiKey(apiKey: string): Promise<{ message: string }>
  restart(): Promise<{ status: string; message: string }>
  logs(): Promise<LogTail>
}

export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new OmlxError('invalid_url', 'Enter an http or https URL for the oMLX server.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OmlxError('invalid_url', 'The oMLX URL must start with http:// or https://.')
  }
  if (url.username || url.password) {
    throw new OmlxError('invalid_url', 'Put the API key in the key field, not in the URL.')
  }
  if (url.search || url.hash) {
    throw new OmlxError('invalid_url', 'The oMLX URL cannot include a query or hash.')
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path === '/' ? '' : path}`
}

export function assertApiKey(apiKey: string): string {
  if (apiKey.length < 4) {
    throw new OmlxError('invalid_params', 'API key must be at least 4 characters.')
  }
  if (/\s/.test(apiKey)) {
    throw new OmlxError('invalid_params', 'API key must not contain whitespace.')
  }
  if (![...apiKey].every((char) => char >= ' ' && char <= '~')) {
    throw new OmlxError('invalid_params', 'API key must be printable ASCII.')
  }
  return apiKey
}

export function draftFromSettings(settings: BaseSettings): SettingsDraft {
  return {
    host: settings.host,
    port: String(settings.port),
    logLevel: settings.logLevel,
    modelDirs: settings.modelDirs.join('\n'),
    modelFallback: settings.modelFallback,
    maxConcurrentRequests: String(settings.maxConcurrentRequests),
    chunkedPrefill: settings.chunkedPrefill,
    prefillPriority: settings.prefillPriority,
    concurrentPriority: settings.concurrentPriority,
    memoryGuardTier: settings.memoryGuardTier,
    memoryGuardCustomCeilingGb:
      settings.memoryGuardCustomCeilingGb == null ? '' : String(settings.memoryGuardCustomCeilingGb),
    cacheEnabled: settings.cacheEnabled,
    hotCacheMaxSize: settings.hotCacheMaxSize,
    ssdCacheMaxSize: settings.ssdCacheMaxSize,
    temperature: String(settings.temperature),
    topP: String(settings.topP),
    topK: String(settings.topK),
    maxTokens: String(settings.maxTokens),
    maxContextWindow: String(settings.maxContextWindow),
    idleTimeoutSeconds: settings.idleTimeoutSeconds == null ? '' : String(settings.idleTimeoutSeconds)
  }
}

export function draftToPatch(draft: SettingsDraft): SettingsPatch {
  const host = draft.host.trim()
  if (!host || host.includes('://') || /\s/.test(host)) {
    throw new OmlxError('invalid_params', 'Host must be a hostname or IP address.')
  }
  const modelDirs = draft.modelDirs
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (modelDirs.length === 0) {
    throw new OmlxError('invalid_params', 'Add at least one model directory.')
  }
  const tier = oneOf(draft.memoryGuardTier, ['safe', 'balanced', 'aggressive', 'custom'], 'Memory guard')
  return {
    host,
    port: integerField(draft.port, 1, 65535, 'Port'),
    logLevel: oneOf(draft.logLevel, ['trace', 'debug', 'info', 'warning', 'error'], 'Log level'),
    modelDirs,
    modelFallback: draft.modelFallback,
    maxConcurrentRequests: integerField(draft.maxConcurrentRequests, 1, 1024, 'Max concurrent requests'),
    chunkedPrefill: draft.chunkedPrefill,
    prefillPriority: oneOf(draft.prefillPriority, ['context', 'speed'], 'Prefill priority'),
    concurrentPriority: oneOf(draft.concurrentPriority, ['prefill', 'balanced', 'decode'], 'Concurrency priority'),
    memoryGuardTier: tier,
    memoryGuardCustomCeilingGb:
      tier === 'custom' ? numberField(draft.memoryGuardCustomCeilingGb, 0.1, 2048, 'Custom memory ceiling') : null,
    cacheEnabled: draft.cacheEnabled,
    hotCacheMaxSize: sizeField(draft.hotCacheMaxSize, 'Hot cache size', false),
    ssdCacheMaxSize: sizeField(draft.ssdCacheMaxSize, 'SSD cache size', true),
    temperature: numberField(draft.temperature, 0, 5, 'Temperature'),
    topP: numberField(draft.topP, 0, 1, 'Top-p'),
    topK: integerField(draft.topK, 0, 100000, 'Top-k'),
    maxTokens: integerField(draft.maxTokens, 1, 10000000, 'Max tokens'),
    maxContextWindow: integerField(draft.maxContextWindow, 1, 10000000, 'Context window'),
    idleTimeoutSeconds: idleField(draft.idleTimeoutSeconds)
  }
}

export function settingsPatchToBody(patch: SettingsPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (patch.host !== undefined) {
    const host = patch.host.trim()
    if (!host || host.includes('://') || /\s/.test(host)) {
      throw new OmlxError('invalid_params', 'Host must be a hostname or IP address.')
    }
    body.host = host
  }
  if (patch.port !== undefined) body.port = integerValue(patch.port, 1, 65535, 'Port')
  if (patch.logLevel !== undefined) {
    body.log_level = oneOf(patch.logLevel, ['trace', 'debug', 'info', 'warning', 'error'], 'Log level')
  }
  if (patch.modelDirs !== undefined) {
    const dirs = patch.modelDirs.map((dir) => dir.trim()).filter((dir) => dir.length > 0)
    if (dirs.length === 0) throw new OmlxError('invalid_params', 'Add at least one model directory.')
    body.model_dirs = dirs
  }
  if (patch.modelFallback !== undefined) body.model_fallback = patch.modelFallback
  if (patch.maxConcurrentRequests !== undefined) {
    body.max_concurrent_requests = integerValue(patch.maxConcurrentRequests, 1, 1024, 'Max concurrent requests')
  }
  if (patch.chunkedPrefill !== undefined) body.chunked_prefill = patch.chunkedPrefill
  if (patch.prefillPriority !== undefined) {
    body.prefill_priority = oneOf(patch.prefillPriority, ['context', 'speed'], 'Prefill priority')
  }
  if (patch.concurrentPriority !== undefined) {
    body.concurrent_priority = oneOf(
      patch.concurrentPriority,
      ['prefill', 'balanced', 'decode'],
      'Concurrency priority'
    )
  }
  if (patch.memoryGuardTier !== undefined) {
    body.memory_guard_tier = oneOf(
      patch.memoryGuardTier,
      ['safe', 'balanced', 'aggressive', 'custom'],
      'Memory guard'
    )
  }
  if (patch.memoryGuardTier === 'custom') {
    if (patch.memoryGuardCustomCeilingGb == null || patch.memoryGuardCustomCeilingGb <= 0) {
      throw new OmlxError('invalid_params', 'Custom memory ceiling must be greater than 0.')
    }
    body.memory_guard_custom_ceiling_gb = patch.memoryGuardCustomCeilingGb
  }
  if (patch.cacheEnabled !== undefined) body.cache_enabled = patch.cacheEnabled
  if (patch.hotCacheMaxSize !== undefined) {
    body.hot_cache_max_size = sizeField(patch.hotCacheMaxSize, 'Hot cache size', false)
  }
  if (patch.ssdCacheMaxSize !== undefined) {
    body.ssd_cache_max_size = sizeField(patch.ssdCacheMaxSize, 'SSD cache size', true)
  }
  if (patch.temperature !== undefined) body.sampling_temperature = numberValue(patch.temperature, 0, 5, 'Temperature')
  if (patch.topP !== undefined) body.sampling_top_p = numberValue(patch.topP, 0, 1, 'Top-p')
  if (patch.topK !== undefined) body.sampling_top_k = integerValue(patch.topK, 0, 100000, 'Top-k')
  if (patch.maxTokens !== undefined) body.sampling_max_tokens = integerValue(patch.maxTokens, 1, 10000000, 'Max tokens')
  if (patch.maxContextWindow !== undefined) {
    body.sampling_max_context_window = integerValue(patch.maxContextWindow, 1, 10000000, 'Context window')
  }
  if (patch.idleTimeoutSeconds === null) body.idle_timeout_seconds = null
  else if (patch.idleTimeoutSeconds !== undefined) {
    body.idle_timeout_seconds = integerValue(patch.idleTimeoutSeconds, 60, 8640000, 'Idle timeout')
  }
  if (Object.keys(body).length === 0) {
    throw new OmlxError('invalid_params', 'There are no setting changes to save.')
  }
  return body
}

export function modelsFromResponse(body: unknown): ModelSummary[] {
  const list = arrayField(body, 'models', 'model list')
  const models: ModelSummary[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    if (!record || typeof record.id !== 'string' || record.id.length === 0) continue
    models.push({
      id: record.id,
      displayName: typeof record.display_name === 'string' && record.display_name ? record.display_name : record.id,
      loaded: record.loaded === true,
      loading: record.is_loading === true,
      pinned: record.pinned === true,
      isDefault: record.is_default === true,
      hidden: record.is_hidden === true,
      helper: record.is_helper === true,
      virtual: record.virtual === true,
      engineType: typeof record.engine_type === 'string' ? record.engine_type : 'batched',
      modelType: typeof record.model_type === 'string' ? record.model_type : 'llm',
      sizeLabel: typeof record.estimated_size_formatted === 'string' ? record.estimated_size_formatted : '—'
    })
  }
  return models
}

export function activityFromResponse(body: unknown): Activity {
  const root = asRecord(body)
  const active = root ? asRecord(root.active_models) : null
  if (!active) throw new OmlxError('bad_response', 'oMLX returned an unexpected activity payload.')
  const list = Array.isArray(active.models) ? active.models : null
  if (!list) throw new OmlxError('bad_response', 'oMLX returned an unexpected activity payload.')
  const pressure = asRecord(active.memory_pressure)
  const used = typeof active.model_memory_used === 'number' ? active.model_memory_used : 0
  const max = typeof active.model_memory_max === 'number' ? active.model_memory_max : 0
  return {
    models: list.flatMap((entry) => {
      const model = activityModel(entry)
      return model ? [model] : []
    }),
    memoryUsedLabel:
      pressure && typeof pressure.current_formatted === 'string' ? pressure.current_formatted : formatBytes(used),
    memoryMaxLabel: pressure && typeof pressure.hard_formatted === 'string' ? pressure.hard_formatted : formatBytes(max)
  }
}

export function baseSettingsFromResponse(body: unknown): BaseSettings {
  const root = asRecord(body)
  if (!root) throw new OmlxError('bad_response', 'oMLX returned an unexpected settings payload.')
  const server = asRecord(root.server) ?? {}
  const model = asRecord(root.model) ?? {}
  const scheduler = asRecord(root.scheduler) ?? {}
  const memory = asRecord(root.memory) ?? {}
  const cache = asRecord(root.cache) ?? {}
  const sampling = asRecord(root.sampling) ?? {}
  const auth = asRecord(root.auth) ?? {}
  const idle = asRecord(root.idle_timeout) ?? {}
  const dirs = Array.isArray(model.model_dirs)
    ? model.model_dirs.filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
    : []
  const idleSeconds = idle.idle_timeout_seconds
  const ceiling = memory.memory_guard_custom_ceiling_gb
  return {
    host: typeof server.host === 'string' ? server.host : '127.0.0.1',
    port: typeof server.port === 'number' ? server.port : 8000,
    logLevel: typeof server.log_level === 'string' ? server.log_level : 'info',
    modelDirs: dirs,
    modelFallback: model.model_fallback === true,
    maxConcurrentRequests: typeof scheduler.max_concurrent_requests === 'number' ? scheduler.max_concurrent_requests : 8,
    chunkedPrefill: scheduler.chunked_prefill === true,
    prefillPriority: typeof scheduler.prefill_priority === 'string' ? scheduler.prefill_priority : 'context',
    concurrentPriority: typeof scheduler.concurrent_priority === 'string' ? scheduler.concurrent_priority : 'balanced',
    memoryGuardTier: typeof memory.memory_guard_tier === 'string' ? memory.memory_guard_tier : 'balanced',
    memoryGuardCustomCeilingGb: typeof ceiling === 'number' && ceiling > 0 ? ceiling : null,
    cacheEnabled: cache.enabled !== false,
    hotCacheMaxSize: typeof cache.hot_cache_max_size === 'string' ? cache.hot_cache_max_size : '0',
    ssdCacheMaxSize: typeof cache.ssd_cache_max_size === 'string' ? cache.ssd_cache_max_size : 'auto',
    temperature: typeof sampling.temperature === 'number' ? sampling.temperature : 0.7,
    topP: typeof sampling.top_p === 'number' ? sampling.top_p : 0.9,
    topK: typeof sampling.top_k === 'number' ? sampling.top_k : 0,
    maxTokens: typeof sampling.max_tokens === 'number' ? sampling.max_tokens : 4096,
    maxContextWindow: typeof sampling.max_context_window === 'number' ? sampling.max_context_window : 32768,
    idleTimeoutSeconds: typeof idleSeconds === 'number' && idleSeconds >= 60 ? idleSeconds : null,
    apiKeySet: auth.api_key_set === true || (typeof auth.api_key === 'string' && auth.api_key.length > 0)
  }
}

export function serverInfoFromResponse(body: unknown): ServerInfo {
  const root = asRecord(body)
  if (!root || typeof root.host !== 'string' || typeof root.port !== 'number') {
    throw new OmlxError('bad_response', 'oMLX returned an unexpected server info payload.')
  }
  return {
    host: root.host,
    port: root.port,
    aliases: Array.isArray(root.aliases) ? root.aliases.filter((alias): alias is string => typeof alias === 'string') : []
  }
}

export function deviceInfoFromResponse(body: unknown): DeviceInfo {
  const root = asRecord(body)
  if (!root) throw new OmlxError('bad_response', 'oMLX returned an unexpected device payload.')
  return {
    chipName: typeof root.chip_name === 'string' ? root.chip_name : 'Unknown chip',
    chipVariant: typeof root.chip_variant === 'string' ? root.chip_variant : '',
    memoryGb: typeof root.memory_gb === 'number' ? root.memory_gb : 0,
    gpuCores: typeof root.gpu_cores === 'number' ? root.gpu_cores : 0
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1
  return `${value.toFixed(digits)} ${units[unit]}`
}

export function createClient(connection: Connection, timeoutMs = 10_000): OmlxClient {
  const baseUrl = normalizeBaseUrl(connection.baseUrl)
  const apiKey = connection.apiKey

  async function send(method: string, path: string, body?: unknown, timeout = timeoutMs): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let response: Response
    try {
      response = await fetch(baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal
      })
    } catch {
      if (controller.signal.aborted) {
        throw new OmlxError('timeout', 'The oMLX server took too long to answer.')
      }
      throw new OmlxError('unreachable', 'Could not reach the oMLX server.')
    } finally {
      clearTimeout(timer)
    }
    if (response.status >= 300 && response.status < 400) {
      throw new OmlxError('server', 'oMLX redirected the request. Redirects are not followed.', response.status)
    }
    if (response.type === 'opaqueredirect') {
      throw new OmlxError('server', 'oMLX redirected the request. Redirects are not followed.')
    }
    const text = await response.text()
    if (text.length > 2_000_000) {
      throw new OmlxError('bad_response', 'oMLX returned a response that is too large.')
    }
    let parsed: unknown = {}
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        throw new OmlxError('bad_response', 'oMLX returned a response that is not JSON.', response.status)
      }
    }
    if (response.ok || response.status === 202) return parsed
    const detail = detailOf(parsed) || `oMLX returned HTTP ${response.status}.`
    throw new OmlxError(codeForStatus(response.status), detail, response.status)
  }

  return {
    async models() {
      return modelsFromResponse(await send('GET', '/admin/api/models'))
    },
    async load(modelId, timeout = 600_000) {
      const parsed = asRecord(await send('POST', modelPath(modelId, 'load'), undefined, timeout))
      return actionMessage(parsed, `Loaded ${modelId}`)
    },
    async unload(modelId, timeout = 120_000) {
      const parsed = asRecord(await send('POST', modelPath(modelId, 'unload'), undefined, timeout))
      return actionMessage(parsed, `Unloaded ${modelId}`)
    },
    async setModelFlags(modelId, flags) {
      const parsed = asRecord(await send('PUT', modelPath(modelId, 'settings'), flags))
      return { message: typeof parsed?.message === 'string' ? parsed.message : 'Updated model settings.' }
    },
    async rescan(timeout = 120_000) {
      const parsed = asRecord(await send('POST', '/admin/api/reload', undefined, timeout))
      return { message: typeof parsed?.message === 'string' ? parsed.message : 'Rescanned model directories.' }
    },
    async abort(modelId, requestId) {
      await send('POST', `${modelPath(modelId, 'requests')}/${encodeURIComponent(requestId)}/abort`)
      return { message: `Stopped request ${requestId}.` }
    },
    async activity() {
      return activityFromResponse(await send('GET', '/admin/api/activity'))
    },
    async serverInfo() {
      return serverInfoFromResponse(await send('GET', '/admin/api/server-info'))
    },
    async deviceInfo() {
      return deviceInfoFromResponse(await send('GET', '/admin/api/device-info'))
    },
    async settings() {
      return baseSettingsFromResponse(await send('GET', '/admin/api/global-settings'))
    },
    async updateSettings(patch, timeout = 30_000) {
      const parsed = asRecord(await send('POST', '/admin/api/global-settings', settingsPatchToBody(patch), timeout))
      const applied = parsed && Array.isArray(parsed.runtime_applied) ? parsed.runtime_applied.filter(isString) : []
      return {
        message: typeof parsed?.message === 'string' ? parsed.message : 'Saved settings.',
        runtimeApplied: applied
      }
    },
    async rotateApiKey(apiKey) {
      const key = assertApiKey(apiKey)
      await send('POST', '/admin/api/global-settings', { api_key: key })
      return { message: 'Replaced the server API key.' }
    },
    async restart() {
      const parsed = asRecord(await send('POST', '/admin/api/server/restart'))
      return {
        status: typeof parsed?.status === 'string' ? parsed.status : 'restarting',
        message:
          'Restart requested. This works when oMLX is supervised by the macOS app or brew services. Expect a short outage.'
      }
    },
    async logs() {
      const parsed = asRecord(await send('GET', '/admin/api/logs?lines=80'))
      const raw = typeof parsed?.logs === 'string' ? parsed.logs : ''
      const tail = raw.split(/\r?\n/).slice(-80).join('\n').slice(-24_000)
      return {
        text: tail,
        file: typeof parsed?.log_file === 'string' ? parsed.log_file : 'server.log',
        totalLines: typeof parsed?.total_lines === 'number' ? parsed.total_lines : tail.split('\n').length
      }
    }
  }
}

function modelPath(modelId: string, action: string): string {
  if (!modelId || modelId.includes('/') || modelId.includes('\\') || modelId.includes('..')) {
    throw new OmlxError('invalid_params', 'That model id cannot be used in a request path.')
  }
  return `/admin/api/models/${encodeURIComponent(modelId)}/${action}`
}

function actionMessage(parsed: Record<string, unknown> | null, fallback: string): { status: string; message: string } {
  return {
    status: typeof parsed?.status === 'string' ? parsed.status : 'ok',
    message: typeof parsed?.message === 'string' ? parsed.message : fallback
  }
}

function codeForStatus(status: number): OmlxErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 507) return 'insufficient_memory'
  if (status === 400) return 'invalid_params'
  if (status === 408) return 'timeout'
  return 'server'
}

function detailOf(body: unknown): string {
  const record = asRecord(body)
  if (!record) return ''
  const detail = record.detail
  if (typeof detail === 'string') return clip(detail)
  if (Array.isArray(detail)) {
    const parts = detail.map((entry) => {
      const item = asRecord(entry)
      if (item && typeof item.msg === 'string') return item.msg
      return typeof entry === 'string' ? entry : ''
    })
    return clip(parts.filter((part) => part.length > 0).join('; '))
  }
  return ''
}

function clip(value: string): string {
  return value.length > 300 ? `${value.slice(0, 299)}…` : value
}

function activityModel(value: unknown): ActivityModel | null {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || record.id.length === 0) return null
  const requests: ActivityRequest[] = []
  pushRows(requests, record.waiting, 'waiting', 'Queued')
  pushRows(requests, record.prefilling, 'prefilling', 'Prefill')
  pushRows(requests, record.generating, 'generating', 'Generating')
  pushRows(requests, record.activities, 'other', 'Active')
  const size =
    typeof record.actual_size_formatted === 'string' && record.actual_size_formatted
      ? record.actual_size_formatted
      : typeof record.estimated_size_formatted === 'string'
        ? record.estimated_size_formatted
        : '—'
  return {
    id: record.id,
    sizeLabel: size,
    pinned: record.pinned === true,
    loading: record.is_loading === true,
    activeRequests: typeof record.active_requests === 'number' ? record.active_requests : 0,
    waitingRequests: typeof record.waiting_requests === 'number' ? record.waiting_requests : 0,
    idleSeconds: typeof record.idle_seconds === 'number' ? record.idle_seconds : null,
    canAbort: record.request_abort === true,
    requests
  }
}

function pushRows(
  target: ActivityRequest[],
  value: unknown,
  phase: ActivityRequest['phase'],
  fallback: string
): void {
  if (!Array.isArray(value)) return
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const id = record.request_id ?? record.id
    if (typeof id !== 'string' && typeof id !== 'number') continue
    target.push({ id: String(id), phase, detail: requestDetail(record, phase, fallback) })
  }
}

function requestDetail(record: Record<string, unknown>, phase: ActivityRequest['phase'], fallback: string): string {
  if (phase === 'waiting' && typeof record.queue_position === 'number') return `Queued #${record.queue_position}`
  if (phase === 'prefilling' && typeof record.processed === 'number' && typeof record.total === 'number') {
    return `Prefill ${record.processed}/${record.total}`
  }
  if (phase === 'generating' && typeof record.tokens_per_second === 'number') {
    const speed = record.tokens_per_second.toFixed(1)
    const tokens = typeof record.generated_tokens === 'number' ? `${record.generated_tokens} tokens · ` : ''
    return `${tokens}${speed} tok/s`
  }
  for (const key of ['detail', 'label', 'phase', 'status']) {
    if (typeof record[key] === 'string' && record[key]) return record[key]
  }
  return fallback
}

function arrayField(body: unknown, key: string, label: string): unknown[] {
  const record = asRecord(body)
  if (!record || !Array.isArray(record[key])) {
    throw new OmlxError('bad_response', `oMLX returned an unexpected ${label}.`)
  }
  return record[key]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function integerField(value: string, min: number, max: number, label: string): number {
  if (!/^-?\d+$/.test(value.trim())) throw new OmlxError('invalid_params', `${label} must be a whole number.`)
  return integerValue(Number(value), min, max, label)
}

function integerValue(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new OmlxError('invalid_params', `${label} must be from ${min} to ${max}.`)
  }
  return value
}

function numberField(value: string, min: number, max: number, label: string): number {
  const parsed = Number(value.trim())
  return numberValue(parsed, min, max, label)
}

function numberValue(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new OmlxError('invalid_params', `${label} must be from ${min} to ${max}.`)
  }
  return value
}

function oneOf(value: string, allowed: string[], label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!allowed.includes(normalized)) {
    throw new OmlxError('invalid_params', `${label} must be one of ${allowed.join(', ')}.`)
  }
  return normalized
}

function sizeField(value: string, label: string, allowAuto: boolean): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 32 || /\s/.test(trimmed)) {
    throw new OmlxError('invalid_params', `${label} must look like 8GB, 512MB, or 0.`)
  }
  if (trimmed.toLowerCase() === 'auto') {
    if (!allowAuto) throw new OmlxError('invalid_params', `${label} cannot be auto. Use 0 to disable it.`)
    return 'auto'
  }
  return trimmed
}

function idleField(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '0') return null
  return integerField(trimmed, 60, 8640000, 'Idle timeout')
}

