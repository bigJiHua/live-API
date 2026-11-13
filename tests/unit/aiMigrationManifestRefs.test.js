const fs = require('node:fs');
const path = require('node:path');

// Current migration commands must keep resolving to saved SQL after cleanup.
// Historical freeze tools are archived evidence and are never executed here.
test('active AI migration commands reference existing migration files', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts;
  for (const command of ['ai:business:migrate', 'ai:call-log:migrate', 'ai:chat-sync:migrate']) {
    const relative = scripts[command].match(/^node (tools\/[A-Za-z0-9-]+\.js)$/)?.[1];
    expect(relative).toBeDefined();
    const tool = fs.readFileSync(path.join(__dirname, '../..', relative), 'utf8');
    const name = tool.match(/const FILE\s*=\s*['"]([A-Za-z0-9_.-]+\.sql)['"]/)?.[1];
    expect(name).toBeDefined();
    expect(fs.existsSync(path.join(__dirname, '../../mysql/migrations', name))).toBe(true);
  }
});
