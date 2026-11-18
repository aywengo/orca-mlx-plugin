import {
  Badge,
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
  EmptyState,
  Field,
  Grid,
  Heading,
  IconButton,
  Input,
  Progress,
  RelativeTime,
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
  type PanelContext,
  type Tone
} from 'orca'
import { assertApiKey, draftFromSettings, draftToPatch, normalizeBaseUrl, OmlxError } from './client.ts'
import './protocol.ts'
import type { Activity, ActivityModel, BaseSettings, JobEvent, ModelSummary, Overview, SettingsDraft } from './types.ts'

interface UsageSample {
  at: number
  memoryPercent: number
  loaded: number
  active: number
  waiting: number
}

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
const connectionOpen = atom('connectionOpen', true, { persist: 'plugin' })
const history = atom<UsageSample[]>('usageHistory', [])
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
    plugin.on('omlx.activity', (value) => {
      set(activity, value)
      recordUsage(value, read(models))
    }),
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
      <Collapsible
        title="Connection"
        description={connectionSummary(read(overview))}
        open={read(connectionOpen)}
        onChange={(open) => set(connectionOpen, open)}
      >
        <ConnectionCard />
      </Collapsible>
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
        <Tab value="pulses" label="Pulses">
          <PulsesTab />
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

function PulsesTab() {
  const current = read(activity)
  const catalog = read(models)
  const samples = read(history)
  const loaded = current?.models ?? []
  const largest = loaded.reduce((max, model) => Math.max(max, model.sizeBytes), 0)
  const total = catalog.length
  const loadingCount = catalog.filter((model) => model.loading).length
  const resident = catalog.filter((model) => model.loaded).length
  const waiting = Math.max(0, total - resident - loadingCount)
  const trail = samples.slice(-16)
  const latest = trail[trail.length - 1] ?? null
  const oldest = trail[0] ?? null
  const [loadedShare, loadingShare] = shareWidths([resident, loadingCount, waiting])
  const memoryNow = percent(current?.memoryUsedBytes ?? 0, current?.memoryMaxBytes ?? 0)
  const active = loaded.reduce((sum, model) => sum + model.activeRequests, 0)
  const queued = loaded.reduce((sum, model) => sum + model.waitingRequests, 0)
  const speed = loaded.reduce((sum, model) => sum + speedOf(model), 0)
  return (
    <Stack gap="md">
      <Box border radius="md" padding="sm" gap="sm" background="card">
        <Row justify="between" align="end">
          <Stack gap="none">
            <Text size="xs" muted>
              Memory
            </Text>
            <Text size="md" weight="semibold" tone={chartTone(memoryNow)}>
              {memoryNow}%
            </Text>
          </Stack>
          <Text size="xs" muted>
            {current?.memoryUsedLabel ?? '—'} of {current?.memoryMaxLabel ?? '—'}
          </Text>
        </Row>
        <UsageBar value={memoryNow} />
        <Row gap="sm" wrap>
          <Text size="xs" tone="success">
            under 40%
          </Text>
          <Text size="xs" tone="accent">
            under 65%
          </Text>
          <Text size="xs" tone="warning">
            under 85%
          </Text>
          <Text size="xs" tone="danger">
            85% and up
          </Text>
        </Row>
        {latest && oldest ? (
          <Stack gap="xs">
            <Box direction="row" width="100%" height={28} radius="sm" background="muted" align="end">
              {trail.map((sample, index) => (
                <Box
                  key={`${index}-${sample.at}`}
                  grow
                  height={trailHeight(sample.memoryPercent)}
                  background={chartTone(sample.memoryPercent)}
                />
              ))}
            </Box>
            <Row justify="between" align="center">
              <RelativeTime at={oldest.at} format="short" muted />
              <Text size="xs" muted>
                {latest.loaded} loaded · {latest.active} active
              </Text>
              <RelativeTime at={latest.at} format="short" muted />
            </Row>
          </Stack>
        ) : (
          <Text size="xs" muted>
            The memory history fills in on the next poll.
          </Text>
        )}
      </Box>
      <Grid minItemWidth="xs" gap="sm">
        <Stat label="Loaded" value={total === 0 ? '—' : String(resident)} detail={total === 0 ? 'No inventory' : `of ${total}`} />
        <Stat label="Requests" value={String(active)} detail={queued > 0 ? `${queued} waiting` : 'None waiting'} tone={active > 0 ? 'accent' : undefined} />
        <Stat label="Speed" value={speed > 0 ? speed.toFixed(1) : '—'} detail="tok/s" />
      </Grid>
      <Stack gap="xs">
        <Text weight="medium">In memory</Text>
        {loaded.length === 0 ? (
          <Text size="sm" muted>
            Nothing is loaded.
          </Text>
        ) : (
          loaded.map((model) => (
            <ModelChart key={model.id} model={model} largest={largest} compare={loaded.length > 1} />
          ))
        )}
      </Stack>
      {total === 0 ? (
        <EmptyState title="No model inventory yet" description="The mix of loaded and waiting models appears after oMLX returns its model list." icon="bar-chart-3" />
      ) : (
        <Box border radius="md" padding="sm" gap="xs">
          <Row justify="between" align="center">
            <Text weight="medium">Catalog</Text>
            <Text size="xs" muted>
              {total} models
            </Text>
          </Row>
          <Box direction="row" width="100%" height={12} radius="full" background="muted" align="stretch">
            {resident > 0 ? <Box width={loadedShare} height={12} background="success" shrink={false} /> : null}
            {loadingCount > 0 ? <Box width={loadingShare} height={12} background="accent" shrink={false} /> : null}
          </Box>
          <Row gap="sm" wrap>
            <Text size="xs" tone="success">
              {resident} loaded
            </Text>
            <Text size="xs" tone="accent">
              {loadingCount} loading
            </Text>
            <Text size="xs" muted>
              {waiting} not loaded
            </Text>
          </Row>
        </Box>
      )}
    </Stack>
  )
}

function Stat(props: { label: string; value: string; detail: string; tone?: Tone }) {
  return (
    <Box border radius="md" padding="sm" gap="none" background="card" grow>
      <Text size="xs" muted>
        {props.label}
      </Text>
      <Text size="md" weight="semibold" tone={props.tone}>
        {props.value}
      </Text>
      <Text size="xs" muted>
        {props.detail}
      </Text>
    </Box>
  )
}

function ModelChart(props: { model: ActivityModel; largest: number; compare: boolean }) {
  const model = props.model
  const speed = speedOf(model)
  const requests = model.requests.filter((request) => request.progress != null)
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Text weight="medium" truncate>
        {model.id}
      </Text>
      <Row gap="sm" wrap>
        <Text size="xs" muted>
          {model.sizeLabel}
        </Text>
        <Text size="xs" muted>
          {model.activeRequests} active · {model.waitingRequests} waiting
        </Text>
        <Text size="xs" muted>
          {speed > 0 ? `${speed.toFixed(1)} tok/s` : 'Idle'}
        </Text>
      </Row>
      {props.compare ? <Progress label={`${model.id} size`} labelHidden value={percent(model.sizeBytes, props.largest)} /> : null}
      {requests.map((request) => (
        <Stack key={request.id} gap="xs">
          <Row justify="between" align="center">
            <Text size="xs">{request.phase}</Text>
            <Text size="xs" muted>
              {request.progress}% · {request.detail}
            </Text>
          </Row>
          <Progress label={`${model.id} ${request.phase}`} labelHidden value={request.progress ?? 0} />
        </Stack>
      ))}
    </Box>
  )
}

function UsageBar(props: { value: number }) {
  return (
    <Box direction="row" width="100%" height={12} radius="full" background="muted" align="stretch">
      {props.value > 0 ? (
        <Box width={barWidth(props.value)} height={12} radius="full" background={chartTone(props.value)} shrink={false} />
      ) : null}
    </Box>
  )
}

function chartTone(value: number): Tone {
  if (value >= 85) return 'danger'
  if (value >= 65) return 'warning'
  if (value >= 40) return 'accent'
  return 'success'
}

function trailHeight(value: number): number {
  return Math.max(4, Math.round((Math.max(0, Math.min(100, value)) / 100) * 28))
}

function barWidth(value: number): `${number}%` {
  const clamped = Math.max(0, Math.min(100, Math.round(value)))
  return `${clamped}%` as `${number}%`
}

function shareWidths(counts: number[]): `${number}%`[] {
  const total = counts.reduce((sum, count) => sum + count, 0)
  if (total <= 0) return counts.map(() => '0%' as `${number}%`)
  const widths = counts.map((count) => Math.floor((count / total) * 100))
  let leftover = 100 - widths.reduce((sum, width) => sum + width, 0)
  const rank = counts
    .map((count, index) => ({ index, frac: (count / total) * 100 - widths[index] }))
    .sort((a, b) => b.frac - a.frac)
  for (const item of rank) {
    if (leftover <= 0) break
    widths[item.index] += 1
    leftover -= 1
  }
  return widths.map((width) => `${width}%` as `${number}%`)
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
    recordUsage(data.activity, data.models)
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

function connectionSummary(current: Overview | null): string {
  if (!current) return 'Server URL and API key'
  const where = current.server ? `${current.server.host}:${current.server.port}` : current.baseUrl || 'No URL'
  return `${statusLabel(current.status)} · ${where} · ${current.keySaved ? 'Key saved' : 'No key'}`
}

function recordUsage(current: Activity, catalog: ModelSummary[]): void {
  const active = current.models.reduce((sum, model) => sum + model.activeRequests, 0)
  const waiting = current.models.reduce((sum, model) => sum + model.waitingRequests, 0)
  const sample: UsageSample = {
    at: Date.now(),
    memoryPercent: percent(current.memoryUsedBytes, current.memoryMaxBytes),
    loaded: catalog.filter((model) => model.loaded).length || current.models.length,
    active,
    waiting
  }
  update(history, (list) => {
    const last = list[list.length - 1]
    const sameReading =
      last !== undefined &&
      last.memoryPercent === sample.memoryPercent &&
      last.active === sample.active &&
      last.loaded === sample.loaded
    if (last && sameReading && sample.at - last.at < 2000) return list
    const at = last && sample.at <= last.at ? last.at + 1 : sample.at
    return [...list, { ...sample, at }].slice(-24)
  })
}

function speedOf(model: ActivityModel): number {
  return model.requests.reduce((sum, request) => sum + (request.tokensPerSecond ?? 0), 0)
}

function percent(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((part / whole) * 100)))
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
