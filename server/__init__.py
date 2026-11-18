__version__ = "0.2.0"
NAME = "Stellwerk"

import os as _os


def env(name: str, default=None):
    """The STELLWERK_<name> environment variable, or default."""
    return _os.environ.get(f"STELLWERK_{name}") or default
