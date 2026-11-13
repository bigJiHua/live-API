// account-balances' compatibility dateDesc metadata is not a timestamp sort.
// Correct prose only when the current approved source explicitly declares the
// config order and there is no unrelated dataset to which the claim may refer.
function normalizeAccountDisplayOrder(answer, datasets = []) {
  if (!datasets.length || datasets.some(dataset => dataset.datasetId !== 'account-balances')
    || !datasets.every(dataset => /按卡片配置顺序/.test(dataset.policy || '') && /最后保存时间.*单独列/.test(dataset.policy || ''))) return answer;
  return String(answer || '').replace(/按(?:最后)?保存时间(?:倒序|从新到旧|降序)(?:排列|排序|展示)?|按(?:最后)?更新时间(?:倒序|从新到旧|降序)(?:排列|排序|展示)?/g,
    '按卡片配置顺序展示，最后保存时间单独列出');
}
module.exports = { normalizeAccountDisplayOrder };
