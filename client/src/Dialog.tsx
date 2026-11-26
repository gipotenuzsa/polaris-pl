import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { colors, radius, space } from './theme';

export function Dialog({
  title,
  visible,
  onClose,
  children,
}: {
  title: string;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          padding: 20,
          backgroundColor: colors.overlay,
        }}
      >
        <Pressable accessibilityLabel="Закрыть окно" onPress={onClose} style={{ position: 'absolute', inset: 0 }} />
        <View
          accessibilityViewIsModal
          style={{
            width: '100%',
            maxWidth: 420,
            padding: space.xl,
            borderRadius: radius.lg,
            backgroundColor: colors.surface,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: space.lg }}>
            <Text accessibilityRole="header" style={{ flex: 1, fontSize: 19, fontWeight: '600', color: colors.text }}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Закрыть"
              onPress={onClose}
              hitSlop={10}
              style={{ padding: 4 }}
            >
              <Ionicons name="close" size={21} color={colors.muted} />
            </Pressable>
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}
