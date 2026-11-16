import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import {
  assertApiKey,
  baseSettingsFromResponse,
  createClient,
  draftToPatch,
  normalizeBaseUrl,
  OmlxError,
  settingsPatchToBody
} from './client.ts'
import { draftFromSettings } from './client.ts'
import type { BaseSettings } from './types.ts'

const SECRET = 'super-secret-key'

test('normalizeBaseUrl accepts an origin and rejects secrets in the URL', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(normalizeBaseUrl('https://omlx.example/admin'), 'https://omlx.example/admin')
  assert.throws(() => normalizeBaseUrl('javascript:alert(1)'), (error: unknown) => {
    assert.ok(error instanceof OmlxError)
    assert.equal(error.code, 'invalid_url')
    return true
  })
  assert.throws(() => normalizeBaseUrl('http://user:secret@127.0.0.1:8000'), (error: unknown) => {
    assert.ok(error instanceof OmlxError)
    assert.equal(error.code, 'invalid_url')
    return true
  })
  assert.throws(() => normalizeBaseUrl('http://127.0.0.1:8000/?token=secret'), (error: unknown) => {
    assert.ok(error instanceof OmlxError)
    return true
  })
})

test('assertApiKey matches oMLX rules', () => {
  assert.equal(assertApiKey('abcd'), 'abcd')
  assert.throws(() => assertApiKey('abc'), (error: unknown) => error instanceof OmlxError)
  assert.throws(() => assertApiKey('bad key'), (error: unknown) => error instanceof OmlxError)
  assert.throws(() => assertApiKey('café-key'), (error: unknown) => error instanceof OmlxError)
})

test('settings mapping drops credentials and builds a flat update', () => {
  const settings = baseSettingsFromResponse({
    server: { host: '127.0.0.1', port: 8000, log_level: 'info' },
    model: { model_dirs: ['/models'], model_fallback: false },
    scheduler: { max_concurrent_requests: 4, chunked_prefill: true, prefill_priority: 'speed', concurrent_priority: 'decode' },
    memory: { memory_guard_tier: 'safe', memory_guard_custom_ceiling_gb: 0 },
    cache: { enabled: true, hot_cache_max_size: '8GB', ssd_cache_max_size: 'auto' },
    sampling: { temperature: 0.2, top_p: 0.8, top_k: 20, max_tokens: 512, max_context_window: 8192 },
    auth: {
      api_key_set: true,
      api_key: SECRET,
      sub_keys: [{ key: SECRET, name: 'app' }],
      skip_api_key_verification: false
    },
    integrations: { web_search_brave_api_key: SECRET },
    idle_timeout: { idle_timeout_seconds: 120 }
  })
  assert.equal(settings.apiKeySet, true)
  assert.equal(settings.idleTimeoutSeconds, 120)
  assert.equal(JSON.stringify(settings).includes(SECRET), false)

  const body = settingsPatchToBody(draftToPatch(draftFromSettings(settings)))
  assert.equal(body.host, '127.0.0.1')
  assert.equal(body.max_concurrent_requests, 4)
  assert.equal(body.sampling_temperature, 0.2)
  assert.deepEqual(body.model_dirs, ['/models'])
  assert.equal(body.idle_timeout_seconds, 120)
  assert.equal('api_key' in body, false)
  assert.equal(JSON.stringify(body).includes(SECRET), false)
  assert.throws(() => settingsPatchToBody({ hotCacheMaxSize: 'auto' }), (error: unknown) => error instanceof OmlxError)
  assert.equal(settingsPatchToBody({ ssdCacheMaxSize: 'AUTO' }).ssd_cache_max_size, 'auto')
})

test('blank idle timeout disables it and a custom memory tier needs a ceiling', () => {
  const draft = draftFromSettings(sampleSettings())
  draft.idleTimeoutSeconds = ''
  assert.equal(draftToPatch(draft).idleTimeoutSeconds, null)
  draft.memoryGuardTier = 'custom'
  draft.memoryGuardCustomCeilingGb = ''
  assert.throws(() => draftToPatch(draft), (error: unknown) => error instanceof OmlxError)
})

test('admin client sends the bearer key, encodes model ids, and redacts settings', async () => {
  const seen: string[] = []
  const server = await listen(async (req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`)
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      send(res, 401, { detail: 'Invalid API key' })
      return
    }
    if (req.method === 'GET' && req.url === '/admin/api/global-settings') {
      send(res, 200, {
        server: { host: '127.0.0.1', port: 8000, log_level: 'debug' },
        model: { model_dirs: ['/models'] },
        scheduler: { max_concurrent_requests: 2, prefill_priority: 'context', concurrent_priority: 'balanced' },
        memory: { memory_guard_tier: 'balanced' },
        cache: { enabled: true, hot_cache_max_size: '0', ssd_cache_max_size: 'auto' },
        sampling: { temperature: 0.7, top_p: 0.9, top_k: 0, max_tokens: 128, max_context_window: 4096 },
        auth: { api_key: SECRET, api_key_set: true, sub_keys: [{ key: SECRET }] },
        idle_timeout: { idle_timeout_seconds: null }
      })
      return
    }
    if (req.method === 'POST' && req.url === '/admin/api/models/Qwen%203/load') {
      send(res, 200, { status: 'ok', message: 'Loaded Qwen 3' })
      return
    }
    if (req.method === 'POST' && req.url === '/admin/api/models/Qwen%203/unload') {
      send(res, 202, { status: 'unloading', message: 'Unloading Qwen 3' })
      return
    }
    if (req.method === 'GET' && req.url === '/admin/api/activity') {
      send(res, 200, {
        active_models: {
          models: [
            {
              id: 'Qwen 3',
              estimated_size_formatted: '4.2 GB',
              pinned: true,
              is_loading: false,
              active_requests: 1,
              waiting_requests: 1,
              idle_seconds: 0,
              request_abort: true,
              waiting: [{ request_id: 'wait-1', queue_position: 1 }],
              prefilling: [{ request_id: 'prefill-1', processed: 10, total: 40 }],
              generating: [{ request_id: 'gen-1', generated_tokens: 12, tokens_per_second: 30.5 }],
              api_key: SECRET
            }
          ],
          model_memory_used: 1024,
          model_memory_max: 2048,
          memory_pressure: { current_formatted: '1 KB', hard_formatted: '2 KB' }
        }
      })
      return
    }
    send(res, 404, { detail: 'missing' })
  })

  try {
    const client = createClient({ baseUrl: server.url, apiKey: SECRET })
    const settings = await client.settings()
    assert.equal(settings.apiKeySet, true)
    assert.equal(settings.logLevel, 'debug')
    assert.equal(JSON.stringify(settings).includes(SECRET), false)

    const loaded = await client.load('Qwen 3')
    assert.equal(loaded.message, 'Loaded Qwen 3')
    const unloaded = await client.unload('Qwen 3')
    assert.equal(unloaded.status, 'unloading')

    const activity = await client.activity()
    assert.equal(activity.models[0]?.requests.length, 3)
    assert.equal(activity.memoryUsedLabel, '1 KB')
    assert.equal(JSON.stringify(activity).includes(SECRET), false)
    assert.ok(seen.some((line) => line.startsWith('GET /admin/api/global-settings Bearer ')))
    assert.equal(seen.some((line) => line.includes(SECRET) && !line.includes('Bearer')), false)
  } finally {
    await close(server)
  }
})

test('admin client maps auth, conflict, memory, and missing-model errors', async () => {
  const cases = [
    { status: 401, code: 'unauthorized' },
    { status: 404, code: 'not_found' },
    { status: 409, code: 'conflict' },
    { status: 507, code: 'insufficient_memory' }
  ] as const
  for (const item of cases) {
    const server = await listen(async (_req, res) => {
      send(res, item.status, { detail: item.code })
    })
    try {
      const client = createClient({ baseUrl: server.url, apiKey: 'abcd' })
      await assert.rejects(client.models(), (error: unknown) => {
        assert.ok(error instanceof OmlxError)
        assert.equal(error.code, item.code)
        assert.equal(error.message, item.code)
        return true
      })
    } finally {
      await close(server)
    }
  }
})

test('admin client omits the header when no key is saved and refuses redirects', async () => {
  const server = await listen(async (req, res) => {
    if (req.url === '/admin/api/models') {
      assert.equal(req.headers.authorization, undefined)
      send(res, 302, '')
      res.setHeader('Location', 'http://127.0.0.1/stolen')
      return
    }
    send(res, 404, { detail: 'no' })
  })
  try {
    const client = createClient({ baseUrl: server.url, apiKey: null })
    await assert.rejects(client.models(), (error: unknown) => {
      assert.ok(error instanceof OmlxError)
      assert.equal(error.code, 'server')
      assert.equal(error.message.includes('stolen'), false)
      return true
    })
  } finally {
    await close(server)
  }
})

test('admin client times out a stalled read', async () => {
  const server = await listen(async () => {
    await new Promise(() => undefined)
  })
  try {
    const client = createClient({ baseUrl: server.url, apiKey: null }, 40)
    await assert.rejects(client.serverInfo(), (error: unknown) => {
      assert.ok(error instanceof OmlxError)
      assert.equal(error.code, 'timeout')
      return true
    })
  } finally {
    await close(server)
  }
})

function sampleSettings(): BaseSettings {
  return baseSettingsFromResponse({
    server: { host: '127.0.0.1', port: 8000, log_level: 'info' },
    model: { model_dirs: ['/models'] },
    scheduler: { max_concurrent_requests: 8, prefill_priority: 'context', concurrent_priority: 'balanced' },
    memory: { memory_guard_tier: 'balanced' },
    cache: { enabled: true, hot_cache_max_size: '8GB', ssd_cache_max_size: '32GB' },
    sampling: { temperature: 0.7, top_p: 0.9, top_k: 40, max_tokens: 1024, max_context_window: 8192 },
    auth: { api_key_set: false },
    idle_timeout: {}
  })
}

async function listen(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    void Promise.resolve(handle(req, res)).catch((error: unknown) => {
      if (!res.headersSent) send(res, 500, { detail: error instanceof Error ? error.message : 'failed' })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections?.()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

async function close(server: { close: () => Promise<void> }): Promise<void> {
  await server.close()
}
