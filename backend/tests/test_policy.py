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
