import { normalizeBaseUrl, OmlxError } from './client.ts'
import type { SavedConnection, SavedConnections } from './types.ts'

export const CONNECTIONS_STORAGE_KEY = 'connections'
export const LEGACY_SECRET_KEY = 'apiKey'
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8000'

export function secretKeyFor(connectionId: string): string {
  return `apiKey:${connectionId}`
}

export function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname || 'oMLX'
  } catch {
    try {
      return new URL(baseUrl.trim()).hostname || 'oMLX'
    } catch {
      return 'oMLX'
    }
  }
}

export function defaultConnectionName(baseUrl: string): string {
  return hostnameFromBaseUrl(baseUrl)
}

export function newConnectionId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function createConnection(baseUrl: string, name?: string, id?: string): SavedConnection {
  const normalized = normalizeBaseUrl(baseUrl)
  const trimmedName = name?.trim()
  return {
    id: id ?? newConnectionId(),
    name: trimmedName && trimmedName.length > 0 ? trimmedName : defaultConnectionName(normalized),
    baseUrl: normalized
  }
}

/** Keep the auto hostname name in sync when the URL changes and the name was still the old default. */
export function resolveConnectionName(args: {
  name: string
  baseUrl: string
  previous?: SavedConnection | null
}): string {
  const trimmed = args.name.trim()
  const nextHost = defaultConnectionName(args.baseUrl)
  if (!trimmed) return nextHost
  if (!args.previous) return trimmed
  const previousDefault = defaultConnectionName(args.previous.baseUrl)
  if (args.previous.name === previousDefault && trimmed === args.previous.name) return nextHost
  return trimmed
}

export function parseSavedConnections(value: unknown): SavedConnections | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.items) || typeof record.activeId !== 'string') return null
  const items: SavedConnection[] = []
  for (const entry of record.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || !item.id) return null
    if (typeof item.name !== 'string' || !item.name.trim()) return null
    if (typeof item.baseUrl !== 'string' || !item.baseUrl.trim()) return null
    items.push({ id: item.id, name: item.name.trim(), baseUrl: item.baseUrl.trim() })
  }
  if (items.length === 0) return null
  const activeId = items.some((item) => item.id === record.activeId) ? record.activeId : items[0].id
  return { items, activeId }
}

export function migrateLegacyConnections(baseUrlRaw: string | null | undefined): SavedConnections {
  const raw = typeof baseUrlRaw === 'string' && baseUrlRaw.trim() ? baseUrlRaw.trim() : DEFAULT_BASE_URL
  let connection: SavedConnection
  try {
    connection = createConnection(raw)
  } catch {
    connection = createConnection(DEFAULT_BASE_URL)
  }
  return { items: [connection], activeId: connection.id }
}

export function activeConnection(store: SavedConnections): SavedConnection {
  return store.items.find((item) => item.id === store.activeId) ?? store.items[0]
}

export function selectConnection(store: SavedConnections, id: string): SavedConnections {
  if (!store.items.some((item) => item.id === id)) {
    throw new OmlxError('invalid_params', 'Choose a saved connection.')
  }
  return { ...store, activeId: id }
}

export function upsertConnection(
  store: SavedConnections,
  input: { id?: string; name: string; baseUrl: string }
): SavedConnections {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  if (input.id) {
    const index = store.items.findIndex((item) => item.id === input.id)
    if (index < 0) throw new OmlxError('invalid_params', 'That connection was removed.')
    const previous = store.items[index]
    const next: SavedConnection = {
      id: previous.id,
      baseUrl,
      name: resolveConnectionName({ name: input.name, baseUrl, previous })
    }
    const items = store.items.slice()
    items[index] = next
    return { items, activeId: store.activeId }
  }
  const created = createConnection(baseUrl, input.name)
  return { items: [...store.items, created], activeId: created.id }
}

export function deleteConnection(store: SavedConnections, id: string): SavedConnections {
  if (store.items.length <= 1) {
    throw new OmlxError('invalid_params', 'Keep at least one connection.')
  }
  if (!store.items.some((item) => item.id === id)) {
    throw new OmlxError('invalid_params', 'That connection was removed.')
  }
  const items = store.items.filter((item) => item.id !== id)
  const activeId = store.activeId === id ? items[0].id : store.activeId
  return { items, activeId }
}
