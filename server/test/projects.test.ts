import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, login, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(async () => env?.close());

describe('проекты', () => {
  it('создание, чаты внутри проекта, инструкции попадают в промпт, удаление оставляет чаты', async () => {
    env = await createTestEnv({ script: () => ({ content: 'ок' }) });
    const h = await login(env.app);
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      env.app.inject({ method, url, headers: h, payload: payload as object | undefined });

    const created = (
      await call('POST', '/api/projects', { name: 'Диплом', instructions: 'Отвечай как научный редактор' })
    ).json();
    const project = created.project;
    expect(project).toMatchObject({ name: 'Диплом', chatCount: 0 });

    // чат сразу создаётся в проекте
    const chat = (await call('POST', '/api/conversations', { projectId: project.id })).json().conversation;
    expect(chat.projectId).toBe(project.id);
    expect((await call('GET', '/api/projects')).json().projects[0].chatCount).toBe(1);

    await call('POST', `/api/conversations/${chat.id}/messages`, { content: 'Привет' });
    await env.ctx.runs.idle();
    const system = env.provider.calls[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('Инструкции проекта «Диплом»');
    expect(system.content).toContain('научный редактор');

    // чат вне проекта инструкций не получает
    const plain = (await call('POST', '/api/conversations', {})).json().conversation;
    expect(plain.projectId).toBeUndefined();
    await call('POST', `/api/conversations/${plain.id}/messages`, { content: 'Привет' });
    await env.ctx.runs.idle();
    expect(String(env.provider.calls.at(-1)!.messages[0]!.content)).not.toContain('Инструкции проекта');

    // перенос в проект и обратно
    expect((await call('PATCH', `/api/conversations/${plain.id}`, { projectId: project.id })).statusCode).toBe(200);
    expect((await call('GET', `/api/conversations/${plain.id}`)).json().conversation.projectId).toBe(project.id);
    expect((await call('PATCH', `/api/conversations/${plain.id}`, { projectId: null })).statusCode).toBe(200);
    expect((await call('GET', `/api/conversations/${plain.id}`)).json().conversation.projectId).toBeUndefined();

    // переименование и правка инструкций
    const patched = (await call('PATCH', `/api/projects/${project.id}`, { name: 'Диплом 2', instructions: '' })).json();
    expect(patched.project).toMatchObject({ name: 'Диплом 2', instructions: '' });

    // несуществующий проект
    expect(
      (await call('POST', '/api/conversations', { projectId: '00000000-0000-4000-8000-000000000000' })).statusCode,
    ).toBe(404);

    // удаление проекта: чат остаётся
    expect((await call('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(200);
    expect((await call('GET', `/api/conversations/${chat.id}`)).json().conversation.projectId).toBeUndefined();
    expect((await call('GET', '/api/projects')).json().projects).toHaveLength(0);
  });

  it('резервная копия переносит проекты вместе с чатами', async () => {
    env = await createTestEnv();
    const project = await env.ctx.projects.create('Работа', 'Коротко');
    const chat = await env.ctx.conversations.create('В проекте', 'chat', project.id);
    const file = await env.ctx.backup.export();
    await env.ctx.db.query('delete from conversations');
    await env.ctx.db.query('delete from projects');
    await env.ctx.backup.restore(file);
    expect((await env.ctx.projects.list())[0]).toMatchObject({ name: 'Работа', instructions: 'Коротко', chatCount: 1 });
    expect((await env.ctx.conversations.get(chat.id)).projectId).toBe(project.id);
  });
});
