// Design tokens — lifted verbatim from the original design reference so the ported
// pyramid reads identically. One source of colour/type; components import T, never hard-code.
export const T = {
  bg: '#F7F4ED',
  paper: '#FBF9F4',
  card: '#FDFCF9',
  ink: '#23221E',
  sub: '#6E6961',
  faint: '#A39D92',
  line: '#C9C2B4',
  lineSoft: '#DDD7CA',
  edge: '#3A3833',
  orange: '#D9622B',
  orangeSoft: 'rgba(217,98,43,0.08)',
  // Opaque equivalent of orangeSoft composited over the bg — for selected fills that sit over the
  // pyramid connectors (a translucent fill would let the arrow show through).
  orangeTint: '#F5E8DD',
  green: '#7A9464',
  greenSoft: 'rgba(122,148,100,0.12)',
  blue: '#4A6B8A',
  serif: "'Tiempos Text', Georgia, 'Times New Roman', serif",
  sans: "Inter, -apple-system, 'Segoe UI', sans-serif",
  mono: "'SF Mono', ui-monospace, Menlo, monospace",
} as const;
