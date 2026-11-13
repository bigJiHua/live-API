const { createToolRegistry, toolRegistry } = require('../../src/modules/ai/service/toolRegistry');
const definition = name => ({ type: 'function', function: { name, parameters: { type: 'object', additionalProperties: false } } });
const family = (overrides = {}) => ({ id: 'test', definitions: [definition('unit_tool')], matches: name => name === 'unit_tool',
  validate: () => {}, access: 'read', effect: 'read', ...overrides });

test.each([
  { definitions: [definition('unit_tool'), definition('unit_tool')] },
  { matches: () => false }, { validate: null }, { effect: null },
  { definitions: [{ type: 'function', function: { name: 'unit_tool', parameters: {} } }] },
])('startup rejects incomplete or ambiguous wiring: %j', overrides => {
  expect(() => createToolRegistry([family(overrides)])).toThrow();
});
test('overlapping classifiers cannot claim the same definition', () => {
  expect(() => createToolRegistry([family(), family({ id: 'other', definitions: [] })])).toThrow(/classifier mismatch/);
});
test('published tools route to the registered execution family; a missing executor stops startup', async () => {
  const handlers = Object.fromEntries(['business', 'context', 'calculate', 'authorization', 'search'].map(name => [name, jest.fn((tool, args) => ({ tool, args }))]));
  const dispatch = toolRegistry.dispatcher(handlers, { open: true, searchEnabled: true });
  for (const entry of toolRegistry.entries()) {
    expect(dispatch(entry.name, { value: entry.name })).toEqual({ tool: entry.name, args: { value: entry.name } });
    expect(handlers[entry.family]).toHaveBeenCalledWith(entry.name, { value: entry.name }, undefined);
  }
  delete handlers.search;
  expect(() => toolRegistry.dispatcher(handlers)).toThrow(/execution family missing/);
});
test('disabled search, legacy authorization and unregistered tools never reach an executor', () => {
  const execute = jest.fn();
  const dispatch = toolRegistry.dispatcher(Object.fromEntries(['business', 'context', 'calculate', 'authorization', 'search'].map(name => [name, execute])));
  for (const name of ['web_search', 'request_authorization', 'unregistered']) expect(() => dispatch(name, {})).toThrow(expect.objectContaining({ code: 'AI_TOOL_DENIED' }));
  expect(execute).not.toHaveBeenCalled();
});
