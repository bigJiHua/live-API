const { CARD_TYPES } = require('./candidateSelection');
const { DATASETS, SORTS, DIRECTIONS, GROUPINGS, CHOICE_GROUP_ENUM } = require('./datasetCapabilities');
const { createEgressPolicy } = require('./egressPolicy');
const { validResolution, validCursor, validQueryPage } = require('./queryMetadata');

const DOMAINS = Object.freeze([...new Set(Object.values(DATASETS))]);
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const validDate = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTypes = value => Array.isArray(value) && value.length > 0 && value.length <= CARD_TYPES.length
  && value.every(type => CARD_TYPES.includes(type)) && new Set(value).size === value.length;
const copy = value => Array.isArray(value) ? [...value] : value;

// Successful-query feedback is an allowlisted projection, not a second
// validator. The guards still reject illegal requests before this is called.
function queryEffectiveArgs(name, originalArgs, validatedArgs, toolResult) {
  const original = record(originalArgs), validated = record(validatedArgs), result = record(toolResult);
  const effectiveArgs = {};
  const scrub = createEgressPolicy().scrub;
  const put = (key, value, valid) => { if (valid(value)) effectiveArgs[key] = copy(value); };
  const text = value => typeof value === 'string' && value.length <= 80;
  const safeText = (key, value) => { if (text(value)) effectiveArgs[key] = scrub(value); };
  const isLimit = value => Number.isInteger(value) && value >= 1 && value <= 50;

  if (name === 'query_data') {
    const datasets = Array.isArray(result.datasets) ? result.datasets : [];
    const dataset = datasets.find(item => item?.datasetId === validated.datasetId
      && item.queryMeta?.datasetId === item.datasetId
      && (!validated.queryId || item.queryMeta.queryId === validated.queryId));
    const meta = record(dataset?.queryMeta), filters = record(meta.filters);
    const scope = record(meta.effectiveScope || result.scope || validated.scope);
    put('datasetId', meta.datasetId || validated.datasetId, value => Object.hasOwn(DATASETS, value));
    put('startDate', scope.startDate, validDate);
    put('endDate', scope.endDate, validDate);
    safeText('filter', Object.hasOwn(filters, 'text') ? filters.text : validated.filter);
    put('direction', Object.hasOwn(filters, 'direction') ? filters.direction : validated.direction,
      value => DIRECTIONS.includes(value));
    put('sort', Object.hasOwn(meta, 'sort') ? meta.sort : validated.sort, value => SORTS.includes(value));
    put('groupBy', Object.hasOwn(meta, 'groupBy') ? meta.groupBy : validated.groupBy, value => GROUPINGS.includes(value));
    put('cardTypes', Object.hasOwn(filters, 'cardTypes') ? filters.cardTypes : validated.cardTypes, validTypes);
    // A returned window can contain fewer rows than the requested limit.
    put('limit', validQueryPage(meta.page, meta) ? meta.page.limit : validated.limit, isLimit);
    if (Object.hasOwn(meta, 'resolution') || Object.hasOwn(validated, 'resolution'))
      put('resolution', meta.resolution || validated.resolution, validResolution);
    // Report whether a validated continuation was consumed, without exposing
    // its signed payload or repeating an untrusted cursor in adjustments.
    if (Object.hasOwn(validated, 'cursor'))
      effectiveArgs.cursorApplied = validCursor(validated.cursor) && validQueryPage(meta.page, meta) && meta.page.offset > 0;
  } else if (name === 'list_choices') {
    put('domain', validated.domain, value => DOMAINS.includes(value));
    put('group', validated.group, value => value === null || CHOICE_GROUP_ENUM.includes(value));
    safeText('bankName', validated.bankName);
    put('cardType', validated.cardType, value => value === null || CARD_TYPES.includes(value));
    put('direction', validated.direction, value => value === null || DIRECTIONS.includes(value));
    safeText('filter', validated.filter);
    put('limit', validated.limit, isLimit);
  } else return { effectiveArgs, argumentAdjustments: [] };

  const requestedValidators = {
    datasetId: value => Object.hasOwn(DATASETS, value), domain: value => DOMAINS.includes(value),
    startDate: validDate, endDate: validDate, sort: value => SORTS.includes(value),
    direction: value => value === null && name === 'list_choices' || DIRECTIONS.includes(value),
    groupBy: value => GROUPINGS.includes(value), cardTypes: validTypes,
    group: value => value === null || CHOICE_GROUP_ENUM.includes(value),
    cardType: value => value === null || CARD_TYPES.includes(value), limit: isLimit,
    resolution: value => value === 'auto' || validResolution(value),
  };
  const argumentAdjustments = [];
  for (const [path, effective] of Object.entries(effectiveArgs)) {
    if (path === 'cursorApplied') continue;
    const supplied = Object.hasOwn(original, path) && original[path] !== undefined;
    if (supplied && JSON.stringify(original[path]) === JSON.stringify(effective)) continue;
    const adjustment = { path, reason: supplied ? 'normalized' : 'defaulted', effective: copy(effective) };
    // Never repeat original free text, credentials or unknown enum values in
    // provider feedback. Only bounded public parameter values may be compared.
    if (supplied && requestedValidators[path]?.(original[path])) adjustment.requested = copy(original[path]);
    argumentAdjustments.push(adjustment);
  }
  return { effectiveArgs, argumentAdjustments };
}

module.exports = { queryEffectiveArgs };
