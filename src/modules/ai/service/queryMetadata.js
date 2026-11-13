const { AiError } = require('./errors');
const { CARD_TYPES } = require('./candidateSelection');
const { SORTS, DIRECTIONS, META_KEYS, META_FILTER_KEYS, getDatasetCapability } = require('./datasetCapabilities');

const validDate = value => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validRange = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['startDate', 'endDate'].includes(key))
  && validDate(value.startDate) && validDate(value.endDate) && value.startDate <= value.endDate;
const validResolution = value => ['detail', 'month', 'year'].includes(value);
const validCursor = value => typeof value === 'string' && value.length <= 2048
  && /^lq1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);

// Shape validation only. The reader verifies the cursor signature, owner,
// query binding and expiry before using it to read another page.
function validQueryPage(page, meta = {}) {
  if (!page || typeof page !== 'object' || Array.isArray(page)
    || Object.keys(page).length !== 4 || Object.keys(page).some(key => !['offset', 'limit', 'hasMore', 'nextCursor'].includes(key))
    || !Number.isSafeInteger(page.offset) || page.offset < 0 || page.offset > 100000
    || !Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 50
    || typeof page.hasMore !== 'boolean' || !(page.nextCursor === null || validCursor(page.nextCursor))
    || page.hasMore !== (page.nextCursor !== null)) return false;
  if (Number.isSafeInteger(meta.returnedRowCount) && (meta.returnedRowCount > page.limit
    || meta.rowsComplete === true && page.offset !== 0)) return false;
  if (Number.isSafeInteger(meta.matchedRowCount) && Number.isSafeInteger(meta.returnedRowCount)) {
    if (page.offset + meta.returnedRowCount > meta.matchedRowCount
      || page.hasMore !== (page.offset + meta.returnedRowCount < meta.matchedRowCount)) return false;
  }
  return true;
}

function validateQueryMeta(meta, dataset, scope) {
  const invalid = () => { throw new AiError('查询范围或覆盖数量无效，请重新查询', 400, 'AI_PREVIEW_INVALID'); };
  // Preserve global metadata compatibility for older/unknown dataset DTOs.
  const capability = getDatasetCapability(meta?.datasetId)?.effectiveMeta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key => !META_KEYS.includes(key))
    || meta.version !== 1 || !/^q_[a-f0-9]{24}$/.test(meta.queryId || '') || meta.datasetId !== dataset.datasetId
    || !validRange(meta.requestedScope) || !validRange(meta.effectiveScope) || !(capability?.sorts || SORTS).includes(meta.sort)
    || !meta.filters || Object.keys(meta.filters).some(key => !(capability?.filterKeys || META_FILTER_KEYS).includes(key))
    || !(capability?.directions || DIRECTIONS).includes(meta.filters.direction) || typeof meta.filters.text !== 'string' || meta.filters.text.length > 80
    || typeof meta.asOf !== 'string' || meta.asOf.length > 80 || !Number.isFinite(Date.parse(meta.asOf))) invalid();
  if (Object.hasOwn(meta, 'groupBy') && !capability?.groupings.includes(meta.groupBy)) invalid();
  if (Object.hasOwn(meta, 'resolution') && !validResolution(meta.resolution)) invalid();
  if (Object.hasOwn(meta, 'page') && !validQueryPage(meta.page, meta)) invalid();
  if (Object.hasOwn(meta.filters, 'cardTypes') && (!capability?.cardTypes
    || !Array.isArray(meta.filters.cardTypes) || !meta.filters.cardTypes.length
    || meta.filters.cardTypes.some(type => !CARD_TYPES.includes(type)) || new Set(meta.filters.cardTypes).size !== meta.filters.cardTypes.length)) invalid();
  for (const key of ['matchedRowCount', 'sourceRecordCount']) {
    if (meta[key] !== null && (!Number.isSafeInteger(meta[key]) || meta[key] < 0)) invalid();
  }
  if (!Number.isSafeInteger(meta.returnedRowCount) || meta.returnedRowCount !== dataset.rows.length
    || meta.matchedRowCount !== null && meta.matchedRowCount < meta.returnedRowCount) invalid();
  for (const key of ['rowsComplete', 'summaryComplete', 'rankingComplete']) if (typeof meta[key] !== 'boolean') invalid();
  if (meta.rowsComplete && (meta.matchedRowCount === null || meta.matchedRowCount !== meta.returnedRowCount)) invalid();
  if (scope && (meta.effectiveScope.startDate !== scope.startDate || meta.effectiveScope.endDate !== scope.endDate)) invalid();
  if (meta.returnedDateRange !== null && (!validRange(meta.returnedDateRange)
    || meta.returnedDateRange.startDate < meta.effectiveScope.startDate || meta.returnedDateRange.endDate > meta.effectiveScope.endDate)) invalid();
  return structuredClone(meta);
}

module.exports = { SORTS, validateQueryMeta, validQueryPage, validCursor, validResolution };
