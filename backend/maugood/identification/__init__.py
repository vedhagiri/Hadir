"""Face identification (P9).

Owns two responsibilities:

1. **Enrollment** — for every ``employee_photos`` row, compute an
   L2-normalised 512-float-32 InsightFace embedding and store it
   Fernet-encrypted. Runs lazily at startup for any row without an
   embedding, eagerly on photo upload (hooked from the P6 flow), and
   on demand via ``POST /api/identification/reembed``.

2. **Matching** — on each capture detection, compute cosine similarity
   against the in-memory cache of enrolled embeddings. The best
   employee wins if and only if the score clears
   ``MAUGOOD_MATCH_THRESHOLD`` (default 0.45). Below threshold → stay
   unidentified. The threshold is **hard, not advisory**
   (PROJECT_CONTEXT §12 / pilot-plan red line).

Public surface kept narrow: the FastAPI router, the matcher singleton,
and the enrollment helpers used by ``maugood.employees.router``.
"""

from maugood.identification.matcher import matcher_cache
from maugood.identification.router import router

__all__ = ["matcher_cache", "router"]
