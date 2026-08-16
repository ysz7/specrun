# Map visual reference

The visual language of the Specrun map, extracted from the Electron prototype before that
prototype was deleted. This file is the only surviving source of the design: every value below
was read out of the running renderer's code, not estimated from a screenshot.

`design/map-tokens.css` is the machine-readable half of this document: the same values as CSS
custom properties plus base classes for the card, the connectors and the chrome, ready to inline
into the map's self-contained HTML template. The prototype had no stylesheet of its own — its
palette lived in a TypeScript token object and everything else was inline React styles — so that
file is a transcription, not a copy. This document explains the values; that one applies them.

One image lives next to this file in `design/media/`:

- `map-example.png` — a map the skill drew for a real project. The authoritative composition
  reference, and the one in the README.

The prototype's own screenshots (`hero.png`, `demo.gif`) were removed once the skill's output
diverged from them. They showed an application window around the map — a title bar, a chat panel,
a status bar — none of which the skill produces; keeping them meant the composition reference and
the shipped output disagreed with nobody to arbitrate. The values below still come from the
prototype's code, which is a different claim and still true.

The prototype was light-only (`color-scheme: light`); no dark palette ever existed. A dark theme,
if one is wanted later, has to be designed rather than recovered.

---

## 1. Palette

One flat token set. Every colour in the prototype came from here; nothing was hard-coded at the
component level.

### Surfaces

| Token | Hex | Use |
|---|---|---|
| `bg` | `#F7F4ED` | page / canvas background, warm off-white paper |
| `paper` | `#FBF9F4` | secondary panel surfaces, half a step lighter than the canvas |
| `card` | `#FDFCF9` | node card fill, the lightest surface — cards read as lifted off the canvas |

### Text

| Token | Hex | Use |
|---|---|---|
| `ink` | `#23221E` | primary text: node titles, active breadcrumb |
| `sub` | `#6E6961` | secondary text: node statements, descriptions, chrome labels |
| `faint` | `#A39D92` | tertiary text: counts, path fragments, mono annotations, separators |

### Lines

| Token | Hex | Use |
|---|---|---|
| `line` | `#C9C2B4` | default card border, panel borders, scrollbar thumb |
| `lineSoft` | `#DDD7CA` | quieter dividers (e.g. the status bar's top border) |
| `edge` | `#3A3833` | structural connectors between nodes and their arrowheads — darker than any border, so the skeleton of the tree reads first |

### Accent and semantics

| Token | Value | Use |
|---|---|---|
| `orange` | `#D9622B` | the single accent: selection, attention, primary buttons, the rule under the apex title |
| `orangeSoft` | `rgba(217,98,43,0.08)` | translucent accent wash behind badges |
| `orangeTint` | `#F5E8DD` | **opaque** equivalent of `orangeSoft` composited over `bg`. Used for the fill of a selected card that sits on top of a connector — a translucent fill would let the line show through the card |
| `green` | `#7A9464` | healthy / confirmed status dot |
| `greenSoft` | `rgba(122,148,100,0.12)` | wash behind a green badge |
| `blue` | `#4A6B8A` | defined in the token set but barely used; available as a fourth semantic colour |

The palette is deliberately narrow: one accent, one positive, everything else neutral warm greys.
Adding a second saturated hue is what would break the look fastest, so node types should be
distinguished by shape, border style and label rather than by inventing new colours.

---

## 2. Typography

Three families, referenced by role and never mixed arbitrarily.

```
serif  'Tiempos Text', Georgia, 'Times New Roman', serif
sans   Inter, -apple-system, 'Segoe UI', sans-serif
mono   'SF Mono', ui-monospace, Menlo, monospace
```

No web fonts were bundled — there is no `@font-face` anywhere. Everything degrades to system
faces, which is what makes the design portable into a single self-contained HTML file.

Role assignment carries most of the character of the design:

- **serif** — only for the name of a thing: the apex title, panel headings, the project name in
  the header. It marks "this is the subject", and its rarity is what gives it weight.
- **sans** — all body text: node titles inside cards, statements, descriptions, buttons.
- **mono** — all machine facts: counts, file paths, flags, badges, breadcrumbs, chrome labels.
  This is the rule that keeps a card readable — the human sentence is sans, the metadata is mono
  and visibly smaller.

### Type scale, as actually used

| Element | Family | Size | Weight | Colour |
|---|---|---|---|---|
| Apex (root) card title | serif | 20 | 600 | `ink` |
| Apex statement | sans | 12.5 | normal | `ink`, line-height 1.45 |
| Apex meta line (`path · N children · N rules`) | sans | 12 | normal | `sub` |
| Apex hint (`↑ back to project`) | mono | 11 | normal | `orange` |
| Focused card title | sans | 15 | 600 | `ink` |
| Focused card statement | sans | 12 | normal | `sub`, line-height 1.45 |
| Focused card hint (`⤓ tap to make it the apex`) | mono | 11 | normal | `orange` |
| Child card title | sans | 12.5 | 550 | `ink`, line-height 1.3 |
| Sibling chip title | sans | 12 | 600 | `ink` |
| Card counter (right-aligned) | mono | 9.5–10 | normal | `faint` |
| Card annotation (`shallow`, path tail, flags) | mono | 9–9.5 | normal | `faint` (or `orange` when it warns) |
| Breadcrumbs | mono | 10.5 | normal | `sub`, current crumb `ink`, separators `faint` |
| Status bar items | mono | 10.5 | normal | `sub` |
| Buttons | sans | 13.5 | 600 primary / normal ghost | `#fff` / `sub` |

Sizes are fractional on purpose (12.5, 13.5, 9.5). They were tuned against the specific faces
above; rounding them all to integers visibly coarsens the density.

Three information levels per card is the ceiling: name (12–15 sans), one sentence (12 sans
`sub`), machine facts (9–10 mono `faint`). A fourth level has nowhere to go.

---

## 3. The node card

The single most important object. Everything else is arrangement.

### Base

```
background:    #FDFCF9            (card)
border:        1.5px solid #C9C2B4  (line)
border-radius: 10px
box-shadow:    0 1px 2px rgba(35,34,30,0.04)
cursor:        pointer
transition:    opacity 0.25s, border-color 0.2s, box-shadow 0.2s
```

The shadow is almost invisible by design — it is a hairline of separation from the canvas, not a
lift. The border does the real work.

Note the border weight: **1.5px, not 1px**. At 1px the warm border disappears against the warm
canvas; at 2px the cards start to look like buttons. This is the one value most likely to be
"corrected" by mistake.

### Padding by role

| Role | Padding | Width |
|---|---|---|
| Apex card | `14px 24px` | `max-width: 440`, text centred |
| Sibling chip | `7px 12px` | intrinsic (content width) |
| Focused card | `13px 18px` | `320` |
| Child card | `9px 13px` | `300` |
| Generic default | `12px 16px` | — |

Card size encodes hierarchy directly: the further down the tree, the narrower and tighter the
card. Nothing else in the design communicates depth, so these widths matter.

### States

| State | Rendering |
|---|---|
| Default | border `1.5px solid line`, base shadow |
| Selected / active (`hot`) | border `1.5px solid orange`, shadow `0 3px 14px rgba(35,34,30,0.12)`; selected chips also swap fill to `orangeTint` |
| Unconfirmed (`dashed`) | border `1.5px dashed orange` — same weight, dashed stroke |
| Dimmed (filtered out) | `opacity: 0.28`, still laid out and still in place |
| Hidden | `opacity: 0`, layout preserved so the arrangement never jumps |
| In progress | pulsing ring: `0 0 0 0 rgba(217,98,43,0.35)` → `0 0 0 6px rgba(217,98,43,0)`, 1.5s ease-in-out, infinite |

**There is no hover state on cards.** Cards respond to selection, not to the pointer. The only
hover effects in the prototype were on title-bar controls and command-palette rows. This is worth
preserving: on a dense map, hover highlighting turns into flicker.

The solid/dashed distinction is the semantic core of the design: **solid means confirmed, dashed
means asserted but not verified.** Colour then says how much it matters — an orange dashed border
is a problem, a grey dashed border is merely unverified.

### Apex accent rule

Under the apex title sits a short horizontal rule, and it is the reason the apex reads as the
root without being larger than everything else:

```
width: 36px; height: 2px; background: #D9622B; margin: 7px auto 0;
```

### Inline pieces inside a card

**Status dot** — 8×8, `border-radius: 99`, no border, `flex-shrink: 0`. Colours: `green` = ok,
`orange` = drift / conflict, `faint` = muted or pending.

**Warning badge** (`⚠3`) — mono 9.5, colour `orange`, background `orangeSoft`, border
`1px solid rgba(217,98,43,0.35)`, radius 5, padding `1px 5px`.

**Neutral badge / chip label** — mono 9, border `1px solid` the text colour at 33% alpha
(written as an `55` hex suffix), radius 5, padding `1px 5px`; background `greenSoft`,
`orangeSoft` or transparent depending on tone.

Badge radius is 5 against the card's 10 — small elements get roughly half the card's radius, which
keeps the corners looking like one family.

---

## 4. Connectors

Two visually distinct kinds of line, and the distinction is deliberate.

### Structural connector — containment

Drawn from the bottom edge of the parent to the top edge of the child, in SVG behind the cards.

```
stroke: #3A3833   (edge)
stroke-width: 1.5
fill: none
```

Not a straight diagonal and not a bezier: an **orthogonal elbow with rounded corners**. It leaves
the parent vertically, turns once at a horizontal junction line, runs sideways, turns again, and
enters the child vertically. Corner radius 9, drawn as quadratic curves:

```
M x1 y1
L x1 (jy - r)   Q x1 jy (x1 + r·dir) jy
L (x2 - r·dir) jy   Q x2 jy x2 (jy + r)
L x2 y2
```

where `jy` is the shared junction line (in the prototype, 26px below the parent's bottom edge) and
`dir` is the horizontal direction. When the two cards are within 2px of the same centre, the elbow
degenerates to a plain vertical segment — an almost-straight elbow looks like a mistake.

**Arrowhead**: a triangle marker, 9×9 viewport, `refX 6.5`, `refY 3.5`, path `M0,0 L7,3.5 L0,7 z`,
filled with `edge`, `orient="auto"`. The line stops ~12px short of the child card so the arrowhead
sits in clear space rather than touching the border.

### Sequence connector — order between siblings

```
stroke: #D9622B   (orange)
stroke-width: 2.2
stroke-dasharray: 0.1 6.5
stroke-linecap: round
```

A zero-length dash with a round cap renders as a **row of dots**, not dashes. Thicker and warmer
than the structural line, but visually lighter because it is mostly gap. No arrowhead.

The pairing is the point: dark, thin, continuous, arrowed = structure; orange, thick, dotted,
unarrowed = sequence. Two line kinds is the budget; a third would need a different mechanism.

### Layering

Connectors are drawn in one SVG layer at `z-index: 0`, `pointer-events: none`,
`overflow: visible`. Cards sit above at `z-index: 1`, and the active card at `z-index: 2` with an
opaque fill — otherwise a line passing behind it shows through and reads as passing over it. Any
card that a connector can pass under must have an opaque background, which is exactly why
`orangeTint` exists as an opaque twin of `orangeSoft`.

---

## 5. Composition

Two compositions exist, and they are not the same drawing.

**The prototype's** was a single centred column on a plain canvas — an apex card, a wrapped row of
sibling chips, then a focused card with children stacked under it, everything on one 720-wide
column that panned and zoomed as one transformed group (`transform: translate(x, y) scale(s)`,
`transform-origin: 0 0`, wheel zoom clamped to 0.3–2.4, `s = min(1, (viewport − 24) / 720)` on
first paint). Vertical rhythm was loose at the top (68 above the apex, 46 to the sibling row, 40
to the focused card) and tight at the bottom (20 between stacked children); junction lines sat 26
below a parent. That arrangement suited an interactive tree with one node in focus at a time.

**The shipped map's** is different, and deliberately so: it is a static picture, read once, by
somebody who has never been here. It is a **freely placed drawing** on a bordered canvas — no fixed
grid, no column positions, no row pitch — with a dashed boundary around the part this repository
owns, arrows at whatever angle they need, and a legend below every boundary. What holds it together
is a set of spacing rules rather than a template of coordinates. `design/media/map-example.png`
still shows the old column and is due a redraw.

```
  ╭─ canvas, faint 40px grid ────────────────────────────────────────────╮
  │        ┌╴Your project checkout ╶╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┐           │
  │        ╷       ╭──▸┌──────────┐──▸┌──────────┐          ╷           │
  │        ╷      ╱    │ Block    │   │ infra    │          ╷           │
  │ ┌────┐ ╷ ┌────────┐└──────────┘   └──────────┘          ╷           │
  │ │ ── │ ╷ │ Hub    │───▸┌──────────┐                     ╷           │
  │ │stmt│▸╷ │ stmt×3 │╲   └──────────┘                     ╷           │
  │ └────┘ ╷ │ tag    │ ╲   ( channel )    ← in the 40 gap  ╷           │
  │        ╷ └────────┘  ╲ ┌──────────┐──▸┌──────────┐──────┼──▸┌─────┐ │
  │        ╷              ▸│ Block    │   │ infra    │      ╷   ┆ ext ┆ │
  │        ╷               └──────────┘   └──────────┘      ╷   └─────┘ │
  │        └╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┘           │
  │  legend  ▫ capability  ▫ infrastructure  ▫ integration  ▬ control    │
  ╰──────────────────────────────────────────────────────────────────────╯
```

### Sizes and rules

| Measure | Value |
|---|---|
| viewBox | `0 0 1000 H` to start, grown in either direction |
| Canvas | a CSS div — `paper` fill, `line` border, radius 14, `overflow-x: auto`; the SVG inside carries `min-width: 900px` so a narrow window scrolls rather than shrinks |
| Grid | 40px, `line-soft` at 0.75 width and 60% opacity, filling the whole SVG |
| Standard block | 180 × 76 · hub 170 × 108 · actor 110 × 76 · infrastructure 150 × 56 |
| Channel pill | 140 × 20, radius 6, `orange` border, centred in the gap |
| Radius / border | 10 on blocks, 12 on the boundary; 1.5px stroke throughout |
| Minimum gaps | 40 vertical between stacked blocks, 40 horizontal (60 where an arrow needs room), 25 boundary padding |
| Legend | below every boundary, ≥20 clear of the lowest |

Card text is centred and stacked: name (sans 12.5/600) at `y + 24`, the `control` rule at `y + 31`,
statements (sans 11 `sub`) at `y + 45` and every 16 below, tag (mono 9.5, `faint` or `orange`) 20
under the last statement. An infrastructure card is name at `y + 24` and mono at `y + 44`, because
its name is already the whole statement. That fourth line is the one addition the shipped map makes
to the prototype's three-level ceiling, and it only works because it is machine facts in mono,
visibly a different register from the sentence above it.

Drawing order carries the layering and is not cosmetic: grid, boundaries, **every arrow**, then
every card, then the legend. Our fills are opaque, so an arrow drawn before the cards passes
cleanly beneath them — which is why the source this borrows from needs a second backing rectangle
under each box and this one does not.

Two changes from the prototype are worth stating plainly, because both contradict rules written
above and both were chosen:

- **The apex card is gone.** The project's name is the page heading; the boundary label says what
  the enclosed part is. A card that only repeats the title costs a row.
- **There is one connector, not two.** The prototype paired a dark arrowed elbow (structure) with
  an orange dotted line (sequence). A picture with no selected node and no ordering has no use for
  the second: every arrow here means *uses*, and what a node is comes from its surface and its
  position instead. The orange is spent on the `control` rule and the one or two hot tags.
- **There is a panel and a grid.** The prototype had neither — "no grid, no frame, no panels" was
  true of it. A static picture that will be exported to PNG and pasted into a document needs an
  edge; a floating column on paper does not read as a diagram once it leaves the app.
- **`infrastructure` fills with `bg`, not `paper`.** On the paper panel, `paper` is the panel's own
  colour and the card would lose its fill; `bg` is one step darker and reads as recessed.

### Chrome

Kept minimal so the map owns the window.

- **Header**, floating over the canvas at top-left, `pointer-events: none` except its own
  controls: project name (serif 14/600), ` / `, current apex (serif 14/600), then mono 10 counters
  and small mono 11 toggle pills — `4px 10px`, radius 8, `1.5px` border, `card` background;
  active pill inverts to orange fill with white text.
- **Breadcrumbs**, centred above the apex: mono 10.5, `sub` for links, `faint` for the `›`
  separators, `ink` for the current node.
- **Status bar**, fixed to the bottom: height 26, `card` background, `1.5px solid lineSoft` top
  border, mono 10.5 `sub` items with 10px horizontal padding; an active item turns `orange`.
- **Scrollbars**: 8px, thumb `#C9C2B4`, radius 4, no track.

### Buttons

```
primary:  sans 13.5/600, #fff on orange, no border, radius 9, padding 11px 16px
ghost:    sans 13.5,     sub on transparent, 1.5px solid line, radius 9, padding 10px 16px
```

Radius 9 for controls against 10 for cards — controls read as slightly crisper without looking
like a different system.

### Popovers and panels

`card` background, `1.5px solid line`, radius 8, `box-shadow: 0 6px 20px rgba(0,0,0,0.12)`,
padding 6. This is the only place a real (visible) shadow is used — floating layers cast one,
in-flow cards do not.

---

## 6. Reproducing a node card from scratch

A checklist for someone who has never seen the original:

1. Warm off-white canvas `#F7F4ED`.
2. Rounded rectangle, radius 10, fill `#FDFCF9`, border `1.5px solid #C9C2B4`, shadow
   `0 1px 2px rgba(35,34,30,0.04)`, padding `9px 13px`, width 300.
3. First row, `display: flex; align-items: center; gap: 8`: an 8px status dot (`#7A9464` when
   healthy), then the title in sans 12.5, weight 550, colour `#23221E`, line-height 1.3; push a
   mono 9.5 `#A39D92` counter to the right with `margin-left: auto`.
4. Optional second row, indented 16px to clear the dot, `margin-top: 4`, `gap: 8`: mono 9.5
   `#A39D92` annotations. Anything that warns switches to `#D9622B`.
5. If the card is unverified, change the border to `1.5px dashed` and, if it also demands
   attention, to `#D9622B`.
6. If the card is selected, border `#D9622B`, shadow `0 3px 14px rgba(35,34,30,0.12)`, and — when
   a connector may pass beneath it — fill `#F5E8DD`.
7. Connect it to its parent with a `1.5px` `#3A3833` orthogonal elbow, corner radius 9, ending
   ~12px above the card with a 9×9 filled arrowhead.

---

## 7. Provenance

Values were read from the Electron prototype's renderer, principally:

- `shared/tokens.ts` — the complete palette and font stacks
- `shared/ui.tsx` — card shell, badges, status dot, buttons
- `shared/status.ts` — the solid/dashed and colour semantics
- `widgets/Pyramid.tsx` — layout metrics, connectors, arrowheads, pan/zoom
- `pages/Workspace.tsx`, `widgets/StatusBar.tsx`, `renderer/index.html` — chrome, background,
  scrollbars
- `renderer/src/main.tsx` — the pulse keyframes

Those files are removed in the next phase. This document and `design/map-tokens.css` replace them:
the prototype is gone, and so are the screenshots of it. What the skill draws today is the
reference for composition — this document, for everything measurable.
