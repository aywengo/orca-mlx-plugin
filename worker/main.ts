import type { OrcaWorkerApi } from 'orca/worker'
import { createClient, normalizeBaseUrl, OmlxError, type OmlxClient } from '../src/client.ts'
import type {
  Activity,
  ConnectionStatus,
  JobEvent,
  JobKind,
  Overview,
  RefreshData,
  Rpc,
  Started
} from '../src/types.ts'

const SECRET_KEY = 'apiKey'

interface Link {
  baseUrl: string
  apiKey: string | null
  pollSeconds: number
  secretsAvailable: boolean
  keySaved: boolean
  urlError: string | null
}

let stopped = false
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
let tail: Promise<void> = Promise.resolve()
let seq = 0
let lastPoll = 5
let latest: RefreshData | null = null
const jobs = new Map<string, JobEvent>()
const inflight = new Map<string, string>()

export default function activate(orca: OrcaWorkerApi): void {
  stopped = false
  orca.panels.handle('omlx.refresh', () => rpc(() => refresh(orca)))
  orca.panels.handle('omlx.logs', () => rpc(async () => (await clientOrThrow(orca)).logs()))
  orca.panels.handle('omlx.jobs', () => ({ ok: true, data: currentJobs() }))
  orca.panels.handle('omlx.load', ({ modelId }) =>
    startJob(orca, 'load', requireId(modelId), async (client) => (await client.load(modelId)).message)
  )
  orca.panels.handle('omlx.unload', ({ modelId }) =>
    startJob(orca, 'unload', requireId(modelId), async (client) => (await client.unload(modelId)).message)
  )
  orca.panels.handle('omlx.rescan', () =>
    startJob(orca, 'rescan', undefined, async (client) => (await client.rescan()).message)
  )
  orca.panels.handle('omlx.restart', () =>
    startJob(orca, 'restart', undefined, async (client) => (await client.restart()).message)
  )
  orca.panels.handle('omlx.saveSettings', ({ patch }) =>
    startJob(orca, 'settings', undefined, async (client) => {
      const update = await client.updateSettings(patch)
      const applied = update.runtimeApplied.length > 0 ? ` Applied now: ${update.runtimeApplied.join(', ')}.` : ''
      return `${update.message}${applied} Host and port apply after a restart.`
    })
  )
  orca.panels.handle('omlx.rotateKey', ({ apiKey }) => startRotate(orca, apiKey))
  orca.panels.handle('omlx.pin', ({ modelId, pinned }) =>
    rpc(async () => {
      const client = await clientOrThrow(orca)
      const result = await client.setModelFlags(requireId(modelId), { is_pinned: pinned })
      void enqueue(() => tick(orca))
      return result
    })
  )
  orca.panels.handle('omlx.default', ({ modelId, isDefault }) =>
    rpc(async () => {
      const client = await clientOrThrow(orca)
      const result = await client.setModelFlags(requireId(modelId), { is_default: isDefault })
      void enqueue(() => tick(orca))
      return result
    })
  )
  orca.panels.handle('omlx.acceleratorCandidates', ({ modelId }) =>
    rpc(async () => (await clientOrThrow(orca)).acceleratorCandidates(requireId(modelId)))
  )
  orca.panels.handle('omlx.accelerator', ({ modelId, nodeId, layers }) =>
    rpc(async () => {
      const client = await clientOrThrow(orca)
      const id = typeof nodeId === 'string' && nodeId.trim() ? nodeId : null
      const count = typeof layers === 'number' ? layers : null
      const result = await client.setAccelerator(requireId(modelId), id, count)
      void enqueue(() => tick(orca))
      return result
    })
  )
  orca.panels.handle('omlx.abort', ({ modelId, requestId }) =>
    rpc(async () => {
      if (typeof requestId !== 'string' || !requestId) {
        throw new OmlxError('invalid_params', 'Choose a request to stop.')
      }
      const client = await clientOrThrow(orca)
      const result = await client.abort(requireId(modelId), requestId)
      void enqueue(() => tick(orca))
      return result
    })
  )

  void enqueue(() => tick(orca)).finally(() => {
    if (!stopped) schedule(orca)
  })
}

export async function deactivate(): Promise<void> {
  stopped = true
  generation += 1
  if (timer) clearTimeout(timer)
  timer = null
}

async function refresh(orca: OrcaWorkerApi): Promise<RefreshData> {
  await enqueue(() => tick(orca))
  schedule(orca)
  return latest ?? emptyRefresh('Could not reach the oMLX server.', 'unreachable')
}

async function tick(orca: OrcaWorkerApi): Promise<void> {
  const snapshot = await collect(orca)
  lastPoll = snapshot.overview.pollSeconds
  latest = snapshot
  await paint(orca, snapshot.overview)
  orca.panels.post('omlx.activity', snapshot.activity)
  orca.panels.post('omlx.status', {
    status: snapshot.overview.status,
    message: snapshot.overview.message,
    loadedCount: snapshot.overview.loadedCount
  })
}

async function collect(orca: OrcaWorkerApi): Promise<RefreshData> {
  let link: Link
  try {
    link = await readLink(orca)
  } catch (error) {
    return emptyRefresh(messageOf(error), 'error')
  }
  if (link.urlError) {
    return snapshotFrom(link, 'invalid_url', link.urlError, emptyActivity(), [], null, link.urlError)
  }
  const client = createClient({ baseUrl: link.baseUrl, apiKey: link.apiKey })
  const [server, device, activity, models, settings] = await Promise.allSettled([
    client.serverInfo(),
    client.deviceInfo(),
    client.activity(),
    client.models(),
    client.settings()
  ])
  const failures = [server, device, activity, models, settings].flatMap((result) =>
    result.status === 'rejected' ? [asOmlx(result.reason)] : []
  )
  const activityData = activity.status === 'fulfilled' ? activity.value : emptyActivity()
  const reachable = server.status === 'fulfilled' || activity.status === 'fulfilled' || models.status === 'fulfilled'
  let status: ConnectionStatus = 'ok'
  if (failures.some((error) => error.code === 'unauthorized')) status = 'unauthorized'
  else if (!reachable) status = failures.some((error) => error.code === 'timeout') ? 'error' : 'unreachable'
  else if (activity.status === 'rejected' && models.status === 'rejected') status = 'error'
  return snapshotFrom(
    link,
    status,
    statusMessage(status, failures, activityData),
    activityData,
    models.status === 'fulfilled' ? models.value : [],
    settings.status === 'fulfilled' ? settings.value : null,
    settings.status === 'rejected' ? messageOf(settings.reason) : null,
    server.status === 'fulfilled' ? server.value : null,
    device.status === 'fulfilled' ? device.value : null
  )
}

function snapshotFrom(
  link: Link,
  status: ConnectionStatus,
  message: string,
  activity: Activity,
  models: RefreshData['models'],
  settings: RefreshData['settings'],
  settingsError: string | null,
  server: Overview['server'] = null,
  device: Overview['device'] = null
): RefreshData {
  return {
    overview: {
      baseUrl: link.baseUrl,
      keySaved: link.keySaved,
      secretsAvailable: link.secretsAvailable,
      pollSeconds: link.pollSeconds,
      status,
      message,
      server,
      device,
      loadedCount: activity.models.length
    },
    models,
    activity,
    settings,
    settingsError,
    jobs: currentJobs()
  }
}

function startJob(
  orca: OrcaWorkerApi,
  kind: JobKind,
  modelId: string | undefined,
  work: (client: OmlxClient) => Promise<string>,
  options?: { clearSecretDraft?: boolean }
): Rpc<Started> {
  const key = modelId ? `${kind}:${modelId}` : kind
  const existing = inflight.get(key)
  if (existing) return { ok: true, data: { jobId: existing } }
  const id = `${kind}-${++seq}`
  inflight.set(key, id)
  publish(orca, {
    id,
    kind,
    state: 'running',
    modelId,
    message: runningText(kind, modelId)
  })
  void (async () => {
    try {
      const client = await clientOrThrow(orca)
      const message = await work(client)
      publish(orca, { id, kind, state: 'done', modelId, message, clearSecretDraft: options?.clearSecretDraft })
      void enqueue(() => tick(orca))
    } catch (error) {
      const message = messageOf(error)
      publish(orca, { id, kind, state: 'error', modelId, message })
      if (kind === 'load' || kind === 'unload' || kind === 'restart') {
        const title =
          kind === 'load'
            ? `Could not load ${modelId ?? 'the model'}`
            : kind === 'unload'
              ? `Could not unload ${modelId ?? 'the model'}`
              : 'Could not restart oMLX'
        try {
          await orca.host.call('notifications.show', { title, body: message })
        } catch {
          // A desktop notification is optional.
        }
      }
    } finally {
      inflight.delete(key)
    }
  })()
  return { ok: true, data: { jobId: id } }
}

function startRotate(orca: OrcaWorkerApi, apiKey: unknown): Rpc<Started> {
  if (typeof apiKey !== 'string') {
    return { ok: false, code: 'invalid_params', message: 'Enter an API key first.' }
  }
  const key = `${'rotate-key'}`
  const existing = inflight.get(key)
  if (existing) return { ok: true, data: { jobId: existing } }
  const id = `rotate-key-${++seq}`
  inflight.set(key, id)
  publish(orca, { id, kind: 'rotate-key', state: 'running', message: 'Replacing the server API key…' })
  void (async () => {
    try {
      const client = await clientOrThrow(orca)
      await client.rotateApiKey(apiKey)
      const link = await readLink(orca)
      let stored = false
      if (link.secretsAvailable) {
        try {
          await orca.host.call('secrets.set', { key: SECRET_KEY, value: apiKey })
          stored = true
        } catch {
          stored = false
        }
      }
      publish(orca, {
        id,
        kind: 'rotate-key',
        state: 'done',
        message: stored
          ? 'Replaced the server API key and saved it in this plugin.'
          : 'Replaced the server API key. This machine could not store it, so paste it into the connection key field.',
        clearSecretDraft: stored
      })
      void enqueue(() => tick(orca))
    } catch (error) {
      publish(orca, { id, kind: 'rotate-key', state: 'error', message: messageOf(error) })
    } finally {
      inflight.delete(key)
    }
  })()
  return { ok: true, data: { jobId: id } }
}

function publish(orca: OrcaWorkerApi, event: JobEvent): void {
  jobs.set(event.id, event)
  const finished = [...jobs.values()].filter((job) => job.state !== 'running')
  while (jobs.size > 20 && finished.length > 0) {
    const drop = finished.shift()
    if (!drop) break
    jobs.delete(drop.id)
  }
  orca.panels.post('omlx.job', event)
}

async function readLink(orca: OrcaWorkerApi): Promise<Link> {
  const settings = await orca.host.call('settings.get', {})
  const baseRaw = typeof settings.settings.baseUrl === 'string' ? settings.settings.baseUrl : 'http://127.0.0.1:8000'
  const pollRaw = settings.settings.pollSeconds
  const pollSeconds =
    typeof pollRaw === 'number' && Number.isFinite(pollRaw) ? Math.max(0, Math.min(300, Math.floor(pollRaw))) : 5
  let secretsAvailable = false
  let apiKey: string | null = null
  try {
    const protection = await orca.host.call('secrets.protection', {})
    secretsAvailable = protection.status === 'os-keyring'
  } catch {
    secretsAvailable = false
  }
  if (secretsAvailable) {
    try {
      const stored = await orca.host.call('secrets.get', { key: SECRET_KEY })
      apiKey = typeof stored.value === 'string' && stored.value.length > 0 ? stored.value : null
    } catch {
      apiKey = null
    }
  }
  let baseUrl = baseRaw.trim() || 'http://127.0.0.1:8000'
  let urlError: string | null = null
  try {
    baseUrl = normalizeBaseUrl(baseUrl)
  } catch (error) {
    urlError = messageOf(error)
  }
  return { baseUrl, apiKey, pollSeconds, secretsAvailable, keySaved: apiKey !== null, urlError }
}

async function clientOrThrow(orca: OrcaWorkerApi): Promise<OmlxClient> {
  const link = await readLink(orca)
  if (link.urlError) throw new OmlxError('invalid_url', link.urlError)
  return createClient({ baseUrl: link.baseUrl, apiKey: link.apiKey })
}

async function paint(orca: OrcaWorkerApi, overview: Overview): Promise<void> {
  const text =
    overview.status === 'ok'
      ? overview.loadedCount === 1
        ? '1 loaded'
        : `${overview.loadedCount} loaded`
      : overview.status === 'unauthorized'
        ? 'Needs key'
        : overview.status === 'invalid_url'
          ? 'Bad URL'
          : 'Offline'
  try {
    await orca.host.call('statusBar.update', {
      id: 'loads',
      text,
      icon: 'bot',
      tone: overview.status === 'ok' ? (overview.loadedCount > 0 ? 'success' : 'neutral') : 'warning',
      tooltip: overview.message,
      visible: true
    })
  } catch {
    // The status bar exists in the desktop app. The panel still works without it.
  }
}

function schedule(orca: OrcaWorkerApi): void {
  const token = ++generation
  if (timer) clearTimeout(timer)
  timer = null
  if (stopped || lastPoll <= 0) return
  timer = setTimeout(() => {
    void (async () => {
      if (stopped || token !== generation) return
      await enqueue(() => tick(orca))
      if (stopped || token !== generation) return
      schedule(orca)
    })()
  }, lastPoll * 1000)
}

function enqueue(work: () => Promise<void>): Promise<void> {
  const run = tail.then(work, work)
  tail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function rpc<T>(work: () => Promise<T>): Promise<Rpc<T>> {
  return work().then(
    (data) => ({ ok: true, data }),
    (error: unknown) => ({ ok: false, code: codeOf(error), message: messageOf(error) })
  )
}

function requireId(modelId: unknown): string {
  if (typeof modelId !== 'string' || modelId.length === 0) {
    throw new OmlxError('invalid_params', 'Choose a model first.')
  }
  return modelId
}

function currentJobs(): JobEvent[] {
  return [...jobs.values()]
}

function runningText(kind: JobKind, modelId: string | undefined): string {
  if (kind === 'load') return `Loading ${modelId ?? 'model'}…`
  if (kind === 'unload') return `Unloading ${modelId ?? 'model'}…`
  if (kind === 'rescan') return 'Rescanning model directories…'
  if (kind === 'settings') return 'Saving settings…'
  if (kind === 'restart') return 'Restarting oMLX…'
  return 'Updating the API key…'
}

function statusMessage(status: ConnectionStatus, failures: OmlxError[], activity: Activity): string {
  if (status === 'unauthorized') return 'The API key was rejected. Check the main oMLX key.'
  if (status === 'unreachable') return 'Could not reach the oMLX server.'
  if (status === 'error') return failures[0]?.message || 'The oMLX request failed.'
  if (activity.models.length === 1) return '1 model loaded.'
  if (activity.models.length > 1) return `${activity.models.length} models loaded.`
  return 'Server is up. No models are loaded.'
}

function emptyRefresh(message: string, status: ConnectionStatus): RefreshData {
  return {
    overview: {
      baseUrl: '',
      keySaved: false,
      secretsAvailable: false,
      pollSeconds: lastPoll,
      status,
      message,
      server: null,
      device: null,
      loadedCount: 0
    },
    models: [],
    activity: emptyActivity(),
    settings: null,
    settingsError: message,
    jobs: currentJobs()
  }
}

function emptyActivity(): Activity {
  return { models: [], memoryUsedLabel: '—', memoryMaxLabel: '—', memoryUsedBytes: 0, memoryMaxBytes: 0 }
}

function asOmlx(error: unknown): OmlxError {
  if (error instanceof OmlxError) return error
  return new OmlxError('server', messageOf(error))
}

function messageOf(error: unknown): string {
  if (error instanceof OmlxError) return error.message
  return 'The oMLX request failed.'
}

function codeOf(error: unknown): string {
  if (error instanceof OmlxError) return error.code
  return 'action_failed'
}
