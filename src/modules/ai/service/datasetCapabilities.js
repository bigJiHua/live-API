// Pure contract registry. Readers own SQL and calculations; this module must
// remain independent of tools, services, databases and runtime configuration.
const SORTS = Object.freeze(['dateDesc', 'amountDesc', 'expenseDesc', 'incomeDesc', 'monthAsc', 'categoryAmountDesc']);
const DIRECTIONS = Object.freeze(['income', 'expense', 'both']);
const FINANCE_DIRECTIONS = Object.freeze({ both: null, income: 1, expense: 0 });
const GROUPINGS = Object.freeze(['card', 'cardMonth']);
const META_KEYS = Object.freeze(['version', 'queryId', 'datasetId', 'requestedScope', 'effectiveScope', 'filters', 'sort',
  'matchedRowCount', 'returnedRowCount', 'sourceRecordCount', 'rowsComplete', 'summaryComplete', 'rankingComplete', 'returnedDateRange', 'asOf', 'groupBy', 'resolution', 'page']);
const META_FILTER_KEYS = Object.freeze(['direction', 'text', 'cardTypes']);
const FILTER_FIELD_KEYS = Object.freeze(["category","company","content","currency","cycle","date","displayType","maxUpdatedAt","method","minUpdatedAt","name","reason","recordedAt","remark","repayStatus","status","tag","title","type","updatedAt"]);

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function capability(domain, options = {}) {
  const finance = domain === 'finance';
  const consumption = options.consumption === true;
  const groupings = consumption ? GROUPINGS : [];
  const canonicalSorts = options.canonicalSorts || [options.sort || 'dateDesc'];
  return {
    domain,
    acceptedArgs: {
      // Finance dataset-specific restrictions remain at the reader boundary.
      directions: finance ? DIRECTIONS : consumption ? ['expense', 'both'] : [],
      sorts: finance ? SORTS : consumption ? ['dateDesc', 'amountDesc', 'expenseDesc'] : [],
      readerSorts: options.readerSorts || (consumption ? ['dateDesc', 'amountDesc', 'expenseDesc'] : []),
      rankingSorts: canonicalSorts.filter(sort => ['amountDesc', 'expenseDesc', 'incomeDesc'].includes(sort)),
      groupings, cardTypes: consumption || options.cardTypes === true,
      filter: { tool: true, reader: options.filter !== false, fields: options.filterFields || [],
        coverage: 'sql-full-range' },
    },
    inputDefaults: { direction: 'both', sort: 'dateDesc', limit: 20 },
    defaults: { sort: options.sort || 'dateDesc', ...(consumption ? { groupBy: 'cardMonth' } : {}) },
    normalization: { ...(consumption ? { direction: 'expense' } : {}),
      ...(options.normalizeSort ? { sort: options.normalizeSort } : {}) },
    datePolicy: { historyThroughToday: ['finance', 'work', 'fund'].includes(domain) || consumption,
      semantics: options.dateSemantics || 'date-range' },
    effectiveMeta: {
      // Existing preview/history validators accept the global sort/direction
      // sets. Preserve that compatibility separately from canonical outputs.
      sorts: SORTS, directions: DIRECTIONS, canonicalSorts,
      rankingSorts: canonicalSorts.filter(sort => ['amountDesc', 'expenseDesc', 'incomeDesc', 'categoryAmountDesc'].includes(sort)), groupings,
      cardTypes: consumption || options.cardTypes === true, keys: META_KEYS, filterKeys: META_FILTER_KEYS,
    },
  };
}

const DATASET_CAPABILITIES = freeze({
  'finance-monthly': capability('finance', { filterFields: [], filter: false, sort: 'monthAsc', normalizeSort: 'monthAsc', readerSorts: ['dateDesc', 'monthAsc'] }),
  'finance-categories': capability('finance', { filterFields: ['category'], sort: 'categoryAmountDesc', normalizeSort: 'categoryAmountDesc', readerSorts: ['dateDesc', 'amountDesc', 'categoryAmountDesc'] }),
  'finance-transactions': capability('finance', { filterFields: ['category', 'remark', 'currency'], readerSorts: ['dateDesc', 'amountDesc'], canonicalSorts: ['dateDesc', 'amountDesc'] }),
  'finance-daily': capability('finance', { filterFields: ['category'], readerSorts: ['dateDesc', 'expenseDesc', 'incomeDesc'], canonicalSorts: ['dateDesc', 'expenseDesc', 'incomeDesc'] }),
  'account-balances': capability('account', { filterFields: ['name', 'type', 'currency', 'updatedAt'], dateSemantics: 'saved-state' }),
  'card-cards': capability('card', { filterFields: ['name', 'type', 'status'], dateSemantics: 'saved-state' }),
  'card-counts': capability('card', { filterFields: ['type', 'displayType'], cardTypes: true, dateSemantics: 'saved-state' }),
  'card-monthlyConsumption': capability('card', { filterFields: ['name'], consumption: true, canonicalSorts: ['dateDesc', 'amountDesc', 'expenseDesc'] }),
  'card-bills': capability('card', { filterFields: ['name', 'repayStatus', 'updatedAt'] }),
  'card-repayments': capability('card', { filterFields: ['name', 'date', 'method'] }),
  'card-pools': capability('card', { filterFields: ['name'], dateSemantics: 'saved-state' }),
  'budget-plans': capability('budget', { filterFields: ['title', 'type', 'cycle'] }),
  'todo-events': capability('todo', { filterFields: ['content', 'type', 'status', 'remark'] }),
  'work-salary': capability('work', { filterFields: ['company', 'type'] }),
  'work-rules': capability('work', { filterFields: ['company', 'type'], dateSemantics: 'saved-state' }),
  'asset-snapshots': capability('asset', { filterFields: ['recordedAt'] }),
  'asset-registers': capability('asset', { filterFields: ['recordedAt'] }),
  'asset-composition': capability('asset', { filterFields: ['type', 'currency', 'minUpdatedAt', 'maxUpdatedAt'], dateSemantics: 'saved-state' }),
  'asset-comparison': capability('asset', { filterFields: ['currency', 'reason'] }),
  'fixedAsset-saved': capability('fixedAsset', { filterFields: ['name', 'tag', 'status'], dateSemantics: 'saved-state' }),
  'fund-holdings': capability('fund', { filterFields: ['name'], dateSemantics: 'saved-state' }),
  'fund-history': capability('fund', { filterFields: ['name'] }),
  'installment-plans': capability('installment', { filterFields: ['name'], dateSemantics: 'mixed-plan-state' }),
});
const DATASETS = Object.freeze(Object.fromEntries(Object.entries(DATASET_CAPABILITIES).map(([id, entry]) => [id, entry.domain])));

// Candidate groups (list_choices) per business domain: the single source of
// truth (追加166). v3Tools derives tool enums from it, businessRead narrows
// candidateOnly reads with it, and the maps below keep group→source-domain and
// group→coverage-dataset declarations next to it, so a new group cannot be
// declared in one place and silently skipped in another. Reader SQL stays in
// the repository; the reader side of this contract is enforced by the
// tablesRead() allowlists in tests/helpers/sqlTables.js.
const CHOICE_GROUPS = freeze({ finance: ['cards', 'categories'], account: ['cards'], card: ['cards'],
  budget: ['categories'], todo: ['todos'], fund: ['funds'], fixedAsset: ['fixedAssets'],
  work: [], asset: [], installment: ['categories'] });
const CHOICE_GROUP_ENUM = Object.freeze([...new Set(Object.values(CHOICE_GROUPS).flat())]);
const CHOICE_DOMAINS = freeze(Object.fromEntries(CHOICE_GROUP_ENUM.map(group =>
  [group, Object.keys(CHOICE_GROUPS).filter(domain => CHOICE_GROUPS[domain].includes(group))])));
// Candidate groups whose own source table lives in exactly one domain's
// reader; candidateOnly reads use this to skip unrelated ledgers entirely.
const CHOICE_SOURCE_DOMAIN = freeze({ todos: 'todo', funds: 'fund', fixedAssets: 'fixedAsset' });
// Candidate group → the dataset feeding choiceCoverage truncation facts.
const CHOICE_SOURCE_DATASETS = freeze({ todos: 'todo-events', funds: 'fund-holdings', fixedAssets: 'fixedAsset-saved' });

function getDatasetCapability(id) {
  return Object.hasOwn(DATASET_CAPABILITIES, id) ? DATASET_CAPABILITIES[id] : undefined;
}

function assertDatasetCapabilities(options = {}) {
  const registry = options.registry || DATASET_CAPABILITIES;
  const datasets = options.datasets || DATASETS;
  const fail = detail => { throw new Error(`AI dataset contract inconsistent: ${detail}`); };
  const subset = (values, allowed) => Array.isArray(values) && values.every(value => allowed.includes(value))
    && new Set(values).size === values.length;
  const domains = [...new Set(Object.values(datasets))];
  if (Object.keys(CHOICE_GROUPS).some(domain => !domains.includes(domain))) fail('choice domain');
  for (const [domain, groups] of Object.entries(CHOICE_GROUPS)) {
    if (!Array.isArray(groups) || groups.some(group => !CHOICE_GROUP_ENUM.includes(group))) fail(`${domain}.choice groups`);
  }
  for (const group of CHOICE_GROUP_ENUM) {
    if (!CHOICE_DOMAINS[group]?.length) fail(`choice group domains ${group}`);
    // A group owned by exactly one domain must declare that reader, so a new
    // candidate group cannot bypass the candidateOnly narrowing.
    if (CHOICE_DOMAINS[group].length === 1 && CHOICE_SOURCE_DOMAIN[group] !== CHOICE_DOMAINS[group][0]) fail(`single-owner group ${group}`);
  }
  if (Object.keys(CHOICE_SOURCE_DATASETS).sort().join() !== Object.keys(CHOICE_SOURCE_DOMAIN).sort().join()) fail('choice source dataset keys');
  for (const [group, domain] of Object.entries(CHOICE_SOURCE_DOMAIN)) {
    if (!CHOICE_GROUP_ENUM.includes(group) || !domains.includes(domain) || !CHOICE_GROUPS[domain].includes(group)) fail(`choice source domain ${group}`);
    const datasetId = CHOICE_SOURCE_DATASETS[group];
    if (!DATASET_CAPABILITIES[datasetId] || DATASET_CAPABILITIES[datasetId].domain !== domain) fail(`choice source dataset ${group}`);
  }
  if (Object.keys(registry).length !== Object.keys(datasets).length
    || Object.keys(registry).some(id => !Object.hasOwn(datasets, id))) fail('dataset keys');
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry || entry.domain !== datasets[id] || options.domains && !options.domains.includes(entry.domain)
      || options.choiceGroups && !Object.hasOwn(options.choiceGroups, entry.domain)) fail(`${id}.domain`);
    const input = entry.acceptedArgs, meta = entry.effectiveMeta;
    if (!input || !meta || !subset(input.sorts, SORTS) || !subset(input.readerSorts, SORTS) || !subset(input.rankingSorts, SORTS)
      || !subset(meta.sorts, SORTS) || !subset(meta.canonicalSorts, meta.sorts) || !subset(meta.rankingSorts, meta.canonicalSorts)
      || !subset(input.directions, DIRECTIONS) || !subset(meta.directions, DIRECTIONS)
      || !subset(input.groupings, GROUPINGS) || !subset(meta.groupings, GROUPINGS)
      || typeof input.cardTypes !== 'boolean' || typeof meta.cardTypes !== 'boolean'
      || !input.filter || typeof input.filter.tool !== 'boolean' || typeof input.filter.reader !== 'boolean'
      || !subset(input.filter.fields, FILTER_FIELD_KEYS) || input.filter.reader !== (input.filter.fields.length > 0)
      || !['sql-full-range', 'result-window'].includes(input.filter.coverage)
      || !subset(meta.keys, META_KEYS) || !subset(meta.filterKeys, META_FILTER_KEYS)) fail(`${id}.allowed values`);
    if (!entry.inputDefaults || !SORTS.includes(entry.inputDefaults.sort) || !DIRECTIONS.includes(entry.inputDefaults.direction)
      || entry.inputDefaults.limit !== 20 || !entry.defaults || !meta.canonicalSorts.includes(entry.defaults.sort)
      || entry.defaults.groupBy !== undefined && !meta.groupings.includes(entry.defaults.groupBy)
      || entry.normalization?.sort !== undefined && !meta.canonicalSorts.includes(entry.normalization.sort)
      || entry.normalization?.direction !== undefined && !meta.directions.includes(entry.normalization.direction)
      || typeof entry.datePolicy?.historyThroughToday !== 'boolean'
      || !['date-range', 'saved-state', 'mixed-plan-state'].includes(entry.datePolicy.semantics)) fail(`${id}.normalization`);
  }
  return true;
}

assertDatasetCapabilities();
module.exports = { DATASET_CAPABILITIES, DATASETS, SORTS, DIRECTIONS, FINANCE_DIRECTIONS, GROUPINGS, META_KEYS, META_FILTER_KEYS, FILTER_FIELD_KEYS,
  CHOICE_GROUPS, CHOICE_GROUP_ENUM, CHOICE_DOMAINS, CHOICE_SOURCE_DOMAIN, CHOICE_SOURCE_DATASETS,
  getDatasetCapability, assertDatasetCapabilities };
