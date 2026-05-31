"""Rich per-system signal extractors. Import each module here so its @register call runs.
Add a new extractor file and list it here."""
from . import m365, active_directory  # noqa: F401

__all__ = ["m365", "active_directory"]
