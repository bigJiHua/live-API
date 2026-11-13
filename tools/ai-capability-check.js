// Long-lived gate: the registry is used by model exposure AND live execution.
const assert = require('assert/strict');
const { toolRegistry } = require('../src/modules/ai/service/toolRegistry');
const { DATASET_CAPABILITIES } = require('../src/modules/ai/service/datasetCapabilities');
const modes = [{}, { open: true }, { open: true, searchEnabled: true }];
for (const mode of modes) {
  const definitions = toolRegistry.definitions(mode);
  assert.equal(new Set(definitions.map(item => item.function.name)).size, definitions.length);
  for (const definition of definitions) {
    const entry = toolRegistry.resolve(definition.function.name, mode);
    assert.equal(typeof entry.validate, 'function');
    assert.throws(() => entry.validate(entry.name, { __unknown_field: true }), `${entry.name} must reject invalid arguments`);
  }
  const query = definitions.find(item => item.function.name === 'query_data');
  assert.deepEqual(query.function.parameters.anyOf.map(branch => branch.properties.datasetId.enum[0]).sort(), Object.keys(DATASET_CAPABILITIES).sort());
}
assert.throws(() => toolRegistry.dispatcher({}), /execution family missing/);
assert.throws(() => toolRegistry.resolve('__unregistered__'), { code: 'AI_TOOL_DENIED' });
console.log(`AI capability wiring passed: ${toolRegistry.entries().length} tools, ${Object.keys(DATASET_CAPABILITIES).length} datasets; invalid/missing wiring rejected.`);
