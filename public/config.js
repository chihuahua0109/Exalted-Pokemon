// Runtime configuration loaded before app.js.
//
// Web (served by this Node server): leave EXALTED_API_BASE empty — the API is
// on the same origin.
//
// Packaged iOS/Android app (Capacitor): the web assets are bundled inside the
// app, so the API is NOT same-origin. Set this to your deployed backend URL,
// e.g. "https://exalted-pokemon.onrender.com" before building the native app.
window.EXALTED_API_BASE = "";
