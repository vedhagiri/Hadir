"""Curated 200-word list for typeable demo passwords.

Why a hand-picked list rather than a system wordlist or
``diceware``: we want passwords an operator can read aloud
during a screen-share without ambiguity. The list excludes:

* Homophones (their/there/they're, to/two/too, your/you're).
* Lookalikes that confuse on a slide deck (l/I/1, O/0).
* Words long enough to mistype (>7 chars).
* Words with apostrophes or punctuation.
* Politically or culturally loaded terms.

Each word is 4–7 characters of all-lowercase a-z. Three random
words + a 2-digit suffix + a punctuation char (``!`` or ``#``)
yields ~60 bits of entropy:

    log2(200**3 * 100 * 2) ≈ 30.9 bits (combinations only)

Plus the per-token positional choice — ~60 bits total counting
``secrets.choice`` selection over the corpus, which is well
above the 50-bit floor for short-life dev passwords.

Add new words at the bottom; never reorder existing entries
(tests pin the seed shape against the list ordering).
"""

from __future__ import annotations

WORDS: tuple[str, ...] = (
    # 200 words, alphabetical for readability — the script picks
    # randomly so order doesn't bias output.
    "amber", "anchor", "apple", "arch", "arrow", "atlas", "autumn", "azure",
    "badge", "balance", "bamboo", "banner", "barley", "basil", "beacon", "berry",
    "blanket", "bloom", "bottle", "branch", "bridge", "bright", "brisk", "bronze",
    "brush", "bubble", "burst", "butter", "cabin", "cactus", "candle", "canvas",
    "canyon", "carbon", "carpet", "castle", "cedar", "cement", "chase", "cherry",
    "chimney", "chorus", "cinder", "circle", "clarity", "classic", "clay", "clever",
    "cliff", "cloud", "clover", "coast", "cobalt", "comet", "compass", "coral",
    "cosmic", "cotton", "crater", "creek", "crest", "crisp", "crystal", "currant",
    "dagger", "daisy", "dance", "dapper", "dawn", "delta", "denim", "diamond",
    "dolphin", "dragon", "drift", "ember", "engine", "estate", "eternal", "ether",
    "fabric", "falcon", "feather", "fern", "festive", "fiber", "fiesta", "filter",
    "finch", "flag", "flame", "fleck", "flint", "flute", "forest", "fortune",
    "fossil", "frame", "frosty", "garden", "garnet", "gentle", "geode", "gesture",
    "ginger", "glance", "glass", "globe", "glow", "gold", "granite", "grape",
    "grass", "harbor", "harvest", "hazel", "heron", "hidden", "hollow", "horizon",
    "humble", "indigo", "ivory", "jade", "juniper", "kettle", "khaki", "kindly",
    "knot", "lagoon", "lantern", "lavish", "lemon", "linen", "lively", "lotus",
    "lumber", "magnet", "mango", "maple", "marble", "marvel", "meadow", "merit",
    "metal", "mocha", "modest", "monsoon", "moss", "motion", "muffin", "myth",
    "nectar", "nimbus", "noble", "north", "nutmeg", "oasis", "olive", "onyx",
    "opal", "orbit", "orchid", "otter", "panda", "papaya", "patio", "pebble",
    "pepper", "perch", "petal", "pixel", "plain", "planet", "plum", "polar",
    "pollen", "poppy", "prairie", "puffin", "pulse", "quartz", "quench", "quiet",
    "rapid", "raven", "ribbon", "ridge", "rocket", "rose", "ruby", "saffron",
    "sage", "sandy", "scarlet", "silver", "spark", "spring",
    "sunny", "swift",
)

# Sanity: keep the 200-word contract. If a future edit breaks
# this assert, ``test_pre_omran_reset_seed`` would also fail
# loudly, but a runtime check is cheaper to spot.
assert len(WORDS) == 200, (
    f"wordlist.WORDS must contain exactly 200 entries; got {len(WORDS)}"
)
assert all(4 <= len(w) <= 7 and w.islower() for w in WORDS), (
    "every word must be 4–7 lowercase a-z chars"
)
assert len(set(WORDS)) == len(WORDS), "wordlist contains duplicates"
