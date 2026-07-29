import { useEffect, useState } from "react";

/* Best/worst play grading for a finished hand.
 *
 * Replaces the `useMemo` both screens used to call `gradeHandPlays` in, which
 * was fine only because grading started at trick 3. It now starts at trick 1,
 * so the solve is a median of ~800ms and occasionally several seconds — that
 * has to be off the main thread, which makes the result asynchronous and this
 * a hook rather than a memo.
 *
 * The recap renders immediately either way. `pending` is true while the solve
 * is out, so the legend can say so instead of the grid quietly looking like a
 * hand where nothing was worth flagging — those two states are different and
 * the recap should not conflate them.
 */

const NONE = { best: null, worst: null, pending: false };

export function useHandGrade(g, active) {
  const [state, setState] = useState(NONE);
  const handNum = g?.handNum;

  useEffect(() => {
    if (!active || !g) {
      setState(NONE);
      return undefined;
    }

    let live = true;
    let worker;
    try {
      worker = new Worker(new URL("./grader.worker.js", import.meta.url), { type: "module" });
    } catch {
      // No worker, no grades. Falling back to grading on this thread would
      // freeze the recap for as long as the solve takes, which is the whole
      // thing this exists to avoid, and grading from a later trick instead
      // would silently answer a different question than the legend claims.
      setState(NONE);
      return undefined;
    }

    setState({ best: null, worst: null, pending: true });
    worker.onmessage = (e) => {
      if (!live) return;
      setState({ best: e.data?.best ?? null, worst: e.data?.worst ?? null, pending: false });
    };
    worker.onerror = () => { if (live) setState(NONE); };
    worker.postMessage({ id: handNum, g });

    // Terminate rather than let it finish: the only consumer is a recap that
    // is already gone, and an abandoned solve can hold a core for seconds.
    return () => { live = false; worker.terminate(); };
    // Keyed on the hand, not on `g` — `trickHistory` is frozen once the hand
    // ends, so a later identity change cannot alter the verdict. (The repo's
    // eslint has no react-hooks plugin, so this is a convention, not enforced.)
  }, [active, handNum]);

  return state;
}
