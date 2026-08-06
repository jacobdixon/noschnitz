#!/usr/bin/env bash
# =============================================================================
# Delete the merged branches that have piled up on origin.
#
# WHY THIS EXISTS AS A SCRIPT rather than a session doing it: a session cannot
# delete a remote branch here. The git proxy ACCEPTS the delete-push and drops
# it, reporting `send-pack: unexpected disconnect` and then `Everything
# up-to-date` — which reads like success. There is no delete-branch tool in the
# GitHub MCP set either. So this has to be run by a person, from a machine with
# ordinary push access.
#
# WHY THERE ARE 34 OF THEM: `gh pr merge --delete-branch` silently fails in this
# repo (a worktree error swallows it), so nothing has ever cleaned up after a
# merge. THE DURABLE FIX IS NOT THIS SCRIPT — it is
#   Settings -> General -> "Automatically delete head branches"
# which would have prevented every branch listed below. Turn that on first, or
# you will be running this again in a fortnight.
#
# HOW THE LIST WAS BUILT, because the obvious method is wrong: each branch tip
# is compared against the head SHA its pull request actually MERGED. Do not use
# `git branch -r --merged origin/master` — squash-merged tips are never
# ancestors of master, so it under-reports badly (2 of 14, the one time it was
# tried here).
#
# SAFETY: every branch carries the SHA it was verified at. If a tip has moved
# since — somebody pushed to it, a session resumed work on it — that branch is
# SKIPPED and reported, not deleted. Re-verify it by hand before adding it back.
#
#   ./scripts/prune-branches.sh            # dry run: prints what it would do
#   ./scripts/prune-branches.sh --delete   # actually deletes
#
# Verified 2026-08-06 against origin/master at d64499e.
# =============================================================================
set -uo pipefail

DELETE=0
[ "${1:-}" = "--delete" ] && DELETE=1

# ---------------------------------------------------------------------------
# NOT IN THIS LIST, deliberately — do not add them:
#
#   master, beta  permanent. beta is a ref release.yml fast-forwards on every
#                 green CI run on master; deleting it breaks the deploy chain.
#   v2            merged (PR #54) and so it LOOKS deletable, but CLAUDE.md keeps
#                 it on purpose as a landmark for the rewrite. Leave it.
#   claude/hand-recap-blind-indicator-8jzuzk   open PR #137
#   claude/build-test-timeouts-wl92g2          open PR #138
# ---------------------------------------------------------------------------

# Tip SHA and branch. Each of these matched the head SHA of a merged PR exactly.
MERGED="
df862d42642a96047f47653bcff14343ceb00e66 ai/endgame-tiebreak
d844223d2f2ed371e3aae656b3bdec76e9beb31c ai/hand-mining
35c74e076e5d2f6aa6a9f757349c2e23631a1c89 ai/partner-belief
7ceedf858bafc0fecbf4c6bfac797411e881bf12 ai/picker-free-duck
573071bb3ed7e63f68e39032edfe1410ebd7e97b ai/protect-trump-power
bfb9c88530452d94c5305c22f9cafe3078d4a7ab ci/pipeline
04b43a0a6a03ead4e969ae3bfffca56a7025d883 ci/verify-production
621aafd227b65fc3c6f376aec55749ac49135b3b claude/ace-clubs-play-analysis-zmlrjm
2c113ad4cc130bfffff63e19e663ab4b0af4d762 claude/ai-takeover-prevention-08bpda
95f60c95e2bed5daa8b478f0fd8cc2880502a9f6 claude/ci-test-suite-review-j3s1fx
1e1fa7cb6e6da52f4fdf842fad66363728f1cc7e claude/hand-pimc-style-assessment-g4e83m
4ee2375a8232aede4a6c39ed40157fb51869c7e7 claude/hands-corpus-findings-h32nqa
417f243efef4df0ad1af7ef0c1bb94ff85305c55 claude/human-hands-beta-review-h32nqa
eafceb3fe138dc5ed532278df57b8231855fa732 claude/jh-play-ai-decision-lhq4jg
1b75c9c27eb9c7ebec0a4b0038e723d5bbe89b3b claude/jh-play-monte-carlo-wb80g8
e9d412cd7e446c12a5f5d6457773b65f4caf16d8 claude/kopps-ace-hearts-trick-3-1xo8yd
cf2ed9f5d9778bd778b63c2376894787f41d3f98 claude/modal-button-alignment-mobile-6yoaex
51d4f8566b87a957840aa170b93c341df5a2bd1b claude/multiplayer-beta-production-1pnyri
8f2c865ebf1eb1a97c46586e66c24e35e1b7c776 claude/multiplayer-voice-work-ps0ws8
31c4680d61605aeac772e8e9881bbf3c19871d31 claude/patty-ad-second-trick-wx10om
768d2e108ed39c5999f42b618f3bf33203a95b5f claude/picker-solo-option-u2b15v
59a5f4f2a112e302dd8995778030d5bf6a10c407 claude/pimc-10s-play-01ktuc
e87cbbfa0e5e1873143b8f6f7261d0229f093a0b claude/review-outstanding-todos-43qbos
835e813ffdbbcd0267f175a4881595d41c7051d0 claude/sheepshead-analysis-compare-7drvmv
33d02311fc1d3a62ed15fc5b28a434ae079137bf claude/social-roadmap-assessment-ylint0
e2c76e5a4a83ad69c54e8b67159dd7cda04d3b79 claude/voice-rooms-com1
bba013138b9b0c37276fffd4afb19ff43f9f6971 feat/hand-collection
3d1f16ce84c0b13532c7bbaeab8bb551b3305b81 fix/schneider-threshold
cf97e3d678a6a0abe94e37b41afb428cbde7f4d6 grader/full-hand
"

# These three do NOT match a merged head SHA — their work shipped under
# rewritten SHAs — so each was confirmed a different way: the version it
# introduced is present in master's CHANGELOG today.
#   claude/fix-verify-grep-exit        0.58.1  ## [0.58.1] - 2026-08-03
#   claude/github-repo-private-fasb2i  0.18.0  ## [0.18.0] - 2026-07-28
#   fix/recap-picker-partner           0.7.4   ## [0.7.4]  - 2026-07-25
SHIPPED_UNDER_ANOTHER_SHA="
3d8419497fffc80cc9758a635b12e8869c726497 claude/fix-verify-grep-exit
cb87ba30836d365e0b446968c1085a9232a0fbb6 claude/github-repo-private-fasb2i
13babe2b6e9ee93206f90d17ffb58180d96275b9 fix/recap-picker-partner
"

# ---------------------------------------------------------------------------
# HELD BACK — these two carry work that is genuinely NOT in master, so they are
# commented out rather than listed. Both are near-certainly superseded, but
# "near-certainly" is not the standard for an irreversible delete. Look, decide,
# then move the line up into SHIPPED_UNDER_ANOTHER_SHA or delete it by hand.
#
#   6216000 claude/engine-grader-review-tqv2t7
#     0.20.0 is in master's CHANGELOG; 0.20.1 is not. The tail is "keep the
#     head-to-head harness, and record the measurement loop" (2026-07-28).
#     Almost certainly superseded by abtest/coalitiontest/firingtest, which all
#     postdate it. Check: git log origin/master..origin/claude/engine-grader-review-tqv2t7
#
#   d6ee89e claude/solo-multiplayer-table-design-7ls38u
#     0.44.1 is not in master's CHANGELOG. Adds scripts/montecarlo.mjs, which
#     does not exist on master — but scripts/pimc.mjs does, and does the same
#     job. Check: git show origin/claude/solo-multiplayer-table-design-7ls38u:scripts/montecarlo.mjs
# ---------------------------------------------------------------------------

echo "Fetching origin so the tip check is against current reality..."
git fetch --prune origin || { echo "fetch failed — aborting"; exit 1; }
echo

to_delete=()
skipped=0

check() {
  local expected="$1" branch="$2" why="$3"
  local actual
  actual=$(git rev-parse --verify --quiet "refs/remotes/origin/$branch") || {
    printf '  gone      %-45s (already deleted)\n' "$branch"
    return
  }
  if [ "$actual" != "$expected" ]; then
    printf '  SKIP      %-45s tip moved: %s -> %s\n' "$branch" "${expected:0:7}" "${actual:0:7}"
    skipped=$((skipped + 1))
    return
  fi
  printf '  delete    %-45s %s\n' "$branch" "$why"
  to_delete+=("$branch")
}

echo "Merged — tip matches the head SHA its PR merged:"
while read -r sha branch; do
  [ -z "${branch:-}" ] && continue
  check "$sha" "$branch" "merged PR"
done <<< "$MERGED"

echo
echo "Merged — shipped under a rewritten SHA, version confirmed in CHANGELOG:"
while read -r sha branch; do
  [ -z "${branch:-}" ] && continue
  check "$sha" "$branch" "version in master's CHANGELOG"
done <<< "$SHIPPED_UNDER_ANOTHER_SHA"

echo
echo "${#to_delete[@]} branch(es) to delete, $skipped skipped."

if [ "$DELETE" -ne 1 ]; then
  echo
  echo "Dry run. Re-run with --delete to actually remove them:"
  echo "  ./scripts/prune-branches.sh --delete"
  exit 0
fi

if [ "${#to_delete[@]}" -eq 0 ]; then
  echo "Nothing to do."
  exit 0
fi

echo
echo "Deleting. One push, so it is one round trip and one atomic-ish operation:"
git push origin --delete "${to_delete[@]}"

echo
echo "Done. Now turn on Settings -> General -> 'Automatically delete head"
echo "branches' so this never needs running again."
