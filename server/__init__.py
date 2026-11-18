__version__ = "0.2.0"
NAME = "Stellwerk"

import os as _os


def env(name: str, default=None):
    """The STELLWERK_<name> environment variable, or default."""
    return _os.environ.get(f"STELLWERK_{name}") or default


def missing_folder(cwd) -> str:
    """Why a session can't open in cwd. In Docker, the folder usually exists on
    the host but isn't mounted into the container."""
    if _os.path.exists("/.dockerenv") or _os.path.exists("/run/.containerenv"):
        return (f"the session's folder isn't visible inside the container: {cwd}. "
                "Add it to the volumes in compose.yaml (see docs/docker.md).")
    return f"the session's folder no longer exists: {cwd}"
