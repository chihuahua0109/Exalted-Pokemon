// Runtime configuration loaded before app.js.
//
// In a normal browser the API is on the same origin, so the base stays empty.
// The packaged iOS/Android app (Capacitor) serves its files from
// capacitor://localhost (or file://), where same-origin calls can't reach the
// backend — there it uses the deployed URL below.
(function () {
  var native =
    location.protocol === "capacitor:" ||
    location.protocol === "file:" ||
    (location.hostname === "localhost" && !location.port);
  window.KAIROS_API_BASE = native ? "https://kairos-pokemon.onrender.com" : "";
})();
