import {
  Badge,
  Button,
  Callout,
  Card,
  CodeView,
  Collapsible,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  Row,
  Select,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  Textarea,
  atom,
  host,
  plugin,
  read,
  set,
  update,
  type PanelContext
} from 'orca'
import { assertApiKey, draftFromSettings, draftToPatch, normalizeBaseUrl, OmlxError } from './client.ts'
import './protocol.ts'
import type { Activity, BaseSettings, JobEvent, ModelSummary, Overview, SettingsDraft } from './types.ts'

const orca = { host }

const phase = atom<'loading' | 'ready'>('loading')
const overview = atom<Overview | null>(null)
const models = atom<ModelSummary[]>([])
const activity = atom<Activity | null>(null)
const settings = atom<BaseSettings | null>(null)
const settingsError = atom<string | null>(null)
const settingsDraft = atom<SettingsDraft | null>('settingsDraft', null)
const dirty = atom('settingsDirty', false)
const jobs = atom<JobEvent[]>([])
const notice = atom<string | null>(null)
const selectedModel = atom<string | null>(null)
const selectedRequest = atom<string | null>(null)
const tab = atom('tab', 'models')
const keyDraft = atom('')
const rotateDraft = atom('')
const urlDraft = atom('urlDraft', 'http://127.0.0.1:8000')
const urlDirty = atom('urlDirty', false)
const logs = atom('')
const logMeta = atom('')
const logsError = atom<string | null>(null)
const logsLoading = atom(false)

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('omlx.job', (event) => {
      update(jobs, (list) => [...list.filter((job) => job.id !== event.id), event])
      set(notice, event.message)
      if (event.clearSecretDraft) set(rotateDraft, '')
      if (event.state === 'done' && event.kind === 'settings') set(dirty, false)
      if (event.state !== 'running') void reload()
    }),
    plugin.on('omlx.activity', (value) => set(activity, value)),
    plugin.on('omlx.status', (value) => {
      update(overview, (current) => (current ? { ...current, ...value } : current))
    })
  )
  void reload()
}

export default function Panel() {
  if (read(phase) === 'loading' && !read(overview)) {
    return <Spinner label="Connecting to oMLX" />
  }
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Heading level={2}>oMLX</Heading>
        <IconButton icon="refresh" label="Refresh" onPress={() => void reload()} />
      </Row>
      <ConnectionCard />
      {read(jobs)
        .filter((job) => job.state === 'running')
        .map((job) => (
          <Text key={job.id} tone="accent">
            {job.message}
          </Text>
        ))}
      {read(notice) ? (
        <Callout tone="neutral" title="Last action" icon="info">
          <Text>{read(notice)}</Text>
        </Callout>
      ) : null}
      <Tabs label="oMLX sections" value={read(tab)} onChange={(value) => openTab(value)}>
        <Tab value="models" label="Models">
          <ModelsTab />
        </Tab>
        <Tab value="running" label="Running">
          <RunningTab />
        </Tab>
        <Tab value="settings" label="Settings">
          <SettingsTab />
        </Tab>
        <Tab value="logs" label="Logs">
          <LogsTab />
        </Tab>
      </Tabs>
    </Stack>
  )
}

function ConnectionCard() {
  const current = read(overview)
  const status = current?.status ?? 'error'
  return (
    <Card title="Connection" description={current?.baseUrl || 'Server URL'}>
      <Stack gap="sm">
        <Row gap="sm" wrap>
          <Badge tone={status === 'ok' ? 'success' : status === 'unauthorized' ? 'warning' : 'danger'}>
            {statusLabel(status)}
          </Badge>
          <Badge tone={current?.keySaved ? 'success' : 'neutral'}>{current?.keySaved ? 'Key saved' : 'No key saved'}</Badge>
          {current ? <Text muted>{current.message}</Text> : null}
        </Row>
        {current?.server ? (
          <Text muted>
            Listening on {current.server.host}:{current.server.port}
            {current.device ? ` · ${deviceLine(current.device)}` : ''}
          </Text>
        ) : null}
        <Text muted>
          {current && current.pollSeconds > 0
            ? `The status bar refreshes every ${current.pollSeconds} seconds.`
            : 'Background polling is paused. Refresh to update the status bar.'}
        </Text>
        {current && !current.secretsAvailable ? (
          <Callout tone="warning" title="Secrets are unavailable" icon="warning">
            <Text>This machine cannot store an API key in Orca’s secret store. The key is not kept in settings.</Text>
          </Callout>
        ) : (
          <Stack gap="xs">
            <Input
              label="API key"
              type="password"
              value={read(keyDraft)}
              placeholder="Main oMLX key"
              onChange={(value) => set(keyDraft, value)}
            />
            <Row gap="sm" wrap>
              <Button icon="check" onPress={() => void saveKey()}>
                Save key
              </Button>
              <Button variant="ghost" disabled={!current?.keySaved} onPress={() => void clearKey()}>
                Remove saved key
              </Button>
            </Row>
          </Stack>
        )}
        <Field label="Server URL" description="Also listed in Orca Settings for this plugin.">
          <Input
            label="Server URL"
            labelHidden
            value={read(urlDraft)}
            onChange={(value) => {
              set(urlDirty, true)
              set(urlDraft, value)
            }}
          />
        </Field>
        <Button variant="outline" onPress={() => void saveUrl()}>
          Save URL
        </Button>
      </Stack>
    </Card>
  )
}

function ModelsTab() {
  const rows = read(models)
  const selected = read(selectedModel)
  const model = rows.find((item) => item.id === selected) ?? null
  return (
    <Stack gap="sm">
      {rows.length === 0 ? (
        <EmptyState title="No models on this server" description="Add a model directory, then rescan." icon="database" />
      ) : (
        <Table
          label="Models"
          columns={[
            { key: 'name', label: 'Model', minWidth: 'sm' },
            { key: 'state', label: 'State' },
            { key: 'size', label: 'Size', align: 'end', hideBelow: 'sm' },
            { key: 'flags', label: 'Flags', hideBelow: 'md' }
          ]}
          rows={rows.map((item) => ({
            key: item.id,
            cells: {
              name: item.displayName,
              state: item.loading ? 'Loading' : item.loaded ? 'Loaded' : 'Not loaded',
              size: item.sizeLabel,
              flags: flagsFor(item)
            }
          }))}
          selectionMode="single"
          selected={selected ? [selected] : []}
          onSelectionChange={({ keys }) => set(selectedModel, keys[0] ?? null)}
          emptyText="No models on this server"
        />
      )}
      <Row gap="xs" wrap>
        <Button icon="play" disabled={!model || model.virtual || model.loaded || model.loading} onPress={() => void loadSelected()}>
          Load
        </Button>
        <Button
          icon="stop"
          variant="outline"
          disabled={!model || model.virtual || (!model.loaded && !model.loading)}
          onPress={() => void unloadSelected()}
        >
          Unload
        </Button>
        <Button variant="ghost" disabled={!model || model.virtual} onPress={() => void pinSelected()}>
          {model?.pinned ? 'Unpin' : 'Pin'}
        </Button>
        <Button variant="ghost" disabled={!model || model.virtual || model.isDefault} onPress={() => void defaultSelected()}>
          Make default
        </Button>
        <Button icon="refresh" variant="ghost" onPress={() => void start('omlx.rescan', {})}>
          Rescan
        </Button>
      </Row>
      {model ? (
        <Text muted>
          {model.modelType} · {model.engineType}
          {model.helper ? ' · helper' : ''}
          {model.hidden ? ' · hidden' : ''}
          {model.virtual ? ' · built in' : ''}
        </Text>
      ) : (
        <Text muted>Select a model to load, unload, pin, or make it the default.</Text>
      )}
    </Stack>
  )
}

function RunningTab() {
  const current = read(activity)
  const loaded = current?.models ?? []
  if (loaded.length === 0) {
    return (
      <EmptyState title="Nothing is loaded" description="Loaded models and their requests show up here." icon="activity" />
    )
  }
  const selected = read(selectedModel)
  const model = loaded.find((item) => item.id === selected) ?? loaded[0] ?? null
  const requestId = read(selectedRequest)
  return (
    <Stack gap="sm">
      <Text muted>
        Memory {current?.memoryUsedLabel ?? '—'} of {current?.memoryMaxLabel ?? '—'}
      </Text>
      <Table
        label="Loaded models"
        columns={[
          { key: 'name', label: 'Model', minWidth: 'sm' },
          { key: 'state', label: 'State' },
          { key: 'requests', label: 'Requests', align: 'end' },
          { key: 'size', label: 'Size', align: 'end', hideBelow: 'sm' }
        ]}
        rows={loaded.map((item) => ({
          key: item.id,
          cells: {
            name: item.id,
            state: item.loading ? 'Loading' : item.activeRequests > 0 ? 'Active' : item.waitingRequests > 0 ? 'Waiting' : 'Idle',
            requests: item.activeRequests + item.waitingRequests,
            size: item.sizeLabel
          }
        }))}
        selectionMode="single"
        selected={model ? [model.id] : []}
        onSelectionChange={({ keys }) => {
          set(selectedModel, keys[0] ?? null)
          set(selectedRequest, null)
        }}
      />
      {model && model.requests.length > 0 ? (
        <Table
          label={`Requests on ${model.id}`}
          columns={[
            { key: 'phase', label: 'Phase' },
            { key: 'detail', label: 'Detail', minWidth: 'sm' }
          ]}
          rows={model.requests.map((request) => ({
            key: request.id,
            cells: { phase: request.phase, detail: `${request.id} · ${request.detail}` }
          }))}
          selectionMode="single"
          selected={requestId ? [requestId] : []}
          onSelectionChange={({ keys }) => set(selectedRequest, keys[0] ?? null)}
        />
      ) : (
        <Text muted>{model ? `${model.id} has no live requests.` : 'Select a loaded model.'}</Text>
      )}
      <Button
        icon="stop"
        tone="danger"
        variant="outline"
        disabled={!model || !requestId || !model.canAbort}
        onPress={() => void abortSelected(model?.id, requestId)}
      >
        Stop request
      </Button>
      {model && !model.canAbort ? <Text muted>This engine cannot stop a single request.</Text> : null}
    </Stack>
  )
}

function SettingsTab() {
  const draft = read(settingsDraft)
  const error = read(settingsError)
  if (!draft) {
    return error ? (
      <Callout tone="warning" title="Settings unavailable" icon="warning">
        <Text>{error}</Text>
      </Callout>
    ) : (
      <Spinner label="Loading settings" />
    )
  }
  return (
    <Stack gap="sm">
      <Text muted>Host and port apply after a restart. Other fields apply when you save.</Text>
      <Row gap="sm" wrap>
        <Button icon="check" onPress={() => void saveSettings()}>
          Save settings
        </Button>
        <Button variant="ghost" disabled={!read(dirty)} onPress={() => resetDraft()}>
          Reset
        </Button>
        <Button icon="refresh" tone="warning" variant="outline" onPress={() => void start('omlx.restart', {})}>
          Restart server
        </Button>
      </Row>
      <Collapsible title="Server" description="Bind address and logging." defaultOpen>
        <Stack gap="sm">
          <TextField label="Host" value={draft.host} onChange={(host) => edit({ host })} />
          <TextField label="Port" value={draft.port} onChange={(port) => edit({ port })} />
          <Choice
            label="Log level"
            value={draft.logLevel}
            values={['trace', 'debug', 'info', 'warning', 'error']}
            onChange={(logLevel) => edit({ logLevel })}
          />
        </Stack>
      </Collapsible>
      <Collapsible title="Models" description="Directories are scanned in order.">
        <Stack gap="sm">
          <Field label="Model directories" description="One path per line.">
            <Textarea
              label="Model directories"
              labelHidden
              rows={4}
              value={draft.modelDirs}
              onChange={(modelDirs) => edit({ modelDirs })}
            />
          </Field>
          <Switch label="Fall back to the default model" checked={draft.modelFallback} onChange={(modelFallback) => edit({ modelFallback })} />
        </Stack>
      </Collapsible>
      <Collapsible title="Scheduler" description="How requests share the GPU.">
        <Stack gap="sm">
          <TextField
            label="Max concurrent requests"
            value={draft.maxConcurrentRequests}
            onChange={(maxConcurrentRequests) => edit({ maxConcurrentRequests })}
          />
          <Switch label="Chunked prefill" checked={draft.chunkedPrefill} onChange={(chunkedPrefill) => edit({ chunkedPrefill })} />
          <Choice label="Prefill priority" value={draft.prefillPriority} values={['context', 'speed']} onChange={(prefillPriority) => edit({ prefillPriority })} />
          <Choice
            label="Concurrency priority"
            value={draft.concurrentPriority}
            values={['prefill', 'balanced', 'decode']}
            onChange={(concurrentPriority) => edit({ concurrentPriority })}
          />
        </Stack>
      </Collapsible>
      <Collapsible title="Memory" description="The guard tier limits how much oMLX will occupy.">
        <Stack gap="sm">
          <Choice
            label="Memory guard"
            value={draft.memoryGuardTier}
            values={['safe', 'balanced', 'aggressive', 'custom']}
            onChange={(memoryGuardTier) => edit({ memoryGuardTier })}
          />
          {draft.memoryGuardTier === 'custom' ? (
            <TextField
              label="Custom ceiling (GB)"
              value={draft.memoryGuardCustomCeilingGb}
              onChange={(memoryGuardCustomCeilingGb) => edit({ memoryGuardCustomCeilingGb })}
            />
          ) : null}
        </Stack>
      </Collapsible>
      <Collapsible title="Cache" description="Hot cache is 0 or a size such as 8GB. SSD cache also accepts auto.">
        <Stack gap="sm">
          <Switch label="SSD cache enabled" checked={draft.cacheEnabled} onChange={(cacheEnabled) => edit({ cacheEnabled })} />
          <TextField label="Hot cache size" value={draft.hotCacheMaxSize} onChange={(hotCacheMaxSize) => edit({ hotCacheMaxSize })} />
          <TextField label="SSD cache size" value={draft.ssdCacheMaxSize} onChange={(ssdCacheMaxSize) => edit({ ssdCacheMaxSize })} />
        </Stack>
      </Collapsible>
      <Collapsible title="Sampling defaults" description="Used when a request does not set its own values.">
        <Stack gap="sm">
          <TextField label="Temperature" value={draft.temperature} onChange={(temperature) => edit({ temperature })} />
          <TextField label="Top-p" value={draft.topP} onChange={(topP) => edit({ topP })} />
          <TextField label="Top-k" value={draft.topK} onChange={(topK) => edit({ topK })} />
          <TextField label="Max tokens" value={draft.maxTokens} onChange={(maxTokens) => edit({ maxTokens })} />
          <TextField label="Context window" value={draft.maxContextWindow} onChange={(maxContextWindow) => edit({ maxContextWindow })} />
          <TextField
            label="Idle timeout (seconds)"
            description="Blank disables the global idle unload. The minimum is 60."
            value={draft.idleTimeoutSeconds}
            onChange={(idleTimeoutSeconds) => edit({ idleTimeoutSeconds })}
          />
        </Stack>
      </Collapsible>
      <Collapsible title="Server API key" description="Replaces the main key on oMLX, then stores it here when the secret store is available.">
        <Stack gap="sm">
          <Input
            label="New server API key"
            type="password"
            value={read(rotateDraft)}
            onChange={(value) => set(rotateDraft, value)}
          />
          <Button variant="outline" onPress={() => void rotateKey()}>
            Replace server key
          </Button>
          <Text muted>{read(settings)?.apiKeySet ? 'The server has a main key.' : 'The server has no main key yet.'}</Text>
        </Stack>
      </Collapsible>
    </Stack>
  )
}

function LogsTab() {
  if (read(logsLoading)) return <Spinner label="Loading the server log" />
  if (read(logsError)) {
    return (
      <Stack gap="sm">
        <Callout tone="warning" title="Log unavailable" icon="warning">
          <Text>{read(logsError)}</Text>
        </Callout>
        <Button icon="refresh" onPress={() => void loadLogs()}>
          Try again
        </Button>
      </Stack>
    )
  }
  if (!read(logs)) {
    return (
      <EmptyState title="No log lines yet" description="The server log tail appears here." icon="file-text">
        <Button icon="refresh" onPress={() => void loadLogs()}>
          Load log
        </Button>
      </EmptyState>
    )
  }
  return (
    <Stack gap="sm">
      <Row justify="between" align="center">
        <Text muted>{read(logMeta)}</Text>
        <Button icon="refresh" variant="ghost" onPress={() => void loadLogs()}>
          Reload
        </Button>
      </Row>
      <CodeView code={read(logs)} label="Server log" wrap maxHeight="lg" />
    </Stack>
  )
}

function TextField(props: { label: string; value: string; description?: string; onChange: (value: string) => void }) {
  return (
    <Field label={props.label} description={props.description}>
      <Input label={props.label} labelHidden value={props.value} onChange={props.onChange} />
    </Field>
  )
}

function Choice(props: { label: string; value: string; values: string[]; onChange: (value: string) => void }) {
  const values = props.values.includes(props.value) ? props.values : [props.value, ...props.values]
  return (
    <Select
      label={props.label}
      value={props.value}
      options={values.map((value) => ({ value, label: value }))}
      onChange={props.onChange}
    />
  )
}

function openTab(value: string): void {
  set(tab, value)
  if (value === 'logs' && !read(logs) && !read(logsLoading)) void loadLogs()
}

async function reload(): Promise<void> {
  try {
    const result = await plugin.request('omlx.refresh', {}, { timeoutMs: 30000 })
    if (!result.ok) {
      set(notice, result.message)
      set(phase, 'ready')
      return
    }
    const data = result.data
    set(overview, data.overview)
    set(models, data.models)
    set(activity, data.activity)
    set(settings, data.settings)
    set(settingsError, data.settingsError)
    set(jobs, data.jobs)
    if (!read(urlDirty)) set(urlDraft, data.overview.baseUrl || read(urlDraft))
    if (data.settings && !read(dirty)) set(settingsDraft, draftFromSettings(data.settings))
    const selected = read(selectedModel)
    if (selected && !data.models.some((model) => model.id === selected) && !data.activity.models.some((model) => model.id === selected)) {
      set(selectedModel, null)
    }
    set(phase, 'ready')
  } catch (error) {
    set(notice, messageOf(error))
    set(phase, 'ready')
  }
}

async function saveKey(): Promise<void> {
  try {
    const protection = await orca.host.call('secrets.protection', {})
    if (protection.status !== 'os-keyring') {
      set(notice, 'This machine cannot store the API key in Orca secrets.')
      return
    }
    const key = assertApiKey(read(keyDraft))
    await orca.host.call('secrets.set', { key: 'apiKey', value: key })
    set(keyDraft, '')
    set(notice, 'API key saved.')
    await reload()
  } catch (error) {
    set(notice, messageOf(error))
  }
}

async function clearKey(): Promise<void> {
  try {
    await orca.host.call('secrets.delete', { key: 'apiKey' })
    set(notice, 'Saved API key removed.')
    await reload()
  } catch (error) {
    set(notice, messageOf(error))
  }
}

async function saveUrl(): Promise<void> {
  try {
    const url = normalizeBaseUrl(read(urlDraft))
    await orca.host.call('settings.set', { key: 'baseUrl', value: url })
    set(urlDirty, false)
    set(urlDraft, url)
    set(notice, 'Server URL saved.')
    await reload()
  } catch (error) {
    set(notice, messageOf(error))
  }
}

async function saveSettings(): Promise<void> {
  const draft = read(settingsDraft)
  if (!draft) return
  try {
    const patch = draftToPatch(draft)
    await start('omlx.saveSettings', { patch })
  } catch (error) {
    set(notice, messageOf(error))
  }
}

async function rotateKey(): Promise<void> {
  try {
    const apiKey = assertApiKey(read(rotateDraft))
    await start('omlx.rotateKey', { apiKey })
  } catch (error) {
    set(notice, messageOf(error))
  }
}

async function loadSelected(): Promise<void> {
  const model = read(selectedModel)
  if (!model) return
  await start('omlx.load', { modelId: model })
}

async function unloadSelected(): Promise<void> {
  const model = read(selectedModel)
  if (!model) return
  await start('omlx.unload', { modelId: model })
}

async function pinSelected(): Promise<void> {
  const model = read(models).find((item) => item.id === read(selectedModel))
  if (!model) return
  const result = await plugin.request('omlx.pin', { modelId: model.id, pinned: !model.pinned })
  set(notice, result.ok ? result.data.message : result.message)
  if (result.ok) await reload()
}

async function defaultSelected(): Promise<void> {
  const modelId = read(selectedModel)
  if (!modelId) return
  const result = await plugin.request('omlx.default', { modelId, isDefault: true })
  set(notice, result.ok ? result.data.message : result.message)
  if (result.ok) await reload()
}

async function abortSelected(modelId: string | undefined, requestId: string | null): Promise<void> {
  if (!modelId || !requestId) return
  const result = await plugin.request('omlx.abort', { modelId, requestId })
  set(notice, result.ok ? result.data.message : result.message)
  if (result.ok) await reload()
}

async function loadLogs(): Promise<void> {
  set(logsLoading, true)
  set(logsError, null)
  try {
    const result = await plugin.request('omlx.logs', {}, { timeoutMs: 20000 })
    if (!result.ok) {
      set(logsError, result.message)
      return
    }
    set(logs, result.data.text)
    set(logMeta, `${result.data.file} · ${result.data.totalLines} lines`)
  } catch (error) {
    set(logsError, messageOf(error))
  } finally {
    set(logsLoading, false)
  }
}

async function start(
  name: 'omlx.rescan' | 'omlx.restart' | 'omlx.load' | 'omlx.unload' | 'omlx.saveSettings' | 'omlx.rotateKey',
  input: { modelId?: string; patch?: ReturnType<typeof draftToPatch>; apiKey?: string }
): Promise<void> {
  try {
    const result = await plugin.request(name, input)
    if (!result.ok) set(notice, result.message)
    else if ('message' in result.data && typeof result.data.message === 'string') set(notice, result.data.message)
  } catch (error) {
    set(notice, messageOf(error))
  }
}

function edit(partial: Partial<SettingsDraft>): void {
  set(dirty, true)
  update(settingsDraft, (current) => (current ? { ...current, ...partial } : current))
}

function resetDraft(): void {
  const current = read(settings)
  if (!current) return
  set(settingsDraft, draftFromSettings(current))
  set(dirty, false)
}

function flagsFor(model: ModelSummary): string {
  const flags = [
    model.pinned ? 'Pinned' : '',
    model.isDefault ? 'Default' : '',
    model.helper ? 'Helper' : '',
    model.hidden ? 'Hidden' : ''
  ].filter((flag) => flag.length > 0)
  return flags.length > 0 ? flags.join(', ') : '—'
}

function deviceLine(device: NonNullable<Overview['device']>): string {
  const chip = device.chipVariant ? `${device.chipName} ${device.chipVariant}` : device.chipName
  return `${chip} · ${device.memoryGb} GB · ${device.gpuCores} GPU cores`
}

function statusLabel(status: Overview['status']): string {
  if (status === 'ok') return 'Connected'
  if (status === 'unauthorized') return 'Key rejected'
  if (status === 'unreachable') return 'Unreachable'
  if (status === 'invalid_url') return 'Bad URL'
  return 'Error'
}

function messageOf(error: unknown): string {
  if (error instanceof OmlxError) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return 'The oMLX request failed.'
}
