const { classifyCurrentTurn } = require('../../src/modules/ai/service/currentTurnIntent');
const { buildTaskContext, finalizeTaskContext } = require('../../src/modules/ai/service/taskContext');
const { buildQueryContext, finalizeQueryContext } = require('../../src/modules/ai/service/queryContext');
const { selectTaskContext } = require('../../src/modules/ai/service/contextState');
const { buildQueryTaskBindings } = require('../../src/modules/ai/service/queryTaskBindings');
const { buildDatasetIntent } = require('../../src/modules/ai/service/queryDatasetIntent');
const today = '2026-11-12';
const oldQuery = finalizeQueryContext(buildQueryContext({ message: '查9月收支，给我图表', today }),
  { status: 'succeeded', turnId: 'completed_query' });
const oldTask = finalizeTaskContext(buildTaskContext({ message: '最近三个月按卡片分别展示月度消费，生成折线图', today }),
  { status: 'succeeded', turnId: 'completed_chart' });
const registry = { version: 1, tasks: [oldTask] };

test.each([
  '你可以新增记忆么，如果可以，新增一个记忆就是：如果对话内我只让你生成图表，那么就无需回复过多，只需要输出对应的图表数据即可',
  '你这一次不是已经可以正确的生成图表了吗？用的什么能力工具告诉我你看到的',
  '你能修改固定资产的什么数据？',
  '固定资产可以修改哪些字段？',
  '以后我只让你生成图表就只回复数据',
  '你刚才为什么生成了图表？',
  '这个图表挺清楚的',
  '图表生成成功了',
  '谢谢图表',
  '图表是什么意思',
  '买菜20元上次已经记好了',
  '记住以下偏好：\n- 查支出时只生成图表\n- 固定资产只展示数据',
  '保存一条记忆：\n查询每月支出图表\n只输出对应的数据',
])('auxiliary turn does not reactivate a completed query: %s', message => {
  const intent = classifyCurrentTurn(message);
  expect(intent.businessSuppressed).toBe(true);
  expect(intent.auxiliaryRequest).toBe(true);
  expect(intent.businessMessage).toBe('');
  expect(selectTaskContext(registry, { message, previous: oldTask })).toBeNull();
  expect(buildQueryContext({ message, today, previous: oldQuery })).toBeNull();
  const task = buildTaskContext({ message, today, previous: oldTask, queryContext: oldQuery });
  expect(task).toMatchObject({ mode: 'chat', subject: null, metric: null, chartRequest: null });
  expect(task.scope).toBeUndefined();
  expect(task.targetDatasetId).toBeUndefined();
  expect(buildQueryTaskBindings({ message, today, tasks: registry })).toEqual([]);
  expect(buildDatasetIntent({ message, subject: 'cards', metric: 'card-consumption', mode: 'query', previous: oldTask,
    followup: true, sameTask: true })).toEqual({});
});

test('memory operations distinguish requested writes, reads, searches and lists', () => {
  expect(classifyCurrentTurn('你可以新增记忆么，如果可以，新增一个记忆就是：以后图表只给数据').memoryOperation).toBe('write');
  expect(classifyCurrentTurn('你可以新增记忆吗？').memoryOperation).toBeNull();
  expect(classifyCurrentTurn('读取我的记忆内容').memoryOperation).toBe('read');
  expect(classifyCurrentTurn('搜索我的记忆中的图表').memoryOperation).toBe('search');
  expect(classifyCurrentTurn('列出已有记忆目录').memoryOperation).toBe('list');
});

test.each([
  '我之前对颜色和财务答复语言有什么偏好？请先读取已保存记忆再回答。',
  '我之前有什么偏好？请先读取记忆再回答。',
  '请先读取已保存的记忆再回答。',
  '请先读取已经保存的记忆再回答。',
  '请先读取已更新的记忆再回答。',
  '请先读取曾经保存的记忆再回答。',
])('reading a persisted memory is read-only despite prior-state and question wording: %s', message => {
  expect(classifyCurrentTurn(message)).toMatchObject({ memoryRequest: true, memoryOperation: 'read',
    businessSuppressed: true, businessMessage: '' });
});

test.each([
  '请保存记忆：我喜欢红色。',
  '请先读取已保存记忆，然后保存一条记忆：我喜欢红色。',
  '先读取已经保存的记忆，同时更新记忆：我喜欢红色。',
  '读取已保存的记忆之后，请记住：我喜欢红色。',
])('an explicit current write remains required after reading existing memory: %s', message => {
  expect(classifyCurrentTurn(message)).toMatchObject({ memoryRequest: true, memoryOperation: 'write',
    businessSuppressed: true });
});

test.each(['列出已保存的记忆目录', '请读取已保存记忆的目录'])
  ('directory and saved-memory listing requests retain the list operation: %s', message => {
    expect(classifyCurrentTurn(message).memoryOperation).toBe('list');
  });

test.each([
  '请先读取已经保存的记忆，但不要保存新记忆。',
  '不要保存新的记忆，只读取已经保存的记忆。',
  '请读取已保存的记忆，但不要搜索记忆。',
])('a read plus denied mutation/search still requests only a memory read: %s', message => {
  expect(classifyCurrentTurn(message)).toMatchObject({ memoryRequest: true, memoryOperation: 'read', businessSuppressed: true });
});

test.each([
  '读取已保存记忆后记住新的长期偏好。',
  '读取已经保存的记忆，再删除旧记忆。',
])('a subsequent affirmative mutation is retained after an existing-memory read: %s', message => {
  expect(classifyCurrentTurn(message).memoryOperation).toBe(/删除/.test(message) ? 'delete' : 'write');
});

test('reading existing memory before a large-range analysis does not create a write obligation or discard the business query', () => {
  const message = '请先读取已保存的记忆，然后分析2023年11月12日至2026年11月12日的收支。';
  expect(classifyCurrentTurn(message)).toMatchObject({ memoryRequest: true, memoryOperation: 'read', businessSuppressed: false });
  const context = buildQueryContext({ message, today });
  expect(context.activeQuery).toMatchObject({ startDate: '2023-11-12', endDate: '2026-11-12' });
});

test.each([
  '记住图表简洁偏好，同时查本月支出',
  '记住：如果我只要求图表，就只输出数据。另外查询本月支出',
  '你刚才用的什么工具？另外查本月支出',
  '查询本月支出，同时保存一条记忆：以后图表只给数据',
  '保存一条记忆：我喜欢简洁的图表。然后查本月支出',
  '这个图表挺清楚的。另外查本月支出',
])('mixed auxiliary and business requests keep only the actual business clause: %s', message => {
  const intent = classifyCurrentTurn(message);
  expect(intent.businessSuppressed).toBe(false);
  expect(intent.businessMessage).toMatch(/查.*本月支出/);
  expect(intent.businessMessage).not.toMatch(/记忆|记住|图表|工具/);
  const queryContext = buildQueryContext({ message, today, previous: oldQuery });
  const task = buildTaskContext({ message, today, previous: oldTask, queryContext });
  expect(task).toMatchObject({ mode: 'query', subject: 'finance', chartRequest: null,
    scope: { startDate: '2026-11-01', endDate: today } });
});

test('new-topic command clears inherited intent while allowing its new query', () => {
  const reset = '忘记上面的内容，我们开启新的话题';
  expect(classifyCurrentTurn(reset)).toMatchObject({ topicReset: true, businessSuppressed: true });
  expect(selectTaskContext(registry, { message: reset, previous: oldTask })).toBeNull();
  const message = reset + '。查本月支出';
  const queryContext = buildQueryContext({ message, today, previous: oldQuery });
  expect(queryContext.activeQuery).toMatchObject({ startDate: '2026-11-01', endDate: today, periodSource: 'current' });
  expect(queryContext.lastResults).toBeUndefined();
  expect(buildTaskContext({ message, today, previous: oldTask, queryContext })).toMatchObject({ mode: 'query', subject: 'finance', chartRequest: null });
});

test.each(['不要开启新的话题', '如果我说开启新的话题会怎样', '例如忘记上面的内容', '不要忘记上面的内容', '如何开启新的话题'])
  ('discussing or denying a topic reset cannot create a durable boundary: %s', message => {
    expect(classifyCurrentTurn(message).topicReset).toBe(false);
  });

test.each([
  '记住：开启新的话题以后，图表只给数据',
  '保存一条记忆：我们开启新的话题时，图表只给数据',
  '记住：如果开启新话题，就忘记上面内容',
  '记住：\n开启新的话题。\n查询每月支出图表',
  '记住，如果开启新的话题，就忘记上面内容',
])('reset words in unquoted memory content never end the live topic: %s', message => {
  expect(classifyCurrentTurn(message)).toMatchObject({ topicReset: false, memoryRequest: true,
    memoryOperation: 'write', businessSuppressed: true });
});

test('an explicit independent reset after a memory request remains a live boundary', () => {
  expect(classifyCurrentTurn('记住我的图表偏好，同时开启新的话题')).toMatchObject({
    topicReset: true, memoryRequest: true, memoryOperation: 'write', businessSuppressed: true });
});

test.each(['不要记住我的图表偏好', '如果我说记住我的图表偏好会怎样', '如何保存我的记忆'])
  ('negated and hypothetical memory mutations do not require a write: %s', message => {
    expect(classifyCurrentTurn(message).memoryOperation).toBeNull();
  });

test.each(['按月份给我看走势', '信用卡呢？', '信用卡呢', '改成饼图', '帮我重新生成图表', '不用改饼图，只看借记卡数量'])
  ('actual chart and parameter followups preserve ordinary parsing: %s', message => {
    expect(classifyCurrentTurn(message)).toMatchObject({ businessMessage: message, auxiliaryRequest: false, businessSuppressed: false });
    expect(buildTaskContext({ message, today, previous: oldTask }).mode).toBe('query');
  });

test('a bare named account continues to be an account supplement rather than a query', () => {
  const message = '农业银行7476那张';
  const task = buildTaskContext({ message, today, previous: oldTask, pendingContext: { status: 'awaiting_input' } });
  expect(task.mode).toBe('pending-supplement');
  expect(buildQueryContext({ message, today, previous: oldQuery })).toBeNull();
});

test.each(['你可以帮我查询本月支出吗？', '你可以给我生成本月收支图表吗？', '查一下当前固定资产', '给我生成本月收支图表', '买菜花了20元', '我目前登记的固定资产有哪些'])
  ('polite and direct business requests remain active: %s', message => {
    expect(classifyCurrentTurn(message).businessMessage).toBe(message);
    expect(classifyCurrentTurn(message).businessSuppressed).toBe(false);
  });

test('quoted memory and tool examples cannot create auxiliary instructions', () => {
  const message = '查询备注为“记住图表只给数据”的本月支出';
  expect(classifyCurrentTurn(message)).toMatchObject({ businessMessage: message, auxiliaryRequest: false });
});

test('a business query about purchased tools is not an assistant capability question', () => {
  const message = '查询本月有哪些工具支出';
  expect(classifyCurrentTurn(message)).toMatchObject({ businessMessage: message, capabilityQuestion: false, businessSuppressed: false });
});
