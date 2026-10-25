import { useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api';
import { formatDateTime } from './format';
import { colors, space, toolLabel } from './theme';
import type { Approval } from './types';
import { Badge, Button, Card, Muted, Row, notify } from './ui';

function prettyArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Карточка действия, которое ждёт решения пользователя. */
export function ApprovalCard({ approval, onResolved }: { approval: Approval; onResolved: () => void }) {
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [open, setOpen] = useState(false);
  const pending = approval.status === 'pending';

  const decide = async (kind: 'approve' | 'reject') => {
    setBusy(kind);
    try {
      await (kind === 'approve' ? api.approve(approval.id) : api.reject(approval.id));
      onResolved();
    } catch (e) {
      notify('Не удалось применить решение', e instanceof Error ? e.message : String(e));
      onResolved();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card style={{ borderColor: pending ? '#ff9f6b' : colors.border }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: space.sm }}>
        <Text style={{ color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 }}>
          {toolLabel(approval.action)}
        </Text>
        {!pending ? (
          <Badge
            label={approval.status === 'approved' ? 'Одобрено' : 'Отклонено'}
            color={approval.status === 'approved' ? colors.success : colors.muted}
          />
        ) : null}
      </Row>
      <Text style={{ color: colors.text, fontSize: 14, lineHeight: 20 }} selectable>
        {approval.summary}
      </Text>
      <Muted style={{ marginTop: 4 }}>{formatDateTime(approval.createdAt)}</Muted>
      <Text onPress={() => setOpen(!open)} style={{ color: colors.accent, marginTop: space.sm, fontSize: 13 }}>
        {open ? 'Скрыть параметры' : 'Показать параметры'}
      </Text>
      {open ? (
        <View style={{ backgroundColor: colors.bg, borderRadius: 8, padding: space.sm, marginTop: space.sm }}>
          <Text style={{ color: colors.muted, fontFamily: 'monospace', fontSize: 12 }} selectable>
            {prettyArgs(approval.args)}
          </Text>
        </View>
      ) : null}
      {pending ? (
        <Row style={{ marginTop: space.md }}>
          <Button
            title="Одобрить"
            icon="checkmark"
            loading={busy === 'approve'}
            disabled={busy !== null}
            onPress={() => decide('approve')}
            style={{ flex: 1, marginRight: space.sm }}
          />
          <Button
            title="Отклонить"
            variant="secondary"
            icon="close"
            loading={busy === 'reject'}
            disabled={busy !== null}
            onPress={() => decide('reject')}
            style={{ flex: 1 }}
          />
        </Row>
      ) : null}
    </Card>
  );
}
