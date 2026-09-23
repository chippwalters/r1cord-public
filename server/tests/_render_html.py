"""Tiny DOM + active-markup scanner for the renderer tests (stdlib html.parser only)."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from html.parser import HTMLParser

_VOID = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"})
_FORBIDDEN = frozenset({"iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "style", "template"})
_ASSET_JS = re.compile(r"assets/page\.[0-9a-f]{12}\.js")
_ASSET_CSS = re.compile(r"assets/(?:site|theme)\.[0-9a-f]{12}\.css")
_WEB = re.compile(r"(?:https?://|mailto:)", re.IGNORECASE)


@dataclass
class Node:
    tag: str
    attrs: dict[str, str | None]
    children: list[Node | str] = field(default_factory=list)

    def iter(self) -> Iterator[Node]:
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.iter()

    def find_all(self, match: Callable[[Node], bool]) -> list[Node]:
        return [node for node in self.iter() if match(node)]

    def by_id(self, element_id: str) -> Node:
        found = self.find_all(lambda n: n.attrs.get("id") == element_id)
        assert len(found) == 1, f"expected one #{element_id}, found {len(found)}"
        return found[0]

    def with_class(self, name: str) -> list[Node]:
        return self.find_all(lambda n: name in (n.attrs.get("class") or "").split())

    def text(self) -> str:
        return "".join(child if isinstance(child, str) else child.text() for child in self.children)


class _Builder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("#document", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Node(tag, dict(attrs)))

    def handle_endtag(self, tag):
        for depth in range(len(self.stack) - 1, 0, -1):
            if self.stack[depth].tag == tag:
                del self.stack[depth:]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse(html: str) -> Node:
    builder = _Builder()
    builder.feed(html)
    builder.close()
    return builder.root


def active_markup(html: str, *, pages: frozenset[str] = frozenset(), photos: frozenset[str] = frozenset()) -> list[str]:
    """Everything in `html` that could run script, load or submit elsewhere, or leave the site.

    Allowed: the page script and stylesheets under assets/, web/mail/#anchor links, links to the
    sibling files in `pages`, images of the photos in `photos`.
    """
    problems = []
    for node in parse(html).iter():
        tag, attrs = node.tag, node.attrs
        for name in attrs:
            if name.startswith("on") or name in ("style", "srcdoc", "formaction", "xlink:href"):
                problems.append(f"<{tag} {name}>")
        if tag in _FORBIDDEN:
            problems.append(f"<{tag}>")
        elif tag == "script":
            if not _ASSET_JS.fullmatch(attrs.get("src") or ""):
                problems.append(f"<script src={attrs.get('src')!r}>")
        elif tag == "link":
            if not (attrs.get("rel") == "stylesheet" and _ASSET_CSS.fullmatch(attrs.get("href") or "")):
                problems.append(f"<link {attrs!r}>")
        elif tag == "meta":
            if (attrs.get("http-equiv") or "").lower() == "refresh":
                problems.append("<meta refresh>")
        elif tag == "img":
            if (attrs.get("src") or "") not in {f"photos/{name}" for name in photos}:
                problems.append(f"<img src={attrs.get('src')!r}>")
        elif tag in ("a", "area"):
            href = attrs.get("href")
            if href is not None and not (href.startswith("#") or _WEB.match(href) or href.split("#")[0] in pages):
                problems.append(f"<a href={href!r}>")
        elif "src" in attrs or "href" in attrs or "action" in attrs or "data" in attrs:
            problems.append(f"<{tag} {attrs!r}>")
    return problems
