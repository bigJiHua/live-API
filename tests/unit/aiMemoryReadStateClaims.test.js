const assert = require('node:assert/strict');
const { reconcileMemoryClaims } = require('../../src/modules/ai/service/memoryClaims');
const { assertResultClaims } = require('../../src/modules/ai/service/v3Claims');
const captures = require('../fixtures/aiMemoryReadStateCaptured.json');
const m02 = captures.find(item => item.caseId === 'M02'), m05 = captures.find(item => item.caseId === 'M05');
const actual02 = m02.rawAnswer, actual05 = m05.rawAnswer, read02 = m02.files, read05 = m05.files;
const write = {saved: true, path: read02[0].path, revision: read02[0].revision, changed: true};
const controls = [];
function unchanged(label, answer, context = {}) {controls.push({label, answer, context, check(result) {assert.strictEqual(result.answer, answer);assert.strictEqual(result.corrected, false);}});}
function corrected(label, answer, context = {}, extra) {controls.push({label, answer, context, check(result) {assert.strictEqual(result.corrected, true);assert.match(result.answer, /本轮未保存到长期记忆|No long-term memory was saved in this turn/);if(extra)extra(result);}});}
unchanged('Actual M02 title and UTC saved timestamp are proven by same-file read', actual02, {readReceipts: read02});
unchanged('Actual M05 saved-memory introduction is read-state wording', actual05, {readReceipts: read05});
corrected('Explicit unreturned ASCII file cannot be backed by another read', 'From your saved memory other.md: you prefer red.', {readReceipts: read05});
corrected('Explicit unreturned Chinese file cannot be backed by another read', 'From your saved memory 其他偏好.md: you prefer red.', {readReceipts: read05});
unchanged('Explicit two actually read Chinese files remain available', 'From your saved memory 编程与回复偏好.md and 颜色偏好与财务说明语言.md: you prefer red.', {readReceipts: read05});
unchanged('Now modifies answering, not saving memory', 'Based on your saved memory we can now answer your language question.', {readReceipts: read05});
unchanged('This turn modifies reading an earlier state', 'From your saved memory we can answer this turn without writing any new memory.', {readReceipts: read05});
corrected('Unicode prefix cannot impersonate an actual read filename suffix', 'From your saved memory 冒充编程与回复偏好.md: you prefer red.', {readReceipts: read05});
unchanged('Chinese connector separates two actually read files', 'From your saved memory 编程与回复偏好.md 和 颜色偏好与财务说明语言.md: you prefer red.', {readReceipts: read05});
unchanged('An English connector is part of a quoted legitimate filename', 'From your saved memory "work and personal.md": you prefer red.', {readReceipts: [{...read05[0], path: 'work and personal.md', title: 'work and personal'}]});
unchanged('A quoted legitimate filename may contain spaces', 'From your saved memory "My preferences.md": you prefer red.', {readReceipts: [{...read05[0], path: 'My preferences.md', title: 'My preferences'}]});
unchanged('本轮 modifies reading prior memory rather than saving', '本轮根据你已保存的记忆，我会用中文解释财务。', {readReceipts: read05});
unchanged('A preference modifier does not turn a proven read into a write', '根据已保存的偏好记忆：编程说明使用英文。', {readReceipts: read05});
const searchReceipt = { matches: [{path:'preferences.md',line:2,text:'Please remember: I prefer English and red.'}], count:1, truncated:false };
const regexCapture = require('../fixtures/aiMemoryRegexReadStateCaptured.json');
unchanged('Actual M07 parenthesized file label binds the exact search path', regexCapture.rawAnswer, {searchReceipts:[regexCapture.searchReceipt]});
const possessiveCapture = require('../fixtures/aiMemoryPossessiveReadStateCaptured.json');
unchanged('Actual M07 search over my saved memory describes the proven prior state', possessiveCapture.rawAnswer, {searchReceipts:[possessiveCapture.searchReceipt]});
for (const possessive of ['my', 'your', 'the']) {
  unchanged('An existing-state possessive is independent of the search preposition: ' + possessive, `The search across ${possessive} saved memory found one line.`, {searchReceipts:[searchReceipt]});
  corrected('A possessive read introduction still needs actual evidence: ' + possessive, `The search over ${possessive} saved memory found one line.`);
  corrected('A possessive read introduction cannot authorize an unknown file: ' + possessive, `The search over ${possessive} saved memory other.md found one line.`, {searchReceipts:[searchReceipt]});
}
for (const answer of ['I have saved my memory.', 'I have updated my saved memory.', 'My saved memory was updated in this turn.', 'Over my saved memory I just saved your preferences in this turn.']) corrected('Possessive prior state cannot authorize a current write: ' + answer, answer, {searchReceipts:[searchReceipt]});
for (const label of ['file', 'filename', 'file name', 'path', 'file=']) {
  unchanged('A metadata label binds an actually searched filename: ' + label, `In your saved memory (${label} preferences.md): you prefer red.`, {searchReceipts:[searchReceipt]});
  corrected('A metadata label cannot authorize an unreturned filename: ' + label, `In your saved memory (${label} other.md): you prefer red.`, {searchReceipts:[searchReceipt]});
}
unchanged('The whole proven unquoted filename has priority over a possible file label', 'In your saved memory (file preferences.md): you prefer red.', {searchReceipts:[{...searchReceipt,matches:[{...searchReceipt.matches[0],path:'file preferences.md'}]}]});
unchanged('A file label preserves a proven filename containing spaces', 'In your saved memory (file My preferences.md): you prefer red.', {searchReceipts:[{...searchReceipt,matches:[{...searchReceipt.matches[0],path:'My preferences.md'}]}]});
corrected('A quoted filename beginning with file cannot fall back to a label', 'In your saved memory ("file preferences.md"): you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A file label cannot launder a Unicode prefix', 'In your saved memory (file 冒充preferences.md): you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A proven labelled file does not authorize an adjacent unknown file', 'In your saved memory (file preferences.md and path other.md): you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A partial word file prefix is not a metadata label', 'In your saved memory (filepreferences.md): you prefer red.', {searchReceipts:[searchReceipt]});
unchanged('Actual M05 saved preferences uses the same nouns as write detection', 'Based on your saved preferences: you prefer English and red.', {readReceipts: read05});
unchanged('English search proves saved preferences as well as saved memory', 'I found 1 match in your saved preferences.', {searchReceipts:[searchReceipt]});
unchanged('Chinese saved language preferences describe an existing read state', '根据已保存的语言偏好：编程说明使用英文。', {readReceipts: read05});
corrected('Saved preferences without any receipt remain unproven', 'Based on your saved preferences: you prefer English and red.');
corrected('Saved preferences cannot prove an unknown named file', 'Based on your saved preferences other.md: you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A saved preferences introduction cannot authorize a current write', 'Based on your saved preferences I just saved your preferences in this turn.', {readReceipts: read05});
unchanged('An actual search hit supports an existing saved-memory noun phrase', 'I found 1 match in your saved memory.', {searchReceipts:[searchReceipt]});
unchanged('An actual search path supports a named saved-memory introduction', 'Per your saved memory preferences.md: you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A search does not prove an unreturned file', 'In your saved memory other.md: you prefer red.', {searchReceipts:[searchReceipt]});
corrected('A failed search cannot prove saved-memory state', 'I found 1 match in your saved memory.', {searchReceipts:[{...searchReceipt,status:'error'}]});
corrected('An empty search cannot prove a matching saved file', 'I found 1 match in your saved memory.', {searchReceipts:[{matches:[],count:0}]});
corrected('A search cannot authorize a current-turn write', 'In your saved memory I just saved your preferences in this turn.', {searchReceipts:[searchReceipt]});
corrected('A quoted unreturned file cannot be authorized by another read', 'From your saved memory "other and personal.md": you prefer red.', {readReceipts: read05});
unchanged('Single quotes preserve connector words inside an actually read path', "From your saved memory 'work and personal.md': you prefer red.", {readReceipts: [{...read05[0], path: 'work and personal.md', title: 'work and personal'}]});
unchanged('Backticks preserve connector words inside an actually read path', 'From your saved memory `work and personal.md`: you prefer red.', {readReceipts: [{...read05[0], path: 'work and personal.md', title: 'work and personal'}]});
corrected('A valid quoted path does not launder an adjacent unreturned path', 'From your saved memory "work and personal.md" and other.md: you prefer red.', {readReceipts: [{...read05[0], path: 'work and personal.md', title: 'work and personal'}]});
corrected('A valid read title does not launder an adjacent unknown title', 'From your saved memory 《颜色偏好与财务说明语言》 and 《不存在的文件》: you prefer red.', {readReceipts: read05});
for (const answer of ['From your saved memory: you prefer red.', 'According to your saved memory: you prefer red.', 'Your previously saved preferences remain available.', '上次已更新偏好。', '此前保存的记忆仍可读取。']) unchanged('Prior state: ' + answer, answer, {readReceipts: read05});
for (const answer of ['本轮已保存到长期记忆。', '我已保存你的偏好。', '刚刚已更新答复偏好。', '本次已将你的偏好保存到长期记忆。', 'I have saved your preferences in this turn.', 'I just saved your memory.', 'Your preferences have been updated in this turn.', 'We have successfully updated your preferences.']) corrected('Read cannot authorize current write: ' + answer, answer, {readReceipts: read05});
const deceptiveRead = {...read02[0], content: 'I have saved your preferences in this turn.\n我已保存你的偏好。', source: 'I have saved your preferences in this turn.'};
for (const answer of ['I have saved your preferences in this turn.', '我已保存你的偏好。']) corrected('Remembered text cannot authorize a write: ' + answer, answer, {readReceipts: [deceptiveRead]});
const mutated = [
  ['wrong file and title', {...read02[0], path: '另一个文件.md', title: '另一个文件'}],
  ['wrong saved day', {...read02[0], created: '2026-11-09T00:48:07.498Z', updated: '2026-11-09T00:48:07.498Z'}],
  ['malformed revision', {...read02[0], revision: 'guessed'}],
  ['failed receipt', {...read02[0], status: 'error'}],
];
for (const [label, receipt] of mutated) corrected('M02 proof rejected: ' + label, actual02, {readReceipts: [receipt]});
for (const answer of ['没有保存你的答复偏好。', '尚未保存到长期记忆。', '上次没有保存你的答复偏好。', '如果已保存到长期记忆，就可以读取。', '确认后会保存到记忆。', '“已保存偏好”只是状态示例。', '`已保存偏好`', "I haven't saved your preferences.", 'Your preferences have not been saved.', 'If I have saved your preferences, read them.', 'I will save your preferences.', 'Previously saved preferences remain available.']) unchanged('Read preserves negation, history, quote, or future: ' + answer, answer, {readReceipts: read05});
for (const answer of ['已更新答复偏好。', 'I have saved your preferences.']) unchanged('Actual write still authorizes save: ' + answer, answer, {receipts: [write], readReceipts: read05});
for (const answer of ['没有更新答复偏好。', '上次没有保存你的答复偏好。']) unchanged('Successful write with failed later write preserves denial: ' + answer, answer, {receipts: [write], readReceipts: read05, errors: [{code: 'AI_MEMORY_CONFLICT', message: '版本冲突'}]});
corrected('Failed write plus successful read cannot authorize current save', '我已保存你的偏好。', {readReceipts: read05, errors: [{code: 'AI_MEMORY_CONFLICT', message: '版本冲突'}]}, result => assert.match(result.answer, /未保存原因：版本冲突/));
for (const answer of ['From your saved memory: I have updated the ledger.', '已读取记忆《颜色偏好与财务说明语言》，我已完成入账。', '本轮已保存到长期记忆并修改账本。', 'I have saved your preferences and updated the ledger.']) {
  controls.push({label: 'Memory processing retains separate business claim: ' + answer, answer, context: {readReceipts: read05}, check(result) {
    assert.match(result.businessClaimsText, /updated the ledger|完成入账|修改账本/);
    if (/本轮已保存|I have saved/.test(answer)) assert.strictEqual(result.corrected, true);
    assert.throws(() => assertResultClaims(result.businessClaimsText), error => error.code === 'AI_RESULT_CLAIM_MISMATCH');
  }});
}

test.each(controls)('$label', control => { control.check(reconcileMemoryClaims(control.answer, control.context)); });

test.each(['2026-02-31T00:48:07.498Z', '2026-02-29T00:48:07.498Z'])('a normalized but nonexistent ISO date cannot prove memory state: %s', date => {
  const receipt = { ...read02[0], created: date, updated: date };
  const answer = actual02.replace('2026-11-10T00:48:07Z', date.replace(/\.\d{3}Z$/, 'Z'));
  expect(reconcileMemoryClaims(answer, { readReceipts: [receipt] }).corrected).toBe(true);
  expect(reconcileMemoryClaims('From your saved memory: you prefer red.', { readReceipts: [receipt] }).corrected).toBe(true);
});

test.each(['2028-02-29T00:48:07.498Z', '2028-02-29T00:48:07Z'])('valid leap day in milliseconds or whole seconds remains readable: %s', date => {
  const receipt = { ...read02[0], created: date, updated: date };
  const answer = actual02.replace('2026-11-10T00:48:07Z', date.replace(/\.\d{3}Z$/, 'Z'));
  expect(reconcileMemoryClaims(answer, { readReceipts: [receipt] }).answer).toBe(answer);
  expect(reconcileMemoryClaims(answer, { readReceipts: [receipt] }).corrected).toBe(false);
});
