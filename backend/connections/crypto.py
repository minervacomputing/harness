"""Encryption at rest for credentials and other stored secrets, such as a run's saved state. Each ciphertext
records its key version, so keys can rotate and a managed key service can replace the application key later
without a data migration."""

import json
from functools import cache

from cryptography.fernet import Fernet, InvalidToken

from minerva.config import config


class CredentialKeyError(RuntimeError):
    pass


@cache
def _keys() -> tuple[str, dict[str, Fernet]]:
    keys: dict[str, Fernet] = {}
    order: list[str] = []
    for entry in config().encryption_keys:
        version, _, key = entry.partition(":")
        if not version or not key:
            raise CredentialKeyError("MINERVA_ENCRYPTION_KEYS entries must look like 'v1:<fernet key>'.")
        keys[version] = Fernet(key.encode())
        order.append(version)
    return order[0], keys


def encrypt(payload: dict) -> tuple[bytes, str]:
    return encrypt_bytes(json.dumps(payload).encode())


def decrypt(ciphertext: bytes, version: str) -> dict:
    return json.loads(decrypt_bytes(ciphertext, version))


def encrypt_bytes(plaintext: bytes) -> tuple[bytes, str]:
    version, keys = _keys()
    return keys[version].encrypt(plaintext), version


def decrypt_bytes(ciphertext: bytes, version: str) -> bytes:
    _, keys = _keys()
    key = keys.get(version)
    if key is None:
        raise CredentialKeyError(f"No decryption key configured for version {version!r}.")
    try:
        return key.decrypt(bytes(ciphertext))
    except InvalidToken as error:
        raise CredentialKeyError("Stored data could not be decrypted.") from error
