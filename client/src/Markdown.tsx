import * as Clipboard from 'expo-clipboard';
import katex from 'katex';
import { createElement, Fragment, useState, type ReactNode } from 'react';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { colors, fonts, radius, space } from './theme';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: "ui-monospace, 'SF Mono', Consolas, monospace" });
const IS_WEB = Platform.OS === 'web';

// ── Математика ────────────────────────────────────────────────────────────────
// Формулы приходят в LaTeX (как в ChatGPT): \( … \), \[ … \], $$ … $$, $ … $.
// В вебе их рисует KaTeX; на нативных платформах — упрощённый текст с юникод-символами.

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻';
const SUB = '₀₁₂₃₄₅₆₇₈₉₊₋';
const SCRIPT_CHARS = '0123456789+-';
const toScript = (s: string, table: string) =>
  s && [...s].every((c) => SCRIPT_CHARS.includes(c)) ? [...s].map((c) => table[SCRIPT_CHARS.indexOf(c)]).join('') : null;
const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝', infty: '∞', pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ', mu: 'μ',
  nu: 'ν', xi: 'ξ', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  sum: 'Σ', prod: 'Π', int: '∫', oint: '∮', partial: '∂', nabla: '∇', hbar: 'ℏ', ell: 'ℓ', to: '→',
  rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
  degree: '°', circ: '°', ldots: '…', dots: '…', cdots: '⋯', quad: ' ', qquad: '  ', langle: '⟨', rangle: '⟩',
  dagger: '†', star: '⋆', otimes: '⊗', oplus: '⊕', angle: '∠', perp: '⊥', parallel: '∥',
};
const paren = (s: string) => (/^[\w.,]+$/.test(s.trim()) ? s.trim() : `(${s.trim()})`);

/** LaTeX → читаемый текст (запасной вариант без KaTeX): 45^2 → 45², \frac{a}{b} → a/b, \times → ×. */
function latexToText(src: string): string {
  let s = src;
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => `${paren(a)}/${paren(b)}`)
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:text|mathrm|mathbf|mathit|operatorname|mathcal|hat|vec|bar|dot|tilde)\s*\{([^{}]*)\}/g, '$1');
  }
  return s
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b\s*/g, '')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\\\/g, '; ')
    .replace(/\\([A-Za-z]+)/g, (m: string, name: string) => SYMBOLS[name] ?? m.slice(1))
    .replace(/\\%/g, '%')
    .replace(/\^\{([^{}]*)\}|\^([0-9+-]+)/g, (_m, a?: string, b?: string) => toScript(a ?? b ?? '', SUP) ?? `^${a ?? b}`)
    .replace(/_\{([^{}]*)\}|_([0-9]+)/g, (_m, a?: string, b?: string) => toScript(a ?? b ?? '', SUB) ?? `_${a ?? b}`)
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const htmlCache = new Map<string, string>();
function renderKatex(tex: string, display: boolean): string | null {
  const key = `${display ? 'D' : 'I'}${tex}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const html = katex.renderToString(tex, { displayMode: display, throwOnError: true, output: 'html', strict: 'ignore' });
    if (htmlCache.size > 500) htmlCache.clear();
    htmlCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

interface Formula {
  tex: string;
  display: boolean;
}

/** Применяет fn только к тексту вне блоков кода и `инлайн-кода`. */
function outsideCode(text: string, fn: (plain: string) => string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .split(/(`[^`\n]*`)/)
            .map((part, j) => (j % 2 === 1 ? part : fn(part)))
            .join(''),
    )
    .join('');
}

/** Вырезает формулы, оставляя в тексте маркеры: \u0002n\u0002 — блочная, \u0001n\u0001 — строчная. */
function extractMath(text: string): { text: string; maths: Formula[] } {
  const maths: Formula[] = [];
  const add = (tex: string, display: boolean) => maths.push({ tex: tex.trim(), display }) - 1;
  const out = outsideCode(text.replace(/[\u0001\u0002]/g, ''), (plain) =>
    plain
      .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_m, a?: string, b?: string) => `\n\n\u0002${add(a ?? b ?? '', true)}\u0002\n\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_m, f: string) => `\u0001${add(f, false)}\u0001`)
      .replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d\w$])/g, (_m, f: string) => `\u0001${add(f, false)}\u0001`),
  );
  return { text: out, maths };
}

function MathView({ math, display }: { math: Formula; display: boolean }) {
  const html = IS_WEB ? renderKatex(math.tex, display) : null;
  if (IS_WEB && html) {
    return display
      ? createElement('div', {
          style: { overflowX: 'auto', overflowY: 'hidden', padding: '2px 0', margin: '2px 0 6px', fontSize: window.innerWidth < 430 ? 15 : 17 },
          dangerouslySetInnerHTML: { __html: html },
        })
      : createElement('span', { dangerouslySetInnerHTML: { __html: html } });
  }
  const text = latexToText(math.tex);
  return display ? (
    <Text style={{ fontFamily: MONO, fontSize: 15, lineHeight: 24, color: colors.text, marginBottom: space.sm }} selectable>
      {text}
    </Text>
  ) : (
    <Text style={{ fontStyle: 'italic' }}>{text}</Text>
  );
}

// ── Инлайн-разметка ───────────────────────────────────────────────────────────

const INLINE =
  /(\u0001\d+\u0001|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<![\w*])\*[^*\s][^*\n]*\*(?!\*)|(?<!\w)_[^_\s][^_\n]*_(?!\w)|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>)\]]+)/g;

const open = (url: string) => void Linking.openURL(url);

/** **жирный**, *курсив*, ~~зачёркнутый~~, `код`, [ссылка](https://…), голые ссылки и формулы. */
function inline(text: string, maths: Formula[], keyBase: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (!part) return null;
    const m = /^\u0001(\d+)\u0001$/.exec(part);
    if (m) return maths[Number(m[1])] ? <MathView key={key} math={maths[Number(m[1])]!} display={false} /> : null;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {inline(part.slice(2, -2), maths, key)}
        </Text>
      );
    if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4)
      return (
        <Text key={key} style={{ textDecorationLine: 'line-through', color: colors.muted }}>
          {inline(part.slice(2, -2), maths, key)}
        </Text>
      );
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <Text key={key} style={{ fontFamily: MONO, fontSize: 14, backgroundColor: colors.surface2 }}>
          {` ${part.slice(1, -1)} `}
        </Text>
      );
    if ((part.startsWith('*') && part.endsWith('*') && part.length > 2) || (part.startsWith('_') && part.endsWith('_') && part.length > 2))
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {inline(part.slice(1, -1), maths, key)}
        </Text>
      );
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link)
      return (
        <Text key={key} style={linkStyle} onPress={() => open(link[2]!)}>
          {link[1]}
        </Text>
      );
    if (/^https?:\/\//.test(part)) {
      const url = part.replace(/[.,;:!?]+$/, '');
      return (
        <Fragment key={key}>
          <Text style={linkStyle} onPress={() => open(url)}>
            {url}
          </Text>
          {part.slice(url.length)}
        </Fragment>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

const linkStyle = { color: colors.accent, textDecorationLine: 'underline' } as const;
const sans = { color: colors.text, fontSize: 16, lineHeight: 25 } as const;
/** Текст ответа — с засечками (как книжная страница), служебные элементы (таблицы, код) — без. */
const base = { ...sans, fontFamily: fonts.serif, fontSize: 17, lineHeight: 27 } as const;

// ── Блоки ─────────────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [done, setDone] = useState(false);
  return (
    <View style={{ backgroundColor: colors.surface2, borderRadius: radius.sm, marginBottom: space.sm, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.md, paddingTop: 6 }}>
        <Text style={{ color: colors.muted, fontSize: 12 }}>{lang || 'код'}</Text>
        <Pressable
          hitSlop={8}
          onPress={async () => {
            await Clipboard.setStringAsync(code);
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }}
        >
          <Text style={{ color: done ? colors.success : colors.muted, fontSize: 12 }}>{done ? 'Скопировано' : 'Копировать'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal contentContainerStyle={{ padding: space.md, paddingTop: 6 }}>
        <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 20, color: colors.text }} selectable>
          {code}
        </Text>
      </ScrollView>
    </View>
  );
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

function Table({ rows, align, maths, k }: { rows: string[][]; align: ('left' | 'center' | 'right')[]; maths: Formula[]; k: string }) {
  return (
    <ScrollView horizontal style={{ marginBottom: space.sm }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden', flexGrow: 1 }}>
        {rows.map((row, r) => (
          <View
            key={r}
            style={{
              flexDirection: 'row',
              backgroundColor: r === 0 ? colors.surface2 : 'transparent',
              borderTopWidth: r === 0 ? 0 : 1,
              borderColor: colors.border,
            }}
          >
            {row.map((cell, c) => (
              <Text
                key={c}
                selectable
                style={[sans, { flex: 1, minWidth: 116, fontSize: 15, lineHeight: 22, paddingHorizontal: 10, paddingVertical: 7, textAlign: align[c] ?? 'left', fontWeight: r === 0 ? '700' : '400' }]}
              >
                {inline(cell, maths, `${k}-${r}-${c}`)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/**
 * Рендер Markdown для ответов агента в стиле ChatGPT: абзацы, заголовки, списки (в т.ч. вложенные и с галочками),
 * цитаты, таблицы, разделители, блоки кода с копированием, ссылки, зачёркивание и формулы LaTeX (KaTeX).
 */
export function Markdown({ text }: { text: string }) {
  const { text: src, maths } = extractMath(text.replace(/\r\n/g, '\n'));
  return <Blocks src={src} maths={maths} />;
}

function Blocks({ src, maths }: { src: string; maths: Formula[] }) {
  const lines = src.split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let afterList = false;
  const key = (p: string) => `${p}${out.length}`;

  const flush = () => {
    if (!para.length) return;
    const k = key('p');
    out.push(
      <Text key={k} style={[base, { marginTop: afterList ? space.sm : 0, marginBottom: space.sm }]} selectable>
        {inline(para.join('\n'), maths, k)}
      </Text>,
    );
    para = [];
    afterList = false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*```\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      afterList = false;
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(<CodeBlock key={key('c')} code={code.join('\n')} lang={fence[1] ?? ''} />);
      continue;
    }

    const block = /^\u0002(\d+)\u0002$/.exec(line.trim());
    if (block) {
      flush();
      afterList = false;
      const m = maths[Number(block[1])];
      if (m) out.push(<MathView key={key('m')} math={m} display />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      afterList = false;
      const k = key('h');
      const level = heading[1]!.length;
      out.push(
        <Text
          key={k}
          style={[base, { fontWeight: '700', fontSize: level === 1 ? 22 : level === 2 ? 19 : 17, lineHeight: level <= 2 ? 28 : 25, marginTop: space.md, marginBottom: 4 }]}
          selectable
        >
          {inline(heading[2]!, maths, k)}
        </Text>,
      );
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      afterList = false;
      out.push(<View key={key('r')} style={{ height: 1, backgroundColor: colors.border, marginVertical: space.md }} />);
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      afterList = false;
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) quote.push(lines[i]!.replace(/^\s*>\s?/, ''));
      i--;
      out.push(
        <View key={key('q')} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space.md, marginBottom: space.sm }}>
          <Blocks src={quote.join('\n')} maths={maths} />
        </View>,
      );
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      flush();
      afterList = false;
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')) as (
        | 'left'
        | 'center'
        | 'right'
      )[];
      const rows = [head];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) {
        const cells = splitRow(lines[i]!);
        while (cells.length < head.length) cells.push('');
        rows.push(cells.slice(0, head.length));
      }
      i--;
      out.push(<Table key={key('t')} rows={rows} align={align} maths={maths} k={key('t')} />);
      continue;
    }

    const item = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const k = key('l');
      const ordered = /^\d/.test(item[2]!);
      const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
      const depth = Math.min(Math.floor(item[1]!.replace(/\t/g, '    ').length / 2), 4);
      out.push(
        <View key={k} style={{ flexDirection: 'row', marginBottom: 3, paddingLeft: depth * 16 }}>
          <Text style={[base, { minWidth: ordered ? 26 : 22, color: colors.muted }]}>
            {task ? (task[1] === ' ' ? '☐' : '☑') : ordered ? item[2] : depth > 0 ? '◦' : '•'}
          </Text>
          <Text style={[base, { flex: 1 }]} selectable>
            {inline(task ? task[2]! : item[3]!, maths, k)}
          </Text>
        </View>,
      );
      afterList = true;
      continue;
    }

    if (afterList && /^\s{2,}\S/.test(line)) {
      const k = key('n');
      out.push(
        <Text key={k} style={[base, { paddingLeft: 22 + Math.min(Math.floor(line.search(/\S/) / 2), 4) * 8, marginBottom: 4 }]} selectable>
          {inline(line.trim(), maths, k)}
        </Text>,
      );
      continue;
    }

    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  return <View>{out}</View>;
}
