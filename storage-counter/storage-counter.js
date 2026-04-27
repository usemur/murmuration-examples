// Storage Counter - demonstrates naive read-modify-write state for publishers testing simple persistent counters.
// ⚠ Not race-safe. Concurrent calls can clobber. Atomic `storage.increment` is coming in v2.
//
// Input:
// - none
// Output:
// - { count }

const current = Number((await storage.get('count')) || '0');
const count = Number.isFinite(current) ? current + 1 : 1;

await storage.set('count', String(count));

return { count };
