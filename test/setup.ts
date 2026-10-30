// Node 24 supplies navigator.language from the host OS. English fixture assertions
// must have the same browser language on German Windows and on Linux CI. Tests
// of other languages continue to select their locale explicitly; runtime defaults
// remain automatic and are not changed by this test-only setup.
if (typeof navigator !== "undefined") {
  Object.defineProperty(navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en-US"] });
}
