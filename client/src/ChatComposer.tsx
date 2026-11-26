import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from 'expo-router';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputInstance,
} from 'react-native';
import { MAX_PICKS, pickImages, picksFromFiles, previewUri, type Picked } from './attachments';
import { PhotoPicker } from './PhotoPicker';
import { colors, shadow } from './theme';

interface SpeechRec {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}
export interface ComposerHandle {
  setText: (text: string) => void;
}

export const ChatComposer = forwardRef<
  ComposerHandle,
  {
    onSend: (text: string, picks: Picked[]) => Promise<void>;
    running: boolean;
    blocked: boolean;
    onStop: () => void;
    draft?: boolean;
  }
>(function ChatComposer({ onSend, running, blocked, onStop, draft }, ref) {
  const focused = useIsFocused();
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<Picked[]>([]);
  const [processing, setProcessing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [listening, setListening] = useState(false);
  const input = useRef<TextInputInstance>(null);
  const container = useRef<ComponentRef<typeof View>>(null);
  const picksRef = useRef<Picked[]>([]);
  const busyRef = useRef(false);
  const sendingRef = useRef(false);
  const recRef = useRef<SpeechRec | null>(null);
  const dropDepth = useRef(0);
  const unavailable = blocked || sending;

  useImperativeHandle(
    ref,
    () => ({
      setText: (value) => {
        setText(value);
        input.current?.focus();
      },
    }),
    [],
  );
  useEffect(
    () => () => {
      recRef.current?.stop();
    },
    [],
  );
  useEffect(() => {
    if (!draft || Platform.OS !== 'web') return;
    try {
      const shared = sessionStorage.getItem('polaris.share');
      if (shared) {
        setText(shared);
        sessionStorage.removeItem('polaris.share');
      }
    } catch {
      /* storage unavailable */
    }
  }, [draft]);

  const updatePicks = (items: Picked[]) => {
    picksRef.current = items;
    setPicks(items);
  };
  const add = async (get: (room: number) => Promise<Picked[]>) => {
    if (busyRef.current || sendingRef.current || blocked) return;
    const room = MAX_PICKS - picksRef.current.length;
    if (room <= 0) {
      setError(`Можно прикрепить до ${MAX_PICKS} фото.`);
      return;
    }
    busyRef.current = true;
    setProcessing(true);
    setError(null);
    try {
      updatePicks([...picksRef.current, ...(await get(room))].slice(0, MAX_PICKS));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (Platform.OS !== 'web' || !focused) return;
    const node = container.current as unknown as HTMLElement | null;
    if (!node) return;
    const paste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      void add((room) => picksFromFiles(files, room));
    };
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      dropDepth.current++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    const leave = () => {
      if (--dropDepth.current <= 0) {
        dropDepth.current = 0;
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      dropDepth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void add((room) => picksFromFiles(files, room));
    };
    node.addEventListener('paste', paste);
    node.addEventListener('dragenter', enter);
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);
    return () => {
      node.removeEventListener('paste', paste);
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    };
    // add uses refs for current files and locks; blocked is the only changing permission.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, blocked]);

  const send = async () => {
    const content = text.trim();
    if ((!content && !picksRef.current.length) || busyRef.current || sendingRef.current || running || blocked) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    recRef.current?.stop();
    try {
      await onSend(content, picksRef.current);
      setText('');
      updatePicks([]);
      input.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const speechOk =
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const scope = window as unknown as {
      SpeechRecognition?: new () => SpeechRec;
      webkitSpeechRecognition?: new () => SpeechRec;
    };
    const Ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (event) =>
      setText(
        (text ? `${text} ` : '') +
          Array.from(event.results)
            .map((r) => r[0]!.transcript)
            .join(''),
      );
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('Не удалось включить диктовку. Проверьте доступ к микрофону.');
    }
  };
  const enabled = (!!text.trim() || picks.length > 0) && !processing && !sending && !running && !blocked;

  return (
    <View
      style={{
        width: '100%',
        maxWidth: 784,
        alignSelf: 'center',
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 10,
      }}
    >
      <View
        ref={container}
        testID="chat-composer"
        style={[
          {
            padding: 12,
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: dragging ? colors.accent : colors.border,
            borderRadius: 23,
          },
          shadow,
        ]}
      >
        {picks.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 4, paddingBottom: 12 }}>
            {picks.map((pick) => (
              <View key={pick.key} style={{ width: 76 }}>
                <Image
                  source={{ uri: previewUri(pick) }}
                  accessibilityLabel={`Прикреплено: ${pick.name}`}
                  resizeMode="cover"
                  style={{ width: 76, height: 70, borderRadius: 10, backgroundColor: colors.surface2 }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Убрать фото: ${pick.name}`}
                  disabled={sending}
                  onPress={() => updatePicks(picksRef.current.filter((p) => p.key !== pick.key))}
                  hitSlop={6}
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -5,
                    width: 21,
                    height: 21,
                    borderRadius: 11,
                    backgroundColor: colors.ink,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Ionicons name="close" size={13} color={colors.accentText} />
                </Pressable>
                <Text numberOfLines={1} style={{ fontSize: 10, color: colors.muted, marginTop: 4 }}>
                  {pick.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        <TextInput
          ref={input}
          accessibilityLabel="Сообщение ChatGTT"
          value={text}
          onChangeText={setText}
          placeholder={dragging ? 'Отпустите фото здесь' : 'Спросите что-нибудь…'}
          placeholderTextColor={colors.muted}
          multiline
          editable={!unavailable}
          autoComplete="off"
          textContentType="none"
          importantForAutofill="no"
          autoCapitalize="sentences"
          onKeyPress={(event) => {
            const key = event.nativeEvent as unknown as {
              key: string;
              shiftKey?: boolean;
              isComposing?: boolean;
              keyCode?: number;
            };
            if (
              Platform.OS === 'web' &&
              key.key === 'Enter' &&
              !key.shiftKey &&
              !key.isComposing &&
              key.keyCode !== 229
            ) {
              (event as unknown as { preventDefault: () => void }).preventDefault();
              void send();
            }
          }}
          style={[
            {
              color: colors.text,
              fontSize: 16,
              lineHeight: 23,
              minHeight: 50,
              maxHeight: 180,
              paddingHorizontal: 6,
              paddingTop: 5,
              paddingBottom: 10,
            },
            Platform.OS === 'web' && ({ outlineStyle: 'none' } as object),
          ]}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            <PhotoPicker
              disabled={unavailable || processing || picks.length >= MAX_PICKS}
              onFiles={(files) => void add((room) => picksFromFiles(files, room))}
              onNative={() => void add(pickImages)}
            />
            {processing || sending ? (
              <>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={{ fontSize: 12, color: colors.muted }}>
                  {processing ? 'Обрабатываю фото…' : 'Отправляю…'}
                </Text>
              </>
            ) : picks.length ? (
              <Text style={{ fontSize: 12, color: colors.muted }}>
                {picks.length} / {MAX_PICKS} фото
              </Text>
            ) : (
              <Text style={{ fontSize: 12, color: colors.muted }}>Фото и изображения</Text>
            )}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {speechOk && !running ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={listening ? 'Остановить диктовку' : 'Диктовать голосом'}
                disabled={unavailable}
                onPress={toggleMic}
                style={{ padding: 8, borderRadius: 18, backgroundColor: listening ? colors.surface2 : 'transparent' }}
              >
                <Ionicons
                  name={listening ? 'stop' : 'mic-outline'}
                  size={19}
                  color={listening ? colors.accent : colors.muted}
                />
              </Pressable>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={running ? 'Остановить' : 'Отправить'}
              disabled={!enabled && !running}
              onPress={running ? onStop : () => void send()}
              style={{
                width: 35,
                height: 35,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: enabled || running ? colors.accent : colors.surface2,
              }}
            >
              <Ionicons
                name={running ? 'stop' : 'arrow-up'}
                size={19}
                color={enabled || running ? colors.accentText : colors.muted}
              />
            </Pressable>
          </View>
        </View>
      </View>
      {error ? (
        <View accessibilityRole="alert" style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 }}>
          <Text style={{ flex: 1, color: colors.danger, fontSize: 12, lineHeight: 18 }}>{error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Скрыть ошибку" onPress={() => setError(null)}>
            <Ionicons name="close" size={16} color={colors.danger} />
          </Pressable>
        </View>
      ) : null}
      <Text style={{ textAlign: 'center', color: colors.muted, fontSize: 11, paddingTop: 10 }}>
        ChatGTT может ошибаться. Проверяйте важную информацию.
      </Text>
    </View>
  );
});
