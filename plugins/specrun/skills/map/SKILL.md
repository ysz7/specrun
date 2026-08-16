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

That rule holds for `capability` and `control` blocks, and stops at `infrastructure` and
`integration`. Those two are named after **what they actually are** — `The lock file`, `Postgres`,
`The skills folder`, `S3` — because a queue called "holding work until later" helps nobody. A
technology in a `capability` name is still a mistake; a technology *as* an infrastructure node is
the point of drawing one.

### The budget

Up to **9 blocks at the top level**, up to **7 children** — infrastructure nodes — hanging off any
one block, **3 levels** deep counting the project itself: the project names the page, the blocks
are the drawing, and each one's infrastructure hangs off it.

These are not arbitrary: a map with thirty boxes is read as a wall and closed. When something
does not fit, group it rather than adding a box — three siblings that share a purpose
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
| `capability` | something the project does for its users | `card` fill, solid border |
| `control` | how a person or another program drives it — CLI, HTTP entry, schedule | solid border, short orange rule under the title |
| `infrastructure` | what a block runs on or writes to — a file, a folder, a queue, a table, a container | quieter `bg` fill, short card, no statement |
| `integration` | a system outside this repository | dashed border, drawn outside the boundary |
| `channel` | what two neighbouring blocks pass between them — a file, a topic, a queue | small pill, orange border, in the gap between them |

Kinds are told apart by surface, border and size — never by inventing new colours. This is the one
place the design departs hardest from the work it is based on, which colour-codes every component
type. The palette has one accent on purpose, and a second saturated hue is what breaks the look
fastest.

### Infrastructure is a node, not a footnote

This is the part most easily got wrong. What a block **runs on or writes to** gets its own card,
above or below that block, on a straight vertical arrow: the lock file, the state database, the
queue, the bucket, the container image. It is a short card — name and one mono line, no statement.

Burying those in the tag line of a capability card loses the shape of the system. A reader can see
that the installer writes something; what they cannot see is *what*, and that a second block reads
the same file.

Two things stop this becoming a wall: only draw infrastructure a block genuinely touches at
runtime, and let the three summary cards carry the rest. Test runners, CI files and release
channels almost always belong there rather than in a box — nothing in the drawing uses them.

When the thing is *between* two neighbouring blocks rather than owned by one — a queue they both
speak to, a file one writes and the next reads — draw it as a **channel pill** in the gap between
them instead, joined to each by a short dashed stub.

### The stack inside a card

A card is a stack of at most four kinds of line, and the order is fixed:

1. **name** — sans 12.5/600, centred. What the block does, in the language of the task.
2. **orange rule** — 36×2, `control` only, directly under the name.
3. **statement** — sans 11 `sub`, centred. One sentence.
4. **tag** — mono 9.5 on its own bottom line, centred: the machine fact worth carrying on the card
   itself (`Python · ast · stdlib`, `init · sync · status · scan`, `:8080`). `faint` by default;
   `--hot` (orange) on the one or two cards where the reader should stop.

A hub — the one block everything goes through — may carry up to three statement lines, 16 apart,
which is what makes it visibly the hub without a colour or a size trick. A card with nothing to
put in the tag line simply ends earlier rather than being padded to a standard height.

An `infrastructure` card is half of that: name, then one mono line. No statement — its name is
already the statement.

### Two strokes

- **uses** — a solid dark line with an arrowhead: this block uses that one. **Any angle.** A fan of
  four straight diagonals out of a hub into a stack is the normal picture, not a failure to line
  things up; leave the block at slightly different heights so the lines stay apart where they
  start.
- **channel** — a short dashed grey stub, no arrowhead, joining a block to a channel pill in the
  gap below it.

Two is the budget. If you find yourself wanting a third for "sends events to" or "reads from", put
that in the card's statement instead — words are cheaper than a legend nobody can hold in their
head. Take the edges from the import graph, and draw only the ones a reader needs; a map with an
edge for every import is a dependency graph, which is a different and much less useful picture.

### What does not go on the map

Every directory that exists, generated code, vendored dependencies, each individual test file,
and anything the scan itself flagged as noise. Facts that matter but do not deserve a box —
entry points, external systems, what runs in CI — go in the three summary cards under the diagram,
which is what they are for.

## 3. Draw it

Copy `assets/template.html` and edit it. It is a complete worked example with real coordinates,
which is far easier to adapt than a description of coordinates would be.

**Its numbers are for its content, not for yours.** There is no fixed grid here: no column
positions to snap to, no row pitch, no standard card height. Place each block where this system's
shape wants it and let the sizes below be starting points. What has to hold is the spacing rules
and the drawing order — those are what keep a map from overlapping itself.

### Sizes to start from

| Thing | Size |
|---|---|
| viewBox | `0 0 1000 H` to start; grow either dimension to fit |
| Standard block | 180 × 76 — name, one statement, one tag |
| Hub block | 170 × 108 — name, three statements, one tag |
| Small block, e.g. an actor | 110 × 76 |
| `infrastructure` block | 150 × 56 — name and one mono line |
| `channel` pill | 140 × 20, `rx="6"` |
| Corner radius | `rx="10"` on blocks, `12` on the boundary |
| Border | `1.5px` everywhere |

Inside a block: name at `y + 24` (sans 12.5/600), the `control` rule at `y + 31`, the first
statement at `y + 45` and each next 16 lower, the tag 20 below the last statement. An
`infrastructure` block is name at `y + 24`, mono at `y + 44`. All of it centred.

### Spacing rules

These are the ones to obey rather than adapt, because breaking them produces a map that looks
almost right:

- **Minimum vertical gap between stacked blocks: 40.** That gap is also exactly where a channel
  pill goes — a 20-tall pill centred in it, with 10px of dashed stub above and below.
- **Minimum horizontal gap between columns: 40**, and 60 where an arrow has to carry an arrowhead
  comfortably.
- **Boundary padding: at least 25** around the outermost block it holds.
- **Legend goes below every boundary, at least 20 clear of the lowest one.** Inside a boundary it
  reads as one of the components that boundary encloses. Grow the viewBox to make room rather than
  tucking it into a margin.

### Drawing order

SVG paints in document order, and the whole layering of the map depends on it:

1. the grid pattern,
2. the boundary rectangles and their labels,
3. **every arrow**,
4. every card,
5. the legend.

Arrows before cards is the rule that matters. Drawn in that order, a line that has to pass under a
block disappears cleanly beneath it, because our cards have opaque fills. Draw the cards first and
the same line runs straight across a name.

(The work this is based on needs a second, opaque backing rectangle under every box for this to
work, because its fills are semi-transparent. Ours are not, so one rect per card is enough.)

**SVG does not wrap text**, so a line that is too long does not reflow — it runs out of the card
and over whatever is beside it, and nothing in the markup looks wrong. The text is centred, so an
overflow spills out of *both* sides. Divide the usable width by the character width before writing
a line, and cut words rather than shrinking the font:

| Line | Character width | On a 180-wide block |
|---|---|---|
| name, sans 12.5/600 | ≈ 6.9 | 23 characters |
| statement, sans 11 | ≈ 5.5 | 29 characters |
| tag, mono 9.5 | ≈ 5.7 | 28 characters, separated by ` · ` |

`Pydantic AI · asyncio · shared runtime` is 38 and overflows a 180-wide tag line;
`Pydantic AI · asyncio` fits and the rest belongs in the statement.

Do not add web fonts, CDN scripts or external images. The map has to open from a double click,
from any folder, with no network — that is the whole reason it is one file, and it is the one
place this skill deliberately does less than the work it is based on, which loads a rasteriser and
a PDF library from a CDN. The export buttons here rasterise the inline SVG on a plain canvas
instead, so leave the `<style>` block inside the `<svg>` where it is: serialising the SVG is what
makes Copy and PNG work, and styles defined outside it would be lost.

## 4. Two modes

**Overview** is the default: the blocks, the boundary, and the infrastructure they actually touch.
It is what somebody asking "what is this repo" wants, and it fits on a screen.

**Detail** is for a request that asks for it — "show me what's inside the agent loop", "expand
the ingestion side". Split the block that was asked about into two or three neighbouring blocks
and give them their own infrastructure; leave the rest of the drawing as it was. Expanding
everything at once produces the thirty-box wall the budget exists to prevent.

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
- is the infrastructure a reader would ask about actually drawn — the file it writes, the database
  it reads — rather than buried in a tag line?
- does anything overlap: text past a card's edge, two blocks closer than 40 apart, a channel pill
  touching the block above it?
- is the legend below every boundary rather than sitting inside one?
- did the arrows get drawn before the cards, so the ones that pass beneath a block disappear under
  it instead of crossing its name?

---

Rendering approach based on `Cocoon-AI/architecture-diagram-generator` by Cocoon AI, MIT.
