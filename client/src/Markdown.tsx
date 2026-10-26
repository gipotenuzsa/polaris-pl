import { Fragment, type ReactNode } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { colors, radius, space } from './theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: "ui-monospace, 'SF Mono', Consolas, monospace" });
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

/** Инлайн-разметка: **жирный**, *курсив*, `код`, [ссылка](https://…). */
function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {part.slice(2, -2)}
        </Text>
      );
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <Text key={key} style={{ fontFamily: MONO, fontSize: 14, backgroundColor: colors.surface2 }}>
          {` ${part.slice(1, -1)} `}
        </Text>
      );
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {part.slice(1, -1)}
        </Text>
      );
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link)
      return (
        <Text
          key={key}
          style={{ color: colors.accent, textDecorationLine: 'underline' }}
          onPress={() => void Linking.openURL(link[2]!)}
        >
          {link[1]}
        </Text>
      );
    return <Fragment key={key}>{part}</Fragment>;
  });
}

const base = { color: colors.text, fontSize: 16, lineHeight: 25 } as const;

/** Лёгкий рендер Markdown для ответов агента: абзацы, списки, заголовки, блоки кода. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    const k = `p${out.length}`;
    out.push(
      <Text key={k} style={[base, { marginBottom: space.sm }]} selectable>
        {inline(para.join('\n'), k)}
      </Text>,
    );
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith('```'); i++) code.push(lines[i]!);
      out.push(
        <View
          key={`c${out.length}`}
          style={{ backgroundColor: colors.surface2, borderRadius: radius.sm, padding: space.md, marginBottom: space.sm }}
        >
          <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 20, color: colors.text }} selectable>
            {code.join('\n')}
          </Text>
        </View>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const k = `h${out.length}`;
      out.push(
        <Text
          key={k}
          style={[base, { fontWeight: '700', fontSize: heading[1]!.length <= 2 ? 19 : 17, marginTop: space.sm, marginBottom: 4 }]}
          selectable
        >
          {inline(heading[2]!, k)}
        </Text>,
      );
      continue;
    }
    const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const k = `l${out.length}`;
      out.push(
        <View key={k} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: Math.min(item[1]!.length, 8) * 4 }}>
          <Text style={[base, { width: 22, color: colors.muted }]}>{/^\d/.test(item[2]!) ? item[2] : '•'}</Text>
          <Text style={[base, { flex: 1 }]} selectable>
            {inline(item[3]!, k)}
          </Text>
        </View>,
      );
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return <View>{out}</View>;
}
