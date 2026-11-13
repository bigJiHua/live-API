jest.mock('../../src/common/config/db', () => ({ execute: jest.fn(() => { throw Error('Public DB forbidden'); }), getConnection: jest.fn(() => { throw Error('Public DB forbidden'); }) }));
jest.mock('../../src/modules/ai/service/deepseek', () => ({ deepseekChat: jest.fn(() => { throw Error('Paid provider forbidden'); }) }));
const { fixture, final, calls } = require('../fixtures/aiV3MemoryFixture');
const captures = require('../fixtures/aiMemoryReadStateCaptured.json');
const clone = value => structuredClone(value);
let log, error, warn;
beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); error = jest.spyOn(console, 'error').mockImplementation(() => {}); warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  log.mockRestore(); error.mockRestore(); warn.mockRestore();
  expect(require('../../src/common/config/db').execute).not.toHaveBeenCalled();
  expect(require('../../src/common/config/db').getConnection).not.toHaveBeenCalled();
  expect(require('../../src/modules/ai/service/deepseek').deepseekChat).not.toHaveBeenCalled();
});
function store(entries) {
  return { list: jest.fn(async () => ({ files: entries, warnings: [], totalBytes: entries.reduce((total, file) => total + file.bytes, 0), truncated: false })),
    read: jest.fn(async (_, args) => { const found = entries.find(file => file.path === args.path); if (!found) throw Error('Unknown captured memory'); return clone(found); }),
    write: jest.fn(async () => { throw Error('Read-state replay must never write memory'); }) };
}
test.each(captures)('$caseId captured three-round response preserves proven read state without writing', async capture => {
  const entries = clone(capture.files), before = clone(entries), memoryStore = store(entries);
  const f = fixture(capture.providers, { memoryStore, clock: () => new Date(capture.clock) });
  const result = await f.send(capture.message);
  expect(f.provider).toHaveBeenCalledTimes(3);
  expect(memoryStore.read).toHaveBeenCalledTimes(capture.caseId === 'M02' ? 1 : 2);
  expect(memoryStore.write).not.toHaveBeenCalled(); expect(entries).toEqual(before);
  expect(result.toolTrace.filter(trace => trace.tool === 'memory_write')).toHaveLength(0);
  expect(result.datasets).toEqual([]); expect(result.answer).toBe(capture.rawAnswer);
  expect(result.answer).not.toBe(capture.previousIncorrectAnswer);
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
  expect(f.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(f.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});
test.each(['index-only', 'list-only', 'read-error'])('%s does not prove a memory-read introduction', async mode => {
  const capture = captures[0], memoryStore = store(clone(capture.files));
  const response = final({ answer: 'From your saved memory: you prefer red.' });
  const scripted = mode === 'index-only' ? [response] : [calls(mode === 'list-only' ? 'memory_list' : 'memory_read', mode === 'list-only' ? {} : { path: 'unknown.md' }), response];
  const f = fixture(scripted, { memoryStore, clock: () => new Date(capture.clock) });
  const result = await f.send('Read my saved memory first.');
  expect(result.answer).toContain('No long-term memory was saved in this turn'); expect(memoryStore.write).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(result.answer);
});
test('a successful read does not authorize a current-turn saved claim or a ledger mutation', async () => {
  const capture = captures[0], memoryStore = store(clone(capture.files));
  const make = answer => fixture([calls('memory_read', { path: capture.files[0].path }), final({ answer })], { memoryStore, clock: () => new Date(capture.clock) });
  const read = make('I have saved your preferences in this turn.');
  const result = await read.send('Read my saved memory first.');
  expect(result.answer).toContain('No long-term memory was saved in this turn'); expect(memoryStore.write).not.toHaveBeenCalled();
  const business = make('From your saved memory: I have updated the ledger.');
  await expect(business.send('Read my saved memory first.')).rejects.toMatchObject({ code: 'AI_RESULT_CLAIM_MISMATCH' });
  expect(business.legacy.prepareTransactionProposal).not.toHaveBeenCalled(); expect(business.legacy.persistTransactionBatch).not.toHaveBeenCalled();
});

test.each(['memory', 'preferences'])('an actual search result retains saved-%s read wording without authorizing writes', async noun => {
  const memoryStore = store([]);
  memoryStore.search = jest.fn(async () => ({ matches:[{path:'preferences.md',line:2,text:'I prefer English and red.'}], count:1, truncated:false, warnings:[] }));
  const answer = `I found 1 match in your saved ${noun}. File: preferences.md; I prefer English and red.`;
  const f = fixture([calls('memory_search', {pattern:'English',mode:'literal'}), final({answer})], {memoryStore});
  const result = await f.send('Search my saved memory for English.');
  expect(result.answer).toBe(answer);
  expect(memoryStore.search).toHaveBeenCalledTimes(1);
  expect(memoryStore.read).not.toHaveBeenCalled();
  expect(memoryStore.write).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(answer);
});

test.each([require('../fixtures/aiMemoryRegexReadStateCaptured.json'), require('../fixtures/aiMemoryPossessiveReadStateCaptured.json')])('actual M07 $requestId preserves prior state and original line through history and recovery', async capture => {
  const memoryStore = store([]);
  memoryStore.search = jest.fn(async () => clone(capture.searchReceipt));
  const f = fixture(capture.providers, {memoryStore, clock: () => new Date(capture.clock)});
  const result = await f.send(capture.message);
  expect(result.answer).toBe(capture.rawAnswer);
  expect(result.answer).not.toBe(capture.previousIncorrectAnswer);
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.provider.mock.calls[1][2]).toEqual([]);
  expect(memoryStore.search).toHaveBeenCalledTimes(1);
  expect(memoryStore.read).not.toHaveBeenCalled(); expect(memoryStore.write).not.toHaveBeenCalled();
  expect(f.state.conversationStore.append.mock.calls.at(-1)[2].answer).toBe(capture.rawAnswer);
  expect(f.state.requestGuard.saveV3Recovery.mock.calls.at(-1)[3]).toEqual(result);
});
