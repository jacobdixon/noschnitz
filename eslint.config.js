/* ============================================================================
   Lint, for exactly one class of bug.

   This is not a style config and deliberately enables almost nothing. It
   exists because `no-undef` catches something the build cannot, and that gap
   has already reached production-adjacent code twice:

     ScoresModal read `isMe`, `s`, `onAway` and `onBack` — variables written
     for PlayerModal's scope and pasted into another component's (7791bc5).
     Opening Scores at a table threw `ReferenceError: isMe is not defined` and
     blanked the entire app. It was live on beta.

     TRUMP_ORDER kept calling makeDeck()/isTrump()/trumpPower() after those
     imports were removed. Same failure, at module load, so the table screen
     would not have rendered at all.

   Both built cleanly and shipped a working-looking bundle, because bundlers
   resolve modules, not free identifiers. A test suite doesn't catch it either
   unless a test happens to render the exact component. `no-undef` catches it
   in every file, every time, in under a second.

   Style rules are left off on purpose: they generate churn and argument, and
   this file should stay something nobody needs to negotiate with.
   ========================================================================= */
import globals from "globals";

export default [
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        ...globals.browser,
        ...globals.node,
        // Injected by Vite at build time (see vite.config.js `define`).
        __APP_VERSION__: "readonly",
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      "no-undef": "error",
      // The sibling failure, and one no-undef cannot see: the binding exists in
      // scope, just later. Hooks near the top of a component that reach for a
      // `const` declared below the early returns throw "Cannot access 'g'
      // before initialization" and blank the screen — again with a clean build.
      "no-use-before-define": ["error", { functions: false, classes: false, variables: true }],
      // The other half of the same problem: a binding left behind after the
      // code that used it is gone. Harmless on its own, but it is what turns
      // an import list into an unreliable description of what a file needs.
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^React$" }],
    },
  },
  { ignores: ["dist/**", "node_modules/**"] },
];
