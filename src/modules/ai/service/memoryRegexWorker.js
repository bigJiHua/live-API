const { parentPort } = require('node:worker_threads');
const { memoryLineSnippet } = require('./memoryTextEvidence');

// Regex execution is isolated so catastrophic backtracking cannot block the
// API event loop. The parent bounds input and terminates this worker on timeout.
parentPort.once('message', ({ documents, pattern, limit, snippetChars }) => {
  try {
    const expression = new RegExp(pattern, 'iu'), matches = [];
    outer: for (const document of documents) {
      const lines = document.content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!expression.test(lines[index])) continue;
        matches.push({ path: document.path, revision: document.revision, line: index + 1,
          ...memoryLineSnippet(lines[index], snippetChars) });
        if (matches.length > limit) break outer;
      }
    }
    parentPort.postMessage({ matches: matches.slice(0, limit), truncated: matches.length > limit });
  } catch (_) { parentPort.postMessage({ error: 'invalid-regex' }); }
});
