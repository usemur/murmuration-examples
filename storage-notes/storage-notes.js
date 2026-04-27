// Storage Notes - manages per-caller notes for publishers who want many small records instead of one large blob.
// Uses the `note:` prefix so `storage.list({ prefix: 'note:' })` only returns note keys.
//
// Input:
// - params.action ("create" | "delete" | "list")
// - params.id, params.title, params.body
// Output:
// - { ok, createdKey?, deletedKey?, notes?, nextCursor? }

const action = params.action || 'list';
const noteKey = params.id ? `note:${params.id}` : null;

if (action === 'create') {
  const key = noteKey || `note:${Date.now()}`;
  await storage.set(key, {
    title: typeof params.title === 'string' ? params.title : 'Untitled',
    body: typeof params.body === 'string' ? params.body : '',
  });
  return { ok: true, createdKey: key };
}

if (action === 'delete' && noteKey) {
  await storage.delete(noteKey);
  return { ok: true, deletedKey: noteKey };
}

const { items, nextCursor } = await storage.list({ prefix: 'note:', limit: 20 });
const notes = await Promise.all(
  items.map(async (item) => ({
    key: item.key,
    updatedAt: item.updatedAt,
    value: JSON.parse((await storage.get(item.key)) || 'null'),
  })),
);

return { notes, nextCursor };
