import * as ImagePicker from 'expo-image-picker';
import { Alert, Platform } from 'react-native';

/** Выбранная, но ещё не отправленная картинка. */
export interface Picked {
  key: string;
  name: string;
  mime: string;
  /** base64 без префикса data: */
  data: string;
}

export const MAX_PICKS = 4;
const MAX_SIDE = 1568;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const previewUri = (p: Pick<Picked, 'mime' | 'data'>) => `data:${p.mime};base64,${p.data}`;

const uid = () => Math.random().toString(36).slice(2, 10);

/** Веб: читает файл, уменьшает до разумного размера и превращает в JPEG (экономит трафик и токены). */
async function fromFile(file: File): Promise<Picked> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Не удалось прочитать изображение'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение');
    ctx.fillStyle = '#fff'; // прозрачные PNG не должны стать чёрными
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return { key: uid(), name: `${base}.jpg`, mime: 'image/jpeg', data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Веб: файлы из input/вставки/перетаскивания → Picked (только изображения). */
export async function picksFromFiles(files: File[], room: number): Promise<Picked[]> {
  const images = files.filter((f) => f.type.startsWith('image/')).slice(0, room);
  return Promise.all(images.map(fromFile));
}

function fromAssets(assets: ImagePicker.ImagePickerAsset[]): Picked[] {
  return assets
    .filter((a) => a.base64)
    .map((a) => ({
      key: uid(),
      name: a.fileName ?? `photo-${uid()}.jpg`,
      mime: ALLOWED.includes(a.mimeType ?? '') ? a.mimeType! : 'image/jpeg',
      data: a.base64!,
    }));
}

const NATIVE_OPTIONS: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.6, exif: false };

async function pickNative(source: 'camera' | 'library', room: number): Promise<Picked[]> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) throw new Error('Нет доступа к камере. Разрешите его в настройках телефона.');
    const res = await ImagePicker.launchCameraAsync(NATIVE_OPTIONS);
    return res.canceled ? [] : fromAssets(res.assets);
  }
  const res = await ImagePicker.launchImageLibraryAsync({
    ...NATIVE_OPTIONS,
    allowsMultipleSelection: room > 1,
    selectionLimit: room,
  });
  return res.canceled ? [] : fromAssets(res.assets);
}

/** Веб: открывает системный диалог выбора файла. */
function pickWeb(room: number): Promise<Picked[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = room > 1;
    input.onchange = () => {
      picksFromFiles([...(input.files ?? [])], room).then(resolve, reject);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Выбор картинок: на вебе — диалог файлов, на телефоне — «Камера» или «Галерея». */
export function pickImages(room: number): Promise<Picked[]> {
  if (Platform.OS === 'web') return pickWeb(room);
  return new Promise((resolve, reject) => {
    const run = (source: 'camera' | 'library') => pickNative(source, room).then(resolve, reject);
    Alert.alert('Прикрепить фото', undefined, [
      { text: 'Камера', onPress: () => void run('camera') },
      { text: 'Галерея', onPress: () => void run('library') },
      { text: 'Отмена', style: 'cancel', onPress: () => resolve([]) },
    ]);
  });
}
