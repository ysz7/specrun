"""Facts about a repository, read from disk and nothing else.

This is the half of the map that must not be imagined. A model looking at a project can describe
what it is *for* far better than any parser, but it cannot be trusted to say which directories
exist, which dependencies are declared, or which module imports which — and a map that is wrong
about those is worse than no map, because it looks authoritative. So the split is: this module
reads, the map skill interprets.

Everything here is therefore literal. There are no layouts, no coordinates, no node types and no
opinion about what belongs on a diagram; those are decisions, and decisions are the model's half
of the work. What comes out is a flat set of observations — a tree, dependencies, entry points,
infrastructure, an import graph — each traceable to a file that was actually opened.

Two limits are deliberate. The import graph covers Python and JavaScript/TypeScript only, because
those are the ecosystems where imports can be resolved without a build; other languages still
contribute their tree, dependencies and entry points, and the graph simply has no edges for them.
And the walk stops after `MAX_FILES`, so a monorepo produces a truncated report rather than a
scan that never returns. Both facts are reported in `notes` rather than left to be discovered.
"""

from __future__ import annotations

import ast
import json
import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Iterator, Sequence

from . import gitignore

#: How deep the reported tree goes. Deeper than this stops describing shape and starts listing
#: files, which is what the tree exists to avoid.
DEFAULT_DEPTH = 3

#: A ceiling on the walk, so that a checkout with a vendored world in it still answers.
MAX_FILES = 20_000

#: Files larger than this are counted but not parsed. Anything this size is generated.
MAX_PARSE_BYTES = 512_000

#: Directories reported per level. A directory with ninety children says "there are ninety of
#: these", and the ten largest say it just as well while leaving the report readable.
MAX_CHILDREN = 12

#: How far from the root a file may sit and still be taken for an entry point on its name alone.
#: Deeper than this, `index.js` is a module inside something, not a way into the project.
MAX_ENTRY_DEPTH = 4

#: Paths listed per kind of infrastructure before the rest become a count.
MAX_INFRA_PER_KIND = 8

#: Directories no walk wants, whether or not the project remembered to ignore them. Caches and
#: build output are not the project; a virtualenv is somebody else's project entirely.
NOISE_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".venv",
        "venv",
        "env",
        "node_modules",
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".gradle",
        ".terraform",
        ".next",
        ".nuxt",
        ".parcel-cache",
        ".turbo",
        ".cache",
        "dist",
        "build",
        "site-packages",
        "coverage",
        ".idea",
        ".vscode",
    }
)

#: Extension → language. Only code: the "languages" fact answers what the project is written in,
#: so counting its Markdown and JSON would drown the answer in its own documentation.
LANGUAGES: dict[str, str] = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "c#",
    ".c": "c",
    ".h": "c",
    ".cc": "c++",
    ".cpp": "c++",
    ".hpp": "c++",
    ".m": "objective-c",
    ".swift": "swift",
    ".scala": "scala",
    ".ex": "elixir",
    ".exs": "elixir",
    ".sh": "shell",
    ".bash": "shell",
    ".sql": "sql",
    ".vue": "vue",
    ".svelte": "svelte",
}

PYTHON_SUFFIXES = frozenset({".py", ".pyi"})
JS_SUFFIXES = frozenset({".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".vue", ".svelte"})

#: Directories that hold modules rather than being one. `src/specrun` is a module called
#: `specrun`; `src` on its own names nothing about the project.
SOURCE_ROOTS: frozenset[str] = frozenset({"src", "lib", "app", "apps", "packages", "cmd", "pkg"})

#: Files whose name alone says a program starts here.
ENTRY_FILE_NAMES: dict[str, str] = {
    "__main__.py": "module",
    "main.py": "module",
    "manage.py": "module",
    "wsgi.py": "server",
    "asgi.py": "server",
    "main.go": "module",
    "main.rs": "module",
    "index.js": "module",
    "index.ts": "module",
    "server.js": "server",
    "server.ts": "server",
    "main.js": "module",
    "main.ts": "module",
}

#: Infrastructure recognised by exact name at any level of the tree.
INFRA_NAMES: dict[str, str] = {
    ".gitlab-ci.yml": "ci",
    ".travis.yml": "ci",
    "Jenkinsfile": "ci",
    "azure-pipelines.yml": "ci",
    "Dockerfile": "container",
    ".dockerignore": "container",
    "Makefile": "build",
    "justfile": "build",
    "noxfile.py": "build",
    "tox.ini": "build",
    ".pre-commit-config.yaml": "tooling",
    "renovate.json": "tooling",
    "dependabot.yml": "tooling",
}

#: Infrastructure recognised by where a file sits or what it is called, in order.
INFRA_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"^\.github/workflows/[^/]+\.ya?ml$", "ci"),
    (r"^\.circleci/config\.ya?ml$", "ci"),
    (r"(^|/)docker-compose[^/]*\.ya?ml$", "container"),
    (r"(^|/)compose\.ya?ml$", "container"),
    (r"(^|/)Dockerfile\.[^/]+$", "container"),
    (r"(^|/)[^/]+\.tf$", "infrastructure-as-code"),
    (r"^(k8s|kubernetes|helm|charts|deploy)/", "orchestration"),
    (r"(^|/)serverless\.ya?ml$", "orchestration"),
)

TEST_DIR_NAMES: frozenset[str] = frozenset({"tests", "test", "spec", "__tests__", "e2e"})

#: Directories whose contents are examples of the project rather than the project. A `main.py`
#: in a fixture is an entry point into nothing.
SAMPLE_DIR_NAMES: frozenset[str] = frozenset(
    {"fixtures", "fixture", "examples", "example", "samples", "playground", "demo", "demos"}
)

DOC_DIR_NAMES: frozenset[str] = frozenset({"docs", "doc", "documentation"})

#: PEP 508 and friends: everything before the first version or marker character is the name.
_REQUIREMENT_NAME = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)")


# --- what a scan reports ----------------------------------------------------------------------


@dataclass(frozen=True)
class TreeNode:
    """One directory, as shape rather than as a listing."""

    name: str
    path: str
    #: Files directly in this directory.
    files: int
    #: Files in this directory and everything under it, including below the depth cutoff.
    total_files: int
    languages: tuple[tuple[str, int], ...] = ()
    children: tuple[TreeNode, ...] = ()
    #: True when this directory has children the depth limit kept out of the report.
    truncated: bool = False
    #: Children left out because this directory has more than the report shows.
    hidden_children: int = 0

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": self.name,
            "path": self.path,
            "files": self.files,
            "total_files": self.total_files,
            "languages": [{"name": n, "files": c} for n, c in self.languages],
            "children": [child.to_dict() for child in self.children],
        }
        if self.truncated:
            data["truncated"] = True
        if self.hidden_children:
            data["hidden_children"] = self.hidden_children
        return data


@dataclass(frozen=True)
class Module:
    """A top-level unit of the project's own code — the vertices of the import graph."""

    name: str
    path: str
    language: str
    files: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "language": self.language,
            "files": self.files,
        }


@dataclass(frozen=True)
class ImportEdge:
    """`source` imports `target`, in `count` places. Both are module names."""

    source: str
    target: str
    count: int

    def to_dict(self) -> dict[str, Any]:
        return {"from": self.source, "to": self.target, "count": self.count}


@dataclass(frozen=True)
class Dependency:
    """A declared dependency on something outside the repository."""

    name: str
    manifest: str
    scope: str = "runtime"
    version: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "manifest": self.manifest,
            "scope": self.scope,
            "version": self.version,
        }


@dataclass(frozen=True)
class EntryPoint:
    """A place the project starts running."""

    name: str
    path: str
    kind: str
    #: Where this was read from: a manifest path, or "filename" when the name alone said so.
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "path": self.path, "kind": self.kind, "source": self.source}


@dataclass(frozen=True)
class Infrastructure:
    """Something in the repository that is about running or checking it, not about its behaviour."""

    kind: str
    path: str

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "path": self.path}


@dataclass(frozen=True)
class Scan:
    """Everything read off the disk in one pass, before anyone decides what it means."""

    root: str
    name: str
    file_count: int
    languages: tuple[tuple[str, int], ...] = ()
    tree: TreeNode | None = None
    modules: tuple[Module, ...] = ()
    imports: tuple[ImportEdge, ...] = ()
    dependencies: tuple[Dependency, ...] = ()
    entry_points: tuple[EntryPoint, ...] = ()
    infrastructure: tuple[Infrastructure, ...] = ()
    #: Limits that were hit and files that could not be read. Absence of a fact is a fact.
    notes: tuple[str, ...] = ()

    @property
    def manifests(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for dependency in self.dependencies:
            seen.setdefault(dependency.manifest, None)
        return tuple(seen)

    def to_dict(self) -> dict[str, Any]:
        return {
            "root": self.root,
            "name": self.name,
            "file_count": self.file_count,
            "languages": [{"name": n, "files": c} for n, c in self.languages],
            "tree": self.tree.to_dict() if self.tree else None,
            "modules": [m.to_dict() for m in self.modules],
            "imports": [e.to_dict() for e in self.imports],
            "dependencies": [d.to_dict() for d in self.dependencies],
            "entry_points": [e.to_dict() for e in self.entry_points],
            "infrastructure": [i.to_dict() for i in self.infrastructure],
            "notes": list(self.notes),
        }


@dataclass
class _Walk:
    """The raw result of reading the directory tree, before it is turned into facts."""

    files: list[str] = field(default_factory=list)
    directories: set[str] = field(default_factory=set)
    truncated: bool = False


# --- the scan ----------------------------------------------------------------------------------


def scan(root: Path, depth: int = DEFAULT_DEPTH, max_files: int = MAX_FILES) -> Scan:
    """Read `root` and report what is there. Opens files; writes nothing."""
    root = root.resolve()
    notes: list[str] = []

    walk = _walk(root, max_files)
    if walk.truncated:
        notes.append(
            f"walk stopped at {max_files} files; the report below covers only what was reached"
        )

    dependencies, manifest_entry_points, manifest_name = _manifests(root, walk.files)
    name = manifest_name or root.name

    modules = _modules(walk.files, name)
    edges, unparsed = _imports(root, walk.files, modules)
    if unparsed:
        notes.append(f"{unparsed} source file(s) could not be parsed for imports")
    if modules and not any(
        module.language in {"python", "javascript", "typescript"} for module in modules
    ):
        notes.append("import graph covers Python and JavaScript/TypeScript only; none found")

    infrastructure, infrastructure_notes = _infrastructure(walk.files, walk.directories)
    notes.extend(infrastructure_notes)

    return Scan(
        root=str(root),
        name=name,
        file_count=len(walk.files),
        languages=_language_counts(walk.files),
        tree=_tree(root.name, walk, depth),
        modules=modules,
        imports=edges,
        dependencies=dependencies,
        entry_points=_entry_points(walk.files, manifest_entry_points),
        infrastructure=infrastructure,
        notes=tuple(notes),
    )


def _walk(root: Path, max_files: int) -> _Walk:
    """Every file git would show, as repository-relative POSIX paths, in sorted order."""
    result = _Walk()

    def descend(directory: Path, base: str, ignore: gitignore.Ignore) -> None:
        if result.truncated:
            return
        ignore = ignore.descend(directory, base)
        try:
            entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
        except OSError:
            return

        directories: list[tuple[Path, str, gitignore.Ignore]] = []
        for entry in entries:
            relative = f"{base}/{entry.name}" if base else entry.name
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                # Symlinked directories are skipped rather than followed: a link out of the tree
                # reports somebody else's files as this project's, and a link back in never ends.
                if entry.name in NOISE_DIRS or ignore.match(relative, True):
                    continue
                directories.append((Path(entry.path), relative, ignore))
                continue
            if ignore.match(relative, False):
                continue
            result.files.append(relative)
            if len(result.files) >= max_files:
                result.truncated = True
                return

        for path, relative, inherited in directories:
            result.directories.add(relative)
            descend(path, relative, inherited)
            if result.truncated:
                return

    descend(root, "", gitignore.load(root))
    result.files.sort()
    return result


def _language_counts(files: Iterable[str]) -> tuple[tuple[str, int], ...]:
    counts: dict[str, int] = {}
    for path in files:
        language = LANGUAGES.get(_suffix(path))
        if language:
            counts[language] = counts.get(language, 0) + 1
    return tuple(sorted(counts.items(), key=lambda item: (-item[1], item[0])))


def _tree(root_name: str, walk: _Walk, depth: int) -> TreeNode:
    """Fold the flat file list back into directories, reported down to `depth`.

    Counts are taken over the whole subtree even where the report stops, so a directory cut off
    by the limit still says how much is under it — that is the number that decides whether it
    deserves a place on a map.
    """
    direct: dict[str, int] = {}
    subtree: dict[str, int] = {}
    languages: dict[str, dict[str, int]] = {}

    for path in walk.files:
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        direct[parent] = direct.get(parent, 0) + 1
        language = LANGUAGES.get(_suffix(path))
        for ancestor in _ancestors(parent):
            subtree[ancestor] = subtree.get(ancestor, 0) + 1
            if language:
                bucket = languages.setdefault(ancestor, {})
                bucket[language] = bucket.get(language, 0) + 1

    children: dict[str, list[str]] = {}
    for directory in sorted(walk.directories):
        parent = directory.rsplit("/", 1)[0] if "/" in directory else ""
        children.setdefault(parent, []).append(directory)

    def build(path: str, name: str, level: int) -> TreeNode:
        own = children.get(path, [])
        ranked = tuple(
            sorted(languages.get(path, {}).items(), key=lambda item: (-item[1], item[0]))
        )
        if level >= depth:
            return TreeNode(
                name=name,
                path=path,
                files=direct.get(path, 0),
                total_files=subtree.get(path, 0),
                languages=ranked,
                truncated=bool(own),
            )
        # The largest subtrees are the ones worth a line; the rest are counted. A monorepo with a
        # hundred sibling test projects would otherwise bury everything else it contains.
        shown = sorted(
            sorted(own, key=lambda child: -subtree.get(child, 0))[:MAX_CHILDREN]
        )
        return TreeNode(
            name=name,
            path=path,
            files=direct.get(path, 0),
            total_files=subtree.get(path, 0),
            languages=ranked,
            children=tuple(build(child, child.rsplit("/", 1)[-1], level + 1) for child in shown),
            hidden_children=len(own) - len(shown),
        )

    return build("", root_name, 0)


ROOT_MODULE_PATH = "."


def _modules(files: Sequence[str], root_name: str) -> tuple[Module, ...]:
    """The project's own top-level code units.

    A directory under `src/` or `packages/` is a module and the container is not, because nobody
    calls a part of a system "src". Directories with no code in them — docs, fixtures, media —
    are not modules either: they are in the tree, and the import graph has nothing to say
    about them.

    Code sitting directly in the root is a module too, under the project's own name. Plenty of
    Go and single-file Python projects are laid out that way, and reporting no modules at all for
    them would say the repository has no code in it.
    """
    grouped: dict[str, list[str]] = {}
    for path in files:
        parts = path.split("/")
        if len(parts) == 1:
            grouped.setdefault(ROOT_MODULE_PATH, []).append(path)
            continue
        if parts[0].startswith("."):
            continue
        if parts[0] in SOURCE_ROOTS and len(parts) >= 3:
            key = "/".join(parts[:2])
        else:
            key = parts[0]
        grouped.setdefault(key, []).append(path)

    modules: list[Module] = []
    for path, contents in sorted(grouped.items()):
        counts = _language_counts(contents)
        if not counts:
            continue
        modules.append(
            Module(
                name=root_name if path == ROOT_MODULE_PATH else path.rsplit("/", 1)[-1],
                path=path,
                language=counts[0][0],
                files=sum(count for _, count in counts),
            )
        )
    return tuple(modules)


def _imports(
    root: Path, files: Sequence[str], modules: Sequence[Module]
) -> tuple[tuple[ImportEdge, ...], int]:
    """Edges between modules, and how many files refused to parse.

    Only imports that land inside the repository become edges. An import of `httpx` is a
    dependency, already reported as one, and drawing it here would turn a map of the project into
    a map of its requirements.
    """
    by_name = {module.name: module for module in modules}
    by_path = sorted(modules, key=lambda module: -len(module.path))
    by_package = _workspace_packages(root, modules)
    counts: dict[tuple[str, str], int] = {}
    unparsed = 0

    for relative in files:
        owner = _owner(relative, by_path)
        if owner is None:
            continue
        suffix = _suffix(relative)
        if suffix in PYTHON_SUFFIXES:
            targets, failed = _python_imports(root / relative, by_name)
        elif suffix in JS_SUFFIXES:
            targets, failed = _js_imports(root / relative, relative, by_path, by_package)
        else:
            continue
        unparsed += failed
        for target in targets:
            if target != owner.name:
                key = (owner.name, target)
                counts[key] = counts.get(key, 0) + 1

    edges = tuple(
        ImportEdge(source=source, target=target, count=count)
        for (source, target), count in sorted(counts.items(), key=lambda item: item[0])
    )
    return edges, unparsed


def _python_imports(path: Path, by_name: dict[str, Module]) -> tuple[list[str], int]:
    text = _read(path)
    if text is None:
        return [], 0
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return [], 1

    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots = [alias.name.split(".", 1)[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            # A relative import cannot leave its own module, so it is never an edge.
            if node.level or not node.module:
                continue
            roots = [node.module.split(".", 1)[0]]
        else:
            continue
        found.extend(name for name in roots if name in by_name)
    return found, 0


def _js_imports(
    path: Path,
    relative: str,
    by_path: Sequence[Module],
    by_package: dict[str, Module],
) -> tuple[list[str], int]:
    text = _read(path)
    if text is None:
        return [], 0

    found: list[str] = []
    for specifier in _JS_SPECIFIER.findall(text):
        if specifier.startswith("."):
            owner = _owner(_resolve_relative(relative, specifier), by_path)
        else:
            # A bare specifier is usually a package from the registry, which is a dependency and
            # already reported as one. In a workspace it can also name a sibling in the same
            # repository, and there it is the only form the edge ever takes — packages in a
            # monorepo import each other by name, never by relative path.
            owner = by_package.get(_package_name(specifier))
        if owner is not None:
            found.append(owner.name)
    return found, 0


def _workspace_packages(root: Path, modules: Sequence[Module]) -> dict[str, Module]:
    """Published name → module, for the modules in this repository that declare one."""
    named: dict[str, Module] = {}
    for module in modules:
        data = _read_json(root / module.path / "package.json")
        name = data.get("name") if data else None
        if isinstance(name, str) and name:
            named[name] = module
    return named


def _package_name(specifier: str) -> str:
    """`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`."""
    parts = specifier.split("/")
    return "/".join(parts[:2]) if specifier.startswith("@") else parts[0]


#: `import ... from "x"`, `export ... from "x"`, `import("x")` and `require("x")` in one pass.
_JS_SPECIFIER = re.compile(
    r"""(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]"""
)


def _resolve_relative(source: str, specifier: str) -> str:
    directory = PurePosixPath(source).parent
    resolved = os.path.normpath(str(directory / specifier))
    return PurePosixPath(resolved).as_posix()


def _owner(path: str, by_path: Sequence[Module]) -> Module | None:
    """The module a path belongs to, longest path first so `src/a` beats `src`."""
    for module in by_path:
        if module.path == ROOT_MODULE_PATH:
            if "/" not in path:
                return module
            continue
        if path == module.path or path.startswith(f"{module.path}/"):
            return module
    return None


# --- manifests ---------------------------------------------------------------------------------


def _manifests(
    root: Path, files: Sequence[str]
) -> tuple[tuple[Dependency, ...], list[EntryPoint], str]:
    """Dependencies and declared entry points, from whichever manifests are present."""
    readers = {
        "pyproject.toml": _read_pyproject,
        "requirements.txt": _read_requirements,
        "package.json": _read_package_json,
        "Cargo.toml": _read_cargo,
        "go.mod": _read_go_mod,
        "composer.json": _read_composer,
        "Gemfile": _read_gemfile,
    }

    dependencies: list[Dependency] = []
    entry_points: list[EntryPoint] = []
    name = ""
    present = set(files)

    for manifest, reader in readers.items():
        if manifest not in present:
            continue
        found, entries, declared = reader(root / manifest, manifest)
        dependencies.extend(found)
        entry_points.extend(entries)
        name = name or declared

    return tuple(dependencies), entry_points, name


def _read_pyproject(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    data = _read_toml(path)
    if data is None:
        return [], [], ""

    project = data.get("project") or {}
    poetry = ((data.get("tool") or {}).get("poetry")) or {}
    found: list[Dependency] = []

    for requirement in project.get("dependencies") or []:
        found.append(_requirement(requirement, manifest, "runtime"))
    for extra, requirements in (project.get("optional-dependencies") or {}).items():
        for requirement in requirements:
            found.append(_requirement(requirement, manifest, f"optional:{extra}"))
    for group, requirements in (data.get("dependency-groups") or {}).items():
        for requirement in requirements:
            if isinstance(requirement, str):
                found.append(_requirement(requirement, manifest, group))
    for dependency, spec in (poetry.get("dependencies") or {}).items():
        if dependency != "python":
            found.append(
                Dependency(dependency, manifest, "runtime", spec if isinstance(spec, str) else "")
            )

    entry_points = [
        EntryPoint(name=script, path=target, kind="console-script", source=manifest)
        for script, target in (project.get("scripts") or {}).items()
    ]
    entry_points += [
        EntryPoint(name=script, path=target, kind="gui-script", source=manifest)
        for script, target in (project.get("gui-scripts") or {}).items()
    ]

    return found, entry_points, str(project.get("name") or poetry.get("name") or "")


def _read_requirements(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    text = _read(path)
    if text is None:
        return [], [], ""
    found = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        found.append(_requirement(line, manifest, "runtime"))
    return found, [], ""


def _read_package_json(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    data = _read_json(path)
    if data is None:
        return [], [], ""

    scopes = {
        "dependencies": "runtime",
        "devDependencies": "dev",
        "peerDependencies": "peer",
        "optionalDependencies": "optional",
    }
    found = [
        Dependency(name, manifest, scope, version if isinstance(version, str) else "")
        for key, scope in scopes.items()
        for name, version in (data.get(key) or {}).items()
    ]

    entry_points: list[EntryPoint] = []
    binaries = data.get("bin")
    if isinstance(binaries, str):
        entry_points.append(
            EntryPoint(str(data.get("name") or "bin"), binaries, "console-script", manifest)
        )
    elif isinstance(binaries, dict):
        entry_points += [
            EntryPoint(name, target, "console-script", manifest)
            for name, target in binaries.items()
            if isinstance(target, str)
        ]
    if isinstance(data.get("main"), str):
        entry_points.append(EntryPoint("main", data["main"], "module", manifest))
    start = (data.get("scripts") or {}).get("start")
    if isinstance(start, str):
        entry_points.append(EntryPoint("start", start, "script", manifest))

    return found, entry_points, str(data.get("name") or "")


def _read_cargo(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    data = _read_toml(path)
    if data is None:
        return [], [], ""

    found = [
        Dependency(name, manifest, scope, spec if isinstance(spec, str) else "")
        for key, scope in (("dependencies", "runtime"), ("dev-dependencies", "dev"))
        for name, spec in (data.get(key) or {}).items()
    ]
    entry_points = [
        EntryPoint(str(binary.get("name") or ""), str(binary.get("path") or ""), "binary", manifest)
        for binary in data.get("bin") or []
        if isinstance(binary, dict)
    ]
    return found, entry_points, str((data.get("package") or {}).get("name") or "")


def _read_go_mod(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    text = _read(path)
    if text is None:
        return [], [], ""

    found: list[Dependency] = []
    name = ""
    in_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("module "):
            name = line.split(None, 1)[1].strip()
            continue
        if line.startswith("require ("):
            in_block = True
            continue
        if in_block and line == ")":
            in_block = False
            continue
        if in_block:
            requirement = line
        elif line.startswith("require "):
            requirement = line.split(None, 1)[1]
        else:
            continue
        scope = "indirect" if "// indirect" in requirement else "runtime"
        parts = requirement.split("//", 1)[0].split()
        if parts:
            found.append(Dependency(parts[0], manifest, scope, parts[1] if len(parts) > 1 else ""))
    return found, [], name.rsplit("/", 1)[-1] if name else ""


def _read_composer(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    data = _read_json(path)
    if data is None:
        return [], [], ""
    found = [
        Dependency(name, manifest, scope, version if isinstance(version, str) else "")
        for key, scope in (("require", "runtime"), ("require-dev", "dev"))
        for name, version in (data.get(key) or {}).items()
        if name != "php"
    ]
    return found, [], str(data.get("name") or "")


def _read_gemfile(path: Path, manifest: str) -> tuple[list[Dependency], list[EntryPoint], str]:
    text = _read(path)
    if text is None:
        return [], [], ""
    found = [
        Dependency(name, manifest, "runtime")
        for name in re.findall(r"""^\s*gem\s+['"]([^'"]+)['"]""", text, re.MULTILINE)
    ]
    return found, [], ""


def _requirement(requirement: str, manifest: str, scope: str) -> Dependency:
    match = _REQUIREMENT_NAME.match(requirement)
    name = match.group(1) if match else requirement.strip()
    version = requirement[len(name) :].strip() if match else ""
    return Dependency(name=name, manifest=manifest, scope=scope, version=version)


# --- the rest of the facts ----------------------------------------------------------------------


def _entry_points(files: Sequence[str], declared: Sequence[EntryPoint]) -> tuple[EntryPoint, ...]:
    """What a manifest declares, plus what a filename says on its own.

    A manifest is the better source, so it goes first and a file it already covers is not
    repeated. The filename rule exists for the projects that have no manifest to read, and it is
    kept near the surface of the tree on purpose: every `index.js` in a fixture directory matches
    it too, and a list of four hundred entry points is a list of none.
    """
    found = list(declared)
    covered = {entry.path for entry in declared}

    for path in files:
        segments = path.split("/")
        name = segments[-1]
        kind = ENTRY_FILE_NAMES.get(name)
        if kind is None or path in covered or len(segments) > MAX_ENTRY_DEPTH:
            continue
        if any(part in TEST_DIR_NAMES or part in SAMPLE_DIR_NAMES for part in segments[:-1]):
            continue
        found.append(EntryPoint(name=name, path=path, kind=kind, source="filename"))

    return tuple(found)


def _infrastructure(
    files: Sequence[str], directories: Iterable[str]
) -> tuple[tuple[Infrastructure, ...], list[str]]:
    """Everything in the repository that is about running or checking it.

    Test and documentation directories are reported as directories, not as the hundreds of files
    inside them: "there are tests, they live here" is the fact, and the file list is noise. For
    the same reason each kind is capped, shallowest first — a repository with ninety `__tests__`
    directories has told you what it has by the eighth, and the count carries the rest.
    """
    found: list[Infrastructure] = []
    seen: set[tuple[str, str]] = set()

    def add(kind: str, path: str) -> None:
        if (kind, path) not in seen:
            seen.add((kind, path))
            found.append(Infrastructure(kind=kind, path=path))

    for directory in sorted(directories):
        name = directory.rsplit("/", 1)[-1]
        if name in TEST_DIR_NAMES:
            add("tests", directory)
        elif name in DOC_DIR_NAMES:
            add("docs", directory)

    for path in files:
        name = path.rsplit("/", 1)[-1]
        kind = INFRA_NAMES.get(name)
        if kind:
            add(kind, path)
            continue
        for pattern, matched_kind in INFRA_PATTERNS:
            if re.search(pattern, path):
                # Terraform and Kubernetes come as directories full of near-identical files;
                # one entry per directory says the same thing and stays readable.
                if matched_kind in {"infrastructure-as-code", "orchestration"}:
                    add(matched_kind, path.rsplit("/", 1)[0] if "/" in path else path)
                else:
                    add(matched_kind, path)
                break

    by_kind: dict[str, list[Infrastructure]] = {}
    for item in found:
        by_kind.setdefault(item.kind, []).append(item)

    kept: list[Infrastructure] = []
    notes: list[str] = []
    for kind, items in sorted(by_kind.items()):
        items.sort(key=lambda item: (item.path.count("/"), item.path))
        kept.extend(items[:MAX_INFRA_PER_KIND])
        if len(items) > MAX_INFRA_PER_KIND:
            notes.append(
                f"{len(items) - MAX_INFRA_PER_KIND} more {kind} path(s) beyond the "
                f"{MAX_INFRA_PER_KIND} reported"
            )

    return tuple(kept), notes


# --- reading ------------------------------------------------------------------------------------


def _read(path: Path) -> str | None:
    """Text of a file, or None if it is unreadable, binary, or too big to be worth parsing."""
    try:
        if path.stat().st_size > MAX_PARSE_BYTES:
            return None
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _read_json(path: Path) -> dict[str, Any] | None:
    text = _read(path)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def _read_toml(path: Path) -> dict[str, Any] | None:
    text = _read(path)
    if text is None:
        return None
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError:
        return None


def _suffix(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    return f".{name.rsplit('.', 1)[-1]}" if "." in name[1:] else ""


def _ancestors(path: str) -> Iterator[str]:
    """`a/b/c` → `a/b/c`, `a/b`, `a`, `` — every directory a file counts towards."""
    current = path
    while current:
        yield current
        current = current.rsplit("/", 1)[0] if "/" in current else ""
    yield ""
