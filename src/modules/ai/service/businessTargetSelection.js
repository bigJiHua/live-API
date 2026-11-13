// A provider-selected ref proves ownership, not a uniquely requested target.
// Source-window truncation prevents uniqueness proof; display-only truncation
// may still be checked against the complete owner-bound raw candidate set.
const TARGET_GROUP = { todo: 'todos', fund: 'funds', fixedAsset: 'fixedAssets', card: 'cards' };
const TARGET_DATASET = { todo: 'todo-events', fund: 'fund-holdings', fixedAsset: 'fixedAsset-saved', card: 'card-cards' };
function uniqueBusinessTarget(ref, kind, snapshots, message, isRejectedSelection) {
  const group = TARGET_GROUP[kind], datasetId = TARGET_DATASET[kind];
  if (!ref || !group || typeof message !== 'string') return false;
  const source = snapshots.find(snapshot => snapshot.refMap?.[ref]?.kind === kind);
  if (!source) return false;
  const id = source.refMap[ref].id, coverage = source.choiceCoverage?.[group];
  const sourceDatasets = (source.rawDatasets || []).filter(dataset => dataset.datasetId === datasetId);
  if (coverage?.total === null || sourceDatasets.some(dataset => dataset.truncated === true)) return false;
  const complete = coverage && Number.isSafeInteger(coverage.total)
    || sourceDatasets.some(dataset => dataset.truncated === false);
  if (!complete) return false;
  const rawCandidates = new Map();
  const add = row => {
    const targetId = row?.id || (kind === 'card' ? row?.cardId : kind === 'fund' ? row?.fundId : null);
    const name = row?.name || (kind === 'todo' ? row?.content : kind === 'fixedAsset' ? row?.info : '');
    if (!targetId || !name || kind === 'card' && /^virtual_/.test(row?.type || row?.cardType || '')) return;
    rawCandidates.set(targetId, { ...row, id: targetId, name });
  };
  // The selected read's full owner-bound candidates determine uniqueness.
  // Unrelated snapshots must not broaden or narrow this particular selection.
  for (const row of source.rawChoices?.[group] || []) add(row);
  for (const dataset of sourceDatasets) for (const row of dataset.rows || []) add(row);
  const selected = rawCandidates.get(id); if (!selected) return false;
  const sameName = [...rawCandidates.values()].filter(row => row.name === selected.name);
  if (sameName.length !== 1) return false;
  if (kind === 'card' && typeof isRejectedSelection === 'function' && isRejectedSelection(selected, [message], [...rawCandidates.values()])) return false;
  if (kind !== 'card' && message.split(/[，,。；;\n]/).some(clause => {
    const index = clause.indexOf(selected.name);
    return index >= 0 && /(?:不是|不要|不用|不选|别|禁止|不允许)[^，,。；;\n]{0,16}$/.test(clause.slice(0, index));
  })) return false;
  const approved = (source.snapshot?.choices?.[group] || []).find(row => row.ref === ref)
    || (source.snapshot?.datasets || []).filter(dataset => dataset.datasetId === datasetId)
      .flatMap(dataset => dataset.rows || []).find(row => row.ref === ref || row[`${kind}Ref`] === ref);
  const approvedName = approved?.name || (kind === 'todo' ? approved?.content : '');
  if (!approvedName) return false;
  // A sole loaded row is not a substitute for a different explicitly quoted target.
  if (!message.includes(approvedName) && /「[^」]+」|“[^”]+”|"[^"\n]+"/.test(message)) return false;
  return rawCandidates.size === 1 || message.includes(approvedName);
}
module.exports = { uniqueBusinessTarget };
