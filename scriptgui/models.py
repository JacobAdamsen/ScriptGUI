"""Pipeline data model shared by the API, the runner and the saved JSON files."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Port(BaseModel):
    """A file argument. For inputs, `path` is only used when nothing is connected.
    For outputs, `path` is the file name inside the node's output folder."""
    name: str
    path: str = ""


class Param(BaseModel):
    """A non-file argument passed as `--name value` (or just `--name` if value is empty)."""
    name: str
    value: str = ""


class Node(BaseModel):
    id: str
    label: str = ""
    script: str = ""
    x: float = 0
    y: float = 0
    inputs: list[Port] = Field(default_factory=list)
    outputs: list[Port] = Field(default_factory=list)
    params: list[Param] = Field(default_factory=list)


class Edge(BaseModel):
    """Connects an output port of `source` to an input port of `target`."""
    source: str
    source_port: str
    target: str
    target_port: str


class Pipeline(BaseModel):
    name: str = "untitled"
    python: str = ""          # empty = the interpreter running the server
    workdir: str = ""         # empty = runs/<name>
    scripts_dir: str = "examples/scripts"
    nodes: list[Node] = Field(default_factory=list)
    edges: list[Edge] = Field(default_factory=list)
