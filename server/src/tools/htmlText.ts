import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'canvas',
  'template',
  'head',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'select',
]);
const BLOCK = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'li',
  'ul',
  'ol',
  'tr',
  'table',
  'blockquote',
  'pre',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'dd',
  'dt',
  'dl',
  'figure',
  'figcaption',
  'details',
  'summary',
]);

export interface ExtractedPage {
  title: string;
  text: string;
  links: { text: string; href: string }[];
}

function walk(node: AnyNode, out: string[], links: ExtractedPage['links'], baseUrl: string | undefined): void {
  if (node.type === 'text') {
    out.push(node.data.replace(/\s+/g, ' '));
    return;
  }
  if (node.type !== 'tag') return;
  const el = node as Element;
  const name = el.name.toLowerCase();
  if (SKIP.has(name)) return;

  const heading = /^h([1-6])$/.exec(name);
  if (heading) out.push(`\n\n${'#'.repeat(Number(heading[1]))} `);
  else if (name === 'li') out.push('\n- ');
  else if (name === 'pre') out.push('\n```\n');
  else if (BLOCK.has(name)) out.push('\n');

  const mark = out.length;
  for (const child of el.children) walk(child, out, links, baseUrl);

  if (name === 'a') {
    const href = el.attribs.href;
    const text = out.slice(mark).join('').trim();
    if (href && text && !href.startsWith('#') && !href.startsWith('javascript:')) {
      try {
        const abs = new URL(href, baseUrl).toString();
        if (links.length < 40 && /^https?:/.test(abs)) links.push({ text: text.slice(0, 100), href: abs });
      } catch {
        /* битая ссылка */
      }
    }
  }
  if (name === 'pre') out.push('\n```\n');
  else if (name !== 'li' && (heading || BLOCK.has(name))) out.push('\n');
}

export function htmlToText(html: string, baseUrl?: string): ExtractedPage {
  const $ = cheerio.load(html);
  const title =
    $('title').first().text().replace(/\s+/g, ' ').trim() || $('h1').first().text().replace(/\s+/g, ' ').trim();
  const rootEl = $('article').first().length
    ? $('article').first()
    : $('main').first().length
      ? $('main').first()
      : $('body').first();
  const root = rootEl.get(0);
  const out: string[] = [];
  const links: ExtractedPage['links'] = [];
  if (root) walk(root, out, links, baseUrl);
  const text = out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text, links };
}
