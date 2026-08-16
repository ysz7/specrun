---
name: map
description: Use this skill when someone wants to *see* a codebase rather than read about it: draw, sketch, visualise, chart, picture or map this repo, project or service's architecture; an "architecture overview" or "one-pager"; "what is this thing / how do the pieces fit" asked with any hint that prose won't do; or someone needing to be walked through the system for onboarding, handover, review or a presentation. It produces one self-contained HTML map whose blocks are named after the jobs the system does. Use it just as readily for iterating on such a map — an earlier or existing map that is stale, too shallow, or should be redrawn, zoomed, given more depth, or opened up to show what's inside one area. "Expand the X side" is a normal request here; the skill just redraws at more detail. Not for: UML (class, sequence, ER, state), flowcharts of a single function or algorithm, infrastructure or network topology drawings, charts of data or metrics, or architecture descriptions wanted purely in words.
---

# Mapping a repository

The map answers one question for someone who has never worked here: *what does this thing do, and
what is it made of?* It is a picture of the project's jobs, not of its folders — a reader who
wanted the folders would have run `ls`.

That makes the hard part naming, not drawing. The facts come from a scanner; the value you add is
deciding which of them are worth a block and what to call it.

## 1. Get the facts

```
specrun scan --json
```

It reports the directory tree with file counts, the modules and the import edges between them,
declared dependencies, entry points, and the infrastructure it found — CI, containers, tests,
Terraform. Everything in it was read off the disk, so it can be trusted as ground truth and
should not be second-guessed or padded out from memory.

Read the `notes` field. It says where the scan stopped: the import graph covers Python and
JavaScript/TypeScript only, wide directories are summarised, and a huge checkout gets truncated.
A gap named there is a gap you have to fill by opening a few files, not one to fill by guessing.

If the `specrun` command is not available, say so, then read the repository yourself — its
manifests, entry points and top-level directories — and carry on. The map is worth having either
way; it is just slower to build and easier to get wrong.

The scan does not know what anything is *for*. Names, one-line statements and which parts matter
come from reading the code: for each block you plan to draw, open its entry file and enough of
its neighbours to say what it does in a sentence. Two or three files per block is usually plenty.

## 2. Decide the blocks

**Name every top-level block in the language of the task, not of the code.** "Reading a
repository", not `scan.py`; "Answering a question from documents", not `rag/`. A block whose name
matches a directory name has usually skipped the thinking step — the reader can see directory
names already, and what they cannot see is what those directories are *for*.

Technologies belong in the third line of a card (`Python · argparse · stdlib`), never in a block
name and never as a block of their own. A technology only becomes a block when it is a system
outside this repository — a database, a payment provider, an API the code calls — and then it is
an `integration`.

### The budget

Up to **9 blocks at the top level**, up to **7 children** under any one block, **3 levels** deep
counting the project itself: the project names the page, the blocks are the columns, the features
hang off the blocks.

These are not arbitrary: a map with thirty boxes is read as a wall and closed. When something
does not fit, group it rather than lengthening the row — three siblings that share a purpose
become one block with three children, and the map gets easier to read instead of longer.

### The project is not a box

The project's own name is the page heading, not a node. Drawing it as a card at the top costs a
row and says nothing the title bar has not already said. What replaces it is the **boundary**: a
dashed rectangle with a mono label (`Your project checkout`, `The service`) around the blocks this
repository actually owns. Anything outside the boundary — the person driving it, an agent reading
its output, a database it writes to — is somebody else's, and that is the fastest fact the map can
give a newcomer.

### Kinds of node

| Kind | What it is | How it is drawn |
|---|---|---|
| `capability` | something the project does for its users | card fill, solid border |
| `infrastructure` | how it is built, run, tested, deployed | quieter `bg` fill, solid border — reads recessed against the panel |
| `integration` | a system outside this repository | dashed border, drawn outside the boundary |
| `control` | how a person or another program drives it — CLI, HTTP entry, schedule | solid border, short orange rule under the title |
| `feature` | something inside a block, at the second level | smaller card, 148 wide, one line of text, no tag |

Kinds are told apart by surface, border, size and label — never by inventing new colours. The
palette has one accent on purpose, and a second saturated hue is what breaks the look fastest.

### The stack inside a top-level card

A top-level card is a stack of at most four lines, and the order is fixed:

1. **name** — sans 12.5/600, centred. What the block does, in the language of the task.
2. **orange rule** — 36×2, `control` only, directly under the name.
3. **statement** — sans 11 `sub`, centred. One sentence.
4. **tag** — mono 9.5 on its own bottom line, centred: the machine fact worth carrying on the card
   itself (`Python · ast · stdlib`, `init · sync · status · scan`, `:8080`). `faint` by default;
   `--hot` (orange) on the one or two cards where the reader should stop.

A card with nothing to put in the tag line is shorter (76 instead of 84) rather than padded. A
fifth line has nowhere to go — that is what the feature nodes below the card are for.

### Two kinds of edge

- **contains** — a dark thin elbow with an arrowhead, from a block down to a feature inside it.
  Vertical, short, and always entering the feature from its left edge.
- **uses** — an orange dotted line with a small arrowhead: this block calls that one. This is the
  left-to-right spine of the map and the thing a reader follows first. Take these from the import
  graph, and draw only the ones a reader needs; a map with an edge for every import is a
  dependency graph, which is a different and much less useful picture.

Two kinds is the whole budget. If you find yourself wanting a third line style for "sends events
to" or "reads from", put that in the card's statement instead — words are cheaper than a legend
nobody can hold in their head. And keep the arrows meaning *uses*: if they start reading as data
flowing through a pipeline, the map has quietly turned into a sequence diagram.

### What does not go on the map

Every directory that exists, generated code, vendored dependencies, each individual test file,
and anything the scan itself flagged as noise. Facts that matter but do not deserve a box —
entry points, external systems, what runs in CI — go in the three summary cards under the diagram,
which is what they are for.

## 3. Draw it

Copy `assets/template.html` and edit it. It is a complete worked example with real coordinates,
which is far easier to adapt than a description of coordinates would be. Keep its geometry and
replace its content.

The map **reads left to right**: who drives it, then what it does, then what it writes to. Each
column is a vertical stack of cards, and the whole thing sits on one panel with a faint grid. Grow
`H` in `viewBox="0 0 1000 H"` to fit the tallest column; leave the width alone.

| Measure | Value |
|---|---|
| Panel | x=12, y=12, w=976, rx=12, faint 80px grid clipped to it |
| Columns | x = 44, 278, 512, 746 — four of them, 190 wide, 44 apart |
| Gutters, where vertical runs belong | the middle of each gap: x = 256, 490, 724 |
| Top-level card | 190 × 84 (× 76 with no tag line), `rx="10"`, border `1.5px` |
| Feature card | 148 × 28, `rx="8"`, at `columnX + 42` — flush with the card's right edge |
| Feature spine | leaves the card's bottom at `columnX + 24` |
| First feature top | 16 below the card; feature pitch 36 |
| Gap under a block's last feature | 28 before the next card in the column |
| Boundary inset | 28 left of the first column inside it, 18 right of the last |
| Elbow corner radius | 9 on `uses`, 8 on the feature spine, drawn as quadratic curves |
| Arrow stops short of a card | 6px |

Four columns is what fits; three or two is common and fine — spread the columns out rather than
leaving a hole. A column with one card in it is a legitimate column.

**Features hang off their parent, never between two blocks.** The spine drops from the parent's
bottom-left and each feature is entered from its *left* edge, so the line reaching the third
feature never crosses the first two. Each feature is one line of sans 11 — no statement, no tag.
If a feature needs a sentence, it is a block, not a feature.

**SVG does not wrap text**, so a line that is too long does not reflow — it runs out of the card
and over whatever is beside it, and nothing in the markup looks wrong. The cards are centred, so
an overflow spills out of *both* sides. Count characters against these ceilings before writing
them, and cut words rather than shrinking the font:

| Line | Ceiling |
|---|---|
| name, sans 12.5/600 | 24 characters |
| statement, sans 11 | 28 characters |
| tag, mono 9.5 | 28 characters, separated by ` · ` |
| feature, sans 11 | 20 characters |
| boundary label, mono 10.5 | 34 characters |

`Pydantic AI · asyncio · shared runtime` is 38 and overflows the tag line;
`Pydantic AI · asyncio` fits and the rest belongs in the statement.

Three mistakes are worth checking for by eye, because all three look fine in the markup:

- **a connector crossing a card.** Horizontal `uses` runs at card mid-height, vertical runs belong
  in the gutters. If an edge cannot get where it is going without crossing something, the
  arrangement is wrong, not the edge — reorder the columns so that related blocks are neighbours.
- **features colliding with the next card down.** A block with four features is 160px taller than
  one with none; the column below it has to move down, not overlap.
- **the legend sitting on top of the drawing.** It goes in the clear space under the shortest
  column, and its longest label has to end before the next column starts. If there is no clear
  space, grow the viewBox rather than tucking it into a margin.

Do not add web fonts, CDN scripts or external images. The map has to open from a double click,
from any folder, with no network — that is the whole reason it is one file. The export buttons in
the template rasterise the inline SVG on a plain canvas for exactly this reason, so leave the
`<style>` block inside the `<svg>` where it is: serialising the SVG is what makes Copy and PNG
work, and styles defined outside it would be lost.

## 4. Two modes

**Overview** is the default: the columns and the boundary, no features. It is what somebody asking
"what is this repo" wants, and it fits on a screen.

**Detail** is for a request that asks for it — "show me what's inside the agent loop", "expand
the ingestion side". Hang features under the blocks that were asked about and leave the other
columns bare. Every block carrying features at once produces the thirty-box wall the budget exists
to prevent, and it makes the columns wildly different heights.

## 5. Save and open it

Write to `.specrun/map.html` unless the developer names another path, then open it — `open` on
macOS, `xdg-open` on Linux — so they see it rather than a path. That folder is already in
`.gitignore` for a reason: a map is a report, regenerated whenever it is wanted, and its diffs
have no place in a review.

## Before handing it over

Look at the rendered file, not at the markup, and check the things that are wrong in ways that
still render perfectly:

- would someone who has never worked here answer "what does this application do" from the top
  level alone?
- do any top-level names contain a language, a framework, a product or a directory name?
- does the boundary hold exactly what this repository owns, with the people and the outside
  systems drawn beyond it?
- do the arrows read as *uses*, or have they started to read as data flowing through a pipeline?
- does every block trace back to something in the scan or to a file you actually opened?
- does anything overlap: a line across a card, features running into the card below them, the
  legend over a node, text past a card's edge?

---

Rendering approach based on `Cocoon-AI/architecture-diagram-generator` by Cocoon AI, MIT.
