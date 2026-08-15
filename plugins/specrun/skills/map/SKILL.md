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

Up to **9 blocks at the top level**, up to **7 children** under any one block, **3 levels** deep.

These are not arbitrary: a map with thirty boxes is read as a wall and closed. When something
does not fit, group it rather than lengthening the row — three siblings that share a purpose
become one block with three children, and the map gets easier to read instead of longer.

### Four kinds of node

| Kind | What it is | How it is drawn |
|---|---|---|
| `capability` | something the project does for its users | card fill, solid border |
| `infrastructure` | how it is built, run, tested, deployed | quieter `paper` fill, solid border |
| `integration` | a system outside this repository | dashed border |
| `control` | how a person or another program drives it — CLI, HTTP entry, schedule | solid border, short orange rule under the title |

Kinds are told apart by surface, border and label — never by inventing new colours. The palette
has one accent on purpose, and a second saturated hue is what breaks the look fastest.

### Two kinds of edge

- **contains** — a dark thin elbow with an arrowhead, drawn from a parent's bottom edge into a
  child's top edge. This is the skeleton and it reads first.
- **uses** — an orange dotted line with a small arrowhead: this block calls that one. Take these
  from the import graph, and draw only the ones a reader needs; a map with an edge for every
  import is a dependency graph, which is a different and much less useful picture.

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

The layout is a grid inside a `viewBox="0 0 1000 H"`; grow `H` to fit the rows and leave the
width alone.

| Measure | Value |
|---|---|
| Card | 300 × 66, `rx="10"`, border `1.5px` |
| Third-level card | 260 × 52 — width is what carries depth |
| Apex card | 440 wide, centred at x=500 |
| Columns | x = 10, 350, 690 (three per row) |
| Gutters, where vertical lines may run | x = 330 and x = 670 |
| Row pitch | 146 (card top to card top) |
| Junction line below a parent | 26px |
| Elbow corner radius | 9, drawn as quadratic curves |
| Arrow stops short of a card | 12px |

Inside a card: an 8px status dot, the title in sans 12.5, the kind in mono 9.5 right-aligned, one
sentence in sans 12, and the technologies in mono 9.5. Three levels of information per card is the
ceiling; a fourth has nowhere to go.

**SVG does not wrap text**, so a line that is too long does not reflow — it runs out of the card
and over whatever is beside it, and nothing in the markup looks wrong. Count characters against
these ceilings before writing them, and cut words rather than shrinking the font:

| Line | Ceiling |
|---|---|
| title, sans 12.5 | 28 characters — the kind tag on the right eats the rest of the row |
| statement, sans 12 | 46 characters |
| technologies, mono 9.5 | 46 characters, separated by ` · ` |

`Pydantic AI · asyncio · shared by console and server` is 52 and overflows;
`Pydantic AI · asyncio · shared runtime` fits and says the same thing.

Two mistakes are worth checking for by eye, because both look fine in the markup:

- **a connector crossing a card.** Vertical runs belong in the gutters. If an edge cannot get
  where it is going without crossing something, the arrangement is wrong, not the edge —
  reorder the blocks so that related ones are neighbours.
- **the legend sitting on top of the drawing.** Put it in clear canvas below the lowest card, and
  grow the viewBox height to make room.

Do not add web fonts, CDN scripts or external images. The map has to open from a double click,
from any folder, with no network — that is the whole reason it is one file. The export buttons in
the template rasterise the inline SVG on a plain canvas for exactly this reason, so leave the
`<style>` block inside the `<svg>` where it is: serialising the SVG is what makes Copy and PNG
work, and styles defined outside it would be lost.

## 4. Two modes

**Overview** is the default: one level, the top-level blocks only, no children. It is what
somebody asking "what is this repo" wants, and it fits on a screen.

**Detail** is for a request that asks for it — "show me what's inside the agent loop", "expand
the ingestion side". Add children under the blocks that were asked about and leave the rest at
one level. Expanding everything at once produces the thirty-box wall the budget exists to
prevent.

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
- do the arrows read as *uses*, or have they started to read as data flowing through a pipeline?
- does every block trace back to something in the scan or to a file you actually opened?
- does anything overlap: a line across a card, the legend over a node, text past a card's edge?

---

Rendering approach based on `Cocoon-AI/architecture-diagram-generator` by Cocoon AI, MIT.
