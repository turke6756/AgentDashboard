#!/usr/bin/env node

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDevLaunchSpec } from './dev-instance.mjs'

const dashboardKeys = [
  'DASHBOARD_PORT',
  'DASHBOARD_HOST',
  'AGENT_DASHBOARD_API_PORT',
  'AGENT_DASHBOARD_API_TOKEN',
  'AGENT_DASHBOARD_SELF_ID',
  'AGENT_DASHBOARD_WORKSPACE_ID',
]

test('REACHABILITY:wp2-dev-launcher-env clears inherited dashboard environment', () => {
  const env = {
    ...Object.fromEntries(dashboardKeys.map((key) => [key, `old-${key}`])),
    KEEP_ME: 'yes',
  }
  const before = { ...env }
  const spec = buildDevLaunchSpec(env)

  for (const key of dashboardKeys) assert.equal(key in spec.env, false, key)
  assert.equal(spec.env.KEEP_ME, 'yes')
  assert.deepEqual(env, before)
})

test('buildDevLaunchSpec selects the isolated bootstrap and default ports', () => {
  const spec = buildDevLaunchSpec({})

  assert.match(spec.command, /node_modules[\\/]electron[\\/]dist[\\/]electron(?:\.exe)?$/)
  assert.deepEqual(spec.args, ['dist-dev/main/main/bootstrap.js'])
  assert.equal(spec.env.LARES_DEV_INSTANCE, '1')
  assert.equal(spec.env.LARES_DEV_API_PORT, '24679')
  assert.equal(spec.env.LARES_DEV_WS_PORT, '4546')
  assert.equal(spec.env.LARES_DEV_JUPYTER_PORT, '18939')
})

test('buildDevLaunchSpec normalizes valid ports and defaults invalid ports', () => {
  const spec = buildDevLaunchSpec({
    LARES_DEV_API_PORT: '1',
    LARES_DEV_WS_PORT: '65535',
    LARES_DEV_JUPYTER_PORT: '04546',
  })
  assert.equal(spec.env.LARES_DEV_API_PORT, '1')
  assert.equal(spec.env.LARES_DEV_WS_PORT, '65535')
  assert.equal(spec.env.LARES_DEV_JUPYTER_PORT, '4546')

  const invalid = ['', '0', '65536', '-1', '1.5', ' 4546', '4546 ', 'nope']
  for (const value of invalid) {
    const invalidSpec = buildDevLaunchSpec({
      LARES_DEV_API_PORT: value,
      LARES_DEV_WS_PORT: value,
      LARES_DEV_JUPYTER_PORT: value,
    })
    assert.equal(invalidSpec.env.LARES_DEV_API_PORT, '24679', value)
    assert.equal(invalidSpec.env.LARES_DEV_WS_PORT, '4546', value)
    assert.equal(invalidSpec.env.LARES_DEV_JUPYTER_PORT, '18939', value)
  }
})
