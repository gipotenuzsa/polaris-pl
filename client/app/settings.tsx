import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, RefreshControl, ScrollView, Text, View } from 'react-native';
import { api, downloadBackup } from '../src/api';
import { formatNumber } from '../src/format';
import { useLoad } from '../src/hooks';
import { disablePush, enablePush, pushState } from '../src/push';
import { colors, space } from '../src/theme';
import type { BudgetLimits, BudgetSummary, ChatGptStatus, CheckinsSettings, MorningSettings } from '../src/types';
import {
  Badge,
  Body,
  Button,
  Card,
  Chip,
  ErrorNote,
  Input,
  Loading,
  Muted,
  Row,
  Screen,
  SectionTitle,
  Toggle,
  confirmAction,
  notify,
} from '../src/ui';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Провайдеры и ChatGPT ───────────────────────────────────────────────────────

function ChatGptCard({ status, onChange }: { status: ChatGptStatus; onChange: () => void }) {
  const [flow, setFlow] = useState<{ authUrl: string; redirectUri: string } | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [check, setCheck] = useState<{
    ok: boolean;
    error?: string;
    modelNotFound?: boolean;
    model: string;
    switchedFrom?: string;
  } | null>(null);
  const [customModel, setCustomModel] = useState('');

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      notify('Ошибка', errText(e));
    } finally {
      setBusy(null);
    }
  };

  const finish = (url: string) =>
    run('finish', async () => {
      await api.chatgptCallback(url);
      setFlow(null);
      setPasted('');
      onChange();
      setCheck(await api.chatgptCheck());
    });

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>ChatGPT (OAuth)</Text>
        <Badge
          label={status.connected ? 'Подключён' : 'Не подключён'}
          color={status.connected ? colors.success : colors.muted}
        />
      </Row>
      <View style={{ backgroundColor: colors.warnBg, borderRadius: 8, padding: space.md, marginBottom: space.md }}>
        <Text style={{ color: colors.warn, fontSize: 13, lineHeight: 19 }}>
          Только для личного использования на своей подписке ChatGPT Plus/Pro. Это неофициальный способ доступа: условия
          OpenAI могут его ограничивать, а интерфейс — меняться без предупреждения. Одна подписка на инстанс.
          ChatGPT — единственный провайдер моделей в Polaris.
        </Text>
      </View>

      <Toggle
        label="Использовать ChatGPT как провайдер"
        value={status.enabled}
        onChange={(v) =>
          run('enable', async () => {
            await api.chatgptSettings({ enabled: v });
            onChange();
          })
        }
        hint={status.connected ? undefined : 'Сначала подключите аккаунт'}
      />

      {status.connected ? (
        <Muted style={{ marginBottom: space.md }}>
          {status.email ?? 'аккаунт подключён'}
          {status.plan ? ` · план ${status.plan}` : ''}
        </Muted>
      ) : null}

      {!flow ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button
            title={status.connected ? 'Переподключить' : 'Подключить ChatGPT'}
            icon="log-in-outline"
            loading={busy === 'connect'}
            onPress={() => run('connect', async () => setFlow(await api.chatgptConnect()))}
            style={{ marginRight: space.sm, marginBottom: space.sm }}
          />
          <Button
            title="Проверить вход"
            variant="secondary"
            icon="pulse-outline"
            loading={busy === 'check'}
            onPress={() => run('check', async () => setCheck(await api.chatgptCheck()))}
            style={{ marginRight: space.sm, marginBottom: space.sm }}
          />
          {status.connected ? (
            <Button
              title="Отключить"
              variant="ghost"
              loading={busy === 'disconnect'}
              onPress={async () => {
                if (await confirmAction('Отключить ChatGPT?', 'Токены будут удалены с сервера.', 'Отключить')) {
                  await run('disconnect', async () => {
                    await api.chatgptDisconnect();
                    setCheck(null);
                    onChange();
                  });
                }
              }}
              style={{ marginBottom: space.sm }}
            />
          ) : null}
        </Row>
      ) : (
        <View>
          <Body>1. Откройте ссылку и войдите в ChatGPT.</Body>
          <Row style={{ marginVertical: space.sm, flexWrap: 'wrap' }}>
            <Button
              title="Открыть вход"
              icon="open-outline"
              onPress={() => void Linking.openURL(flow.authUrl)}
              style={{ marginRight: space.sm, marginBottom: space.sm }}
            />
            <Button
              title="Скопировать ссылку"
              variant="secondary"
              icon="copy-outline"
              onPress={async () => {
                await Clipboard.setStringAsync(flow.authUrl);
                notify('Ссылка скопирована');
              }}
              style={{ marginBottom: space.sm }}
            />
          </Row>
          <Body>
            2. После входа браузер попытается открыть адрес вида {flow.redirectUri}?code=… Страница не откроется — это
            нормально. Скопируйте полный адрес из строки браузера и вставьте сюда.
          </Body>
          <View style={{ marginTop: space.sm }}>
            <Button
              title="Вставить из буфера и войти"
              icon="clipboard-outline"
              variant="secondary"
              loading={busy === 'finish'}
              onPress={async () => {
                const t = (await Clipboard.getStringAsync()).trim();
                if (!t) return notify('Буфер пуст', 'Сначала скопируйте адрес из строки браузера.');
                setPasted(t);
                void finish(t);
              }}
              style={{ marginBottom: space.sm }}
            />
            <Input
              value={pasted}
              onChangeText={(t) => {
                setPasted(t);
                if (/[?&]code=/.test(t) && /[?&]state=/.test(t)) void finish(t.trim()); // вставили адрес целиком — входим сразу
              }}
              placeholder="http://localhost:1455/auth/callback?code=…&state=…"
              multiline
            />
          </View>
          <Row>
            <Button
              title="Завершить вход"
              loading={busy === 'finish'}
              disabled={!pasted.trim()}
              onPress={() => void finish(pasted.trim())}
              style={{ flex: 1, marginRight: space.sm }}
            />
            <Button
              title="Отмена"
              variant="secondary"
              onPress={() => {
                setFlow(null);
                setPasted('');
              }}
              style={{ flex: 1 }}
            />
          </Row>
        </View>
      )}

      {check ? (
        <View style={{ marginTop: space.sm }}>
          <Text style={{ color: check.ok ? colors.success : colors.danger, fontSize: 14, lineHeight: 20 }} selectable>
            {check.ok
              ? check.switchedFrom
                ? `✓ Вход работает. Модель ${check.switchedFrom} недоступна для этого способа входа — выбрана ${check.model}, она отвечает.`
                : `✓ Вход работает, модель ${check.model} отвечает.`
              : check.modelNotFound
                ? `✕ ${check.error ?? `Модель ${check.model} недоступна для этого способа входа.`} Выберите другую модель ниже.`
                : `✕ ${check.error ?? 'Проверка не прошла'}`}
          </Text>
        </View>
      ) : null}

      <SectionTitle>Модель</SectionTitle>
      <Row style={{ flexWrap: 'wrap' }}>
        {status.models.map((m) => (
          <Chip
            key={m}
            label={m}
            active={status.model === m}
            onPress={() =>
              run('model', async () => {
                await api.chatgptSettings({ model: m });
                setCheck(null);
                onChange();
              })
            }
          />
        ))}
      </Row>
      <Row>
        <View style={{ flex: 1, marginRight: space.sm }}>
          <Input value={customModel} onChangeText={setCustomModel} placeholder="Другая модель, например gpt-5" />
        </View>
        <View style={{ marginBottom: space.md }}>
          <Button
            title="Задать"
            variant="secondary"
            disabled={!customModel.trim()}
            onPress={() =>
              run('model', async () => {
                await api.chatgptSettings({ model: customModel.trim() });
                setCustomModel('');
                onChange();
              })
            }
          />
        </View>
      </Row>
    </Card>
  );
}

// ── Бюджет ─────────────────────────────────────────────────────────────────────

function BudgetForm({ data, onSaved }: { data: BudgetSummary; onSaved: () => Promise<void> }) {
  const l = data.limits;
  const [form, setForm] = useState<Record<keyof BudgetLimits, string>>({
    dailyTokens: String(l.dailyTokens),
    dailyUsd: String(l.dailyUsd),
    runTokens: String(l.runTokens),
    runUsd: String(l.runUsd),
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const limits: BudgetLimits = {
      dailyTokens: Math.round(Number(form.dailyTokens)),
      dailyUsd: Number(form.dailyUsd.replace(',', '.')),
      runTokens: Math.round(Number(form.runTokens)),
      runUsd: Number(form.runUsd.replace(',', '.')),
    };
    if (Object.values(limits).some((v) => !Number.isFinite(v) || v < 0))
      return notify('Проверьте числа', 'Лимиты — неотрицательные числа. 0 — без лимита.');
    setSaving(true);
    try {
      await api.saveBudget(limits);
      await onSaved();
      notify('Лимиты сохранены');
    } catch (e) {
      notify('Не сохранено', errText(e));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof BudgetLimits, label: string) => (
    <Input
      label={label}
      value={form[key]}
      onChangeText={(t) => setForm((f) => ({ ...f, [key]: t }))}
      keyboardType="decimal-pad"
    />
  );

  return (
    <>
      {field('dailyTokens', 'Дневной лимит, токенов')}
      {field('dailyUsd', 'Дневной лимит, $')}
      {field('runTokens', 'На одну команду/задачу, токенов')}
      {field('runUsd', 'На одну команду/задачу, $')}
      <Muted style={{ marginBottom: space.md }}>
        0 — без лимита. При превышении агент жёстко останавливается. Для подписки ChatGPT учитываются только токены.
      </Muted>
      <Button title="Сохранить лимиты" onPress={save} loading={saving} />
    </>
  );
}

function BudgetCard() {
  const { data, error, refresh } = useLoad(() => api.budget(), 30_000);
  return (
    <Card>
      <ErrorNote message={error} />
      {data ? (
        <>
          <Body>
            Сегодня потрачено: {formatNumber(data.daily.tokens)} токенов, ${data.daily.usd.toFixed(4)}
          </Body>
          {data.byProvider.map((p) => (
            <Muted key={p.provider}>
              {p.provider}: {p.calls} запр., {formatNumber(p.tokens)} ток., ${p.usd.toFixed(4)}
            </Muted>
          ))}
          <View style={{ marginTop: space.md }}>
            <BudgetForm key={JSON.stringify(data.limits)} data={data} onSaved={refresh} />
          </View>
        </>
      ) : (
        <Loading />
      )}
    </Card>
  );
}

// ── Утренняя сводка и инструкции ───────────────────────────────────────────────

interface SettingsData {
  morning: MorningSettings;
  agent: { instructions: string };
  timezone: string;
}

function MorningForm({ data, onSaved }: { data: SettingsData; onSaved: () => Promise<void> }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(data.morning.enabled);
  const [time, setTime] = useState(data.morning.time);
  const [tz, setTz] = useState(data.morning.timezone);
  const [instructions, setInstructions] = useState(data.agent.instructions);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      notify('Ошибка', errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <Toggle
          label="Утренняя сводка"
          value={enabled}
          onChange={setEnabled}
          hint="Раз в сутки: дела, задачи, напоминания и новости по вашим интересам"
        />
        <Input label="Время (ЧЧ:ММ)" value={time} onChangeText={setTime} placeholder="08:00" />
        <Input label="Часовой пояс" value={tz} onChangeText={setTz} placeholder="Asia/Almaty" />
        <Row style={{ flexWrap: 'wrap' }}>
          <Button
            title="Сохранить"
            loading={busy === 'save'}
            onPress={() =>
              run('save', async () => {
                await api.saveMorning({ enabled, time: time.trim(), timezone: tz.trim() });
                await onSaved();
                notify('Сохранено');
              })
            }
            style={{ marginRight: space.sm, marginBottom: space.sm }}
          />
          <Button
            title="Сформировать сейчас"
            variant="secondary"
            loading={busy === 'now'}
            onPress={() =>
              run('now', async () => {
                const r = await api.runMorning();
                router.push(`/chat/${r.conversationId}`);
              })
            }
            style={{ marginBottom: space.sm }}
          />
        </Row>
      </Card>
      <SectionTitle>Инструкции агенту</SectionTitle>
      <Card>
        <Input
          value={instructions}
          onChangeText={setInstructions}
          multiline
          autoCapitalize="sentences"
          autoCorrect
          placeholder="Например: отвечай кратко, на «ты», деньги считай в тенге"
        />
        <Button
          title="Сохранить инструкции"
          loading={busy === 'agent'}
          onPress={() =>
            run('agent', async () => {
              await api.saveAgent(instructions);
              await onSaved();
              notify('Сохранено');
            })
          }
        />
      </Card>
    </>
  );
}

function MorningCard() {
  const { data, error, refresh } = useLoad(() => api.settings());
  return (
    <>
      <ErrorNote message={error} />
      {data ? (
        <MorningForm key={JSON.stringify([data.morning, data.agent])} data={data} onSaved={refresh} />
      ) : (
        <Loading />
      )}
    </>
  );
}

// ── Проактивные проверки ───────────────────────────────────────────────────────

function CheckinsForm({ initial, onSaved }: { initial: CheckinsSettings; onSaved: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hours, setHours] = useState(initial.everyHours);
  const [from, setFrom] = useState(initial.quietFrom);
  const [to, setTo] = useState(initial.quietTo);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      notify('Ошибка', errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Toggle
        label="Polaris сам пишет, когда есть повод"
        value={enabled}
        onChange={setEnabled}
        hint="Каждые несколько часов просматривает дела, напоминания и вашу память. Если сообщать нечего — молчит (токены тратятся только на проверку)"
      />
      <Muted style={{ marginBottom: 6 }}>Как часто проверять</Muted>
      <Row style={{ flexWrap: 'wrap', marginBottom: space.sm }}>
        {[1, 3, 6, 12].map((h) => (
          <Chip key={h} label={`каждые ${h} ч`} active={hours === h} onPress={() => setHours(h)} />
        ))}
      </Row>
      <Row>
        <View style={{ flex: 1, marginRight: space.sm }}>
          <Input label="Тихие часы с" value={from} onChangeText={setFrom} placeholder="22:00" />
        </View>
        <View style={{ flex: 1 }}>
          <Input label="до" value={to} onChangeText={setTo} placeholder="08:00" />
        </View>
      </Row>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button
          title="Сохранить"
          loading={busy === 'save'}
          onPress={() =>
            run('save', async () => {
              await api.saveCheckins({ enabled, everyHours: hours, quietFrom: from.trim(), quietTo: to.trim(), timezone: initial.timezone });
              await onSaved();
              notify('Сохранено');
            })
          }
          style={{ marginRight: space.sm, marginBottom: space.sm }}
        />
        <Button
          title="Проверить сейчас"
          variant="secondary"
          loading={busy === 'now'}
          onPress={() =>
            run('now', async () => {
              const r = await api.runCheckin();
              notify(r.posted ? 'Есть что сказать' : 'Пока сообщать нечего', r.posted ? 'Сообщение появилось в разговоре.' : 'Polaris проверил дела и решил промолчать.');
            })
          }
          style={{ marginBottom: space.sm }}
        />
      </Row>
    </Card>
  );
}

function CheckinsCard() {
  const { data, error, refresh } = useLoad(() => api.settings());
  return (
    <>
      <ErrorNote message={error} />
      {data ? <CheckinsForm key={JSON.stringify(data.checkins)} initial={data.checkins} onSaved={refresh} /> : <Loading />}
    </>
  );
}

// ── Резервная копия данных ─────────────────────────────────────────────────────

function BackupCard() {
  const [busy, setBusy] = useState<string | null>(null);
  if (Platform.OS !== 'web') {
    return (
      <Card>
        <Muted>Копию данных можно скачать и восстановить в веб-версии (откройте адрес сервера в браузере) и в Windows-приложении.</Muted>
      </Card>
    );
  }

  const download = async () => {
    setBusy('download');
    try {
      await downloadBackup();
    } catch (e) {
      notify('Не удалось скачать', errText(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!(await confirmAction('Заменить данные?', `Все текущие данные на этом сервере (переписка, память, задачи) будут заменены содержимым файла «${file.name}». Это нельзя отменить.`, 'Заменить'))) return;
      setBusy('restore');
      try {
        const counts = await api.restoreBackup(JSON.parse(await file.text()));
        notify('Данные восстановлены', `Сообщений: ${counts.counts.messages ?? 0}, записей памяти: ${counts.counts.memory ?? 0}. Страница перезагрузится.`);
        globalThis.location?.assign('/');
      } catch (e) {
        notify('Не удалось восстановить', errText(e));
      } finally {
        setBusy(null);
      }
    };
    input.click();
  };

  return (
    <Card>
      <Muted style={{ marginBottom: space.md }}>
        Файл со всей перепиской, памятью, заметками, задачами и настройками. Нужен для переезда на другую базу данных и как страховка. Вход в ChatGPT и
        уведомления в копию не входят — после переезда подключите их заново.
      </Muted>
      <Row style={{ flexWrap: 'wrap' }}>
        <Button title="Скачать копию" icon="download-outline" loading={busy === 'download'} onPress={download} style={{ marginRight: space.sm, marginBottom: space.sm }} />
        <Button title="Восстановить из файла" variant="secondary" icon="cloud-upload-outline" loading={busy === 'restore'} onPress={restore} style={{ marginBottom: space.sm }} />
      </Row>
    </Card>
  );
}

// ── Push-уведомления на телефон (PWA) ──────────────────────────────────────────

function PushCard() {
  const { data: state, refresh } = useLoad(() => pushState());
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setResult(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setResult(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16 }}>Уведомления на телефон</Text>
        {state === 'on' ? <Badge label="Включены" color={colors.success} /> : null}
      </Row>
      {state === 'unsupported' ? (
        <Muted>
          Этот браузер или окно не поддерживает push-уведомления. На iPhone откройте Polaris из иконки на экране
          «Домой», на Android — в Chrome.
        </Muted>
      ) : null}
      {state === 'needs-install' ? (
        <Body>
          На iPhone push работает только у приложения с экрана «Домой» (iOS 16.4 и новее): в Safari нажмите «Поделиться»
          → «На экран „Домой“», откройте Polaris с новой иконки и вернитесь в эти настройки.
        </Body>
      ) : null}
      {state === 'denied' ? (
        <Body>
          Уведомления запрещены. Разрешите их: на iPhone — Настройки → Уведомления → Polaris; в браузере — настройки
          сайта. Потом вернитесь сюда.
        </Body>
      ) : null}
      {state === 'off' ? (
        <>
          <Muted style={{ marginBottom: space.md }}>
            Результаты задач, напоминания, запросы подтверждения и ответы агента будут приходить на экран блокировки,
            даже когда приложение закрыто.
          </Muted>
          <Button
            title="Включить уведомления"
            icon="notifications-outline"
            loading={busy === 'on'}
            onPress={() => run('on', enablePush)}
          />
        </>
      ) : null}
      {state === 'on' ? (
        <Row style={{ flexWrap: 'wrap' }}>
          <Button
            title="Отправить тест"
            icon="paper-plane-outline"
            loading={busy === 'test'}
            onPress={() =>
              run('test', async () => {
                const r = await api.pushTest();
                setResult(
                  r.sent > 0
                    ? `Отправлено устройствам: ${r.sent}. Уведомление придёт через пару секунд.`
                    : 'Не удалось доставить — попробуйте выключить и включить снова.',
                );
              })
            }
            style={{ marginRight: space.sm, marginBottom: space.sm }}
          />
          <Button
            title="Выключить"
            variant="secondary"
            loading={busy === 'off'}
            onPress={() => run('off', disablePush)}
            style={{ marginBottom: space.sm }}
          />
        </Row>
      ) : null}
      {result ? <Muted style={{ marginTop: space.sm }}>{result}</Muted> : null}
    </Card>
  );
}

export default function Settings() {
  const { data, error, loading, refresh } = useLoad(() => api.providers());

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: 60 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} tintColor={colors.accent} />}
        >
          <ErrorNote message={error} onRetry={refresh} />
          {loading && !data ? <Loading /> : null}

          {Platform.OS === 'web' ? (
            <>
              <SectionTitle>Уведомления</SectionTitle>
              <PushCard />
            </>
          ) : null}

          <SectionTitle>Провайдер</SectionTitle>
          {data ? <ChatGptCard status={data.chatgpt} onChange={refresh} /> : null}

          <SectionTitle>Бюджет</SectionTitle>
          <BudgetCard />

          <SectionTitle>Утренняя сводка</SectionTitle>
          <MorningCard />

          <SectionTitle>Проактивные проверки</SectionTitle>
          <CheckinsCard />

          <SectionTitle>Резервная копия</SectionTitle>
          <BackupCard />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
