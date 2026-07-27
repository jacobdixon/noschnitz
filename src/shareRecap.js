/* ============================================================================
   Screenshot the recap and hand it to the OS share sheet.

   Lives outside both screens because a shared hand is the project's actual bug
   report format — someone plays a hand, thinks the AI misplayed it, and sends
   the picture. That has to work identically from the solo game and from a
   table, and a second copy of it would be a second set of fallbacks to get
   wrong.

   html2canvas is fetched from a CDN on first use rather than bundled, because
   it is larger than the whole app and almost nobody taps Share.
   ========================================================================= */
import { felt } from "./ui.jsx";

const CDN = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";

function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = CDN;
    script.onload = () => resolve(window.html2canvas);
    script.onerror = () => reject(new Error("Couldn't load screenshot library"));
    document.head.appendChild(script);
  });
}

/**
 * @param {HTMLElement} node     the capture region (RecapModal's captureRef)
 * @param {number}      handNum  names the file and the share text
 */
export async function shareRecap(node, handNum) {
  if (!node) return;
  try {
    const html2canvas = await loadHtml2Canvas();
    const canvas = await html2canvas(node, { backgroundColor: felt.bgDeep, scale: 2 });
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      const fileName = `sheepshead-hand-${handNum}.png`;
      const file = new File([blob], fileName, { type: "image/png" });
      const title = `Sheepshead — Hand ${handNum}`;
      const text = `Sheepshead hand ${handNum} — take a look at this play.`;
      try {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title, text });
        } else if (navigator.share) {
          await navigator.share({ title, text });
        } else {
          // Desktop: no share sheet, so just save the image.
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          a.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        // AbortError when the user dismisses the share sheet — not a failure.
      }
    }, "image/png");
  } catch (err) {
    console.error("Recap share failed:", err);
  }
}
