import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'

const SCHEMA_URL =
  'https://raw.githubusercontent.com/stablyai/orca/main/docs/schemas/plugins/orca-plugin.v2.schema.json'

test('orca-plugin.json matches the published Orca manifest schema', async () => {
  const response = await fetch(SCHEMA_URL)
  assert.equal(response.ok, true)
  const schema = (await response.json()) as Record<string, unknown>
  const manifest = JSON.parse(await readFile(new URL('../orca-plugin.json', import.meta.url), 'utf8')) as unknown
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  const valid = validate(manifest)
  assert.equal(valid, true, ajv.errorsText(validate.errors, { separator: '\n' }))
})
