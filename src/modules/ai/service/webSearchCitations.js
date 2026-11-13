const crypto = require('crypto');
const { safeSourceUrl } = require('./webSearchClient');

// sources must come from this turn's successful, per-user egress-projected search receipts.
// Protect only complete, exactly matched source URLs; surrounding prose always takes the original scrub.
function scrubWithCitations(text, scrub, sources = []) {
  if (typeof scrub !== 'function') throw new TypeError('Citation scrubbing requires the existing egress scrubber');
  if (typeof text !== 'string' || !Array.isArray(sources) || !sources.length) return scrub(text);
  const allowed = new Set(sources.map(source => typeof source === 'string' ? source : source?.url)
    .filter(url => typeof url === 'string' && safeSourceUrl(url) === url));
  if (!allowed.size) return scrub(text);
  let nonce;
  do {
    // Alphabetic nonce survives phone/number redaction and cannot be supplied by input text.
    nonce = crypto.randomBytes(16).toString('hex').replace(/[a-f0-9]/g, ch => String.fromCharCode(97 + parseInt(ch, 16)));
  } while (text.includes(nonce) || [...allowed].some(url => url.includes(nonce)));
  const protectedUrls = [];
  const input = text.replace(/https?:\/\/[^\s<>]+/gi, (whole, offset) => {
    const preceding = offset === 0 ? '' : text[offset - 1];
    if (preceding && !/[\s(<\["':：，。；！？]/.test(preceding)) return whole;
    let candidate = whole, trailing = '';
    // Markdown/plain parentheses may wrap the full URL. Do not split any path/query/fragment suffix.
    if (preceding === '(' && candidate.endsWith(')')) {
      candidate = candidate.slice(0, -1); trailing = ')';
    } else if ((preceding === '"' || preceding === "'") && candidate.endsWith(preceding)) {
      candidate = candidate.slice(0, -1); trailing = preceding;
    } else if (preceding === '[' && candidate.endsWith(']')) {
      candidate = candidate.slice(0, -1); trailing = ']';
    }
    if (!allowed.has(candidate)) return whole;
    const marker = `@@WEBCITATION_${nonce}_${protectedUrls.length}@@`;
    protectedUrls.push({ marker, url: candidate });
    return marker + trailing;
  });
  if (!protectedUrls.length) return scrub(text);
  let output = scrub(input);
  if (typeof output !== 'string') throw new TypeError('Citation scrubber must return text');
  for (const { marker, url } of protectedUrls) output = output.split(marker).join(url);
  return output;
}

module.exports = { scrubWithCitations };
