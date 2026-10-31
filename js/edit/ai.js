// Optional AI assistant for Edit Mode: talks to OpenRouter (an OpenAI-compatible gateway to many models)
// directly from the browser with the user's own API key, using tool calling to drive the editor's tools.
const API = 'https://openrouter.ai/api/v1';

async function call(key, path, init = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      // Attribution shown in the user's OpenRouter activity.
      'HTTP-Referer': location.origin,
      'X-Title': 'Bishop PTO site editor',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error?.message || `OpenRouter error ${res.status}`);
  return data;
}

// Throws if the key is invalid.
export async function checkKey(key) {
  await call(key, 'key');
}

// Models that support tool calling, as [{ id, name, price }] sorted by name; price is USD per million input tokens.
export async function listModels(key) {
  const data = await call(key, 'models');
  return (data.data || [])
    .filter((m) => m.supported_parameters?.includes('tools') && !m.id.endsWith(':batch'))
    .map((m) => ({ id: m.id, name: m.name || m.id, price: Number(m.pricing?.prompt) * 1e6 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const summarize = (name, args) => {
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return `${name}(${text.length > 140 ? `${text.slice(0, 140)}…` : text})`;
};

// Claude models on OpenRouter cache only when asked; other providers cache automatically.
const explicitCaching = (model) => /^~?anthropic\//.test(model);

// tools: { name: { description, parameters?, run(args) } } with JSON Schema parameters.
// system: fixed instructions. context: () => string, a note on the editor's current state added to each user
// message; keeping it out of the system prompt keeps the start of every request identical, so it can be cached.
export function createAssistant({ tools, system, context, maxSteps = 30 }) {
  let messages = [];
  let session = crypto.randomUUID();
  let controller = null;
  const toolSpecs = Object.entries(tools).map(([name, t]) => ({
    type: 'function',
    function: { name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } },
  }));

  return {
    reset() { messages = []; session = crypto.randomUUID(); },
    stop() { controller?.abort(); },
    async send({ key, model, text, onEvent }) {
      controller = new AbortController();
      const turnStart = messages.length;
      messages.push({ role: 'user', content: `${context()}\n\n${text}` });
      const usage = { cost: 0, input: 0, cached: 0, steps: 0 };
      try {
        for (let step = 0; step < maxSteps; step++) {
          const data = await call(key, 'chat/completions', {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              model,
              messages: [{ role: 'system', content: system }, ...messages],
              tools: toolSpecs,
              // Keep this chat on the same provider so its cache is reused.
              session_id: session,
              ...(explicitCaching(model) && { cache_control: { type: 'ephemeral' } }),
            }),
          });
          usage.steps++;
          usage.cost += data.usage?.cost || 0;
          usage.input += data.usage?.prompt_tokens || 0;
          usage.cached += data.usage?.prompt_tokens_details?.cached_tokens || 0;
          const choice = data.choices?.[0];
          const message = choice?.message;
          if (!message || choice.finish_reason === 'error') {
            throw new Error(`The model returned no answer (${choice?.error?.message || choice?.finish_reason || 'unknown reason'}).`);
          }
          // Keep the model's message verbatim (including any reasoning details) for the next request.
          messages.push(message);
          if (message.content) onEvent('assistant', message.content);
          const calls = message.tool_calls || [];
          if (!calls.length) {
            if (!message.content) throw new Error(`The model returned no answer (${choice.finish_reason || 'unknown reason'}).`);
            return;
          }

          for (const tc of calls) {
            const { name, arguments: raw } = tc.function;
            onEvent('tool', summarize(name, raw || '{}'));
            let content;
            try {
              if (!tools[name]) throw new Error(`Unknown tool ${name}`);
              const result = await tools[name].run(raw ? JSON.parse(raw) : {});
              content = typeof result === 'string' ? result : JSON.stringify(result ?? 'ok');
            } catch (err) {
              content = JSON.stringify({ error: err.message });
              onEvent('tool', `  ↳ error: ${err.message}`);
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content });
          }
        }
        throw new Error(`Stopped after ${maxSteps} steps.`);
      } catch (err) {
        // Drop the incomplete turn so the conversation stays valid; edits already made remain (and can be undone).
        messages.length = turnStart;
        throw err.name === 'AbortError' ? new Error('Stopped.') : err;
      } finally {
        controller = null;
        if (usage.steps) onEvent('usage', usage);
      }
    },
  };
}
