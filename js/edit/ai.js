// Optional AI assistant for Edit Mode: talks to the Google Gemini REST API directly from the
// browser with the user's own API key, using function calling to drive the editor's tools.
const API = 'https://generativelanguage.googleapis.com/v1beta';

async function call(key, path, init = {}) {
  const res = await fetch(`${API}/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
  return data;
}

export async function listModels(key) {
  const data = await call(key, 'models?pageSize=1000');
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && m.name.includes('gemini'))
    .map((m) => m.name.replace(/^models\//, ''));
}

// Prefer the newest stable "flash" model: fast, cheap, and good at tool use.
export function defaultModel(models) {
  const version = (name) => parseFloat(name.match(/gemini-([\d.]+)/)?.[1] || 0);
  const flash = models.filter((n) => /^gemini-[\d.]+-flash$/.test(n)).sort((a, b) => version(b) - version(a));
  return flash[0] || models.find((n) => n.includes('flash')) || models[0];
}

const summarize = ({ name, args = {} }) => {
  const text = JSON.stringify(args);
  return `${name}(${text.length > 140 ? `${text.slice(0, 140)}…` : text})`;
};

// tools: { name: { description, parameters?, run(args) } }; system: () => string
export function createAssistant({ tools, system, maxSteps = 30 }) {
  let contents = [];
  let controller = null;
  const functionDeclarations = Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description,
    ...(t.parameters && { parameters: t.parameters }),
  }));

  return {
    reset() { contents = []; },
    stop() { controller?.abort(); },
    async send({ key, model, text, onEvent }) {
      controller = new AbortController();
      const turnStart = contents.length;
      contents.push({ role: 'user', parts: [{ text }] });
      try {
        for (let step = 0; step < maxSteps; step++) {
          const data = await call(key, `models/${model}:generateContent`, {
            method: 'POST',
            signal: controller.signal,
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system() }] },
              contents,
              tools: [{ functionDeclarations }],
            }),
          });
          const candidate = data.candidates?.[0];
          if (!candidate?.content?.parts?.length) {
            const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown reason';
            throw new Error(`The model returned no answer (${reason}).`);
          }
          // Keep the model's content verbatim (including thought signatures) for the next request.
          contents.push(candidate.content);
          for (const part of candidate.content.parts) {
            if (part.text && !part.thought) onEvent('assistant', part.text);
          }
          const calls = candidate.content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
          if (!calls.length) return;

          const parts = [];
          for (const fc of calls) {
            onEvent('tool', summarize(fc));
            let response;
            try {
              if (!tools[fc.name]) throw new Error(`Unknown tool ${fc.name}`);
              response = { result: await tools[fc.name].run(fc.args || {}) };
            } catch (err) {
              response = { error: err.message };
              onEvent('tool', `  ↳ error: ${err.message}`);
            }
            parts.push({ functionResponse: { name: fc.name, response } });
          }
          contents.push({ role: 'user', parts });
        }
        throw new Error(`Stopped after ${maxSteps} steps.`);
      } catch (err) {
        // Drop the incomplete turn so the conversation stays valid; edits already made remain (and can be undone).
        contents.length = turnStart;
        throw err.name === 'AbortError' ? new Error('Stopped.') : err;
      } finally {
        controller = null;
      }
    },
  };
}
