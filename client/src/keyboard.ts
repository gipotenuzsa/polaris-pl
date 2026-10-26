import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

const NON_TEXT_INPUTS = ['checkbox', 'radio', 'button', 'file', 'submit', 'range', 'color'];

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.includes(el.type);
}

/**
 * Открыта ли экранная клавиатура. Нужна, чтобы прятать нижнюю панель вкладок и не тратить место.
 * Нативные платформы: события Keyboard. Веб: на сенсорных устройствах — фокус в поле ввода (iPhone в PWA не всегда
 * меняет размеры окна при клавиатуре) плюс уменьшение visualViewport; на компьютере панель не прячется.
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
      if (!touch) return;
      let focused = false;
      let squeezed = false;
      const vv = window.visualViewport;
      const sync = () => setOpen(focused || squeezed);
      const onIn = (e: FocusEvent) => {
        if (isEditable(e.target)) {
          focused = true;
          sync();
        }
      };
      const onOut = () => {
        // между полями фокус «моргает» — смотрим, куда он ушёл
        setTimeout(() => {
          focused = isEditable(document.activeElement);
          sync();
        }, 60);
      };
      const onResize = () => {
        squeezed = !!vv && window.innerHeight - vv.height > 120;
        sync();
      };
      document.addEventListener('focusin', onIn);
      document.addEventListener('focusout', onOut);
      vv?.addEventListener('resize', onResize);
      return () => {
        document.removeEventListener('focusin', onIn);
        document.removeEventListener('focusout', onOut);
        vv?.removeEventListener('resize', onResize);
      };
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
