// Storage Session Memory - keeps the last 10 chat messages for agent authors who want lightweight per-user context.
// Stores one JSON array in the `messages` key, scoped automatically per caller.
//
// Input:
// - params.role (optional "user" | "assistant")
// - params.content (optional string)
// Output:
// - { messages }

const messagesRaw = await storage.get('messages');
const messages = messagesRaw ? JSON.parse(messagesRaw) : [];

if (typeof params.content !== 'string' || !params.content.trim()) {
  return { messages };
}

const nextMessage = {
  role: params.role === 'assistant' ? 'assistant' : 'user',
  content: params.content.trim(),
  at: new Date().toISOString(),
};
const updated = [...messages, nextMessage].slice(-10);

await storage.set('messages', JSON.stringify(updated));

return { messages: updated };
