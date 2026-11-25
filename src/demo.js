import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportAnalysis } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';
const example = await readJson(new URL('../examples/history.json', import.meta.url), 65536);
for (const scenario of ['original', 'corrected', 'later', 'overlap', 'unknown']) {
  const directory = await mkdtemp(join(tmpdir(), 'bitemporal-demo-'));
  try {
    const input = structuredClone(example), choice = scenario === 'overlap' ? 'original' : scenario;
    if (scenario === 'overlap') input.facts.push({ ...structuredClone(input.facts[0]), id: 'other-paper' });
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    assert.equal((await step(options)).status, 'pending');
    api.answer(id(1), choice); const result = await step(options);
    if (scenario === 'unknown') assert.equal(result.status, 'unknown');
    else if (scenario === 'overlap') assert.equal(result.status, 'ambiguous');
    else {
      const exported = await exportAnalysis(directory, input); assert.equal(exported.analysis.profile.id, choice);
      const values = Object.fromEntries(exported.analysis.rows.map(row => [row.key, row.value]));
      assert.equal(values.paper, choice === 'original' ? 'A4' : 'A5'); assert.equal(values.ink, choice === 'later' ? undefined : 'black');
    }
    if (['unknown', 'overlap'].includes(scenario)) await assert.rejects(exportAnalysis(directory, input));
    assert.equal(api.calls.filter(call => call.method === 'POST').length, 1);
    console.log(JSON.stringify({ scenario, status: result.status, rows: result.analysis?.rows ?? null,
      absentKeys: result.analysis?.absentKeys ?? null, ambiguities: result.analysis?.ambiguities ?? null }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
