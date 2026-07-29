/* Hand grading, off the main thread.
 *
 * `gradeHandPlays` solves the hand double-dummy at every decision. Graded from
 * trick 3 that costs a few tens of milliseconds and could sit in a `useMemo`;
 * graded from trick 1 — which is what makes an opening lead or a trick-2 duck
 * reviewable at all — it is a median of ~800ms and up to ~8s, because the cost
 * of an exact solve is set by how many cards are still out. Neither number is
 * available synchronously inside a render, so the search moved here instead of
 * the threshold staying where it was.
 *
 * Deliberately thin: every decision worth testing lives in `gradeHandPlays`,
 * which the harnesses call directly. This file exists to own the thread, not
 * any logic, so nothing here needs a test of its own.
 */
import { gradeHandPlays } from "./engine.js";

self.onmessage = (e) => {
  const { id, g } = e.data ?? {};
  try {
    const { best, worst } = gradeHandPlays(g);
    self.postMessage({ id, best, worst });
  } catch {
    // A hand that exhausts the node budget reports as "nothing to say about
    // this one", which is already how the grader answers a hand where no
    // decision could have changed anything. A recap that renders without a
    // verdict is fine; one that fails to render is not.
    self.postMessage({ id, best: null, worst: null });
  }
};
