import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Открыта ли экранная клавиатура. Нужна, чтобы прятать нижнюю панель вкладок и не тратить место:
 * на iPhone в PWA клавиатура уменьшает visualViewport, на нативных платформах есть события Keyboard.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      if (!vv) return;
      const update = () => setOpen(window.innerHeight - vv.height > 120);
      vv.addEventListener('resize', update);
      return () => vv.removeEventListener('resize', update);
    }
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setOpen(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}
