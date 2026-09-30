"""Pure permission evaluation. No database access, so it is cheap to test exhaustively."""

from collections.abc import Callable, Iterable
from dataclasses import dataclass

Key = tuple[str, str, str, str]  # (connection id, resource kind, resource id, action)
# A grant on every resource of a kind, including ones created later. Never a real resource id.
ANY = "*"
# Stands for every resource id no layer mentions; it matches only wildcard grants.
_UNMENTIONED = object()

RequiresOf = Callable[[str], str | None]


@dataclass(frozen=True, slots=True)
class Resource:
    connection_id: str
    kind: str
    id: str
    # For kinds that nest (folders): the ids of the enclosing resources, nearest first. A grant on any of
    # them applies to this resource too, and a deny on any of them wins.
    within: tuple[str, ...] = ()
    # Whether there may be ancestors beyond `within` that the connector could not see. They could carry a
    # deny, so any exact deny for the action blocks, and they never help an allow.
    partial: bool = False

    def ids(self) -> tuple[str, ...]:
        return (self.id, *self.within)


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

    def _matches(self, keys: frozenset[Key], connection_id: str, kind: str, ids: tuple, action: str) -> bool:
        if (connection_id, kind, ANY, action) in keys:
            return True
        return any(item is not _UNMENTIONED and (connection_id, kind, item, action) in keys for item in ids)

    def blocks(self, connection_id: str, kind: str, ids: tuple, action: str, partial: bool = False) -> bool:
        if partial and any(
            key[0] == connection_id and key[1] == kind and key[3] == action for key in self.denies
        ):
            return True
        return self._matches(self.denies, connection_id, kind, ids, action)

    def passes(self, connection_id: str, kind: str, ids: tuple, action: str) -> bool:
        return not self.restricted or self._matches(self.allows, connection_id, kind, ids, action)


def _chain(action: str, requires_of: RequiresOf) -> list[str]:
    chain: list[str] = []
    current: str | None = action
    while current is not None and current not in chain:
        chain.append(current)
        current = requires_of(current)
    return chain


def _no_requirements(_: str) -> None:
    return None


@dataclass(frozen=True, slots=True)
class Policy:
    """The intersection of layers. Lower layers can only narrow what higher layers allow."""

    layers: tuple[Layer, ...]

    def _permits(self, connection_id: str, kind: str, ids: tuple, action: str, partial: bool = False) -> bool:
        if any(layer.blocks(connection_id, kind, ids, action, partial) for layer in self.layers):
            return False
        return all(layer.passes(connection_id, kind, ids, action) for layer in self.layers)

    def permits(self, resource: Resource, action: str, requires_of: RequiresOf = _no_requirements) -> bool:
        """The action and every action it requires, on this one resource.

        Requirements are checked here rather than only when grants are saved, because layers can combine
        into a policy that allows an action without its requirement.
        """
        if ANY in resource.ids():
            raise ValueError("The wildcard selects grants; it is not a resource.")
        return all(
            self._permits(resource.connection_id, resource.kind, resource.ids(), item, resource.partial)
            for item in _chain(action, requires_of)
        )

    def permits_any(
        self,
        connection_id: str,
        kind: str,
        action: str,
        requires_of: RequiresOf = _no_requirements,
        hierarchical: bool = False,
    ) -> bool:
        """Whether some resource of this kind could pass `permits`. Exact for flat kinds.

        Resources no layer mentions all behave alike, so one symbolic candidate stands for them. For kinds
        that nest, one more candidate sits inside every mentioned resource that nothing denies. Any resource
        that passes has only such ancestors, and more of them can only add allows, so this candidate passes
        whenever some real one does. It may also pass when no real resource does (the ancestors need not
        nest), so it may only open reads whose results are then checked one by one.
        """
        mentioned = {
            key[2]
            for layer in self.layers
            for key in (*layer.allows, *layer.denies)
            if key[0] == connection_id and key[1] == kind and key[2] != ANY
        }
        chain = _chain(action, requires_of)
        candidates: list[tuple] = [(candidate,) for candidate in (*mentioned, _UNMENTIONED)]
        if hierarchical:
            denied = {
                key[2]
                for layer in self.layers
                for key in layer.denies
                if key[0] == connection_id and key[1] == kind and key[3] in chain
            }
            candidates.append((_UNMENTIONED, *sorted(mentioned - denied)))
        return any(all(self._permits(connection_id, kind, ids, item) for item in chain) for ids in candidates)

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
