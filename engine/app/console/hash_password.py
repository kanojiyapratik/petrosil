"""Generates a CONSOLE_USERS password hash.

    python -m app.console.hash_password 'the password'

Exists so a plain password never has to be pasted into an env var, or into a
chat window on the way to one.
"""

import sys

from .auth import hash_password


def main() -> int:
    password = sys.argv[1] if len(sys.argv) > 1 else ""

    if len(password) < 8:
        print("Usage: python -m app.console.hash_password <password>   (8 characters or more)")
        return 1

    print(hash_password(password))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
