import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const maxBodyBytes = 64 * 1024;

const tutorInstructions = {
  conversation: `You are a friendly, patient English conversation tutor for adult learners aged 25–30. Help the learner practise English through a natural conversation. Adapt to their level without asking them to identify it first. Mostly answer in clear, simple English. If they ask in Russian or request an explanation in Russian, explain briefly in Russian, then return to English practice. Gently correct at most one or two useful errors: show a natural corrected version and a short explanation, then ask one relevant follow-up question. Keep replies concise and encouraging. Do not overwhelm the learner, invent credentials, or claim that your assessment is a formal proficiency score. Use plain text, not tables or Markdown headings.`,
  grammar: `You are a patient English grammar tutor for adult learners aged 25–30. Explain grammar in clear, simple language, using short examples. If the learner gives an answer or sentence, first show a corrected version when needed, then explain the most useful rule in a few lines. Finish with one short practice question and wait for their answer. If they ask in Russian, you may explain briefly in Russian while keeping examples in English. Do not overwhelm them or claim a formal proficiency score. Use plain text, not tables or Markdown headings.`,
  writing: `You are a supportive English writing tutor for adult learners aged 25–30. When given a draft, preserve the learner's intended meaning and voice. Give a corrected version, then explain up to three important edits in concise plain language. If the learner has not supplied a draft, ask what they are writing and who will read it. Do not invent facts, rewrite more than requested, or claim a formal proficiency score. If asked in Russian, explain briefly in Russian. Use plain text, not tables or Markdown headings.`,
  plan: `You are a practical English study planner for adult learners aged 25–30. Use the learner's selected goal, self-estimated level, schedule, and available session time to create a realistic plan. Respect the stated time limit in every session and the stated number of study days each week. Give a clear progression by week and day, exact minutes for each activity, spaced vocabulary/grammar review, a balance of independent practice and useful AI exercises, and occasional real human speaking or writing practice where useful. Include a simple weekly progress check. Recommend free or readily available activities rather than requiring paid resources. Match the language requested by the learner. Keep the plan readable and actionable in plain text. In follow-up messages, revise the existing plan to fit changed time, days, goals, or level; preserve what still works and recalculate session timings so they remain within the new limit. Do not claim a formal proficiency assessment.`
};

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cleanMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return null;
  const messages = [];
  let totalBytes = 0;
  for (const item of value) {
    if (!item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return null;
    const content = item.content.trim();
    if (!content || content.length > 3000) return null;
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > 48 * 1024) return null;
    messages.push({ role: item.role, content });
  }
  return messages;
}

async function handleChat(request, response) {
  if (!process.env.OPENAI_API_KEY) {
    sendJson(response, 503, { code: 'API_KEY_MISSING' });
    return;
  }
  let body;
  try { body = await readJson(request); }
  catch (error) {
    sendJson(response, error.message === 'BODY_TOO_LARGE' ? 413 : 400, { code: 'INVALID_REQUEST' });
    return;
  }

  const mode = body?.mode;
  const messages = cleanMessages(body?.messages);
  if (!Object.hasOwn(tutorInstructions, mode) || !messages) {
    sendJson(response, 400, { code: 'INVALID_REQUEST' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: tutorInstructions[mode],
        input: messages,
        max_output_tokens: mode === 'plan' ? 1500 : 500,
        store: false
      })
    });
    if (!upstream.ok) {
      console.error(`OpenAI Responses API returned HTTP ${upstream.status}`);
      sendJson(response, 502, { code: 'OPENAI_REQUEST_FAILED' });
      return;
    }
    const data = await upstream.json();
    const reply = data.output_text || (data.output || [])
      .flatMap(item => item.content || [])
      .filter(part => part.type === 'output_text')
      .map(part => part.text)
      .join('\n')
      .trim();
    if (!reply) {
      sendJson(response, 502, { code: 'EMPTY_REPLY' });
      return;
    }
    sendJson(response, 200, { reply });
  } catch (error) {
    console.error(error.name === 'AbortError' ? 'OpenAI request timed out' : 'OpenAI request failed');
    sendJson(response, 502, { code: error.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'OPENAI_REQUEST_FAILED' });
  } finally {
    clearTimeout(timeout);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { configured: Boolean(process.env.OPENAI_API_KEY) });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/chat') {
    await handleChat(request, response);
    return;
  }
  if (request.method !== 'GET' || !['/', '/index.html'].includes(url.pathname)) {
    response.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end('Not found');
    return;
  }
  try {
    const html = await readFile(path.join(root, 'index.html'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    response.end(html);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Could not load index.html');
  }
});

server.listen(port, host, () => {
  console.log(`English tutor is running at http://${host}:${port}`);
  console.log(process.env.OPENAI_API_KEY ? 'API key detected.' : 'Set OPENAI_API_KEY in this terminal to enable AI replies.');
});
