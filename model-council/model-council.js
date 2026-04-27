// Model Council — queries 4 LLMs in parallel via OpenRouter, then synthesizes consensus.
//
// Required secret: OPENROUTER_API_KEY
// Input: params.question (string)
// Output: { question, individual: [...], synthesis }

const OPENROUTER_API_KEY = params.secrets?.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing OPENROUTER_API_KEY secret' }),
  });
  throw new Error('Missing OPENROUTER_API_KEY');
}

const question = params.question;
if (!question) {
  Lit.Actions.setResponse({
    response: JSON.stringify({ error: 'Missing "question" parameter' }),
  });
  throw new Error('Missing question');
}

const models = [
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini Flash' },
  { id: 'x-ai/grok-3-mini', name: 'Grok' },
];

async function queryModel(modelId, question) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: question }],
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return `Error (${res.status}): ${text}`;
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? 'No response';
}

// Query all models in parallel
const results = await Promise.all(
  models.map(async (m) => ({
    model: m.name,
    response: await queryModel(m.id, question),
  })),
);

// Synthesize consensus
const synthesisPrompt = `You are a meta-analyst. Below are responses from 4 different AI models to the same question. Synthesize their answers into a single, balanced consensus response. Note areas of agreement and any significant disagreements.

Question: ${question}

${results.map((r) => `--- ${r.model} ---\n${r.response}`).join('\n\n')}

Provide a clear, concise synthesis:`;

const synthesisResponse = await queryModel('anthropic/claude-sonnet-4', synthesisPrompt);

Lit.Actions.setResponse({
  response: JSON.stringify({
    question,
    individual: results,
    synthesis: synthesisResponse,
  }),
});
