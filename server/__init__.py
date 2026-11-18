__version__ = "0.2.0"
NAME = "Stellwerk"

import os as _os


def env(name: str, default=None):
    """STELLWERK_<name>, or HERMES_WEB_<name> (the project's name before 0.2.0)."""
    return _os.environ.get(f"STELLWERK_{name}") or _os.environ.get(f"HERMES_WEB_{name}") or default
