// Stable identifiers and slugs (format-spec §2, §4 Base.id).
//   genId(kind) → "<prefix>-<6 hex>", matching /^[a-z]+-[0-9a-f]{6}$/
//   slugify(title) → kebab-case, ASCII-transliterated, ≤ 48 chars
import { randomBytes } from 'node:crypto';
import type { Kind } from './schema.js';

const ID_PREFIX: Record<Kind, string> = {
  root: 'a',
  section: 'sec',
  domain: 'd',
  sub: 's',
  rule: 'r',
  plan: 'p',
  'plan-step': 'ps',
  note: 'n',
};

/** Generate a fresh id for a node of the given kind, e.g. `genId("rule") → "r-9be1f2"`. */
export function genId(kind: Kind): string {
  return `${ID_PREFIX[kind]}-${randomBytes(3).toString('hex')}`;
}

// Minimal Cyrillic → Latin transliteration so Russian titles yield readable ASCII slugs.
const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

const SLUG_MAX = 48;

/**
 * Derive a stable slug from a title: lowercase, transliterate to ASCII, collapse any run of
 * non-alphanumeric characters to a single `-`, trim, and cap at 48 characters. Slugs never
 * change after creation (a rename changes `title`, not the file), so this is only used once.
 */
export function slugify(title: string): string {
  const translit = [...title.toLowerCase()]
    .map((ch) => (ch in CYRILLIC ? CYRILLIC[ch] : ch))
    .join('');
  const ascii = translit.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const slug = ascii
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug;
}
