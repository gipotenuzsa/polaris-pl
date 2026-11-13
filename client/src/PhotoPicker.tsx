import { Ionicons } from '@expo/vector-icons';
import { createElement, useState, type ChangeEvent } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { colors } from './theme';

/** A mounted input receives the actual click, without a detached element or lost user gesture. */
export function PhotoPicker({
  disabled,
  onFiles,
  onNative,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  onNative: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const style = {
    width: 36,
    height: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled ? 0.35 : 1,
    backgroundColor: focused ? colors.surface2 : 'transparent',
  } as const;
  if (Platform.OS !== 'web') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Прикрепить фото"
        disabled={disabled}
        onPress={onNative}
        style={style}
      >
        <Ionicons name="add" size={24} color={colors.text} />
      </Pressable>
    );
  }
  return (
    <View style={style}>
      <Ionicons name="add" size={24} color={colors.text} />
      {createElement('input', {
        type: 'file',
        accept: 'image/*',
        multiple: true,
        disabled,
        'aria-label': 'Прикрепить фото',
        title: 'Прикрепить фото',
        onFocus: () => setFocused(true),
        onBlur: () => setFocused(false),
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = ''; // selecting the same file again must fire change
          if (files.length) onFiles(files);
        },
        style: {
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          opacity: 0,
          cursor: disabled ? 'default' : 'pointer',
        },
      })}
    </View>
  );
}
