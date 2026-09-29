"""Pure permission evaluation. No database access, so it is cheap to test exhaustively."""

from collections.abc import Iterable
from dataclasses import dataclass

Key = tuple[str, str, str, str]  # (connection id, resource kind, resource id, action)


@dataclass(frozen=True, slots=True)
class Resource:
    connection_id: str
    kind: str
    id: str


@dataclass(frozen=True, slots=True)
class Layer:
    name: str
    restricted: bool
    allows: frozenset[Key]
    denies: frozenset[Key]

    @classmethod
    def build(
        cls, name: str, restricted: bool, grants: Iterable[tuple[str, str, str, Iterable[str], str]]
    ) -> Layer:
        allows: set[Key] = set()
        denies: set[Key] = set()
        for connection_id, kind, resource_id, actions, effect in grants:
            target = denies if effect == "deny" else allows
            target.update((connection_id, kind, resource_id, action) for action in actions)
        return cls(name, restricted, frozenset(allows), frozenset(denies))


@dataclass(frozen=True, slots=True)
class Policy:
    """The intersection of layers. Lower layers can only narrow what higher layers allow."""

    layers: tuple[Layer, ...]

    def permits(self, resource: Resource, action: str) -> bool:
        key = (resource.connection_id, resource.kind, resource.id, action)
        if any(key in layer.denies for layer in self.layers):
            return False
        return all(not layer.restricted or key in layer.allows for layer in self.layers)

    def to_json(self) -> list[dict]:
        return [
            {
                "name": layer.name,
                "restricted": layer.restricted,
                "allows": sorted(list(key) for key in layer.allows),
                "denies": sorted(list(key) for key in layer.denies),
            }
            for layer in self.layers
        ]

    @classmethod
    def from_json(cls, data: list[dict]) -> Policy:
        return cls(
            tuple(
                Layer(
                    name=item["name"],
                    restricted=item["restricted"],
                    allows=frozenset(tuple(key) for key in item["allows"]),
                    denies=frozenset(tuple(key) for key in item["denies"]),
                )
                for item in data
            )
        )


DENY_ALL = Policy((Layer("deny-all", True, frozenset(), frozenset()),))
