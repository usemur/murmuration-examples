// Storage Preferences - saves one caller's theme preference for publishers adding simple per-user memory.
// Storage scope is automatic per (flow, caller), so every caller gets an independent `prefs` key.
//
// Input:
// - params.theme (optional string)
// Output:
// - { before, after }

const beforeRaw = await storage.get('prefs');
const before = beforeRaw ? JSON.parse(beforeRaw) : { theme: 'light' };
const theme =
  typeof params.theme === 'string' && params.theme.trim()
    ? params.theme.trim()
    : before.theme;

await storage.set('prefs', { theme });

return {
  before,
  after: JSON.parse(await storage.get('prefs')),
};
