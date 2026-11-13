import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';

/** Выбранная, но ещё не отправленная картинка. */
export interface Picked {
  key: string;
  name: string;
  mime: string;
  /** base64 без префикса data: */
  data: string;
}

export const MAX_PICKS = 4;
const MAX_SIDE = 2560;
const MAX_BYTES = 8_000_000;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const previewUri = (p: Pick<Picked, 'mime' | 'data'>) => `data:${p.mime};base64,${p.data}`;

const uid = () => Math.random().toString(36).slice(2, 10);

function readData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Не удалось прочитать файл. Попробуйте выбрать его ещё раз.'));
    reader.readAsDataURL(file);
  });
}

/** Preserve small originals and PNG transparency; resize only when needed. */
async function fromFile(file: File): Promise<Picked> {
  if (!file.size) throw new Error(`Файл «${file.name}» пустой.`);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(new Error(`Не удалось открыть «${file.name}». Выберите изображение в формате PNG, JPEG, WebP или GIF.`));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const mime =
      file.type ||
      (
        { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<
          string,
          string
        >
      )[file.name.split('.').pop()?.toLowerCase() ?? ''] ||
      'application/octet-stream';
    if (scale === 1 && ALLOWED.includes(mime ?? '') && file.size <= MAX_BYTES) {
      return { key: uid(), name: file.name.slice(0, 200) || 'image', mime, data: await readData(file) };
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Не удалось обработать изображение');
    const png = mime === 'image/png';
    if (!png) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let outputMime = png ? 'image/png' : 'image/jpeg';
    let data = canvas.toDataURL(outputMime, 0.92).split(',')[1] ?? '';
    if (data.length * 0.75 > MAX_BYTES) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      outputMime = 'image/jpeg';
      data = canvas.toDataURL(outputMime, 0.85).split(',')[1] ?? '';
    }
    if (!data || data.length * 0.75 > MAX_BYTES) throw new Error('Изображение слишком большое. Выберите файл до 8 МБ.');
    const base = (file.name.replace(/\.[^.]+$/, '') || 'image').slice(0, 190);
    return { key: uid(), name: `${base}.${outputMime === 'image/png' ? 'png' : 'jpg'}`, mime: outputMime, data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Веб: файлы из input/вставки/перетаскивания → Picked (только изображения). */
export async function picksFromFiles(files: File[], room: number): Promise<Picked[]> {
  if (room <= 0) return [];
  const images = files
    .filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(f.name))
    .slice(0, room);
  if (!images.length) throw new Error('Выберите изображение в формате PNG, JPEG, WebP или GIF.');
  return Promise.all(images.map(fromFile));
}

function fromAssets(assets: ImagePicker.ImagePickerAsset[]): Picked[] {
  return assets.map((a) => {
    if (!a.base64) throw new Error('Не удалось прочитать фото. Попробуйте выбрать его ещё раз.');
    if (a.base64.length * 0.75 > MAX_BYTES) throw new Error('Фото слишком большое. Выберите изображение до 8 МБ.');
    // Pickers can convert HEIC/PNG to JPEG. Match the actual bytes rather than the original asset's MIME.
    const mime = a.base64.startsWith('/9j/')
      ? 'image/jpeg'
      : a.base64.startsWith('iVBORw0KGgo')
        ? 'image/png'
        : a.base64.startsWith('UklGR')
          ? 'image/webp'
          : a.base64.startsWith('R0lGOD')
            ? 'image/gif'
            : ALLOWED.includes(a.mimeType ?? '')
              ? a.mimeType!
              : 'image/jpeg';
    return {
      key: uid(),
      name: a.fileName ?? `photo-${uid()}.jpg`,
      mime,
      data: a.base64,
    };
  });
}

const NATIVE_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  base64: true,
  quality: 0.9,
  exif: false,
};

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

/** Native picker. Web uses a mounted file input in PhotoPicker. */
export function pickImages(room: number): Promise<Picked[]> {
  return new Promise((resolve, reject) => {
    let chosen = false;
    const run = (source: 'camera' | 'library') => {
      chosen = true;
      return pickNative(source, room).then(resolve, reject);
    };
    Alert.alert(
      'Прикрепить фото',
      undefined,
      [
        { text: 'Камера', onPress: () => void run('camera') },
        { text: 'Галерея', onPress: () => void run('library') },
        { text: 'Отмена', style: 'cancel', onPress: () => resolve([]) },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          if (!chosen) resolve([]);
        },
      },
    );
  });
}
