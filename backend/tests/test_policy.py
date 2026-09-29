from permissions.policy import DENY_ALL, Layer, Policy, Resource

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
