// Демо-модель: OpenAI-совместимый /v1/chat/completions с вызовами инструментов — для проверки Polaris без ключей.
//   node scripts/mock-llm.mjs [порт=8799]
// Подключение:  OPENROUTER_API_KEY=demo OPENROUTER_BASE_URL=http://127.0.0.1:8799/v1 OPENROUTER_MODEL=mock
import http from 'node:http';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8799);

const HELP =
  'Привет! Я демо-модель Polaris. Попробуйте: «запомни, что я люблю чай», «создай заметку про отпуск», ' +
  '«создай файл», «удали файл demo.txt», «напомни выпить воды», «создай задачу проверять новости».';

function reply(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? '');
  const last = msgs[msgs.length - 1];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const text = String(lastUser?.content ?? '');
  const lower = text.toLowerCase();
  const call = (name, args) => ({
    content: null,
    tool_calls: [
      {
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

  if (last?.role === 'tool') {
    const out = String(last.content ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
    return { content: /отклонил/i.test(out) ? `Хорошо, не буду. (${out})` : `Готово. ${out}` };
  }
  if (system.includes('Режим фоновой задачи'))
    return { content: `Задача выполнена (демо-модель): «${text.slice(0, 80)}».` };
  if (system.includes('Режим утренней сводки'))
    return { content: 'Доброе утро! Сегодня всё спокойно — срочных дел нет. (демо-модель)' };

  if (lower.includes('запомни'))
    return call('memory_save', {
      kind: 'preference',
      content: text.replace(/^.*?запомни,?\s*(что)?\s*/i, '').slice(0, 200) || text,
    });
  if (lower.includes('заметк')) return call('note_create', { title: 'Заметка от Polaris', body: text });
  if (lower.includes('удали файл'))
    return call('file_delete', { path: (/файл\s+(\S+)/i.exec(text)?.[1] ?? 'demo.txt').replace(/[.,;]$/, '') });
  if (lower.includes('создай файл') || lower.includes('запиши файл'))
    return call('file_write', { path: 'demo.txt', content: `Файл создан демо-моделью.\n${text}` });
  if (lower.includes('напомни'))
    return call('reminder_create', { text: text.replace(/^.*?напомни,?\s*/i, '') || 'Напоминание', inMinutes: 1 });
  if (lower.includes('создай задачу'))
    return call('task_create', { goal: text.replace(/^.*?создай задачу,?\s*/i, '') || text });
  if (lower.includes('время') || lower.includes('час')) return call('get_time', {});
  return { content: HELP };
}

http
  .createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.statusCode = 404;
        return res.end('mock-llm: POST /v1/chat/completions');
      }
      const body = JSON.parse(data || '{}');
      const message = { role: 'assistant', ...reply(body) };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: 'mock-llm',
          choices: [{ message }],
          usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0 },
        }),
      );
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock-llm слушает http://127.0.0.1:${port}/v1`));
