// Runtime configuration loaded before app.js.
//
// Web (served by this Node server): leave KAIROS_API_BASE empty — the API is
// on the same origin.
//
// Packaged iOS/Android app (Capacitor): the web assets are bundled inside the
// app, so the API is NOT same-origin. Set this to your deployed backend URL
// before building the native app.
// NOTE: still the old Render subdomain — rename the service in the Render
// dashboard to "kairos-pokemon" and update this URL to match.
window.KAIROS_API_BASE = "https://exalted-pokemon.onrender.com";
