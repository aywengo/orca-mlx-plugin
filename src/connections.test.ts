import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createConnection,
  defaultConnectionName,
  deleteConnection,
  hostnameFromBaseUrl,
  migrateLegacyConnections,
  parseSavedConnections,
  resolveConnectionName,
  secretKeyFor,
  selectConnection,
  upsertConnection
} from './connections.ts'

test('hostname and default name come from the URL host', () => {
  assert.equal(hostnameFromBaseUrl('http://127.0.0.1:8000'), '127.0.0.1')
  assert.equal(defaultConnectionName('https://studio.local:8000/'), 'studio.local')
  assert.equal(secretKeyFor('c_1'), 'apiKey:c_1')
})

test('createConnection normalizes the URL and fills a hostname name', () => {
  const connection = createConnection('http://mac.local:8000/', '  ')
  assert.equal(connection.baseUrl, 'http://mac.local:8000')
  assert.equal(connection.name, 'mac.local')
  assert.ok(connection.id.startsWith('c_'))
})

test('resolveConnectionName follows the host when the name was still the auto default', () => {
  const previous = createConnection('http://127.0.0.1:8000', '127.0.0.1', 'c_a')
  assert.equal(
    resolveConnectionName({ name: '127.0.0.1', baseUrl: 'http://studio.local:8000', previous }),
    'studio.local'
  )
  assert.equal(
    resolveConnectionName({ name: 'Home Mac', baseUrl: 'http://studio.local:8000', previous }),
    'Home Mac'
  )
})

test('parseSavedConnections accepts a valid store and rejects junk', () => {
  const parsed = parseSavedConnections({
    activeId: 'b',
    items: [
      { id: 'a', name: 'A', baseUrl: 'http://127.0.0.1:8000' },
      { id: 'b', name: 'B', baseUrl: 'http://studio.local:8000' }
    ]
  })
  assert.equal(parsed?.activeId, 'b')
  assert.equal(parsed?.items.length, 2)
  assert.equal(parseSavedConnections({ items: [] }), null)
  assert.equal(parseSavedConnections(null), null)
})

test('migrateLegacyConnections builds one connection from the old URL', () => {
  const store = migrateLegacyConnections('http://127.0.0.1:8000')
  assert.equal(store.items.length, 1)
  assert.equal(store.items[0].name, '127.0.0.1')
  assert.equal(store.items[0].baseUrl, 'http://127.0.0.1:8000')
  assert.equal(store.activeId, store.items[0].id)
})

test('upsert, select, and delete maintain the active connection', () => {
  let store = migrateLegacyConnections('http://127.0.0.1:8000')
  store = upsertConnection(store, { name: '', baseUrl: 'http://studio.local:8000' })
  assert.equal(store.items.length, 2)
  assert.equal(store.items[1].name, 'studio.local')
  assert.equal(store.activeId, store.items[1].id)

  store = selectConnection(store, store.items[0].id)
  assert.equal(store.activeId, store.items[0].id)

  const removed = store.items[0].id
  store = deleteConnection(store, removed)
  assert.equal(store.items.length, 1)
  assert.equal(store.activeId, store.items[0].id)
  assert.throws(() => deleteConnection(store, store.items[0].id), /at least one/)
})
