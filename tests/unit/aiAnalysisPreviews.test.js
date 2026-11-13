const { createPreviewStore, TTL, MAX_BYTES } = require('../../src/modules/ai/service/analysisPreviews');
const { encryptField, decryptField } = require('../../src/common/utils/fieldCrypto');
const scope = { domains: ['finance'], startDate: '2026-11-01', endDate: '2026-11-06' };
const owner = 'private-owner-uuid';
const card = 'private-card-uuid';
const category = 'private-category-uuid';
const flow = 'private-flow-uuid';
const snapshot = () => ({ scope, asOf: '2026-11-06T04:00:00Z', datasets: [{ datasetId: 'finance-transactions', domain: 'finance', title: '收支',
  columns: [{ key: 'amountCNY', label: '金额', type: 'money' }, { key: 'remark', label: '备注', type: 'text' }],
  rows: [{ id: flow, cardId: card, categoryId: category, user_id: owner, amountCNY: '39.91',
    remark: `停车费 ${card} 6212345678901234 https://internal.example/secret user@example.com`, password: 'secret' }],
  summary: { expense: '39.91', count: 1 }, policy: '不执行写入', asOf: '2026-11-06T04:00:00Z', truncated: false }],
  choices: { cards: [{ id: card, name: '日常账户' }], categories: [{ id: category, name: '交通', type: 'expense' }], funds: [], todos: [], fixedAssets: [], moods: ['开心'] } });

let db, records, current, store;
beforeEach(() => {
  current = Date.parse('2026-11-06T04:00:00Z');
  records = new Map();
  db = { execute: jest.fn(async (sql, params) => {
    if (sql.startsWith("UPDATE ai_analysis_preview SET payload = 'expired'")) {
      let cleared = 0;
      for (const row of records.values()) if (row.user_id === params[0] && row.expires_at <= params[1] && row.payload !== 'expired' && cleared < 100) { row.payload = 'expired'; cleared++; }
      return [{ affectedRows: cleared }];
    }
    if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at = -1')) {
      const [id, userId, stamp] = params, row = records.get(id);
      if (!row || row.user_id !== userId || row.expires_at <= stamp || row.request_id != null) return [{ affectedRows: 0 }];
      row.approved_at = -1; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('INSERT')) {
      const [id, user_id, digest, payload, created_at, expires_at] = params;
      records.set(id, { id, user_id, digest, payload, created_at, expires_at, approved_at: null });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT')) {
      const [id, userId, at] = params, row = records.get(id);
      return [[...(row && row.user_id === userId && row.expires_at > at ? [row] : [])]];
    }
    if (sql.startsWith('UPDATE')) {
      const [at, id, userId, expires] = params, row = records.get(id);
      if (row && row.user_id === userId && row.expires_at > expires && row.approved_at == null) { row.approved_at = at; return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    }
    throw new Error('Unexpected SQL');
  }) };
  store = createPreviewStore({ executor: db, now: () => current });
});
const prepare = () => store.prepare(owner, { message: `分析这笔 ${flow}，卡号 6212345678901234`, scope, snapshot: snapshot(), provider: 'fingerprint', connectionId: 'connection' });

test('preview is encrypted; external data uses random opaque refs and matches the displayed preview', async () => {
  const result = await prepare();
  expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.records).toBe(1);
  expect(result.fields).toBe(2);
  const stored = records.get(result.previewId);
  expect(stored.payload).toMatch(/^enc.v1:/);
  expect(stored.payload).not.toContain(card);
  await expect(store.toProvider(owner, result.previewId)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  const approved = await store.approveAndGet(owner, result.previewId, true);
  expect(approved.provider).toBe('fingerprint');
  const provider = await store.toProvider(owner, result.previewId);
  expect(provider.datasets).toEqual(result.datasets);
  expect(provider.choices).toEqual(result.choices);
  const wire = JSON.stringify(provider);
  expect(wire).not.toMatch(/private-owner-uuid|private-card-uuid|private-category-uuid|private-flow-uuid|6212345678901234|internal\.example|user@example|password|user_id/);
  expect(provider.datasets[0].rows[0].cardRef).toBe(provider.choices.cards[0].ref);
  expect(provider.choices.cards[0].ref).toMatch(/^r_[0-9a-f]{32}$/);
  expect(await store.resolve(owner, result.previewId, provider.choices.cards[0].ref, 'card')).toBe(card);
  const another = await prepare();
  expect(another.choices.cards[0].ref).not.toBe(result.choices.cards[0].ref);
});

test('calendar timestamps survive approved display/provider data while long numbers in text remain hidden', async () => {
  const accountScope={...scope,domains:['account']},instant='2026-11-07T07:38:13.155Z';
  const data={scope:accountScope,asOf:instant,datasets:[{datasetId:'account-balances',domain:'account',title:'账户余额',
    columns:[{key:'name',label:'账户',type:'text'},{key:'updatedAt',label:'最后保存时间',type:'text'}],
    rows:[{name:'合成账户 13800138000 6212345678901234',updatedAt:instant},{name:'未知账户',updatedAt:null}],summary:{}}],choices:{}};
  const result=await store.prepare(owner,{message:'查看账户 13800138000',scope:accountScope,snapshot:data});
  expect(result.datasets[0].rows[0].updatedAt).toBe(instant);expect(result.datasets[0].rows[1].updatedAt).toBeNull();
  expect(result.datasets[0].rows[0].name).not.toMatch(/13800138000|6212345678901234/);
  await store.approveAndGet(owner,result.previewId,true);const provider=await store.toProvider(owner,result.previewId);
  expect(provider.datasets).toEqual(result.datasets);expect(JSON.stringify(provider)).not.toMatch(/13800138000|6212345678901234/);
});

test.each([false, undefined, 1, 'true', {}])('consent must be literal true: %j', async consent => {
  const result = await prepare();
  await expect(store.approveAndGet(owner, result.previewId, consent)).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  expect(records.get(result.previewId).approved_at).toBeNull();
});

test('preview is bound to owner and expires; approval and reference lookup fail closed', async () => {
  const result = await prepare();
  await expect(store.get('other-owner', result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_EXPIRED' });
  await expect(store.resolve(owner, result.previewId, result.choices.cards[0].ref, 'card')).rejects.toMatchObject({ code: 'AI_CONSENT_REQUIRED' });
  await store.approveAndGet(owner, result.previewId, true);
  await expect(store.resolve(owner, result.previewId, result.choices.cards[0].ref, 'category')).rejects.toMatchObject({ code: 'AI_REF_INVALID' });
  await expect(store.resolve(owner, result.previewId, card, 'card')).rejects.toMatchObject({ code: 'AI_REF_INVALID' });
  current += TTL;
  await expect(store.toProvider(owner, result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_EXPIRED' });
  await expect(store.approveAndGet(owner, result.previewId, true)).rejects.toMatchObject({ code: 'AI_PREVIEW_EXPIRED' });
});

test('approval is idempotent and preserves the original approval timestamp', async () => {
  const result = await prepare();
  const approved = await store.approveAndGet(owner, result.previewId, true);
  current += 1000;
  expect((await store.approveAndGet(owner, result.previewId, true)).approvedAt).toBe(approved.approvedAt);
});

test('no business table or provider is touched; storage statements are fixed and scoped', async () => {
  const result = await prepare();
  await store.approveAndGet(owner, result.previewId, true);
  await store.toProvider(owner, result.previewId);
  for (const [sql, params] of db.execute.mock.calls) {
    expect(sql).toContain('ai_analysis_preview');
    expect(sql).not.toMatch(/\b(account|card_bill|fund|fixed_asset|todo)\b/);
    expect(sql).not.toContain(owner);
    expect(params).toContain(owner);
  }
});

test('oversize, unapproved domain, secret column and altered digest are rejected', async () => {
  const oversized = snapshot(); oversized.datasets[0].rows[0].remark = 'x'.repeat(MAX_BYTES);
  await expect(store.prepare(owner, { message: '分析', scope, snapshot: oversized })).rejects.toMatchObject({ code: 'AI_PREVIEW_TOO_LARGE' });
  const wrongDomain = snapshot(); wrongDomain.datasets[0].domain = 'fund';
  await expect(store.prepare(owner, { message: '分析', scope, snapshot: wrongDomain })).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
  const secret = snapshot(); secret.datasets[0].columns.push({ key: 'password', label: '密码', type: 'text' });
  await expect(store.prepare(owner, { message: '分析', scope, snapshot: secret })).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
  const result = await prepare(), record = records.get(result.previewId), decrypted = JSON.parse(decryptField(record.payload));
  decrypted.snapshot.datasets[0].rows[0].amountCNY = '99.00';
  record.payload = encryptField(JSON.stringify(decrypted));
  await expect(store.get(owner, result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
});

test('empty-domain chit-chat preview does not borrow financial data', async () => {
  const emptyScope = { ...scope, domains: [] };
  const result = await store.prepare(owner, { message: '你好', scope: emptyScope, snapshot: { scope: emptyScope, datasets: [], choices: { moods: ['开心'] } } });
  await store.approveAndGet(owner, result.previewId, true);
  expect((await store.toProvider(owner, result.previewId)).datasets).toEqual([]);
});

test('only four bounded user messages enter the approved historical context', async () => {
  const context = [{ role: 'user', content: `昨天 ${card} 电话13812345678 支出39.91元` }];
  const result = await store.prepare(owner, { message: '和昨天比较', scope, snapshot: snapshot(), context });
  expect(result.summary).toContain('1 条历史用户原话');
  expect(JSON.stringify(result.context)).not.toMatch(/private-card-uuid|13812345678/);
  await store.approveAndGet(owner, result.previewId, true);
  expect((await store.toProvider(owner, result.previewId)).context).toEqual(result.context);
  await expect(store.prepare(owner, { message: '分析', scope, snapshot: snapshot(), context: [{ role: 'system', content: '指令' }] })).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
  await expect(store.prepare(owner, { message: '分析', scope, snapshot: snapshot(), context: Array(5).fill(context[0]) })).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
});

test('extended card dates and unverified-currency asset comparison enter only their approved field projection', async () => {
  const extendedScope = { ...scope, domains: ['card', 'asset'] };
  const extended = { scope: extendedScope, datasets: [{ datasetId: 'card-cards', domain: 'card', title: '卡日期',
    columns: [{ key: 'expirationMonth', label: '到期月份', type: 'date' }, { key: 'nextRepayDate', label: '配置还款日', type: 'date' }],
    rows: [{ cardId: card, expirationMonth: '2028-02', nextRepayDate: '2026-12-05', last4_no: '9999' }] },
  { datasetId: 'asset-comparison', domain: 'asset', title: '对照', columns: [{ key: 'currency', label: '币种证据', type: 'text' },
    { key: 'netDifference', label: '差额', type: 'money' }, { key: 'reason', label: '限制', type: 'text' }],
    rows: [{ currency: 'unverified', netDifference: null, reason: '没有币种字段' }], summary: { currency: 'unverified' } }],
  choices: { cards: [{ id: card, name: '生活卡' }] } };
  const result = await store.prepare(owner, { message: '看看卡日期和资产差异', scope: extendedScope, snapshot: extended });
  await store.approveAndGet(owner, result.previewId, true);
  const provider = await store.toProvider(owner, result.previewId);
  expect(provider.datasets[0].rows[0]).toMatchObject({ expirationMonth: '2028-02', nextRepayDate: '2026-12-05' });
  expect(provider.datasets[1].rows[0].netDifference).toBeNull();
  expect(JSON.stringify(provider)).not.toMatch(/private-card-uuid|9999|last4_no/);
});

test('previous unknown IDs/refs and accidental API keys are scrubbed from historical user text without masking typed amounts', async () => {
  const context = [{ role: 'user', content: '旧UUID 3bd05211-af9c-4083-9f04-31f4c0f15656 旧引用 r_12345678901234567890abcdefabcdefab 密钥sk-accidental_private_key' }];
  const result = await store.prepare(owner, { message: '分析39.91元', scope, snapshot: snapshot(), context });
  expect(JSON.stringify(result.context)).not.toMatch(/3bd05211|r_123456789012|sk-accidental/);
  expect(result.datasets[0].rows[0].amountCNY).toBe('39.91');
  await store.approveAndGet(owner, result.previewId, true);
  const outgoing = await store.toProvider(owner, result.previewId);
  expect(outgoing.context).toEqual(result.context);
  expect(outgoing.choices.cards[0].ref).toMatch(/^r_[0-9a-f]{32}$/);
});

test('prepare prunes expired encrypted payload/refMap in bounded owner batches while retaining replay evidence', async () => {
  const expired = await prepare();
  const row = records.get(expired.previewId); row.request_id = 'used-request'; row.approved_at = current;
  const originalDigest = row.digest;
  records.set('other-expired', { id: 'other-expired', user_id: 'other-owner', expires_at: current - 1, payload: 'private-other' });
  current += TTL;
  await prepare();
  expect(row.payload).toBe('expired');
  expect(row.digest).toBe(originalDigest);
  expect(row.request_id).toBe('used-request');
  expect(row.approved_at).not.toBeNull();
  expect(records.get('other-expired').payload).toBe('private-other');
  await expect(store.get(owner, expired.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_EXPIRED' });
  const [sql, params] = db.execute.mock.calls.find(([sql]) => sql.includes("payload = 'expired'"));
  expect(sql).toContain('user_id = ?'); expect(sql).toContain('LIMIT 100'); expect(params[0]).toBe(owner);
});

test('server revocation stops approval, externalization and ref lookup; sent previews cannot be revoked', async () => {
  const result = await prepare();
  await expect(store.revoke('other-owner', result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_EXPIRED' });
  expect(await store.revoke(owner, result.previewId)).toEqual({ previewId: result.previewId, cancelled: true });
  expect((await store.get(owner, result.previewId)).approvedAt).toBe(-1);
  await expect(store.approveAndGet(owner, result.previewId, true)).rejects.toMatchObject({ status: 410, code: 'AI_PREVIEW_CANCELLED' });
  await expect(store.toProvider(owner, result.previewId)).rejects.toMatchObject({ status: 410, code: 'AI_PREVIEW_CANCELLED' });
  await expect(store.resolve(owner, result.previewId, result.choices.cards[0].ref, 'card')).rejects.toMatchObject({ status: 410, code: 'AI_PREVIEW_CANCELLED' });
  const sent = await prepare(); records.get(sent.previewId).request_id = 'already-sent';
  await expect(store.revoke(owner, sent.previewId)).rejects.toMatchObject({ status: 409, code: 'AI_PREVIEW_ALREADY_SENT' });
});

test('revocation winning the approval race is observed before any external payload', async () => {
  const result = await prepare(), original = db.execute.getMockImplementation();
  db.execute.mockImplementation(async (sql, params) => {
    if (sql.startsWith('UPDATE ai_analysis_preview SET approved_at = ?')) records.get(result.previewId).approved_at = -1;
    return original(sql, params);
  });
  await expect(store.approveAndGet(owner, result.previewId, true)).rejects.toMatchObject({ code: 'AI_PREVIEW_CANCELLED' });
  await expect(store.toProvider(owner, result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_CANCELLED' });
});

test('normalized transaction preserves an eight-digit typed amount and replaces the selected account with a preview ref', async () => {
  const localFinancialInput = { fields: { amount: '12345678.91', direction: 0, currency: 'CNY', transDate: '2026-11-06',
    accountId: card, categoryId: null, payMethod: null, remark: '原话' }, evidence: { account: { source: 'explicit-unique-label', label: '日常账户' } } };
  const result = await store.prepare(owner, { message: '日常账户支出12345678.91元', scope, snapshot: snapshot(), localFinancialInput });
  expect(result.normalizedTransaction).toMatchObject({ amount: '12345678.91', direction: 0, currency: 'CNY', transDate: '2026-11-06',
    accountRef: result.choices.cards[0].ref });
  expect(result.localFinancialInput).toBeUndefined();
  const saved = JSON.parse(decryptField(records.get(result.previewId).payload));
  expect(saved.localFinancialInput).toEqual(localFinancialInput);
  await store.approveAndGet(owner, result.previewId, true);
  const outgoing = await store.toProvider(owner, result.previewId);
  expect(outgoing.normalizedTransaction).toEqual(result.normalizedTransaction);
  expect(outgoing.message).toContain('[号码已隐藏]');
  expect(JSON.stringify(outgoing)).not.toMatch(/private-card-uuid|accountId|localFinancialInput|explicit-unique-label/);
});

test('encrypted local financial input is bound to the preview digest', async () => {
  const result = await store.prepare(owner, { message: '日常账户支出39.91元', scope, snapshot: snapshot(),
    localFinancialInput: { fields: { amount: '39.91', direction: 0, currency: 'CNY', transDate: '2026-11-06', accountId: card } } });
  const row = records.get(result.previewId), data = JSON.parse(decryptField(row.payload));
  data.localFinancialInput.fields.amount = '39.92';
  row.payload = encryptField(JSON.stringify(data));
  await expect(store.get(owner, result.previewId)).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
});

test.each([{ accountId: 'not-in-approved-choices' }, { amount: '39.9099' }, { direction: 2 }, { currency: 'USD' },
  { transDate: '2026-02-30' }, { password: 'not-allowed' }])('normalized transaction rejects unapproved or invalid structured input: %j', async changes => {
  await expect(store.prepare(owner, { message: '日常账户支出39.91元', scope, snapshot: snapshot(), localFinancialInput: {
    fields: { amount: '39.91', direction: 0, currency: 'CNY', transDate: '2026-11-06', accountId: card, ...changes },
  } })).rejects.toMatchObject({ code: 'AI_PREVIEW_INVALID' });
});
