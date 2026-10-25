import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { api } from '../../src/api';
import { localInputToIso } from '../../src/format';
import { space } from '../../src/theme';
import type { Schedule } from '../../src/types';
import { Button, Chip, ErrorNote, Input, Muted, Row, Screen, SectionTitle } from '../../src/ui';

type Mode = 'now' | 'once' | 'interval' | 'daily';

export default function NewTask() {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<Mode>('now');
  const [at, setAt] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [time, setTime] = useState('09:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const build = (): Schedule | null | undefined => {
    if (mode === 'now') return null;
    if (mode === 'once') {
      const iso = localInputToIso(at);
      return iso ? { type: 'once', at: iso } : undefined;
    }
    if (mode === 'interval') {
      const n = Number(minutes);
      return Number.isInteger(n) && n >= 5 ? { type: 'interval', everyMinutes: n } : undefined;
    }
    return /^\d{1,2}:\d{2}$/.test(time.trim()) ? { type: 'daily', time: time.trim() } : undefined;
  };

  const submit = async () => {
    const schedule = build();
    if (schedule === undefined) {
      setError(
        mode === 'once'
          ? 'Дата и время в формате 2026-03-01 09:30'
          : mode === 'interval'
            ? 'Интервал — целое число минут, не меньше 5'
            : 'Время в формате ЧЧ:ММ',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { item } = await api.createTask(goal.trim(), schedule);
      router.replace(`/task/${item.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
          <ErrorNote message={error} />
          <Input
            label="Цель"
            value={goal}
            onChangeText={setGoal}
            multiline
            autoCapitalize="sentences"
            autoCorrect
            placeholder="Например: каждое утро собирай главные новости про ИИ и кратко пересказывай"
          />
          <SectionTitle>Когда запускать</SectionTitle>
          <Row style={{ flexWrap: 'wrap' }}>
            <Chip label="Сразу" active={mode === 'now'} onPress={() => setMode('now')} />
            <Chip label="Один раз" active={mode === 'once'} onPress={() => setMode('once')} />
            <Chip label="Каждые N минут" active={mode === 'interval'} onPress={() => setMode('interval')} />
            <Chip label="Ежедневно" active={mode === 'daily'} onPress={() => setMode('daily')} />
          </Row>
          <View style={{ marginTop: space.md }}>
            {mode === 'once' ? (
              <Input
                label="Дата и время (по вашему времени)"
                value={at}
                onChangeText={setAt}
                placeholder="2026-03-01 09:30"
              />
            ) : null}
            {mode === 'interval' ? (
              <Input label="Интервал, минут" value={minutes} onChangeText={setMinutes} keyboardType="number-pad" />
            ) : null}
            {mode === 'daily' ? (
              <Input label="Время (часовой пояс инстанса)" value={time} onChangeText={setTime} placeholder="09:00" />
            ) : null}
          </View>
          <Muted style={{ marginBottom: space.lg }}>
            Действия с риском (удаление, перезапись, действия в браузере) задача выполнит только после вашего
            подтверждения. Расход ограничен бюджетом — см. «Ещё → Настройки».
          </Muted>
          <Button title="Создать задачу" onPress={submit} loading={busy} disabled={goal.trim().length < 3} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
