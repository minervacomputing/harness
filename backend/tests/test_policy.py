import random

import pytest

from permissions.policy import ANY, DENY_ALL, Layer, Policy, Resource

WORK = Resource("c1", "project", "work")
PRIVATE = Resource("c1", "project", "private")


def layer(name, restricted, allows=(), denies=()):
    return Layer.build(
        name,
        restricted,
        [("c1", "project", rid, actions, "allow") for rid, actions in allows]
        + [("c1", "project", rid, actions, "deny") for rid, actions in denies],
    )


def test_lower_layers_only_narrow():
    ceiling = layer("ceiling", True, allows=[("work", ["read", "create"])])
    user = layer("user", True, allows=[("work", ["read"]), ("private", ["read"])])
    policy = Policy((ceiling, user, layer("agent", False)))
    assert policy.permits(WORK, "read")
    assert not policy.permits(WORK, "create"), "the user layer did not allow create"
    assert not policy.permits(PRIVATE, "read"), "the ceiling did not allow private"


def test_unrestricted_layers_pass_through_but_denies_win():
    policy = Policy(
        (
            layer("ceiling", False, denies=[("work", ["create"])]),
            layer("user", True, allows=[("work", ["read", "create"])]),
        )
    )
    assert policy.permits(WORK, "read")
    assert not policy.permits(WORK, "create")


def test_exact_resource_matching():
    policy = Policy((layer("user", True, allows=[("work", ["read"])]),))
    assert not policy.permits(Resource("c2", "project", "work"), "read"), "other connection"
    assert not policy.permits(Resource("c1", "section", "work"), "read"), "other kind"


def test_json_round_trip():
    policy = Policy(
        (
            layer("ceiling", False, denies=[("private", ["read"])]),
            layer("user", True, allows=[("work", ["read"])]),
        )
    )
    restored = Policy.from_json(policy.to_json())
    assert restored == policy
    assert not DENY_ALL.permits(WORK, "read")


REQUIRES = {"create": "read"}.get
NEW = Resource("c1", "project", "created-later")


def test_wildcard_allows_every_resource_including_new_ones():
    policy = Policy((layer("user", True, allows=[(ANY, ["read"])]),))
    assert policy.permits(WORK, "read")
    assert policy.permits(NEW, "read")
    assert not policy.permits(WORK, "create")
    assert not policy.permits(Resource("c2", "project", "work"), "read"), "wildcards stay on their connection"
    assert not policy.permits(Resource("c1", "section", "work"), "read"), "and on their kind"


def test_wildcard_is_not_a_resource():
    with pytest.raises(ValueError):
        Policy((layer("user", False),)).permits(Resource("c1", "project", ANY), "read")


def test_denies_win_over_wildcards_and_wildcard_denies_win_over_everything():
    exact_deny = Policy((layer("user", True, allows=[(ANY, ["read"])], denies=[("private", ["read"])]),))
    assert exact_deny.permits(WORK, "read")
    assert not exact_deny.permits(PRIVATE, "read")
    wildcard_deny = Policy(
        (
            layer("ceiling", False, denies=[(ANY, ["create"])]),
            layer("user", True, allows=[("work", ["read", "create"])]),
        )
    )
    assert not wildcard_deny.permits(WORK, "create")
    assert wildcard_deny.permits(WORK, "read")


def test_requirements_are_checked_on_the_same_resource():
    policy = Policy(
        (
            layer("ceiling", False, denies=[("work", ["read"])]),
            layer("user", True, allows=[("work", ["read", "create"]), ("private", ["read"])]),
        )
    )
    assert policy.permits(WORK, "create"), "without requirements only the action itself counts"
    assert not policy.permits(WORK, "create", REQUIRES)
    assert policy.permits(PRIVATE, "read", REQUIRES)
    assert not policy.permits(PRIVATE, "create", REQUIRES)


@pytest.mark.parametrize(
    ("layers", "action", "expected"),
    [
        ([layer("user", True)], "read", False),
        ([layer("user", True, allows=[("work", ["read"])])], "read", True),
        ([layer("user", True, allows=[(ANY, ["read"])])], "read", True),
        ([layer("user", False)], "read", True),
        ([layer("user", False, denies=[(ANY, ["read"])])], "read", False),
        # A deny on one resource leaves every other resource.
        ([layer("user", False, denies=[("work", ["read"])])], "read", True),
        ([layer("user", True, allows=[(ANY, ["read"])], denies=[("work", ["read"])])], "read", True),
        # create needs read on the same resource; allowing them on different resources is not enough.
        ([layer("user", True, allows=[("work", ["create"]), ("private", ["read"])])], "create", False),
        ([layer("user", True, allows=[("work", ["create"]), (ANY, ["read"])])], "create", True),
        (
            [layer("user", True, allows=[(ANY, ["create", "read"])], denies=[("work", ["read"])])],
            "create",
            True,
        ),
        (
            [
                layer("ceiling", True, allows=[("work", ["read", "create"])]),
                layer("user", True, allows=[(ANY, ["read", "create"])]),
            ],
            "create",
            True,
        ),
        (
            [
                layer("ceiling", True, allows=[("work", ["read"])]),
                layer("user", True, allows=[("private", ["read"])]),
            ],
            "read",
            False,
        ),
    ],
)
def test_permits_any_matches_some_concrete_resource(layers, action, expected):
    policy = Policy(tuple(layers))
    assert policy.permits_any("c1", "project", action, REQUIRES) is expected
    # permits_any must agree with checking every resource that could matter.
    candidates = [WORK, PRIVATE, NEW]
    assert any(policy.permits(r, action, REQUIRES) for r in candidates) is expected


# Folders: "docs" holds "drafts", which holds the file "essay".
ESSAY = Resource("c1", "project", "essay", within=("drafts", "docs"))


def test_a_grant_on_a_folder_covers_what_is_inside_it():
    policy = Policy((layer("user", True, allows=[("docs", ["read"])]),))
    assert policy.permits(ESSAY, "read")
    assert policy.permits(Resource("c1", "project", "drafts", within=("docs",)), "read")
    assert not policy.permits(Resource("c1", "project", "docs"), "create")
    assert not policy.permits(Resource("c1", "project", "notes", within=("home",)), "read")


def test_a_deny_on_any_enclosing_folder_wins():
    policy = Policy(
        (
            layer("ceiling", False, denies=[("drafts", ["read"])]),
            layer("user", True, allows=[(ANY, ["read"]), ("essay", ["read"])]),
        )
    )
    assert not policy.permits(ESSAY, "read")
    assert policy.permits(Resource("c1", "project", "essay", within=("docs",)), "read")


def test_partial_ancestry_never_helps_and_fears_every_exact_deny():
    # The unknown ancestors could be "docs", so an allow on it does not count.
    unknown = Resource("c1", "project", "essay", within=("drafts",), partial=True)
    assert not Policy((layer("user", True, allows=[("docs", ["read"])]),)).permits(unknown, "read")
    # Under a wildcard it is readable, until any exact deny exists: that deny could be on an unknown ancestor.
    assert Policy((layer("user", True, allows=[(ANY, ["read"])]),)).permits(unknown, "read")
    guarded = Policy((layer("user", True, allows=[(ANY, ["read"])], denies=[("elsewhere", ["read"])]),))
    assert not guarded.permits(unknown, "read")
    assert guarded.permits(ESSAY, "read"), "complete ancestry is judged by its own ids"
    # Denies for other actions are irrelevant, but a deny on a required action counts.
    create_denied = Policy(
        (layer("user", True, allows=[(ANY, ["read", "create"])], denies=[("elsewhere", ["create"])]),)
    )
    assert create_denied.permits(unknown, "read")
    read_denied = Policy(
        (layer("user", True, allows=[(ANY, ["read", "create"])], denies=[("elsewhere", ["read"])]),)
    )
    assert not read_denied.permits(unknown, "create", REQUIRES)


def test_the_wildcard_is_never_an_ancestor():
    with pytest.raises(ValueError):
        Policy((layer("user", False),)).permits(Resource("c1", "project", "essay", within=(ANY,)), "read")


def test_permits_any_sees_allows_on_nested_folders_across_layers():
    policy = Policy(
        (
            layer("ceiling", True, allows=[("docs", ["read"])]),
            layer("user", True, allows=[("drafts", ["read"])]),
        )
    )
    assert not policy.permits_any("c1", "project", "read"), "flat resources cannot pass both layers"
    assert policy.permits_any("c1", "project", "read", hierarchical=True)
    assert policy.permits(ESSAY, "read")
    denied = Policy((*policy.layers, layer("agent", False, denies=[("docs", ["read"])])))
    assert not denied.permits_any("c1", "project", "read", hierarchical=True)


def test_hierarchical_permits_any_is_exact_over_every_placement():
    """For any layers, permits_any says yes exactly when some resource, inside any set of mentioned
    folders, passes. Real trees allow fewer placements, so it may say yes where none does."""
    rng = random.Random(7)  # noqa: S311
    ids = ["a", "b", "c"]
    choices = [*ids, ANY]
    for _ in range(400):
        layers = []
        for name in ("ceiling", "user", "agent"):
            allows = [
                (rng.choice(choices), rng.sample(["read", "create"], rng.randint(1, 2)))
                for _ in range(rng.randint(0, 2))
            ]
            denies = [
                (rng.choice(choices), rng.sample(["read", "create"], 1)) for _ in range(rng.randint(0, 1))
            ]
            layers.append(layer(name, rng.random() < 0.7, allows, denies))
        policy = Policy(tuple(layers))
        for action in ("read", "create"):
            placements = [
                Resource("c1", "project", rid, tuple(w for w in ids if w != rid and mask >> ids.index(w) & 1))
                for rid in [*ids, "new"]
                for mask in range(8)
            ]
            some = any(policy.permits(r, action, REQUIRES) for r in placements)
            assert policy.permits_any("c1", "project", action, REQUIRES, hierarchical=True) is some
