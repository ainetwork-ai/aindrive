import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { parseHandoffClients } from '../lib/oauth-handoff-config.js';

test('operator key configuration is public-only and fails closed', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ format: 'jwk' });
  const config = { docs: { issuer: 'https://ainize.ai', keys: [key] } };
  const parse = value => parseHandoffClients(JSON.stringify(value));
  assert.deepEqual(parse(config).docs, config.docs);
  for (const value of [null, [], { docs: { issuer: 'http://ainize.ai', keys: [key] } },
    { docs: { issuer: 'https://user:pass@ainize.ai', keys: [key] } },
    { docs: { issuer: 'https://ainize.ai?client=docs', keys: [key] } },
    { docs: { issuer: 'https://ainize.ai', keys: [] } },
    { docs: { issuer: 'https://ainize.ai', keys: [privateKey.export({ format: 'jwk' })] } },
    { ...config, invalid: { issuer: 'https://ainize.ai', keys: [{ ...key, x: 'bad' }] } }]) {
    assert.deepEqual(Object.keys(parse(value)), []);
  }
  assert.deepEqual(parseHandoffClients('{broken'), {});
});
