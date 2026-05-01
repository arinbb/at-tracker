/* AT Section Tracker — vanilla JS app
 * Per-profile state stored in localStorage; URL hash holds shareable encoded snapshot.
 * Notes stored only in localStorage (not in share code, to keep URLs short).
 */
(() => {
  const DATA_URL = "at_data.json";
  const LORE_URL = "at_lore.json";
  const LS_PROFILES = "at-tracker-profiles-v1";
  const LS_ACTIVE = "at-tracker-active-profile-v1";
  const LS_PREFS = "at-tracker-prefs-v1";
  const DEFAULT_PROFILE = "Me";
  const EPOCH = Date.UTC(2000, 0, 1);

  // -------- DOM --------
  const $ = (id) => document.getElementById(id);
  const sectionsEl = $("sections");
  const loadingEl = $("loading");
  const filterEl = $("filter");
  const filterHikedEl = $("filter-hiked");
  const filterPlannedEl = $("filter-planned");
  const directionEl = $("direction");
  const viewModeEl = $("view-mode");
  const showSheltersEl = $("show-shelters");
  const colorByYearEl = $("color-by-year");
  const profileSelectEl = $("profile-select");
  const statSegs = $("stat-segs");
  const statTotalSegs = $("stat-total-segs");
  const statMiles = $("stat-miles");
  const statTotalMiles = $("stat-total-miles");
  const statPct = $("stat-pct");
  const progressFill = $("progress-fill");

  // -------- State --------
  let DATA = null;
  let FEATURES = null; // {features:[...]} from at_features.json
  let segFeatures = new Map(); // segId -> [feature, ...]
  let featureLayerGroups = new Map(); // kind -> Leaflet layer group
  let featureById = new Map(); // feature.id -> feature (for global search/zoom)
  let layerControl = null;
  let LORE = []; // loaded from at_lore.json
  let loreBySegId = new Map(); // segId -> [lore entry, ...]
  let loreLayer = null;
  let segIndex = new Map();
  let segCumulative = new Map();
  let progress = new Map();
  let planned = new Set();
  let trips = []; // [{id, name, createdAt, segs: [ids]}]; planned is derived from active trip
  let activeTripId = null;
  let notes = new Map();
  let prefs = {
    direction: "nobo",
    showShelters: true,
    colorByYear: false,
    viewMode: "state",
    theme: null, // null = follow system; "light" or "dark" = explicit
    pace: 12, // mi/day for trip-day estimates
    tripStartDate: null, // ISO date for the planned trip start
    zeroDayFreq: 0, // insert a rest day every N hike days; 0 = none
  };
  let profiles = [DEFAULT_PROFILE];
  let activeProfile = DEFAULT_PROFILE;
  let map = null;
  let segLayers = new Map();
  let shelterLayer = null;
  let lastShiftAnchor = null;
  let pendingBulkRange = null; // {from, to, ids}
  let openStates = new Set(); // state names whose section the user has expanded
  let openChunks = new Set(); // "state::chunk-i" keys for expanded sub-groups
  let multiSelectMode = false; // mobile-friendly bulk-select toggle
  let multiSelectAnchor = null; // first segId tapped while in multi-select mode
  let addTripMode = false; // "+ Trip" mode: pick start, then end, then date
  let addTripStart = null; // first segId picked in add-trip mode
  let notesSaveTimer = null; // debounced notes flush
  let cloudUser = null; // Firebase User when signed in
  let cloudSaveTimer = null; // debounced cloud write
  let cloudInhibit = false; // suppress writes during initial cloud->local merge
  let pendingApplyAfterHook = null; // optional callback after applyBulkDate

  // -------- Storage helpers --------
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { console.warn("localStorage write failed:", e?.name || e); return false; }
  }
  function safeGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { console.warn("localStorage read failed:", e?.name || e); return null; }
  }
  function progressKey(name) { return `at-tracker-progress::${name}`; }
  function notesKey(name) { return `at-tracker-notes::${name}`; }
  function plannedKey(name) { return `at-tracker-planned::${name}`; }
  function tripsKey(name) { return `at-tracker-trips::${name}`; }

  // -------- Encoding (URL share) --------
  function encodeProgress(prog) {
    const entries = [];
    for (const [id, date] of prog) entries.push([id, dateToDay(date)]);
    const buf = new ArrayBuffer(entries.length * 4);
    const dv = new DataView(buf);
    entries.forEach(([id, day], i) => {
      dv.setUint16(i * 4, id, true);
      dv.setUint16(i * 4 + 2, day, true);
    });
    return bytesToB64url(new Uint8Array(buf));
  }
  function decodeProgress(code) {
    if (!code) return new Map();
    const bytes = b64urlToBytes(code);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Map();
    for (let i = 0; i + 4 <= bytes.length; i += 4) {
      const id = dv.getUint16(i, true);
      const day = dv.getUint16(i + 2, true);
      out.set(id, dayToDate(day));
    }
    return out;
  }
  function encodePlanned(set) {
    const ids = [...set].sort((a, b) => a - b);
    const buf = new ArrayBuffer(ids.length * 2);
    const dv = new DataView(buf);
    ids.forEach((id, i) => dv.setUint16(i * 2, id, true));
    return bytesToB64url(new Uint8Array(buf));
  }
  function decodePlanned(code) {
    if (!code) return new Set();
    const bytes = b64urlToBytes(code);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = new Set();
    for (let i = 0; i + 2 <= bytes.length; i += 2) out.add(dv.getUint16(i, true));
    return out;
  }
  function dateToDay(s) {
    if (!s) return 0;
    const [y, m, d] = s.split("-").map(Number);
    if (!y) return 0;
    return Math.max(0, Math.min(65535, Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000)));
  }
  function dayToDate(day) {
    if (!day) return "";
    const t = EPOCH + day * 86400000;
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function bytesToB64url(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // -------- v2 -> v3 user data migration --------
  // Reads the previous-version data file (at_data_v2.json) and remaps every
  // user-tracked segment ID (across all profiles) to the new schema by
  // matching on segment-midpoint lat/lon proximity. Idempotent: marker key
  // 'at-tracker-migrated-v3' prevents repeats.
  async function migrateV2ToV3() {
    let v2;
    try {
      const r = await fetch("at_data_v2.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      v2 = await r.json();
    } catch (e) {
      console.warn("can't load at_data_v2.json — skipping migration:", e);
      return;
    }
    const v2Segs = v2.segments || [];
    if (v2Segs.length === 0) return;
    // Build v3 spatial index: for each v3 segment, midpoint lat/lon
    const v3Index = DATA.segments.map((s) => {
      const c = s.geom;
      const m = c[Math.floor(c.length / 2)];
      return { id: s.id, lon: m[0], lat: m[1] };
    });
    function nearestV3SegmentId(midLon, midLat) {
      let best = null;
      let bestKm = Infinity;
      for (const m of v3Index) {
        const lat0 = (m.lat + midLat) * 0.5 * Math.PI / 180;
        const dx = (m.lon - midLon) * 111.32 * Math.cos(lat0);
        const dy = (m.lat - midLat) * 110.574;
        const km = Math.sqrt(dx * dx + dy * dy);
        if (km < bestKm) { bestKm = km; best = m; }
      }
      return best ? { id: best.id, km: bestKm } : null;
    }
    // Build the remap once
    const remap = new Map(); // oldId -> newId
    for (const s of v2Segs) {
      if (!s.geom || s.geom.length < 2) continue;
      const m = s.geom[Math.floor(s.geom.length / 2)];
      const match = nearestV3SegmentId(m[0], m[1]);
      if (match && match.km < 1.5) remap.set(s.id, match.id);
    }
    if (remap.size === 0) return;
    console.warn(`Migrating ${remap.size} v2 -> v3 segment ID mappings...`);

    // Apply to each per-profile localStorage record
    const profilesList = loadProfileList();
    for (const profileName of profilesList) {
      // progress
      const prog = safeGet(progressKey(profileName));
      if (prog) {
        try {
          const obj = JSON.parse(prog);
          const newObj = {};
          for (const [k, v] of Object.entries(obj)) {
            const newId = remap.get(Number(k));
            if (newId != null) newObj[newId] = v;
          }
          safeSet(progressKey(profileName), JSON.stringify(newObj));
        } catch (e) {}
      }
      // planned
      const pl = safeGet(plannedKey(profileName));
      if (pl) {
        try {
          const arr = JSON.parse(pl).map(Number).map((id) => remap.get(id)).filter((id) => id != null);
          safeSet(plannedKey(profileName), JSON.stringify(arr));
        } catch (e) {}
      }
      // notes
      const nt = safeGet(notesKey(profileName));
      if (nt) {
        try {
          const obj = JSON.parse(nt);
          const newObj = {};
          for (const [k, v] of Object.entries(obj)) {
            const newId = remap.get(Number(k));
            if (newId != null) newObj[newId] = v;
          }
          safeSet(notesKey(profileName), JSON.stringify(newObj));
        } catch (e) {}
      }
      // trips (each has segs: [oldIds]) and pins are by name so they survive
      const tr = safeGet(tripsKey(profileName));
      if (tr) {
        try {
          const obj = JSON.parse(tr);
          if (Array.isArray(obj.trips)) {
            for (const t of obj.trips) {
              if (Array.isArray(t.segs)) {
                t.segs = t.segs.map(Number).map((id) => remap.get(id)).filter((id) => id != null);
              }
            }
          }
          safeSet(tripsKey(profileName), JSON.stringify(obj));
        } catch (e) {}
      }
    }
  }

  // -------- v3 -> v4 user data migration --------
  // Same shape as v2->v3: read at_data_v3.json (a snapshot saved before the
  // v4 KMZ-based rebuild), build a remap from each v3 segment's midpoint to
  // the closest v4 segment by lat/lon, then rewrite every per-profile
  // progress/planned/notes/trips record. v4 has fewer, larger segments
  // (~290 vs 629) so multiple v3 IDs may collapse onto one v4 ID — that's
  // expected, the UI just shows the v4 segment as hiked once any of its
  // contributing v3 segments was hiked.
  async function migrateV3ToV4() {
    let v3;
    try {
      const r = await fetch("at_data_v3.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      v3 = await r.json();
    } catch (e) {
      console.warn("can't load at_data_v3.json — skipping v3->v4 migration:", e);
      return;
    }
    const v3Segs = v3.segments || [];
    if (v3Segs.length === 0) return;
    const v4Index = DATA.segments.map((s) => {
      const c = s.geom;
      const m = c[Math.floor(c.length / 2)];
      return { id: s.id, lon: m[0], lat: m[1] };
    });
    function nearestV4SegmentId(midLon, midLat) {
      let best = null;
      let bestKm = Infinity;
      for (const m of v4Index) {
        const lat0 = (m.lat + midLat) * 0.5 * Math.PI / 180;
        const dx = (m.lon - midLon) * 111.32 * Math.cos(lat0);
        const dy = (m.lat - midLat) * 110.574;
        const km = Math.sqrt(dx * dx + dy * dy);
        if (km < bestKm) { bestKm = km; best = m; }
      }
      return best ? { id: best.id, km: bestKm } : null;
    }
    const remap = new Map();
    for (const s of v3Segs) {
      if (!s.geom || s.geom.length < 2) continue;
      const m = s.geom[Math.floor(s.geom.length / 2)];
      const match = nearestV4SegmentId(m[0], m[1]);
      // Allow a slightly larger threshold (3 km) since v4 segments are
      // larger and a v3 midpoint may sit anywhere along its v4 parent.
      if (match && match.km < 3.0) remap.set(s.id, match.id);
    }
    if (remap.size === 0) return;
    console.warn(`Migrating ${remap.size} v3 -> v4 segment ID mappings...`);

    const profilesList = loadProfileList();
    for (const profileName of profilesList) {
      const prog = safeGet(progressKey(profileName));
      if (prog) {
        try {
          const obj = JSON.parse(prog);
          const newObj = {};
          for (const [k, v] of Object.entries(obj)) {
            const newId = remap.get(Number(k));
            // If multiple v3 ids map to the same v4 id, keep the earliest date.
            if (newId != null) {
              if (!(newId in newObj) || (v && (!newObj[newId] || v < newObj[newId]))) {
                newObj[newId] = v;
              }
            }
          }
          safeSet(progressKey(profileName), JSON.stringify(newObj));
        } catch (e) {}
      }
      const pl = safeGet(plannedKey(profileName));
      if (pl) {
        try {
          const arr = [...new Set(JSON.parse(pl).map(Number).map((id) => remap.get(id)).filter((id) => id != null))];
          safeSet(plannedKey(profileName), JSON.stringify(arr));
        } catch (e) {}
      }
      const nt = safeGet(notesKey(profileName));
      if (nt) {
        try {
          const obj = JSON.parse(nt);
          const newObj = {};
          for (const [k, v] of Object.entries(obj)) {
            const newId = remap.get(Number(k));
            if (newId != null) {
              // If multiple v3 notes collapse onto one v4 seg, concatenate.
              newObj[newId] = newObj[newId] ? `${newObj[newId]}\n---\n${v}` : v;
            }
          }
          safeSet(notesKey(profileName), JSON.stringify(newObj));
        } catch (e) {}
      }
      const tr = safeGet(tripsKey(profileName));
      if (tr) {
        try {
          const obj = JSON.parse(tr);
          if (Array.isArray(obj.trips)) {
            for (const t of obj.trips) {
              if (Array.isArray(t.segs)) {
                t.segs = [...new Set(t.segs.map(Number).map((id) => remap.get(id)).filter((id) => id != null))];
              }
            }
          }
          safeSet(tripsKey(profileName), JSON.stringify(obj));
        } catch (e) {}
      }
    }
  }

  // -------- Profiles --------
  function loadProfileList() {
    const raw = safeGet(LS_PROFILES);
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) return arr.map(String);
      } catch (e) {}
    }
    return [DEFAULT_PROFILE];
  }
  function saveProfileList() { safeSet(LS_PROFILES, JSON.stringify(profiles)); }
  function loadActiveProfile() {
    const raw = safeGet(LS_ACTIVE);
    return raw && profiles.includes(raw) ? raw : profiles[0];
  }
  function saveActiveProfile() { safeSet(LS_ACTIVE, activeProfile); }
  function ensureProfile(name) {
    if (!profiles.includes(name)) {
      profiles = [...profiles, name];
      saveProfileList();
    }
  }
  function renderProfileSelect() {
    profileSelectEl.innerHTML = profiles.map(p =>
      `<option value="${escapeHtml(p)}"${p === activeProfile ? " selected" : ""}>${escapeHtml(p)}</option>`
    ).join("");
    updateIdentityLabel();
  }
  // Keep the avatar pill (top-right) in sync with the active profile.
  function updateIdentityLabel() {
    const labelEl = $("identity-label");
    const avatarEl = $("identity-avatar");
    if (labelEl) labelEl.textContent = activeProfile;
    if (avatarEl) {
      const init = (activeProfile || "?").trim().charAt(0).toUpperCase() || "?";
      avatarEl.textContent = init;
    }
  }
  function switchProfile(name) {
    if (!profiles.includes(name)) return;
    activeProfile = name;
    saveActiveProfile();
    progress = loadProgressForActive();
    planned = loadPlannedForActive();
    notes = loadNotesForActive();
    {
      const td = loadTripsForActive();
      trips = td.trips;
      activeTripId = td.activeTripId;
      // If trips were loaded, prefer them as the source of truth.
      if (trips.length > 0) syncPlannedFromActiveTrip();
      else if (planned.size > 0) {
        // Wrap legacy planned set into a default trip and persist
        ensureActiveTrip();
        syncActiveTripFromPlanned();
        saveTrips();
      }
    }
    renderProfileSelect();
    renderSections();
    updateStats();
    refreshMapStyles();
  }

  // -------- Persistence (per-profile) --------
  function loadProgressForActive() {
    const hash = location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const code = params.get("c");
    if (code) {
      try { return decodeProgress(code); }
      catch (e) { console.warn("bad URL code", e); }
    }
    const raw = safeGet(progressKey(activeProfile));
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v || ""]));
      } catch (e) { console.warn("bad localStorage progress", e); }
    }
    return new Map();
  }
  // -------- Trips --------
  // Per-profile list of saved planned hikes; activeTripId is the one currently
  // shown as "planned" in the sidebar/map. The legacy single-set planned API
  // is preserved by mirroring the active trip into the `planned` Set.
  function loadTripsForActive() {
    const raw = safeGet(tripsKey(activeProfile));
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        if (Array.isArray(obj.trips)) {
          return { trips: obj.trips, activeTripId: obj.activeTripId };
        }
      } catch (e) {}
    }
    // Legacy migration: if we have a planned set but no trips, wrap it.
    const legacy = loadPlannedForActive();
    if (legacy.size > 0) {
      const t = {
        id: "default-" + Date.now(),
        name: "My next hike",
        createdAt: Date.now(),
        segs: [...legacy],
      };
      return { trips: [t], activeTripId: t.id };
    }
    return { trips: [], activeTripId: null };
  }
  function saveTrips() {
    safeSet(tripsKey(activeProfile), JSON.stringify({ trips, activeTripId }));
    scheduleCloudSave();
  }
  function getActiveTrip() {
    return trips.find((t) => t.id === activeTripId) || null;
  }
  function ensureActiveTrip() {
    let t = getActiveTrip();
    if (t) return t;
    t = {
      id: "trip-" + Date.now(),
      name: "My next hike",
      createdAt: Date.now(),
      segs: [],
    };
    trips.push(t);
    activeTripId = t.id;
    return t;
  }
  function syncPlannedFromActiveTrip() {
    const t = getActiveTrip();
    planned = new Set(t ? t.segs.map(Number) : []);
  }
  function syncActiveTripFromPlanned() {
    const t = getActiveTrip();
    if (!t) return;
    t.segs = [...planned];
  }
  function switchTrip(tripId) {
    if (!trips.find((t) => t.id === tripId)) return;
    activeTripId = tripId;
    saveTrips();
    syncPlannedFromActiveTrip();
    renderSections();
    updateStats();
    refreshMapStyles();
  }

  function loadPlannedForActive() {
    const hash = location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const code = params.get("pl");
    if (code) {
      try { return decodePlanned(code); }
      catch (e) { console.warn("bad URL planned code", e); }
    }
    const raw = safeGet(plannedKey(activeProfile));
    if (raw) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr.map(Number));
      } catch (e) {}
    }
    return new Set();
  }
  function loadNotesForActive() {
    const raw = safeGet(notesKey(activeProfile));
    if (!raw) return new Map();
    try {
      const obj = JSON.parse(raw);
      return new Map(Object.entries(obj).map(([k, v]) => [Number(k), v || ""]));
    } catch (e) { return new Map(); }
  }
  function loadPrefs() {
    const raw = safeGet(LS_PREFS);
    if (!raw) return prefs;
    try { return { ...prefs, ...JSON.parse(raw) }; }
    catch (e) { return prefs; }
  }
  function saveProgress() {
    const obj = {};
    for (const [k, v] of progress) obj[k] = v;
    safeSet(progressKey(activeProfile), JSON.stringify(obj));
    safeSet(plannedKey(activeProfile), JSON.stringify([...planned]));
    const code = encodeProgress(progress);
    const planCode = encodePlanned(planned);
    const params = new URLSearchParams();
    if (code) params.set("c", code);
    if (planCode) params.set("pl", planCode);
    if (activeProfile !== DEFAULT_PROFILE) params.set("p", activeProfile);
    const hash = params.toString();
    history.replaceState(null, "", hash ? `#${hash}` : location.pathname);
    scheduleCloudSave();
  }
  function savePlanned() { saveProgress(); /* planned saves go through the same URL/LS path */ }
  function saveNotes() {
    const obj = {};
    for (const [k, v] of notes) if (v) obj[k] = v;
    safeSet(notesKey(activeProfile), JSON.stringify(obj));
    scheduleCloudSave();
  }
  function savePrefs() { safeSet(LS_PREFS, JSON.stringify(prefs)); }

  // -------- Map --------
  function initMap() {
    map = L.map("map", { preferCanvas: true }).setView([39.5, -77.5], 6);
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    });
    const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OSM</a>, ' +
        'tiles © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    });
    osm.addTo(map);
    layerControl = L.control.layers(
      { "OpenStreetMap": osm, "OpenTopoMap (terrain)": topo },
      null,
      { position: "topright", collapsed: true }
    ).addTo(map);

    // Custom map legend control
    const Legend = L.Control.extend({
      options: { position: "bottomleft" },
      onAdd() {
        const el = $("map-legend");
        el.style.display = "block";
        return el;
      },
    });
    new Legend().addTo(map);

    window.addEventListener("resize", () => map.invalidateSize());
    window._atMap = map;
  }
  // Curated palette — twelve distinct, accessible colors that look good on both
  // light and dark map basemaps. Cycles by (year - earliestYear) so that when
  // someone has 1995-and-up data, the same year always gets the same color.
  const YEAR_PALETTE = [
    "#2a7d3a", "#1a5fb4", "#a23232", "#b56a00", "#6b3da3", "#0f7a6b",
    "#c44569", "#3a6e9c", "#5b8a3a", "#a8702a", "#7d3a8b", "#2c5d63",
  ];
  function yearColor(year) {
    if (!year) return YEAR_PALETTE[0];
    let earliest = Infinity;
    for (const date of progress.values()) {
      if (!date) continue;
      const y = Number(date.slice(0, 4));
      if (y && y < earliest) earliest = y;
    }
    if (earliest === Infinity) earliest = year;
    const idx = ((year - earliest) % YEAR_PALETTE.length + YEAR_PALETTE.length) % YEAR_PALETTE.length;
    return YEAR_PALETTE[idx];
  }
  // Read CSS vars at call time so the trail line picks up theme changes
  // (light / dark / vintage) without a reload.
  function _cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.body).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) {
      return fallback;
    }
  }
  function styleFor(segId) {
    const date = progress.get(segId);
    const hiked = progress.has(segId);
    const isPlanned = planned.has(segId);
    if (!hiked) {
      if (isPlanned) return { color: _cssVar("--plan", "#1a5fb4"), weight: 4, opacity: 0.95, dashArray: "6 5" };
      return { color: _cssVar("--trail-unhiked", "#7a4f3a"), weight: 2.5, opacity: 0.85, dashArray: null };
    }
    let color = _cssVar("--hike", "#2a7d3a");
    if (prefs.colorByYear) {
      const year = date ? Number(date.slice(0, 4)) : null;
      color = yearColor(year);
    }
    return { color, weight: 5, opacity: 0.95, dashArray: null };
  }
  // Haversine distance in km between two [lon, lat] points.
  function _havKm(a, b) {
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // The NPS Treadway feed is missing geometry for a handful of trail-club
  // chunks (notably around Daleville VA, the Whites in NH, and parts of PA).
  // The stitcher concatenates coords across those gaps, which renders as a
  // long straight line cutting across the actual trail. Split a segment's
  // geom into runs of <1km hops so Leaflet draws disconnected strokes
  // instead of bridging the gap with a visually wrong straight line.
  function _splitGeomOnGaps(geom, thresholdKm) {
    if (!geom || geom.length < 2) return [geom || []];
    const runs = [];
    let cur = [geom[0]];
    for (let i = 1; i < geom.length; i++) {
      if (_havKm(geom[i - 1], geom[i]) > thresholdKm) {
        if (cur.length > 1) runs.push(cur);
        cur = [geom[i]];
      } else {
        cur.push(geom[i]);
      }
    }
    if (cur.length > 1) runs.push(cur);
    return runs.length > 0 ? runs : [geom];
  }
  function drawSegmentsOnMap() {
    const bounds = L.latLngBounds([]);
    DATA.segments.forEach((seg) => {
      // Multi-polyline: each "run" is a contiguous chunk of geometry without
      // a >1km internal jump. Leaflet renders each run as a separate stroke.
      const runs = _splitGeomOnGaps(seg.geom, 1.0);
      const latlngs = runs.map((run) => run.map(([lon, lat]) => [lat, lon]));
      const layer = L.polyline(latlngs, { ...styleFor(seg.id), bubblingMouseEvents: false });
      layer.on("click", () => {
        const el = document.querySelector(`[data-seg="${seg.id}"]`);
        if (el) {
          const stateEl = el.closest(".state");
          if (stateEl) {
            stateEl.classList.remove("collapsed");
            openStates.add(stateEl.dataset.state);
          }
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("map-hover");
          setTimeout(() => el.classList.remove("map-hover"), 1500);
        }
      });
      const cumStart = segCumulative.get(seg.id) || 0;
      layer.bindTooltip(
        `${escapeHtml(seg.from)} → ${escapeHtml(seg.to)}<br>` +
        `<small>${seg.miles.toFixed(1)} mi · mile ${cumStart.toFixed(1)}–${(cumStart + seg.miles).toFixed(1)} · ${escapeHtml(seg.state)}</small>`
      );
      layer.addTo(map);
      segLayers.set(seg.id, layer);
      latlngs.forEach((ll) => bounds.extend(ll));
    });
    if (bounds.isValid()) {
      requestAnimationFrame(() => {
        map.invalidateSize();
        map.fitBounds(bounds, { padding: [20, 20] });
      });
    }

    shelterLayer = L.layerGroup();
    DATA.shelters.forEach((s) => {
      L.circleMarker([s.lat, s.lon], {
        radius: 2.5, color: "#3a2d20", fillColor: "#e8a849",
        fillOpacity: 0.95, weight: 0.8,
      })
        .bindTooltip(`<strong>${escapeHtml(s.name)}</strong><br><small>${escapeHtml(s.state)}</small>`)
        .addTo(shelterLayer);
    });
    if (prefs.showShelters) shelterLayer.addTo(map);
  }
  function refreshMapStyles() {
    for (const [id, layer] of segLayers) {
      const s = styleFor(id);
      layer.setStyle(s);
      if (progress.has(id)) layer.bringToFront();
    }
  }

  // -------- Render sidebar --------
  // Hand-curated AT viewpoints to fill OSM coverage gaps. OSM under-tags
  // viewpoints in SW VA / Roan / Smokies / S-VA where some of the trail's
  // most iconic vistas live. These coordinates are well-known and within
  // ~500m of the named feature; many are also tagged as natural=peak in
  // OSM but never as tourism=viewpoint.
  const CURATED_VIEWS = [
    // Southern VA (Roanoke / Lynchburg area)
    { id: "v_mcafee_knob",     name: "McAfee Knob",            kind: "view", lat: 37.3759, lon: -80.0830, elev_m: 974 },
    { id: "v_tinker_cliffs",   name: "Tinker Cliffs",          kind: "view", lat: 37.4119, lon: -80.0317, elev_m: 982 },
    { id: "v_dragons_tooth",   name: "Dragon's Tooth",         kind: "view", lat: 37.3922, lon: -80.1547, elev_m: 950 },
    { id: "v_apple_orchard",   name: "Apple Orchard Mountain", kind: "view", lat: 37.5083, lon: -79.5097, elev_m: 1283 },
    { id: "v_priest",          name: "The Priest",             kind: "view", lat: 37.7481, lon: -79.0833, elev_m: 1280 },
    { id: "v_three_ridges",    name: "Three Ridges",           kind: "view", lat: 37.8189, lon: -79.0061, elev_m: 1233 },
    { id: "v_spy_rock",        name: "Spy Rock",               kind: "view", lat: 37.7642, lon: -79.1394, elev_m: 1230 },
    { id: "v_cole_mountain",   name: "Cole Mountain (Cold Mountain bald)", kind: "view", lat: 37.6953, lon: -79.2319, elev_m: 1234 },
    { id: "v_tar_jacket",      name: "Tar Jacket Ridge",       kind: "view", lat: 37.6814, lon: -79.2436, elev_m: 1175 },
    { id: "v_punchbowl",       name: "Punchbowl Mountain",     kind: "view", lat: 37.5867, lon: -79.4406, elev_m: 793 },

    // Mt. Rogers / Grayson Highlands (SW VA)
    { id: "v_mt_rogers",       name: "Mount Rogers summit",    kind: "view", lat: 36.6597, lon: -81.5454, elev_m: 1746 },
    { id: "v_whitetop",        name: "Whitetop Mountain",      kind: "view", lat: 36.6361, lon: -81.5944, elev_m: 1684 },
    { id: "v_wilburn_ridge",   name: "Wilburn Ridge",          kind: "view", lat: 36.6489, lon: -81.5181, elev_m: 1646 },
    { id: "v_the_scales",      name: "The Scales",             kind: "view", lat: 36.6622, lon: -81.5167, elev_m: 1418 },
    { id: "v_pine_mtn_va",     name: "Pine Mountain (VA)",     kind: "view", lat: 36.6856, lon: -81.5050, elev_m: 1582 },

    // Roan Highlands (NC/TN border)
    { id: "v_roan_high_knob",  name: "Roan High Knob",         kind: "view", lat: 36.1051, lon: -82.1116, elev_m: 1916 },
    { id: "v_roan_high_bluff", name: "Roan High Bluff",        kind: "view", lat: 36.1167, lon: -82.1333, elev_m: 1908 },
    { id: "v_round_bald",      name: "Round Bald",             kind: "view", lat: 36.1083, lon: -82.1006, elev_m: 1733 },
    { id: "v_jane_bald",       name: "Jane Bald",              kind: "view", lat: 36.1133, lon: -82.0853, elev_m: 1786 },
    { id: "v_grassy_ridge",    name: "Grassy Ridge Bald",      kind: "view", lat: 36.1267, lon: -82.0700, elev_m: 1899 },
    { id: "v_hump_mtn",        name: "Hump Mountain",          kind: "view", lat: 36.1561, lon: -82.0033, elev_m: 1605 },
    { id: "v_little_hump",     name: "Little Hump Mountain",   kind: "view", lat: 36.1392, lon: -82.0250, elev_m: 1551 },
    { id: "v_yellow_mtn",      name: "Yellow Mountain Gap",    kind: "view", lat: 36.1278, lon: -82.0494, elev_m: 1460 },

    // NC ridges + Smokies
    { id: "v_beauty_spot",     name: "Beauty Spot",            kind: "view", lat: 36.0733, lon: -82.4517, elev_m: 1311 },
    { id: "v_big_bald",        name: "Big Bald",               kind: "view", lat: 36.0067, lon: -82.5453, elev_m: 1681 },
    { id: "v_camp_creek_bald", name: "Camp Creek Bald",        kind: "view", lat: 35.9789, lon: -82.7150, elev_m: 1456 },
    { id: "v_big_firescald",   name: "Big Firescald Knob",     kind: "view", lat: 35.9711, lon: -82.7592, elev_m: 1374 },
    { id: "v_max_patch",       name: "Max Patch",              kind: "view", lat: 35.7956, lon: -82.9622, elev_m: 1411 },
    { id: "v_mt_cammerer",     name: "Mount Cammerer",         kind: "view", lat: 35.7714, lon: -83.1567, elev_m: 1564 },
    { id: "v_charlies_bunion", name: "Charlies Bunion",        kind: "view", lat: 35.6492, lon: -83.3717, elev_m: 1814 },
    { id: "v_clingmans_dome",  name: "Clingmans Dome",         kind: "view", lat: 35.5630, lon: -83.4985, elev_m: 2025 },
    { id: "v_silers_bald",     name: "Silers Bald",            kind: "view", lat: 35.5600, lon: -83.5742, elev_m: 1716 },
    { id: "v_rocky_top",       name: "Rocky Top",              kind: "view", lat: 35.5800, lon: -83.7547, elev_m: 1605 },
    { id: "v_spence_field",    name: "Spence Field",           kind: "view", lat: 35.5483, lon: -83.7233, elev_m: 1542 },
  ];
  // Mark all curated entries with shared metadata
  CURATED_VIEWS.forEach((f) => {
    f.slug = "";
    f.off = 0;
    f.off_dir = "";
    f.state = "";
    f.parent_town = "";
    f.source = "curated";
  });

  // Wikimedia stable-redirect URLs for each US state's flag, scaled to 40px.
  // Special:FilePath redirects to the current thumbnail without needing the
  // unpredictable file hash. Combined states get two flags side by side.
  const FLAG_URL = (filename) =>
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(filename)}?width=40`;
  const STATE_FLAGS = {
    "Georgia": ["Flag of Georgia (U.S. state).svg"],
    "North Carolina": ["Flag of North Carolina.svg"],
    "Tennessee": ["Flag of Tennessee.svg"],
    "North Carolina/Tennessee": ["Flag of North Carolina.svg", "Flag of Tennessee.svg"],
    "Virginia": ["Flag of Virginia.svg"],
    "West Virginia": ["Flag of West Virginia.svg"],
    "Maryland": ["Flag of Maryland.svg"],
    "Pennsylvania": ["Flag of Pennsylvania.svg"],
    "New Jersey": ["Flag of New Jersey.svg"],
    "New York": ["Flag of New York.svg"],
    "New Jersey/New York": ["Flag of New Jersey.svg", "Flag of New York.svg"],
    "Connecticut": ["Flag of Connecticut.svg"],
    "Massachusetts": ["Flag of Massachusetts.svg"],
    "Vermont": ["Flag of Vermont.svg"],
    "New Hampshire": ["Flag of New Hampshire.svg"],
    "Maine": ["Flag of Maine.svg"],
  };
  // Decompose the OSM-relation-pair states into individual states for display.
  // Use latitude rather than cumulative miles so the split survives a
  // total-trail-mileage change (e.g. when we swap data sources). The AT
  // does zigzag NC/TN through the Smokies, so this is a simplification —
  // but it's good enough for sidebar grouping.
  //  - NC/TN: split at lat 35.78 (≈Davenport Gap)
  //  - NJ/NY: split at lat 41.357 (≈NJ/NY state line on the AT)
  function effectiveStateName(seg) {
    const m = seg.geom && seg.geom.length > 0 ? seg.geom[Math.floor(seg.geom.length / 2)] : null;
    if (seg.state === "North Carolina/Tennessee") {
      return m && m[1] < 35.78 ? "North Carolina" : "Tennessee";
    }
    if (seg.state === "New Jersey/New York") {
      return m && m[1] < 41.357 ? "New Jersey" : "New York";
    }
    return seg.state;
  }
  function stateFlagsHTML(stateName) {
    const flags = STATE_FLAGS[stateName];
    if (!flags) return "";
    return `<span class="state-flags">${flags.map((f) =>
      `<img class="state-flag" src="${FLAG_URL(f)}" alt="" loading="lazy" />`
    ).join("")}</span>`;
  }
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function computeCumulative() {
    let mi = 0;
    const sorted = [...DATA.segments].sort((a, b) => a.id - b.id);
    for (const s of sorted) {
      segCumulative.set(s.id, mi);
      mi += s.miles;
    }
  }
  // Match each feature to its closest segment by lat/lon. Skip features
  // farther than 6mi from any segment (likely not on the AT). For matched
  // features, store on segFeatures[segId] = [...features]. Most features
  // are at the same location as multiple segment endpoints, so many segments
  // get one or two features each.
  function matchFeaturesToSegments() {
    if (!FEATURES || !FEATURES.features) return;
    segFeatures = new Map();
    // Pre-extract midpoints for speed
    const segMid = DATA.segments.map((s) => {
      const c = s.geom;
      const mid = c[Math.floor(c.length / 2)];
      return { id: s.id, lon: mid[0], lat: mid[1], state: s.state };
    });
    const KM_PER_MI = 1.609344;
    const MAX_KM = 8 * KM_PER_MI;
    for (const f of FEATURES.features) {
      if (typeof f.lat !== "number" || typeof f.lon !== "number") continue;
      let bestSeg = null;
      let bestKm = Infinity;
      for (const m of segMid) {
        const lat0 = (m.lat + f.lat) * 0.5 * Math.PI / 180;
        const dx = (m.lon - f.lon) * 111.32 * Math.cos(lat0);
        const dy = (m.lat - f.lat) * 110.574;
        const km = Math.sqrt(dx * dx + dy * dy);
        if (km < bestKm) { bestKm = km; bestSeg = m; }
      }
      if (bestSeg && bestKm <= MAX_KM) {
        // Compute and stash a mile-from-Springer for sorting + display.
        // Prefer wikitrail's mi_springer when present, else use our segment's
        // cumulative mile (start of segment).
        const ourMi = (segCumulative.get(bestSeg.id) || 0);
        f._mile = (typeof f.mi_springer === "number" && f.mi_springer > 0)
          ? f.mi_springer
          : ourMi;
        f._matchKm = bestKm;
        if (!segFeatures.has(bestSeg.id)) segFeatures.set(bestSeg.id, []);
        segFeatures.get(bestSeg.id).push(f);
      }
      featureById.set(f.id, f);
    }
  }
  // Per-kind config for the toggleable map layers.
  const FEATURE_KIND_CONFIG = [
    { kind: "peak",       emoji: "🏔",  label: "Peaks",       defaultOn: true  },
    { kind: "view",       emoji: "🌄",  label: "Viewpoints",  defaultOn: true  },
    { kind: "town",       emoji: "🏘️", label: "Towns",       defaultOn: true  },
    { kind: "parking",    emoji: "🅿️", label: "Trailhead parking", defaultOn: false },
    { kind: "campsite",   emoji: "⛺",  label: "Campsites",   defaultOn: false },
    { kind: "bridge",     emoji: "🌉",  label: "Bridges",     defaultOn: false },
    { kind: "privy",      emoji: "🚻",  label: "Privies",     defaultOn: false },
    { kind: "maildrop",   emoji: "📮",  label: "Maildrops",   defaultOn: false },
    { kind: "resupply",   emoji: "🏪",  label: "Resupply",    defaultOn: true  },
    { kind: "outfitter",  emoji: "🥾",  label: "Outfitters",  defaultOn: false },
    { kind: "hostel",     emoji: "🛏",  label: "Hostels",     defaultOn: false },
    { kind: "hotel",      emoji: "🏨",  label: "Hotels",      defaultOn: false },
    { kind: "restaurant", emoji: "🍽",  label: "Restaurants", defaultOn: false },
    { kind: "service",    emoji: "🚐",  label: "Shuttles/Services", defaultOn: false },
    { kind: "medical",    emoji: "🏥",  label: "Medical",     defaultOn: false },
  ];
  function buildFeaturePopup(f, cfg) {
    const bits = [];
    if (typeof f.elev_m === "number" && f.elev_m > 0) {
      bits.push(`${Math.round(f.elev_m * 3.28084).toLocaleString()} ft`);
    }
    if (f.off > 0) bits.push(`${f.off}${f.off_dir} from trail`);
    if (f.parent_town) bits.push(`in ${escapeHtml(f.parent_town)}`);
    if (typeof f._mile === "number" && f._mile > 0) bits.push(`mi ${f._mile.toFixed(1)} from Springer`);
    if (f.state) bits.push(escapeHtml(f.state));
    return (
      `<div class="feat-popup">` +
      `<strong>${cfg.emoji} ${escapeHtml(f.name)}</strong>` +
      (bits.length ? `<br><small style="color:var(--muted);">${bits.join(" · ")}</small>` : "") +
      `</div>`
    );
  }
  function buildFeatureLayers() {
    if (!FEATURES || !FEATURES.features) return;
    // Tear down any existing layers (e.g. on data reload)
    for (const lg of featureLayerGroups.values()) {
      try { map.removeLayer(lg); } catch (e) {}
      if (layerControl) try { layerControl.removeLayer(lg); } catch (e) {}
    }
    featureLayerGroups.clear();
    const cfgByKind = new Map(FEATURE_KIND_CONFIG.map((c) => [c.kind, c]));
    for (const cfg of FEATURE_KIND_CONFIG) {
      featureLayerGroups.set(cfg.kind, L.layerGroup());
    }
    for (const f of FEATURES.features) {
      if (typeof f.lat !== "number" || typeof f.lon !== "number") continue;
      const cfg = cfgByKind.get(f.kind);
      if (!cfg) continue;
      const icon = L.divIcon({
        html: `<span class="feat-emoji">${cfg.emoji}</span>`,
        className: "feat-marker",
        iconSize: [22, 22],
        iconAnchor: [11, 22],
      });
      const m = L.marker([f.lat, f.lon], { icon, riseOnHover: true, keyboard: false });
      m.bindPopup(buildFeaturePopup(f, cfg), { autoPan: true, maxWidth: 260 });
      m.feature = f; // for click handlers
      m.addTo(featureLayerGroups.get(f.kind));
    }
    // Register with the layer control + apply default visibility
    for (const cfg of FEATURE_KIND_CONFIG) {
      const lg = featureLayerGroups.get(cfg.kind);
      const count = lg.getLayers().length;
      if (cfg.defaultOn) lg.addTo(map);
      if (layerControl) layerControl.addOverlay(lg, `${cfg.emoji} ${cfg.label} (${count})`);
    }
  }
  // Find a feature in our index by id and zoom to it on the map, opening popup.
  function focusFeatureOnMap(featureId) {
    const f = featureById.get(featureId);
    if (!f) return;
    const lg = featureLayerGroups.get(f.kind);
    if (lg && !map.hasLayer(lg)) lg.addTo(map);
    map.setView([f.lat, f.lon], Math.max(map.getZoom(), 13), { animate: true });
    if (lg) {
      lg.eachLayer((m) => {
        if (m.feature && m.feature.id === f.id) m.openPopup();
      });
    }
  }
  // Zoom to a segment by id and pulse-highlight the sidebar row.
  function focusSegmentOnMap(segId) {
    const layer = segLayers.get(segId);
    if (!layer) return;
    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 14 });
    const el = document.querySelector(`[data-seg="${segId}"]`);
    if (el) {
      const stateEl = el.closest(".state");
      if (stateEl) {
        stateEl.classList.remove("collapsed");
        openStates.add(stateEl.dataset.state);
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("map-hover");
      setTimeout(() => el.classList.remove("map-hover"), 1500);
    }
  }
  // -------- Global search --------
  let searchActive = -1; // index in current search-results list
  function openSearch() {
    const ov = $("search-overlay");
    if (!ov) return;
    ov.classList.add("show");
    const inp = $("search-input");
    inp.value = "";
    renderSearchResults("");
    setTimeout(() => inp.focus(), 0);
  }
  function closeSearch() {
    const ov = $("search-overlay");
    if (ov) ov.classList.remove("show");
    searchActive = -1;
  }
  function searchAll(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const results = [];
    const score = (text) => {
      const t = text.toLowerCase();
      if (!t.includes(q)) return null;
      // Higher score = better
      let s = 0;
      if (t === q) s += 100;
      if (t.startsWith(q)) s += 50;
      // Word-start match
      const words = t.split(/\s+/);
      if (words.some((w) => w.startsWith(q))) s += 25;
      // Inverse length penalty (shorter names rank higher when same prefix)
      s -= Math.min(20, t.length / 4);
      return s;
    };
    // Features
    if (FEATURES) {
      for (const f of FEATURES.features) {
        const s = score(f.name);
        if (s == null) continue;
        const cfg = FEATURE_KIND_CONFIG.find((c) => c.kind === f.kind);
        const ctxBits = [];
        if (f.parent_town) ctxBits.push(f.parent_town);
        if (typeof f._mile === "number" && f._mile > 0) ctxBits.push(`mi ${f._mile.toFixed(0)}`);
        results.push({
          score: s,
          icon: cfg ? cfg.emoji : "📍",
          name: f.name,
          ctx: ctxBits.join(" · "),
          action: () => { closeSearch(); focusFeatureOnMap(f.id); },
        });
      }
    }
    // Lore
    for (const entry of LORE) {
      const s = score(entry.title);
      if (s == null) continue;
      results.push({
        score: s + 10, // small boost — curated content is high-value
        icon: "ℹ",
        name: entry.title,
        ctx: "lore",
        action: () => {
          closeSearch();
          map.setView([entry.lat, entry.lon], 13, { animate: true });
        },
      });
    }
    // Segments by from/to name
    if (DATA && DATA.segments) {
      for (const seg of DATA.segments) {
        const s = Math.max(score(seg.from) || -Infinity, score(seg.to) || -Infinity);
        if (!isFinite(s)) continue;
        const cumStart = segCumulative.get(seg.id) || 0;
        results.push({
          score: s - 5, // slight penalty so feature names tend to win
          icon: "🥾",
          name: `${seg.from} → ${seg.to}`,
          ctx: `${seg.state} · mi ${cumStart.toFixed(0)}`,
          action: () => { closeSearch(); focusSegmentOnMap(seg.id); },
        });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 30);
  }
  function renderSearchResults(q) {
    const out = $("search-results");
    if (!out) return;
    const results = searchAll(q);
    if (!q) {
      out.innerHTML = `<div style="padding: 16px 10px; color: var(--muted); font-size: 13px;">Try: McAfee Knob, Hot Springs, Damascus, Mt Washington, Roan, Springer…</div>`;
      searchActive = -1;
      return;
    }
    if (results.length === 0) {
      out.innerHTML = `<div style="padding: 16px 10px; color: var(--muted); font-size: 13px;">No matches for "${escapeHtml(q)}"</div>`;
      searchActive = -1;
      return;
    }
    out.innerHTML = results.map((r, i) =>
      `<div class="row${i === 0 ? " active" : ""}" data-search-idx="${i}">` +
      `<span class="icon">${r.icon}</span>` +
      `<span class="name">${escapeHtml(r.name)}</span>` +
      `<span class="ctx">${escapeHtml(r.ctx || "")}</span>` +
      `</div>`
    ).join("");
    searchActive = 0;
    // Wire click handlers
    out.querySelectorAll(".row").forEach((row, i) => {
      row.addEventListener("click", () => results[i].action());
    });
    // Stash for keyboard nav
    out._results = results;
  }
  function searchKeyDown(e) {
    const out = $("search-results");
    const results = out && out._results;
    if (!results || results.length === 0) {
      if (e.key === "Escape") closeSearch();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      searchActive = Math.min(results.length - 1, searchActive + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      searchActive = Math.max(0, searchActive - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[searchActive]) results[searchActive].action();
      return;
    } else if (e.key === "Escape") {
      closeSearch();
      return;
    } else {
      return;
    }
    out.querySelectorAll(".row").forEach((row, i) => {
      row.classList.toggle("active", i === searchActive);
      if (i === searchActive) row.scrollIntoView({ block: "nearest" });
    });
  }
  // -------- Lore --------
  function attachLoreToSegments() {
    loreBySegId.clear();
    if (!LORE || LORE.length === 0) return;
    const MAX_KM = 1.0;
    for (const entry of LORE) {
      if (typeof entry.lat !== "number" || typeof entry.lon !== "number") continue;
      let bestSeg = null, bestKm = Infinity;
      for (const seg of DATA.segments) {
        for (const [lon, lat] of seg.geom) {
          const lat0 = ((lat + entry.lat) * 0.5) * Math.PI / 180;
          const dx = (lon - entry.lon) * 111.32 * Math.cos(lat0);
          const dy = (lat - entry.lat) * 110.574;
          const km = Math.sqrt(dx * dx + dy * dy);
          if (km < bestKm) { bestKm = km; bestSeg = seg; }
        }
      }
      if (bestSeg && bestKm <= MAX_KM) {
        if (!loreBySegId.has(bestSeg.id)) loreBySegId.set(bestSeg.id, []);
        loreBySegId.get(bestSeg.id).push(entry);
      }
    }
  }
  function drawLoreOnMap() {
    if (loreLayer) {
      try { map.removeLayer(loreLayer); } catch (e) {}
    }
    loreLayer = L.layerGroup();
    for (const entry of LORE) {
      if (typeof entry.lat !== "number" || typeof entry.lon !== "number") continue;
      const icon = L.divIcon({
        className: "lore-marker",
        html: '<div style="font-size:14px;line-height:1;background:#fff;border:1.5px solid #c89441;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;color:#a07020;font-weight:700;box-shadow:0 1px 3px rgba(0,0,0,.3);">i</div>',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      const m = L.marker([entry.lat, entry.lon], { icon });
      const safeBody = escapeHtml(entry.body || "");
      const safeTitle = escapeHtml(entry.title || "");
      const urlHtml = entry.url
        ? `<br><a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener" style="font-size:11px;">More on Wikipedia →</a>`
        : "";
      m.bindPopup(`<strong>${safeTitle}</strong><br><span style="font-style:italic">${safeBody}</span>${urlHtml}`, { maxWidth: 280 });
      m.addTo(loreLayer);
    }
    loreLayer.addTo(map);
  }
  function loreButtonHTML(segId) {
    const entries = loreBySegId.get(segId);
    if (!entries || entries.length === 0) return "";
    return `<button class="lore-btn" data-lore="${segId}" title="${escapeHtml(entries[0].title)}" aria-label="Show local history note">i</button>`;
  }
  function loreRowHTML(segId) {
    const entries = loreBySegId.get(segId);
    if (!entries || entries.length === 0) return "";
    const parts = entries.map((entry) => {
      const url = entry.url ? `<a class="lore-url" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">More →</a>` : "";
      return `<span class="lore-title">${escapeHtml(entry.title)}</span><span class="lore-body">${escapeHtml(entry.body)}</span> ${url}`;
    });
    return `<div class="lore-row">${parts.join("<hr style='border:0;border-top:1px dashed var(--rule);margin:6px 0;'/>")}</div>`;
  }

  function segRowHTML(seg, reverse, totalMi) {
    const hiked = progress.has(seg.id);
    const date = progress.get(seg.id) || "";
    const note = notes.get(seg.id) || "";
    const cumStart = segCumulative.get(seg.id) || 0;
    const displayMi = reverse ? (totalMi - (cumStart + seg.miles)) : cumStart;
    const isPlanned = planned.has(seg.id);
    const today = todayISO();
    return `<div class="seg${hiked ? " hiked" : ""}${isPlanned ? " planned" : ""}" data-seg="${seg.id}">` +
      `<input type="checkbox" data-toggle="${seg.id}" ${hiked ? "checked" : ""} title="Click to mark hiked; shift-click (or use Multi-select) to mark a range" aria-label="Mark ${escapeHtml(seg.from)} to ${escapeHtml(seg.to)} as hiked"/>` +
      `<div class="name">${escapeHtml(seg.from)}<span class="arrow">→</span>${escapeHtml(seg.to)}</div>` +
      `<div class="miles"><span class="miles-text">${seg.miles.toFixed(1)} mi<span class="cum">@ ${displayMi.toFixed(1)} mi</span></span>` +
      `<button class="plan-btn" data-plan="${seg.id}" title="${isPlanned ? "Remove from planned" : "Mark as next planned hike"}" aria-label="${isPlanned ? "Remove from planned" : "Mark as planned"}" aria-pressed="${isPlanned}"><svg viewBox="0 0 16 16" fill="${isPlanned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 1.5h8v13l-4-2.5-4 2.5z"/></svg></button>` +
      `<button class="zoom-btn" data-zoom="${seg.id}" title="Zoom map to this section" aria-label="Zoom to section"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M6.5 3a.5.5 0 0 1 .5.5V6h2.5a.5.5 0 0 1 0 1H7v2.5a.5.5 0 0 1-1 0V7H3.5a.5.5 0 0 1 0-1H6V3.5a.5.5 0 0 1 .5-.5"/></svg></button>` +
      loreButtonHTML(seg.id) +
      `</div>` +
      `<div class="date-row"><label style="font-size:12px;color:var(--muted)">Date:</label><input type="date" data-date="${seg.id}" value="${escapeHtml(date)}" max="${today}" /></div>` +
      `<div class="notes-row"><textarea data-note="${seg.id}" placeholder="Notes (weather, who you hiked with, conditions…)" rows="1">${escapeHtml(note)}</textarea></div>` +
      loreRowHTML(seg.id) +
      `</div>`;
  }
  function updateSegRowInPlace(id) {
    const el = document.querySelector(`[data-seg="${id}"]`);
    if (!el) return;
    const seg = segIndex.get(id);
    if (!seg) return;
    const totalMi = DATA.segments.reduce((a, s) => a + s.miles, 0);
    const reverse = prefs.direction === "sobo";
    el.outerHTML = segRowHTML(seg, reverse, totalMi);
  }
  function renderSections() {
    if (prefs.viewMode === "trip") return renderTripView();
    const filterText = filterEl.value.trim().toLowerCase();
    const onlyHiked = filterHikedEl.checked;
    const onlyPlanned = filterPlannedEl?.checked;
    const reverse = prefs.direction === "sobo";

    const segsByState = new Map();
    for (const seg of DATA.segments) {
      const k = effectiveStateName(seg);
      if (!segsByState.has(k)) segsByState.set(k, []);
      segsByState.get(k).push(seg);
    }
    if (reverse) {
      for (const list of segsByState.values()) list.reverse();
    }

    // Build the sidebar state list, expanding combined OSM relations into
    // their constituent states so the listing shows 14 rows instead of 12.
    const expandedStates = [];
    for (const st of [...DATA.states].sort((a, b) => a.order - b.order)) {
      if (st.name === "North Carolina/Tennessee") {
        const ncMi = (segsByState.get("North Carolina") || []).reduce((a, s) => a + s.miles, 0);
        const tnMi = (segsByState.get("Tennessee") || []).reduce((a, s) => a + s.miles, 0);
        expandedStates.push({ name: "North Carolina", order: st.order, miles: ncMi });
        expandedStates.push({ name: "Tennessee", order: st.order + 0.5, miles: tnMi });
      } else if (st.name === "New Jersey/New York") {
        const njMi = (segsByState.get("New Jersey") || []).reduce((a, s) => a + s.miles, 0);
        const nyMi = (segsByState.get("New York") || []).reduce((a, s) => a + s.miles, 0);
        expandedStates.push({ name: "New Jersey", order: st.order, miles: njMi });
        expandedStates.push({ name: "New York", order: st.order + 0.5, miles: nyMi });
      } else {
        expandedStates.push(st);
      }
    }
    const orderedStates = expandedStates.sort((a, b) => (reverse ? b.order - a.order : a.order - b.order));
    const totalMi = DATA.segments.reduce((a, s) => a + s.miles, 0);
    const html = [];
    for (const st of orderedStates) {
      const segs = segsByState.get(st.name) || [];
      const visible = segs.filter((seg) => {
        if (onlyHiked && !progress.has(seg.id)) return false;
        if (onlyPlanned && !planned.has(seg.id)) return false;
        if (!filterText) return true;
        return (
          (seg.from || "").toLowerCase().includes(filterText) ||
          (seg.to || "").toLowerCase().includes(filterText) ||
          (seg.state || "").toLowerCase().includes(filterText)
        );
      });
      if (visible.length === 0 && (filterText || onlyHiked || onlyPlanned)) continue;
      const hikedCount = segs.filter((s) => progress.has(s.id)).length;
      const hikedMi = segs.filter((s) => progress.has(s.id)).reduce((a, s) => a + s.miles, 0);
      const totalStateMi = segs.reduce((a, s) => a + s.miles, 0);
      const expandedByFilter = !!(filterText || onlyHiked || onlyPlanned);
      const isOpen = expandedByFilter || openStates.has(st.name);
      const collapsedClass = isOpen ? "" : " collapsed";
      const CHUNK_SIZE = 30;
      const useChunks = visible.length > CHUNK_SIZE && !filterText && !onlyHiked && !onlyPlanned;
      html.push(`<section class="state${collapsedClass}" data-state="${escapeHtml(st.name)}">`);
      html.push(`<header class="state-header">`);
      html.push(`<svg class="caret" viewBox="0 0 12 12" fill="currentColor"><path d="M3 4.5l3 3 3-3"/></svg>`);
      html.push(stateFlagsHTML(st.name));
      html.push(`<span>${escapeHtml(st.name)}</span>`);
      html.push(`<span class="state-stats"><span class="done">${hikedCount}</span>/${segs.length} · ${hikedMi.toFixed(1)}/${totalStateMi.toFixed(1)} mi</span>`);
      html.push(`<span class="state-actions">`);
      // Show ✓ all only if there's anything left to mark, ✕ all only if
      // there's anything to clear. Both visible when the state is mixed.
      if (hikedCount < segs.length) {
        html.push(`<button class="state-bulk-btn" data-bulk-state="${escapeHtml(st.name)}" title="Mark all sections in ${escapeHtml(st.name)} as hiked" aria-label="Mark all in state hiked">✓ all</button>`);
      }
      if (hikedCount > 0) {
        html.push(`<button class="state-bulk-btn state-clear-btn" data-clear-state="${escapeHtml(st.name)}" title="Clear hiked status on every section in ${escapeHtml(st.name)}" aria-label="Clear all in state">✕ all</button>`);
      }
      html.push(`</span>`);
      html.push(`</header>`);
      html.push(`<div class="state-body">`);
      if (useChunks) {
        const chunks = [];
        for (let i = 0; i < visible.length; i += CHUNK_SIZE) {
          chunks.push(visible.slice(i, i + CHUNK_SIZE));
        }
        chunks.forEach((chunkSegs, ci) => {
          const chunkKey = `${st.name}::${ci}`;
          const chunkOpen = openChunks.has(chunkKey);
          const firstName = chunkSegs[0].from;
          const lastName = chunkSegs[chunkSegs.length - 1].to;
          const chunkMi = chunkSegs.reduce((a, s) => a + s.miles, 0);
          const chunkHikedMi = chunkSegs.filter((s) => progress.has(s.id)).reduce((a, s) => a + s.miles, 0);
          html.push(`<div class="chunk${chunkOpen ? "" : " collapsed"}" data-chunk="${escapeHtml(chunkKey)}">`);
          html.push(`<div class="chunk-header"><svg class="caret" viewBox="0 0 12 12" fill="currentColor"><path d="M3 4.5l3 3 3-3"/></svg>`);
          html.push(`<span>${escapeHtml(firstName.slice(0, 30))} → ${escapeHtml(lastName.slice(0, 30))}</span>`);
          html.push(`<span class="chunk-stats">${chunkHikedMi.toFixed(1)}/${chunkMi.toFixed(1)} mi</span></div>`);
          html.push(`<div class="chunk-body">`);
          for (const seg of chunkSegs) html.push(segRowHTML(seg, reverse, totalMi));
          html.push(`</div></div>`);
        });
      } else {
        for (const seg of visible) html.push(segRowHTML(seg, reverse, totalMi));
      }
      html.push(`</div></section>`);
    }
    sectionsEl.innerHTML = html.join("");
  }
  function updateStats() {
    const total = DATA.segments.length;
    const totalMi = DATA.segments.reduce((a, s) => a + s.miles, 0);
    const done = progress.size;
    let doneMi = 0;
    for (const id of progress.keys()) {
      const s = segIndex.get(id);
      if (s) doneMi += s.miles;
    }
    statSegs.textContent = done;
    statTotalSegs.textContent = total;
    statMiles.textContent = doneMi.toFixed(1);
    statTotalMiles.textContent = totalMi.toFixed(1);
    const pct = total > 0 ? (doneMi / totalMi) * 100 : 0;
    statPct.textContent = `${pct.toFixed(1)}%`;
    progressFill.style.width = `${pct}%`;
    let plannedMi = 0;
    for (const id of planned) {
      const s = segIndex.get(id);
      if (s && !progress.has(id)) plannedMi += s.miles;
    }
    const plannedCount = [...planned].filter((id) => !progress.has(id)).length;
    const plannedEl = $("stat-planned");
    if (plannedEl) {
      plannedEl.textContent = plannedCount > 0
        ? `· ${plannedCount} planned (${plannedMi.toFixed(1)} mi)`
        : "";
    }
  }

  // -------- Trip view --------
  function renderTripView() {
    const filterText = filterEl.value.trim().toLowerCase();
    // Group hiked segments by date.
    const byDate = new Map();
    for (const [id, date] of progress) {
      const seg = segIndex.get(id);
      if (!seg) continue;
      const key = date || "(no date)";
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key).push(seg);
    }
    // Sort each trip by id (south->north)
    for (const list of byDate.values()) list.sort((a, b) => a.id - b.id);
    // Sort dates: most recent first; "(no date)" sinks to bottom
    const dates = [...byDate.keys()].sort((a, b) => {
      if (a === "(no date)") return 1;
      if (b === "(no date)") return -1;
      return b.localeCompare(a);
    });
    if (dates.length === 0) {
      sectionsEl.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--muted); font-size: 13px;">
        No hiked sections yet. Switch back to "By state" to start marking sections.
      </div>`;
      return;
    }
    const html = [];
    for (const date of dates) {
      const segs = byDate.get(date);
      const visible = segs.filter((seg) => {
        if (!filterText) return true;
        return (
          (seg.from || "").toLowerCase().includes(filterText) ||
          (seg.to || "").toLowerCase().includes(filterText) ||
          (seg.state || "").toLowerCase().includes(filterText)
        );
      });
      if (visible.length === 0) continue;
      const totalMi = segs.reduce((a, s) => a + s.miles, 0);
      const states = [...new Set(segs.map((s) => s.state))];
      const niceDate = date === "(no date)" ? "(no date set)" : prettyDate(date);
      html.push(`<section class="state" data-state="trip:${escapeHtml(date)}">`);
      html.push(`<header class="state-header">`);
      html.push(`<svg class="caret" viewBox="0 0 12 12" fill="currentColor"><path d="M3 4.5l3 3 3-3"/></svg>`);
      html.push(`<span>${escapeHtml(niceDate)}</span>`);
      html.push(`<span class="state-stats">${segs.length} sec · ${totalMi.toFixed(1)} mi · ${escapeHtml(states.join(", "))}</span>`);
      html.push(`</header>`);
      html.push(`<div class="state-body">`);
      const today = todayISO();
      for (const seg of visible) {
        const note = notes.get(seg.id) || "";
        const cumStart = segCumulative.get(seg.id) || 0;
        html.push(`<div class="seg hiked" data-seg="${seg.id}">`);
        html.push(`<input type="checkbox" data-toggle="${seg.id}" checked />`);
        html.push(`<div class="name">${escapeHtml(seg.from)}<span class="arrow">→</span>${escapeHtml(seg.to)} <small style="color:var(--muted)">(${escapeHtml(seg.state)})</small></div>`);
        html.push(`<div class="miles">${seg.miles.toFixed(1)} mi<span class="cum">@ ${cumStart.toFixed(1)} mi</span></div>`);
        html.push(`<div class="date-row">`);
        html.push(`<label style="font-size:12px;color:var(--muted)">Date:</label>`);
        html.push(`<input type="date" data-date="${seg.id}" value="${escapeHtml(date === "(no date)" ? "" : date)}" max="${today}" />`);
        html.push(`</div>`);
        html.push(`<div class="notes-row"><textarea data-note="${seg.id}" placeholder="Notes (weather, who you hiked with, conditions…)" rows="1">${escapeHtml(note)}</textarea></div>`);
        html.push(`</div>`);
      }
      html.push(`</div></section>`);
    }
    sectionsEl.innerHTML = html.join("");
  }
  function prettyDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y) return iso;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  }

  // -------- Stats --------
  function computeStats() {
    const total = DATA.segments.length;
    const totalMi = DATA.segments.reduce((a, s) => a + s.miles, 0);
    const done = progress.size;
    const sortedHiked = [...progress.keys()]
      .map((id) => segIndex.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);
    const doneMi = sortedHiked.reduce((a, s) => a + s.miles, 0);

    // Longest unbroken stretch: walk all segments in id order, accumulate miles
    // for runs of consecutive hiked ids; track the longest run.
    const allInOrder = [...DATA.segments].sort((a, b) => a.id - b.id);
    let bestRunMi = 0, bestRunCount = 0;
    let curMi = 0, curCount = 0;
    for (const seg of allInOrder) {
      if (progress.has(seg.id)) { curMi += seg.miles; curCount++; }
      else { curMi = 0; curCount = 0; }
      if (curMi > bestRunMi) { bestRunMi = curMi; bestRunCount = curCount; }
    }

    // Per-date stats (= trips)
    const byDate = new Map();
    for (const [id, date] of progress) {
      const seg = segIndex.get(id);
      if (!seg) continue;
      const key = date || "";
      if (!byDate.has(key)) byDate.set(key, { mi: 0, count: 0 });
      const e = byDate.get(key);
      e.mi += seg.miles;
      e.count++;
    }
    const tripMiles = [...byDate.entries()].filter(([k]) => k).map(([, v]) => v.mi).sort((a, b) => a - b);
    const meanTrip = tripMiles.length ? tripMiles.reduce((a, b) => a + b, 0) / tripMiles.length : 0;
    const medianTrip = tripMiles.length
      ? (tripMiles.length % 2 === 1
        ? tripMiles[(tripMiles.length - 1) / 2]
        : (tripMiles[tripMiles.length / 2 - 1] + tripMiles[tripMiles.length / 2]) / 2)
      : 0;
    const longestTrip = tripMiles.length ? tripMiles[tripMiles.length - 1] : 0;
    const hikeDays = byDate.size - (byDate.has("") ? 1 : 0);

    // Year breakdown
    const byYear = new Map();
    for (const [id, date] of progress) {
      const seg = segIndex.get(id);
      if (!seg) continue;
      const year = date ? date.slice(0, 4) : "(no date)";
      if (!byYear.has(year)) byYear.set(year, 0);
      byYear.set(year, byYear.get(year) + seg.miles);
    }
    const yearRows = [...byYear.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    // States completed
    const stateProgress = new Map();
    for (const seg of DATA.segments) {
      if (!stateProgress.has(seg.state)) stateProgress.set(seg.state, { total: 0, done: 0 });
      const p = stateProgress.get(seg.state);
      p.total += seg.miles;
      if (progress.has(seg.id)) p.done += seg.miles;
    }
    const stateRows = [...stateProgress.entries()];
    const statesCompleted = stateRows.filter(([, p]) => p.done >= p.total - 0.05).length;

    return {
      total, totalMi, done, doneMi,
      bestRunMi, bestRunCount,
      hikeDays, meanTrip, medianTrip, longestTrip, tripCount: hikeDays,
      yearRows, stateRows, statesCompleted,
    };
  }
  function renderStats() {
    const s = computeStats();
    const pct = s.totalMi > 0 ? (s.doneMi / s.totalMi) * 100 : 0;
    const grid = (rows) => `<div class="stat-grid">${rows.map(([k, v]) => `<div class="label">${k}</div><div class="val">${v}</div>`).join("")}</div>`;
    const html = [];
    html.push(grid([
      ["Sections hiked", `${s.done} / ${s.total}`],
      ["Miles hiked", `${s.doneMi.toFixed(1)} / ${s.totalMi.toFixed(1)}`],
      ["Progress", `${pct.toFixed(1)}%`],
      ["States completed", `${s.statesCompleted} / ${s.stateRows.length}`],
    ]));
    html.push(`<h3>Trips</h3>`);
    html.push(grid([
      ["Hike days", s.hikeDays],
      ["Avg miles per trip", s.meanTrip.toFixed(1)],
      ["Median miles per trip", s.medianTrip.toFixed(1)],
      ["Longest trip", `${s.longestTrip.toFixed(1)} mi`],
      ["Longest unbroken stretch", `${s.bestRunMi.toFixed(1)} mi (${s.bestRunCount} sec)`],
    ]));
    if (s.yearRows.length > 0) {
      html.push(`<h3>By year</h3>`);
      const maxYearMi = Math.max(...s.yearRows.map(([, mi]) => mi));
      for (const [year, mi] of s.yearRows) {
        const w = maxYearMi > 0 ? (mi / maxYearMi) * 100 : 0;
        html.push(`<div class="year-row"><div>${escapeHtml(year)}</div><div class="bar-bg"><div class="bar-fill" style="width:${w}%"></div></div><div class="bar-num">${mi.toFixed(1)} mi</div></div>`);
      }
    }
    html.push(`<h3>By state</h3>`);
    const stateMaxMi = Math.max(...s.stateRows.map(([, p]) => p.total));
    for (const [state, p] of s.stateRows) {
      const w = stateMaxMi > 0 ? (p.done / stateMaxMi) * 100 : 0;
      const wTotal = stateMaxMi > 0 ? (p.total / stateMaxMi) * 100 : 0;
      html.push(`<div class="state-row"><div>${escapeHtml(state)}</div>` +
        `<div class="bar-bg" style="position:relative;">` +
        `<div class="bar-fill" style="width:${w}%"></div>` +
        `<div style="position:absolute;top:0;left:0;width:${wTotal}%;height:100%;border:1px solid var(--rule);box-sizing:border-box;border-radius:4px;pointer-events:none;"></div>` +
        `</div>` +
        `<div class="bar-num">${p.done.toFixed(1)}/${p.total.toFixed(1)}</div></div>`);
    }
    $("stats-profile-name").textContent = activeProfile;
    $("stats-body").innerHTML = html.join("");
    $("stats-modal").classList.add("show");
  }

  // -------- Planned summary --------
  // Classify a breakpoint name. Returns { kind, icon } where kind is one of
  // "shelter" | "road" | "border" | "landmark".
  function breakpointKind(name) {
    const n = String(name || "");
    if (/shelter|lean.?to|cabin|hut|campsite/i.test(n)) return { kind: "shelter", icon: "🛖" };
    if (/\(US\s|\(SR\s|\(VA\s|\(NC\s|\(TN\s|\(NY\s|\(VT\s|\(NH\s|\(ME\s|\(CT\s|\(MA\s|\(GA\s|\(PA\s|\(MD\s|\(WV\s|\(NJ\s|Highway|Pkwy|Parkway|Road|Avenue|Boulevard|Drive|Pike|Route\s|\bRd\b|\bSt\b|\bAve\b|Trail Crossing/i.test(n)) return { kind: "road", icon: "🛣️" };
    if (/(south end|north end)/i.test(n)) return { kind: "border", icon: "📍" };
    return { kind: "landmark", icon: "•" };
  }
  // Convert elevation feet per mile to a continuous 1.0-10.0 difficulty grade
  // calibrated to AT terrain. Bands and color picked to be readable at a glance
  // and to roughly match how seasoned AT hikers describe each tier.
  // Anchors:
  //   ft/mi   ->   grade   ->   label
  //     0           1.0         Flat
  //    50           2.0         Gentle
  //   100           3.0         Easy moderate
  //   175           4.5         Moderate
  //   275           6.0         Strenuous
  //   400           7.5         Very strenuous
  //   600           9.0         Brutal
  //  1000+         10.0         Extreme
  const DIFFICULTY_ANCHORS = [
    [0,    1.0],
    [50,   2.0],
    [100,  3.0],
    [175,  4.5],
    [275,  6.0],
    [400,  7.5],
    [600,  9.0],
    [1000, 10.0],
  ];
  function difficultyGrade(ftPerMi) {
    if (!isFinite(ftPerMi) || ftPerMi <= 0) return 1.0;
    for (let i = 0; i < DIFFICULTY_ANCHORS.length - 1; i++) {
      const [x0, y0] = DIFFICULTY_ANCHORS[i];
      const [x1, y1] = DIFFICULTY_ANCHORS[i + 1];
      if (ftPerMi <= x1) {
        const t = (ftPerMi - x0) / (x1 - x0);
        return Math.round((y0 + t * (y1 - y0)) * 10) / 10;
      }
    }
    return 10.0;
  }
  function difficultyLabel(grade) {
    if (grade < 2.0) return "Flat";
    if (grade < 3.0) return "Gentle";
    if (grade < 4.5) return "Easy moderate";
    if (grade < 6.0) return "Moderate";
    if (grade < 7.5) return "Strenuous";
    if (grade < 9.0) return "Very strenuous";
    if (grade < 10.0) return "Brutal";
    return "Extreme";
  }
  function difficultyColor(grade) {
    // Smooth gradient from green (1.0) -> yellow (5) -> orange (7.5) -> deep red (10)
    if (grade <= 5) {
      // 1.0-5.0: green to yellow
      const t = (grade - 1) / 4;
      const r = Math.round(90 + t * 165);
      const g = Math.round(140 - t * 20);
      const b = Math.round(60 - t * 30);
      return `rgb(${r}, ${g}, ${b})`;
    }
    if (grade <= 7.5) {
      // 5-7.5: yellow to orange
      const t = (grade - 5) / 2.5;
      const r = Math.round(255);
      const g = Math.round(120 - t * 50);
      const b = Math.round(30 - t * 20);
      return `rgb(${r}, ${g}, ${b})`;
    }
    // 7.5-10: orange to deep red
    const t = (grade - 7.5) / 2.5;
    const r = Math.round(255 - t * 100);
    const g = Math.round(70 - t * 50);
    const b = Math.round(10);
    return `rgb(${r}, ${g}, ${b})`;
  }
  function stressLevel(ftPerMi) {
    const grade = difficultyGrade(ftPerMi);
    return {
      grade,
      label: difficultyLabel(grade),
      color: difficultyColor(grade),
    };
  }
  // Render a small color-graded bar with a numeric label, e.g. "7.2/10".
  // Walk the planned route mile by mile, distributing each segment's
  // climb-per-mile across the buckets it overlaps. Returns an array of
  // {startMi, widthMi, ftPerMi} objects, one per bucket.
  function bucketizeDifficulty(plannedSegs, bucketMi) {
    const totalMi = plannedSegs.reduce((a, s) => a + s.miles, 0);
    if (totalMi <= 0) return [];
    const n = Math.max(1, Math.ceil(totalMi / bucketMi));
    const buckets = Array.from({ length: n }, () => ({ mi: 0, ft: 0 }));
    let cum = 0;
    for (const s of plannedSegs) {
      const segStart = cum;
      const segEnd = cum + s.miles;
      const totalFt = (s.elev_gain || 0) + (s.elev_loss || 0);
      const ftPerMi = s.miles > 0 ? totalFt / s.miles : 0;
      const startBi = Math.floor(segStart / bucketMi);
      const endBi = Math.min(n - 1, Math.max(startBi, Math.floor((segEnd - 1e-6) / bucketMi)));
      for (let bi = startBi; bi <= endBi; bi++) {
        const ba = bi * bucketMi;
        const bb = ba + bucketMi;
        const overlap = Math.max(0, Math.min(bb, segEnd) - Math.max(ba, segStart));
        buckets[bi].mi += overlap;
        buckets[bi].ft += ftPerMi * overlap;
      }
      cum = segEnd;
    }
    return buckets.map((b, i) => ({
      startMi: i * bucketMi,
      widthMi: b.mi,
      ftPerMi: b.mi > 0 ? b.ft / b.mi : 0,
    }));
  }
  // SVG bar chart of per-mile difficulty for a planned trip. One bar per
  // mile (or 2/5/10-mile bucket for longer trips). Bar height = ft/mi,
  // bar color = difficulty grade gradient, hover tooltip shows the range.
  function renderDifficultyChart(plannedSegs) {
    const totalMi = plannedSegs.reduce((a, s) => a + s.miles, 0);
    if (totalMi <= 0) return "";
    // Adaptive bucket so we always fit ~30-100 bars
    let bucketMi = 1;
    if (totalMi > 50) bucketMi = 2;
    if (totalMi > 200) bucketMi = 5;
    if (totalMi > 600) bucketMi = 10;
    const buckets = bucketizeDifficulty(plannedSegs, bucketMi);
    if (buckets.length === 0) return "";
    const peakFt = Math.max(0, ...buckets.map((b) => b.ftPerMi));
    // Cap y-axis at sensible AT scales: 800 default, more if trip has >800
    const yMax = Math.max(800, peakFt * 1.1);

    const W = 560;
    const H = 130;
    const padL = 36;
    const padR = 8;
    const padT = 10;
    const padB = 24;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const barW = innerW / buckets.length;
    const bars = buckets.map((b, i) => {
      const x = padL + i * barW;
      const h = (b.ftPerMi / yMax) * innerH;
      const y = padT + innerH - h;
      const grade = difficultyGrade(b.ftPerMi);
      const color = difficultyColor(grade);
      const lo = b.startMi.toFixed(0);
      const hi = (b.startMi + bucketMi).toFixed(0);
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(0.5, barW - 0.4).toFixed(2)}" height="${Math.max(0, h).toFixed(2)}" fill="${color}"><title>Mile ${lo}–${hi}: ${Math.round(b.ftPerMi)} ft/mi (grade ${grade.toFixed(1)} ${difficultyLabel(grade)})</title></rect>`;
    }).join("");
    // Y-axis grid lines + labels
    const yMarks = [];
    for (const v of [200, 400, 600, 800, 1000].filter((v) => v <= yMax)) {
      const y = padT + innerH - (v / yMax) * innerH;
      yMarks.push(`<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--rule)" stroke-width="0.5" stroke-dasharray="2,2"/>`);
      yMarks.push(`<text x="${padL - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${v}</text>`);
    }
    // X-axis labels: start, 25/50/75%, end
    const xLabels = [];
    const xPoints = totalMi <= 8 ? [0, totalMi] : [0, totalMi * 0.25, totalMi * 0.5, totalMi * 0.75, totalMi];
    for (const mi of xPoints) {
      const x = padL + (mi / totalMi) * innerW;
      xLabels.push(`<text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="var(--muted)">${mi.toFixed(0)}</text>`);
    }
    xLabels.push(`<text x="${(W - padR - 4).toFixed(1)}" y="${(H - 1).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--muted)">mi</text>`);
    // Y-axis title
    const yTitle = `<text x="4" y="${(padT + 6).toFixed(1)}" font-size="9" fill="var(--muted)">ft/mi</text>`;
    return (
      `<div class="diff-chart-wrap"><svg class="diff-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">` +
      yMarks.join("") +
      bars +
      xLabels.join("") +
      yTitle +
      `</svg>` +
      `<div class="diff-chart-cap">Each bar = ${bucketMi} mi · hover for details</div>` +
      `</div>`
    );
  }
  function difficultyBadgeHTML(ftPerMi, opts) {
    const o = opts || {};
    const stress = stressLevel(ftPerMi);
    const widthPct = (stress.grade / 10) * 100;
    const sizes = o.compact
      ? { barW: 36, h: 4, font: 10 }
      : { barW: 70, h: 6, font: 11 };
    return (
      `<span class="diff-badge" title="${stress.label} — ${Math.round(ftPerMi)} ft/mi">` +
      `<span class="diff-bar" style="width:${sizes.barW}px;height:${sizes.h}px;">` +
        `<span class="diff-fill" style="width:${widthPct}%;background:${stress.color};"></span>` +
      `</span>` +
      `<span class="diff-num" style="font-size:${sizes.font}px;color:${stress.color};">${stress.grade.toFixed(1)}</span>` +
      `</span>`
    );
  }
  // Collect all wikitrail features whose nearest segment is in the planned set.
  // Returns { kind: [features], ... }, deduped by feature id, sorted by mile.
  function collectPlannedFeatures(plannedSegs) {
    const buckets = {};
    if (!FEATURES) return buckets;
    const seen = new Set();
    for (const s of plannedSegs) {
      const fs = segFeatures.get(s.id);
      if (!fs) continue;
      for (const f of fs) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        if (!buckets[f.kind]) buckets[f.kind] = [];
        buckets[f.kind].push(f);
      }
    }
    for (const kind in buckets) {
      buckets[kind].sort((a, b) => (a._mile || 0) - (b._mile || 0));
    }
    return buckets;
  }
  // Build the human-readable context string for a feature chip:
  // - peaks/views: "(6,289 ft) · mi 1856"
  // - towns/businesses with off-trail offset: "0.5W · in Pearisburg, VA · mi 638"
  // - everything else: "mi 1234"
  function featureContextHTML(f) {
    const bits = [];
    if (typeof f.elev_m === "number" && f.elev_m > 0) {
      const ft = Math.round(f.elev_m * 3.28084);
      bits.push(`${ft.toLocaleString()} ft`);
    }
    if (f.off > 0) bits.push(`${f.off}${f.off_dir}`);
    if (f.parent_town) bits.push(`in ${escapeHtml(f.parent_town)}`);
    if (typeof f._mile === "number" && f._mile > 0) bits.push(`mi ${f._mile.toFixed(0)}`);
    return bits.length ? ` <small style="color:var(--muted);">${bits.join(" · ")}</small>` : "";
  }
  function renderPlannedSummary() {
    const plannedSegs = [...planned]
      .filter((id) => !progress.has(id))
      .map((id) => segIndex.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);

    const totalMi = plannedSegs.reduce((a, s) => a + s.miles, 0);
    const states = [...new Set(plannedSegs.map((s) => s.state))];
    const gain = plannedSegs.reduce((a, s) => a + (s.elev_gain || 0), 0);
    const loss = plannedSegs.reduce((a, s) => a + (s.elev_loss || 0), 0);
    const hasElev = plannedSegs.some((s) => typeof s.elev_gain === "number");
    const ftPerMi = hasElev && totalMi > 0 ? (gain + loss) / totalMi : 0;
    const stress = stressLevel(ftPerMi);

    // Endpoints classified by kind, with cumulative mile from southern terminus.
    const endpoints = new Map(); // name -> {kind, icon, mile}
    for (const s of plannedSegs) {
      const startMi = segCumulative.get(s.id) || 0;
      if (!endpoints.has(s.from)) endpoints.set(s.from, { ...breakpointKind(s.from), mile: startMi });
      if (!endpoints.has(s.to)) endpoints.set(s.to, { ...breakpointKind(s.to), mile: startMi + s.miles });
    }
    const shelters = [...endpoints].filter(([, v]) => v.kind === "shelter").sort((a, b) => a[1].mile - b[1].mile).map(([n, v]) => ({name: n, mile: v.mile}));
    const roads = [...endpoints].filter(([, v]) => v.kind === "road").sort((a, b) => a[1].mile - b[1].mile).map(([n, v]) => ({name: n, mile: v.mile}));

    // Pace (mi/day) — persist user's preference across reloads.
    const pace = Math.max(1, Math.min(50, Number(prefs.pace) || 12));
    const estDays = totalMi > 0 ? Math.max(1, Math.round(totalMi / pace)) : 0;

    // Contiguous runs of planned segments
    const sortedIds = plannedSegs.map((s) => s.id).sort((a, b) => a - b);
    const allOrdered = [...DATA.segments].sort((a, b) => a.id - b.id);
    const idIndex = new Map(allOrdered.map((s, i) => [s.id, i]));
    const runs = [];
    let runStart = null, runEnd = null, runMi = 0;
    for (const id of sortedIds) {
      const idx = idIndex.get(id);
      const seg = segIndex.get(id);
      if (runStart === null) { runStart = idx; runEnd = idx; runMi = seg.miles; continue; }
      if (idx === runEnd + 1) { runEnd = idx; runMi += seg.miles; }
      else {
        runs.push({ start: runStart, end: runEnd, mi: runMi });
        runStart = idx; runEnd = idx; runMi = seg.miles;
      }
    }
    if (runStart !== null) runs.push({ start: runStart, end: runEnd, mi: runMi });

    const grid = (rows) => `<div class="stat-grid">${rows.map(([k, v]) => `<div class="label">${k}</div><div class="val">${v}</div>`).join("")}</div>`;
    const html = [];
    // Trip selector + new/rename/delete actions (always shown so user can create one)
    {
      const t = getActiveTrip();
      html.push(`<div class="trip-control">`);
      html.push(`<label>Trip: <select id="trip-select" title="Choose a saved planned trip">`);
      if (trips.length === 0) {
        html.push(`<option value="">(none)</option>`);
      } else {
        for (const tt of trips) {
          html.push(`<option value="${escapeHtml(tt.id)}"${tt.id === activeTripId ? " selected" : ""}>${escapeHtml(tt.name)} · ${tt.segs.length} sec</option>`);
        }
      }
      html.push(`</select></label>`);
      html.push(`<button id="trip-new" title="Save current planned set as a new trip">+ New</button>`);
      if (t) {
        html.push(`<button id="trip-rename" title="Rename current trip">✎</button>`);
        html.push(`<button id="trip-delete" title="Delete current trip">✕</button>`);
      }
      html.push(`</div>`);
    }
    // Defined here so they're in scope for the post-render initial itinerary
    // calculation below (outside the `else` block).
    const startDate = prefs.tripStartDate || todayISO();
    const zeroFreq = prefs.zeroDayFreq != null ? prefs.zeroDayFreq : 0;

    if (plannedSegs.length === 0) {
      html.push(`<div class="empty">No planned segments yet. Click the flag icon next to any unhiked section to mark it as your next planned hike.</div>`);
    } else {
      const statsRows = [
        ["Sections", plannedSegs.length],
        ["Total miles", totalMi.toFixed(1)],
      ];
      if (hasElev) {
        statsRows.push(["Elevation gain", `+${Math.round(gain).toLocaleString()} ft`]);
        statsRows.push(["Elevation loss", `−${Math.round(loss).toLocaleString()} ft`]);
        statsRows.push(["Net elevation", `${gain > loss ? "+" : ""}${Math.round(gain - loss).toLocaleString()} ft`]);
        statsRows.push(["Climb per mile", `${Math.round(ftPerMi)} ft/mi`]);
      }
      statsRows.push(["States", states.join(", ") || "—"]);
      statsRows.push(["Shelters on route", shelters.length]);
      statsRows.push(["Road crossings on route", roads.length]);
      if (runs.length > 1) {
        statsRows.push(["Distinct stretches", runs.length]);
        statsRows.push(["Longest stretch", `${Math.max(...runs.map((r) => r.mi)).toFixed(1)} mi`]);
      }
      html.push(grid(statsRows));

      // Pace + estimated trip days. Live-recomputes when user changes pace.
      html.push(`<div class="pace-row">` +
        `<label>Pace: <input type="number" id="pace-input" min="1" max="40" step="0.5" value="${pace}" /> mi/day</label>` +
        `<label style="margin-left:6px;">Start: <input type="date" id="trip-start" value="${escapeHtml(startDate)}" /></label>` +
        `<label style="margin-left:6px;">Zero day every <input type="number" id="zero-freq" min="0" max="14" step="1" value="${zeroFreq}" style="width:48px;" /> days (0 = none)</label>` +
        `<span style="color:var(--muted);">→</span>` +
        `<span id="pace-out"><strong>${estDays}</strong> hike day${estDays === 1 ? "" : "s"}</span>` +
        `</div>`);

      // Difficulty bar (only when we have elevation)
      if (hasElev) {
        const widthPct = (stress.grade / 10) * 100;
        html.push(`<div class="diff-bar-row" style="border-color:${stress.color};">` +
          `<div class="grade" style="color:${stress.color};">${stress.grade.toFixed(1)}<span class="of">/10</span></div>` +
          `<div class="meta"><div class="label" style="color:${stress.color};">${stress.label}</div>` +
            `<div class="track"><div class="fill" style="width:${widthPct}%;background:${stress.color};"></div></div></div>` +
          `<div class="num">${Math.round(ftPerMi)} ft/mi</div>` +
          `</div>`);
      }

      // Per-mile difficulty bar chart
      if (hasElev) {
        html.push(`<h3>📊 Difficulty by mile</h3>`);
        html.push(renderDifficultyChart(plannedSegs));
      }

      // Sections — compact one-line-per-segment listing
      const showState = states.length > 1;
      html.push(`<h3>Sections (${plannedSegs.length})</h3>`);
      let cumMi = 0;
      for (const s of plannedSegs) {
        cumMi += s.miles;
        const fromKind = breakpointKind(s.from);
        const toKind = breakpointKind(s.to);
        const segGain = Math.round(s.elev_gain || 0);
        const segLoss = Math.round(s.elev_loss || 0);
        const segFtPerMi = s.miles > 0 ? (segGain + segLoss) / s.miles : 0;
        const segStress = stressLevel(segFtPerMi);
        const elevStr = hasElev ? `+${segGain.toLocaleString()}/−${segLoss.toLocaleString()}` : "";
        const stateSuffix = showState ? ` <small>· ${escapeHtml(s.state.replace("North Carolina/Tennessee", "NC/TN").replace("New Jersey/New York", "NJ/NY"))}</small>` : "";
        html.push(
          `<div class="seg-line">` +
          `<span class="seg-icons" title="${fromKind.kind} → ${toKind.kind}">${fromKind.icon}→${toKind.icon}</span>` +
          `<span class="seg-name" title="${escapeHtml(s.from)} → ${escapeHtml(s.to)}">${escapeHtml(s.from)} → ${escapeHtml(s.to)}${stateSuffix}</span>` +
          `<span class="mi">${s.miles.toFixed(1)} / ${cumMi.toFixed(1)}</span>` +
          (hasElev ? `<span class="seg-elev">${elevStr}</span>` : `<span></span>`) +
          (hasElev ? difficultyBadgeHTML(segFtPerMi, { compact: true }) : `<span></span>`) +
          `</div>`
        );
      }

      // Calendar / itinerary — day-by-day breakdown
      html.push(`<h3>📅 Day-by-day plan</h3>`);
      html.push(`<div id="planned-itinerary"></div>`);

      // Wikitrail features along the planned route (towns, resupply, maildrops...)
      const featureBuckets = collectPlannedFeatures(plannedSegs);
      const FEATURE_GROUPS = [
        { kind: "peak", emoji: "🏔", label: "Notable peaks" },
        { kind: "view", emoji: "🌄", label: "Viewpoints" },
        { kind: "town", emoji: "🏘️", label: "Towns" },
        { kind: "parking", emoji: "🅿️", label: "Trailhead parking" },
        { kind: "campsite", emoji: "⛺", label: "Campsites" },
        { kind: "bridge", emoji: "🌉", label: "Bridges" },
        { kind: "privy", emoji: "🚻", label: "Privies" },
        { kind: "maildrop", emoji: "📮", label: "Post offices / maildrops" },
        { kind: "resupply", emoji: "🏪", label: "Resupply (grocery / store)" },
        { kind: "outfitter", emoji: "🥾", label: "Outfitters" },
        { kind: "hostel", emoji: "🛏", label: "Hostels" },
        { kind: "hotel", emoji: "🏨", label: "Hotels / motels" },
        { kind: "restaurant", emoji: "🍽", label: "Restaurants / bars" },
        { kind: "service", emoji: "🚐", label: "Shuttles / laundry" },
        { kind: "medical", emoji: "🏥", label: "Medical" },
      ];
      for (const g of FEATURE_GROUPS) {
        const items = featureBuckets[g.kind];
        if (!items || items.length === 0) continue;
        html.push(`<h3>${g.emoji} ${g.label} (${items.length})</h3>`);
        html.push(`<div class="endpoints-list">${items.map((f) => {
          const titleBits = [];
          if (f.off > 0) titleBits.push(`${f.off}${f.off_dir} from trail`);
          if (f.parent_town) titleBits.push(`in ${f.parent_town}`);
          if (typeof f._mile === "number" && f._mile > 0) titleBits.push(`mile ${f._mile.toFixed(1)} from Springer`);
          const title = titleBits.join(" · ");
          return `<span class="ep" title="${escapeHtml(title)}">${g.emoji} ${escapeHtml(f.name)}${featureContextHTML(f)}</span>`;
        }).join("")}</div>`);
      }

      // Endpoint chips (from segment endpoints, not features)
      const epChip = (icon, item) => `<span class="ep" title="mile ${item.mile.toFixed(1)} from southern terminus">${icon} ${escapeHtml(item.name)} <small style="color:var(--muted);">mi ${item.mile.toFixed(0)}</small></span>`;
      if (shelters.length > 0) {
        html.push(`<h3>🛖 Shelters on route (${shelters.length})</h3>`);
        html.push(`<div class="endpoints-list">${shelters.map((s) => epChip("🛖", s)).join("")}</div>`);
      }
      if (roads.length > 0) {
        html.push(`<h3>🛣️ Road access points (${roads.length})</h3>`);
        html.push(`<div class="endpoints-list">${roads.map((s) => epChip("🛣️", s)).join("")}</div>`);
      }
      if (!hasElev) {
        html.push(`<h3>Note</h3>`);
        html.push(`<div style="font-size: 12px; color: var(--muted);">Elevation gain/loss not yet available — rebuild data with elevation enabled to add it.</div>`);
      }
    }
    $("planned-profile-name").textContent = activeProfile;
    $("planned-body").innerHTML = html.join("");
    $("planned-modal").classList.add("show");

    // Wire trip selector + actions (newly rendered)
    $("trip-select")?.addEventListener("change", (e) => {
      switchTrip(e.target.value);
      renderPlannedSummary();
    });
    $("trip-new")?.addEventListener("click", () => {
      const name = (prompt("Name this trip (e.g. 'Smokies 2025'):", `Trip ${trips.length + 1}`) || "").trim();
      if (!name) return;
      const t = { id: "trip-" + Date.now(), name, createdAt: Date.now(), segs: [...planned] };
      trips.push(t);
      activeTripId = t.id;
      saveTrips();
      renderPlannedSummary();
    });
    $("trip-rename")?.addEventListener("click", () => {
      const t = getActiveTrip();
      if (!t) return;
      const name = (prompt("Rename trip to:", t.name) || "").trim();
      if (!name || name === t.name) return;
      t.name = name;
      saveTrips();
      renderPlannedSummary();
    });
    $("trip-delete")?.addEventListener("click", () => {
      const t = getActiveTrip();
      if (!t) return;
      if (!confirm(`Delete trip "${t.name}"? This removes the saved trip but does not unmark any segments as planned.`)) return;
      const wasSegs = [...t.segs];
      trips = trips.filter((x) => x.id !== activeTripId);
      activeTripId = trips.length > 0 ? trips[0].id : null;
      // If no other trip exists, the planned set goes empty
      if (!activeTripId) planned = new Set();
      else syncPlannedFromActiveTrip();
      saveTrips();
      saveProgress();
      renderSections();
      updateStats();
      refreshMapStyles();
      renderPlannedSummary();
    });

    // Pin/unpin overnight stops in the calendar (delegated click)
    $("planned-itinerary")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pin-stop]");
      if (!btn) return;
      e.preventDefault();
      const stopName = btn.dataset.pinStop;
      const t = ensureActiveTrip();
      if (!Array.isArray(t.pins)) t.pins = [];
      const idx = t.pins.indexOf(stopName);
      if (idx >= 0) t.pins.splice(idx, 1);
      else t.pins.push(stopName);
      saveTrips();
      // Re-render only the calendar div
      const itEl = $("planned-itinerary");
      if (itEl) itEl.innerHTML = renderItineraryHTML(plannedSegs, pace, startDate, zeroFreq);
    });

    // Wire pace, start date, zero-day inputs — all live-recompute the itinerary
    const recomputeItinerary = () => {
      const v = Math.max(1, Math.min(50, Number($("pace-input").value) || 12));
      prefs.pace = v;
      const startEl = $("trip-start");
      if (startEl && startEl.value) prefs.tripStartDate = startEl.value;
      const zEl = $("zero-freq");
      if (zEl) prefs.zeroDayFreq = Math.max(0, Math.min(14, Number(zEl.value) || 0));
      savePrefs();
      const newDays = totalMi > 0 ? Math.max(1, Math.round(totalMi / v)) : 0;
      const out = $("pace-out");
      if (out) out.innerHTML = `<strong>${newDays}</strong> hike day${newDays === 1 ? "" : "s"}`;
      const ititem = $("planned-itinerary");
      if (ititem) ititem.innerHTML = renderItineraryHTML(plannedSegs, v, prefs.tripStartDate || todayISO(), prefs.zeroDayFreq || 0);
    };
    ["pace-input", "trip-start", "zero-freq"].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener("input", recomputeItinerary);
    });
    // Initial render of the calendar
    const itEl = $("planned-itinerary");
    if (itEl) itEl.innerHTML = renderItineraryHTML(plannedSegs, pace, startDate, zeroFreq);
  }
  // Build a day-by-day plan: walk planned segments in order, accumulating
  // miles up to `pace`. Prefer to stop at a shelter endpoint near the day's
  // target. Insert zero days at the configured frequency.
  function buildItinerary(plannedSegs, paceMi, startISO, zeroFreq, pinNames) {
    const days = [];
    const pinSet = new Set(pinNames || []);
    let curMi = 0;
    let curGain = 0;
    let curLoss = 0;
    let dayStart = plannedSegs.length > 0 ? plannedSegs[0].from : null;
    let segIdx = 0;
    let dayStartSegIdx = 0; // first plannedSegs index belonging to this day
    let consumedMiInCurSeg = 0; // miles used out of the current segment
    while (segIdx < plannedSegs.length) {
      // Pin check: if a pinned overnight stop is within 2.5x pace ahead,
      // force the day to end exactly there (override the algorithmic logic).
      let pinSegIdx = -1;
      {
        let aheadMi = -consumedMiInCurSeg;
        for (let i = segIdx; i < plannedSegs.length; i++) {
          const s = plannedSegs[i];
          aheadMi += s.miles;
          if (pinSet.has(s.to)) { pinSegIdx = i; break; }
          if (aheadMi > paceMi * 2.5) break;
        }
      }
      if (pinSegIdx >= 0) {
        let dayMi = 0, dayGain = 0, dayLoss = 0;
        for (let i = segIdx; i <= pinSegIdx; i++) {
          const s = plannedSegs[i];
          const consumed = (i === segIdx) ? (s.miles - consumedMiInCurSeg) : s.miles;
          dayMi += consumed;
          dayGain += (s.elev_gain || 0) * (consumed / s.miles);
          dayLoss += (s.elev_loss || 0) * (consumed / s.miles);
        }
        const lastSeg = plannedSegs[pinSegIdx];
        const k = breakpointKind(lastSeg.to);
        const daySegs = plannedSegs.slice(dayStartSegIdx, pinSegIdx + 1);
        days.push({
          from: dayStart,
          to: lastSeg.to,
          toIcon: k.icon,
          toKind: k.kind,
          miles: dayMi,
          gain: dayGain,
          loss: dayLoss,
          segs: daySegs,
          pinned: true,
        });
        dayStart = lastSeg.to;
        dayStartSegIdx = pinSegIdx + 1;
        segIdx = pinSegIdx + 1;
        consumedMiInCurSeg = 0;
        curMi += dayMi; curGain += dayGain; curLoss += dayLoss;
        continue;
      }
      const target = paceMi;
      // Walk forward until we hit target or run out of segments
      let dayMi = 0;
      let dayGain = 0;
      let dayLoss = 0;
      let dayEnd = null;
      let dayEndKind = null;
      // A list of (mi-into-day, segEndName, segEndKind, gainSoFar, lossSoFar, segIdxAfter)
      const candidateStops = [];
      while (segIdx < plannedSegs.length) {
        const s = plannedSegs[segIdx];
        const remaining = s.miles - consumedMiInCurSeg;
        if (dayMi + remaining < target - 0.01) {
          // Use this whole segment, not yet at target
          dayMi += remaining;
          dayGain += (s.elev_gain || 0) * (remaining / s.miles);
          dayLoss += (s.elev_loss || 0) * (remaining / s.miles);
          consumedMiInCurSeg = 0;
          segIdx++;
          const k = breakpointKind(s.to);
          candidateStops.push({
            mi: dayMi, gain: dayGain, loss: dayLoss,
            end: s.to, endKind: k.kind, endIcon: k.icon,
            segIdxAfter: segIdx,
          });
        } else {
          // We could finish this segment OR stop short. We prefer to finish at
          // a segment endpoint when it's reasonably close to target.
          const finishMi = dayMi + remaining;
          const overshoot = finishMi - target;
          // If overshooting <= 1.5 mi we'll just go to the segment end.
          if (overshoot <= 1.5) {
            dayMi = finishMi;
            dayGain += (s.elev_gain || 0) * (remaining / s.miles);
            dayLoss += (s.elev_loss || 0) * (remaining / s.miles);
            const k = breakpointKind(s.to);
            candidateStops.push({
              mi: dayMi, gain: dayGain, loss: dayLoss,
              end: s.to, endKind: k.kind, endIcon: k.icon,
              segIdxAfter: segIdx + 1,
            });
            consumedMiInCurSeg = 0;
            segIdx++;
          }
          break;
        }
      }
      // Pick the best candidate stop: prefer shelter endpoints close to target.
      let chosen = null;
      if (candidateStops.length > 0) {
        // Score: shelters preferred, then proximity to target.
        const scored = candidateStops.map((c) => ({
          ...c,
          score: (c.endKind === "shelter" ? 0 : c.endKind === "road" ? 0.3 : 0.6) +
                 Math.abs(c.mi - target) * 0.05,
        }));
        scored.sort((a, b) => a.score - b.score);
        chosen = scored[0];
      } else if (segIdx < plannedSegs.length) {
        // Couldn't even finish a single segment — split it (rare)
        const s = plannedSegs[segIdx];
        const usable = Math.min(target, s.miles - consumedMiInCurSeg);
        consumedMiInCurSeg += usable;
        dayMi = usable;
        dayGain = (s.elev_gain || 0) * (usable / s.miles);
        dayLoss = (s.elev_loss || 0) * (usable / s.miles);
        chosen = {
          mi: dayMi, gain: dayGain, loss: dayLoss,
          end: `mid-segment (${s.from} → ${s.to})`, endKind: "split", endIcon: "✂️",
          segIdxAfter: segIdx + (consumedMiInCurSeg >= s.miles ? 1 : 0),
        };
        if (consumedMiInCurSeg >= s.miles) { consumedMiInCurSeg = 0; segIdx++; }
      } else {
        break;
      }
      const daySegs = plannedSegs.slice(dayStartSegIdx, chosen.segIdxAfter);
      // If we split a segment, include the in-progress one for KML purposes
      if (daySegs.length === 0 && segIdx < plannedSegs.length) {
        daySegs.push(plannedSegs[segIdx]);
      }
      days.push({
        from: dayStart,
        to: chosen.end,
        toIcon: chosen.endIcon,
        toKind: chosen.endKind,
        miles: chosen.mi,
        gain: chosen.gain,
        loss: chosen.loss,
        segs: daySegs,
      });
      dayStartSegIdx = chosen.segIdxAfter;
      dayStart = chosen.end;
      curMi += chosen.mi;
      curGain += chosen.gain;
      curLoss += chosen.loss;
    }
    // Apply start date + zero days
    const out = [];
    let hikeDayCount = 0;
    let date = parseISODate(startISO);
    for (const d of days) {
      out.push({ kind: "hike", date: formatISODate(date), ...d });
      hikeDayCount++;
      // Advance one day
      date.setUTCDate(date.getUTCDate() + 1);
      // Insert a zero day if frequency hits
      if (zeroFreq > 0 && hikeDayCount % zeroFreq === 0) {
        out.push({ kind: "zero", date: formatISODate(date) });
        date.setUTCDate(date.getUTCDate() + 1);
      }
    }
    return out;
  }
  function parseISODate(s) {
    const [y, m, d] = (s || todayISO()).split("-").map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  }
  function formatISODate(d) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  function dayOfWeek(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" });
  }
  function renderItineraryHTML(plannedSegs, pace, startISO, zeroFreq) {
    if (plannedSegs.length === 0) return "";
    const t = getActiveTrip();
    const pins = t && Array.isArray(t.pins) ? t.pins : [];
    const itinerary = buildItinerary(plannedSegs, pace, startISO, zeroFreq, pins);
    const rows = [];
    let cumMi = 0, hikeNum = 0;
    for (const d of itinerary) {
      if (d.kind === "zero") {
        rows.push(
          `<div class="iti-row iti-zero"><span class="iti-day">${dayOfWeek(d.date)}</span>` +
          `<span class="iti-date">${escapeHtml(d.date)}</span>` +
          `<span class="iti-text">🛌 Zero day · rest in town</span><span></span></div>`
        );
      } else {
        hikeNum++;
        cumMi += d.miles;
        const dayFtPerMi = d.miles > 0 ? (d.gain + d.loss) / d.miles : 0;
        const isPinned = !!d.pinned;
        const pinTitle = isPinned ? "Pinned overnight stop — click to unpin" : "Pin this stop as a required overnight";
        rows.push(
          `<div class="iti-row${isPinned ? " iti-pinned" : ""}"><span class="iti-day">${dayOfWeek(d.date)}</span>` +
          `<span class="iti-date">${escapeHtml(d.date)}</span>` +
          `<span class="iti-text">Day ${hikeNum}: <strong>${escapeHtml(d.from)}</strong> → <strong>${d.toIcon} ${escapeHtml(d.to)}</strong> ` +
            `<button class="iti-pin${isPinned ? " on" : ""}" data-pin-stop="${escapeHtml(d.to)}" title="${pinTitle}" aria-label="${pinTitle}" aria-pressed="${isPinned}">📌</button>` +
          `</span>` +
          `<span class="iti-stats">${d.miles.toFixed(1)} mi · ${cumMi.toFixed(1)} cum · +${Math.round(d.gain)}/−${Math.round(d.loss)} ft ${difficultyBadgeHTML(dayFtPerMi, { compact: true })}</span>` +
          `</div>`
        );
      }
    }
    const hikeDays = itinerary.filter((d) => d.kind === "hike").length;
    const zeroDays = itinerary.filter((d) => d.kind === "zero").length;
    const totalDays = hikeDays + zeroDays;
    const summary = `<div class="iti-summary">${hikeDays} hike day${hikeDays === 1 ? "" : "s"}` +
      (zeroDays > 0 ? ` + ${zeroDays} zero day${zeroDays === 1 ? "" : "s"} = ${totalDays} total` : "") +
      `</div>`;
    return summary + rows.join("");
  }
  // Print just the planned modal: temporarily set a body class that the
  // CSS uses to hide everything else, fire window.print(), restore.
  function printPlannedView() {
    document.body.classList.add("print-plan");
    // Need the modal to be visible during print
    $("planned-modal").classList.add("show");
    // Most browsers fire print() synchronously; afterprint event lets us cleanup
    const cleanup = () => {
      document.body.classList.remove("print-plan");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    setTimeout(() => window.print(), 50);
  }
  // Build a plain-text summary of the active trip suitable for messaging apps.
  function planTextSummary(plannedSegs, itinerary) {
    const t = getActiveTrip();
    const totalMi = plannedSegs.reduce((a, s) => a + s.miles, 0);
    const gain = plannedSegs.reduce((a, s) => a + (s.elev_gain || 0), 0);
    const loss = plannedSegs.reduce((a, s) => a + (s.elev_loss || 0), 0);
    const ftPerMi = totalMi > 0 ? (gain + loss) / totalMi : 0;
    const stress = stressLevel(ftPerMi);
    const hikeDays = itinerary.filter((d) => d.kind === "hike").length;
    const zeroDays = itinerary.filter((d) => d.kind === "zero").length;
    const states = [...new Set(plannedSegs.map((s) => s.state))].join(", ");
    const lines = [];
    lines.push(`🥾 ${t ? t.name : "AT planned hike"}`);
    lines.push(`${totalMi.toFixed(1)} mi · ${hikeDays} hike day${hikeDays === 1 ? "" : "s"}` +
      (zeroDays > 0 ? ` + ${zeroDays} zero day${zeroDays === 1 ? "" : "s"}` : "") +
      ` · ${states}`);
    lines.push(`+${Math.round(gain).toLocaleString()} / −${Math.round(loss).toLocaleString()} ft (${stress.grade.toFixed(1)}/10 ${stress.label})`);
    if (itinerary.length > 0) {
      lines.push("");
      let n = 0;
      for (const d of itinerary) {
        if (d.kind === "zero") {
          lines.push(`  ${d.date}  Zero day · rest`);
        } else {
          n++;
          lines.push(`  ${d.date}  Day ${n}: ${d.from} → ${d.to}  ${d.miles.toFixed(1)} mi · +${Math.round(d.gain)}/−${Math.round(d.loss)} ft`);
        }
      }
    }
    return lines.join("\n");
  }
  // URL that opens the app with this trip pre-loaded as planned segments.
  function planShareURL() {
    const t = getActiveTrip();
    const planCode = encodePlanned(planned);
    const params = new URLSearchParams();
    if (planCode) params.set("pl", planCode);
    if (t) {
      params.set("plan_name", t.name);
    }
    if (prefs.tripStartDate) params.set("plan_start", prefs.tripStartDate);
    if (prefs.pace) params.set("plan_pace", String(prefs.pace));
    if (prefs.zeroDayFreq) params.set("plan_zero", String(prefs.zeroDayFreq));
    return `${location.origin}${location.pathname}#${params.toString()}`;
  }
  function openSharePlan() {
    const plannedSegs = [...planned]
      .filter((id) => !progress.has(id))
      .map((id) => segIndex.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);
    if (plannedSegs.length === 0) { alert("No planned segments to share."); return; }
    const pace = Math.max(1, Math.min(50, Number(prefs.pace) || 12));
    const startDate = prefs.tripStartDate || todayISO();
    const zeroFreq = Math.max(0, Math.min(14, Number(prefs.zeroDayFreq) || 0));
    const itinerary = buildItinerary(plannedSegs, pace, startDate, zeroFreq);
    $("share-plan-url").value = planShareURL();
    $("share-plan-text").value = planTextSummary(plannedSegs, itinerary);
    $("share-plan-modal").classList.add("show");
  }
  // Apply ?plan_name=... &plan_start=... &plan_pace=... from URL hash on load.
  // pl=... is already handled by loadPlannedForActive.
  function applyURLPlanMeta() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const planName = params.get("plan_name");
    const planStart = params.get("plan_start");
    const planPace = params.get("plan_pace");
    const planZero = params.get("plan_zero");
    if (!planName && !planStart && !planPace && !planZero) return;
    if (planStart) prefs.tripStartDate = planStart;
    if (planPace) prefs.pace = Math.max(1, Math.min(50, Number(planPace) || 12));
    if (planZero) prefs.zeroDayFreq = Math.max(0, Math.min(14, Number(planZero) || 0));
    savePrefs();
    if (planName && planned.size > 0) {
      // Save as a new trip
      const existing = trips.find((x) => x.name === planName);
      if (!existing) {
        const t = { id: "trip-" + Date.now(), name: planName, createdAt: Date.now(), segs: [...planned] };
        trips.push(t);
        activeTripId = t.id;
        saveTrips();
      }
    }
  }
  function clearAllPlanned() {
    if (planned.size === 0) return;
    if (!confirm(`Clear all ${planned.size} planned segments?`)) return;
    planned = new Set();
    saveProgress();
    renderSections();
    updateStats();
    refreshMapStyles();
    $("planned-modal").classList.remove("show");
  }
  function markPlannedAsHiked() {
    const todo = [...planned].filter((id) => !progress.has(id));
    if (todo.length === 0) return;
    pendingBulkRange = { ids: todo, checked: true };
    $("bulk-date-count").textContent = todo.length;
    $("bulk-date-input").value = todayISO();
    $("bulk-date-input").max = todayISO();
    $("planned-modal").classList.remove("show");
    $("bulk-date-modal").classList.add("show");
    // Once applied, clear the planned flags for the just-hiked segments
    const orig = applyBulkDate;
    pendingApplyAfterHook = () => {
      for (const id of todo) planned.delete(id);
      saveProgress();
      renderSections();
      updateStats();
      refreshMapStyles();
      pendingApplyAfterHook = null;
    };
  }
  // -------- Theme: light / dark / vintage --------
  // The button cycles through the three states; the icon reflects what the
  // NEXT click will switch to, not the current theme. Refreshes map styles
  // after applying so the trail line picks up the new --hike / --plan vars.
  const THEME_ORDER = ["light", "dark", "vintage"];
  const THEME_BTN_LABELS = {
    light:   "☾ Dark mode",
    dark:    "🗺 Vintage",
    vintage: "☀ Light mode",
  };
  function resolveTheme() {
    if (prefs.theme && THEME_ORDER.includes(prefs.theme)) return prefs.theme;
    // null/auto: follow system preference, but never auto-switch to vintage.
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }
  function applyTheme() {
    const t = resolveTheme();
    document.body.classList.toggle("theme-dark", t === "dark");
    document.body.classList.toggle("theme-vintage", t === "vintage");
    const btn = $("theme-btn");
    if (btn) btn.textContent = THEME_BTN_LABELS[t] || THEME_BTN_LABELS.light;
    // Trail line color is derived from CSS vars at refresh time.
    if (typeof refreshMapStyles === "function") refreshMapStyles();
  }
  function toggleTheme() {
    const cur = resolveTheme();
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    prefs.theme = next;
    savePrefs();
    applyTheme();
  }

  // -------- Segment toggling --------
  function toggleSegment(id, checked, date) {
    if (checked) {
      progress.set(id, date || todayISO());
    } else {
      progress.delete(id);
    }
  }
  function rangeIds(fromId, toId) {
    const all = [...DATA.segments].sort((a, b) => a.id - b.id);
    const fromIdx = all.findIndex((s) => s.id === fromId);
    const toIdx = all.findIndex((s) => s.id === toId);
    if (fromIdx < 0 || toIdx < 0) return [];
    const [lo, hi] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
    return all.slice(lo, hi + 1).map((s) => s.id);
  }

  // -------- Bulk-date modal --------
  function openBulkDate(ids, makeChecked) {
    pendingBulkRange = { ids, checked: makeChecked };
    $("bulk-date-count").textContent = ids.length;
    $("bulk-date-input").value = todayISO();
    $("bulk-date-input").max = todayISO();
    $("bulk-date-modal").classList.add("show");
  }
  function applyBulkDate(date) {
    if (!pendingBulkRange) return;
    const { ids, checked } = pendingBulkRange;
    for (const id of ids) toggleSegment(id, checked, date);
    pendingBulkRange = null;
    $("bulk-date-modal").classList.remove("show");
    saveProgress();
    renderSections();
    updateStats();
    refreshMapStyles();
    if (typeof pendingApplyAfterHook === "function") pendingApplyAfterHook();
  }

  // -------- Event handlers --------
  function onSidebarClick(e) {
    // In add-trip mode, ANY click on a segment row counts as a pick — even
    // taps that land on the bookmark/zoom/lore icons. This must fire before
    // the lore/plan/zoom button handlers below, otherwise a slightly-off tap
    // gets swallowed by those handlers and the user sees clicks "do nothing"
    // (which manifests as needing an extra click before the modal opens).
    if (addTripMode) {
      const segRow = e.target.closest(".seg[data-seg]");
      if (segRow) {
        e.preventDefault();
        e.stopPropagation();
        const cb = segRow.querySelector('[data-toggle]');
        if (cb) cb.checked = progress.has(Number(cb.dataset.toggle));
        const id = Number(segRow.dataset.seg);
        handleAddTripPick(id);
        return;
      }
    }
    const loreBtn = e.target.closest("[data-lore]");
    if (loreBtn) {
      e.preventDefault();
      e.stopPropagation();
      const row = loreBtn.closest(".seg");
      if (row) row.classList.toggle("lore-open");
      return;
    }
    const planBtn = e.target.closest("[data-plan]");
    if (planBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(planBtn.dataset.plan);
      ensureActiveTrip();
      if (planned.has(id)) planned.delete(id);
      else planned.add(id);
      syncActiveTripFromPlanned();
      saveTrips();
      saveProgress();
      updateStats();
      refreshMapStyles();
      updateSegRowInPlace(id);
      return;
    }
    const zoomBtn = e.target.closest("[data-zoom]");
    if (zoomBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(zoomBtn.dataset.zoom);
      const layer = segLayers.get(id);
      if (layer && map) {
        const b = layer.getBounds();
        if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 14 });
        // Brief highlight pulse
        const oldStyle = styleFor(id);
        layer.setStyle({ color: "#8b3a2f", weight: 7, opacity: 1 });
        layer.bringToFront();
        setTimeout(() => layer.setStyle(oldStyle), 1200);
      }
      return;
    }
    // Bulk-mark: stop propagation so the click doesn't also collapse the state.
    const bulkBtn = e.target.closest("[data-bulk-state]");
    if (bulkBtn) {
      e.preventDefault();
      e.stopPropagation();
      const stateName = bulkBtn.dataset.bulkState;
      const segs = DATA.segments.filter(
        (s) => effectiveStateName(s) === stateName && !progress.has(s.id)
      );
      if (segs.length === 0) {
        alert(`All sections in ${stateName} are already marked hiked.`);
        return;
      }
      const ids = segs.map((s) => s.id);
      openBulkDate(ids, true);
      return;
    }
    // Clear hiked status on every section in a state. Confirms first
    // since this is destructive (drops dates + notes are kept on the
    // segment but no longer visible since the row collapses).
    const clearBtn = e.target.closest("[data-clear-state]");
    if (clearBtn) {
      e.preventDefault();
      e.stopPropagation();
      const stateName = clearBtn.dataset.clearState;
      const segs = DATA.segments.filter(
        (s) => effectiveStateName(s) === stateName && progress.has(s.id)
      );
      if (segs.length === 0) {
        alert(`No sections in ${stateName} are marked hiked.`);
        return;
      }
      const totalMi = segs.reduce((a, s) => a + s.miles, 0);
      const ok = confirm(
        `Clear hiked status on all ${segs.length} sections in ${stateName} ` +
        `(${totalMi.toFixed(1)} mi)? Dates will be lost. Notes are kept.`
      );
      if (!ok) return;
      const ids = segs.map((s) => s.id);
      for (const id of ids) toggleSegment(id, false);
      saveProgress();
      updateStats();
      refreshMapStyles();
      renderSections();
      return;
    }
    const chunkHeader = e.target.closest(".chunk-header");
    if (chunkHeader) {
      const chunkEl = chunkHeader.parentElement;
      chunkEl.classList.toggle("collapsed");
      const key = chunkEl.dataset.chunk;
      if (chunkEl.classList.contains("collapsed")) openChunks.delete(key);
      else openChunks.add(key);
      return;
    }
    const header = e.target.closest(".state-header");
    if (header) {
      const stateEl = header.parentElement;
      stateEl.classList.toggle("collapsed");
      const stateName = stateEl.dataset.state;
      if (stateEl.classList.contains("collapsed")) openStates.delete(stateName);
      else openStates.add(stateName);
      return;
    }
    const cb = e.target.closest("[data-toggle]");
    if (cb) {
      const id = Number(cb.dataset.toggle);
      const desired = cb.checked;
      // Multi-select (touch-friendly) and shift-click both behave the same:
      // first tap sets an anchor, second tap completes the range.
      const useRange = e.shiftKey
        || (multiSelectMode && multiSelectAnchor !== null && multiSelectAnchor !== id);
      const anchor = e.shiftKey ? lastShiftAnchor : multiSelectAnchor;
      if (useRange && anchor !== null && anchor !== id) {
        const ids = rangeIds(anchor, id);
        // Roll back the visual flip from the click; the modal/bulk path does it.
        cb.checked = !desired;
        if (e.shiftKey) lastShiftAnchor = id;
        if (multiSelectMode) {
          multiSelectAnchor = null;
          document.body.classList.remove("multi-select");
          multiSelectMode = false;
          $("multi-select-btn")?.setAttribute("aria-pressed", "false");
        }
        if (desired) {
          openBulkDate(ids, true);
        } else {
          for (const sid of ids) toggleSegment(sid, false);
          saveProgress();
          updateStats();
          refreshMapStyles();
          for (const sid of ids) updateSegRowInPlace(sid);
          updateAffectedStateHeaders(ids);
        }
        return;
      }
      // Multi-select first tap: set anchor, no toggle yet
      if (multiSelectMode && multiSelectAnchor === null) {
        cb.checked = !desired; // revert visual flip
        multiSelectAnchor = id;
        document.querySelectorAll(".seg[data-anchor]").forEach((el) => el.removeAttribute("data-anchor"));
        const row = cb.closest(".seg");
        if (row) row.setAttribute("data-anchor", "true");
        return;
      }
      toggleSegment(id, desired);
      lastShiftAnchor = id;
      saveProgress();
      updateStats();
      refreshMapStyles();
      updateSegRowInPlace(id);
      updateAffectedStateHeaders([id]);
      if (prefs.viewMode === "trip") renderSections(); // trip view groups by date — needs full re-render
    }
  }
  function updateStateHeader(stateEl) {
    const stateName = stateEl.dataset.state;
    const segs = DATA.segments.filter((s) => effectiveStateName(s) === stateName);
    const hikedCount = segs.filter((s) => progress.has(s.id)).length;
    const hikedMi = segs
      .filter((s) => progress.has(s.id))
      .reduce((a, s) => a + s.miles, 0);
    const totalMi = segs.reduce((a, s) => a + s.miles, 0);
    const stats = stateEl.querySelector(".state-stats");
    if (stats) {
      stats.innerHTML = `<span class="done">${hikedCount}</span>/${segs.length} · ${hikedMi.toFixed(1)}/${totalMi.toFixed(1)} mi`;
    }
    // Also update any chunk header stats inside this state
    stateEl.querySelectorAll(".chunk").forEach((chunkEl) => {
      const segs = [...chunkEl.querySelectorAll("[data-seg]")].map((el) => Number(el.dataset.seg));
      const chunkSegObjs = segs.map((id) => segIndex.get(id)).filter(Boolean);
      const cMi = chunkSegObjs.reduce((a, s) => a + s.miles, 0);
      const cHikedMi = chunkSegObjs
        .filter((s) => progress.has(s.id))
        .reduce((a, s) => a + s.miles, 0);
      const cs = chunkEl.querySelector(".chunk-stats");
      if (cs) cs.textContent = `${cHikedMi.toFixed(1)}/${cMi.toFixed(1)} mi`;
    });
  }
  function updateAffectedStateHeaders(ids) {
    const states = new Set();
    for (const id of ids) {
      const seg = segIndex.get(id);
      if (seg) states.add(seg.state);
    }
    for (const stateName of states) {
      const stateEl = document.querySelector(`[data-state="${CSS.escape(stateName)}"]`);
      if (stateEl) updateStateHeader(stateEl);
    }
  }
  function onSidebarChange(e) {
    const dateInput = e.target.closest("[data-date]");
    if (dateInput) {
      const id = Number(dateInput.dataset.date);
      let val = dateInput.value;
      const today = todayISO();
      if (val && val > today) { val = today; dateInput.value = today; }
      if (progress.has(id)) {
        progress.set(id, val);
        saveProgress();
        if (prefs.colorByYear) refreshMapStyles();
        // Trip view groups by date — re-render so the segment moves to its new group
        if (prefs.viewMode === "trip") renderSections();
      }
    }
  }
  function toggleMultiSelect() {
    multiSelectMode = !multiSelectMode;
    multiSelectAnchor = null;
    // Multi-select and add-trip are mutually exclusive.
    if (multiSelectMode && addTripMode) exitAddTripMode();
    document.body.classList.toggle("multi-select", multiSelectMode);
    document.querySelectorAll(".seg[data-anchor]").forEach((el) => el.removeAttribute("data-anchor"));
    const btn = $("multi-select-btn");
    if (btn) btn.setAttribute("aria-pressed", String(multiSelectMode));
  }
  // ----- Add-trip: pick start segment, then end, then a date.
  // Reuses the bulk-date modal to apply the same date to every segment in
  // the contiguous range. Exit cleanly via Esc, the banner button, or by
  // toggling multi-select.
  function toggleAddTripMode() {
    if (addTripMode) {
      exitAddTripMode();
      return;
    }
    addTripMode = true;
    addTripStart = null;
    if (multiSelectMode) toggleMultiSelect();
    document.body.classList.add("add-trip");
    document.querySelectorAll(".seg[data-trip-anchor]").forEach((el) => el.removeAttribute("data-trip-anchor"));
    renderAddTripBanner();
    const btn = $("add-trip-btn");
    if (btn) btn.setAttribute("aria-pressed", "true");
  }
  function exitAddTripMode() {
    addTripMode = false;
    addTripStart = null;
    document.body.classList.remove("add-trip");
    document.querySelectorAll(".seg[data-trip-anchor]").forEach((el) => el.removeAttribute("data-trip-anchor"));
    const banner = $("add-trip-banner");
    if (banner) banner.style.display = "none";
    const btn = $("add-trip-btn");
    if (btn) btn.setAttribute("aria-pressed", "false");
  }
  function renderAddTripBanner() {
    const banner = $("add-trip-banner");
    if (!banner) return;
    if (!addTripMode) {
      banner.style.display = "none";
      return;
    }
    banner.style.display = "";
    if (!addTripStart) {
      banner.innerHTML =
        `<strong>Add a trip:</strong> tap the <em>first</em> segment of your trip on the list. ` +
        `<button id="add-trip-cancel" type="button">Cancel</button>`;
    } else {
      const seg = segIndex.get(addTripStart);
      const startLabel = seg ? `${seg.from} → ${seg.to}` : "(unknown)";
      banner.innerHTML =
        `<strong>Start:</strong> ${escapeHtml(startLabel)}. Now tap the <em>last</em> segment. ` +
        `<button id="add-trip-cancel" type="button">Cancel</button>`;
    }
  }
  // Called from the segment-row click branch when add-trip mode is active.
  function handleAddTripPick(segId) {
    if (!addTripStart) {
      addTripStart = segId;
      document.querySelectorAll(".seg[data-trip-anchor]").forEach((el) => el.removeAttribute("data-trip-anchor"));
      const row = document.querySelector(`.seg[data-seg="${segId}"]`);
      if (row) row.setAttribute("data-trip-anchor", "true");
      renderAddTripBanner();
      return;
    }
    if (segId === addTripStart) {
      // Same row twice: just deselect, let user pick again.
      addTripStart = null;
      document.querySelectorAll(".seg[data-trip-anchor]").forEach((el) => el.removeAttribute("data-trip-anchor"));
      renderAddTripBanner();
      return;
    }
    const ids = rangeIds(addTripStart, segId);
    if (ids.length === 0) {
      exitAddTripMode();
      return;
    }
    exitAddTripMode();
    openBulkDate(ids, true);
  }
  function toggleLegend() {
    const el = $("map-legend");
    if (!el) return;
    el.classList.toggle("collapsed");
    try {
      // "0" = explicitly expanded, "1" = collapsed. Default (no value) = collapsed.
      localStorage.setItem("at-tracker-legend-collapsed", el.classList.contains("collapsed") ? "1" : "0");
    } catch (e) {}
  }
  function onSidebarInput(e) {
    const noteInput = e.target.closest("[data-note]");
    if (noteInput) {
      const id = Number(noteInput.dataset.note);
      notes.set(id, noteInput.value);
      clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(() => { saveNotes(); notesSaveTimer = null; }, 500);
    }
  }
  // Flush any pending note save on page hide so we never lose typing.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && notesSaveTimer) {
      clearTimeout(notesSaveTimer); notesSaveTimer = null; saveNotes();
    }
  });
  function onSidebarHover(e) {
    const row = e.target;
    const id = Number(row.dataset.seg);
    const layer = segLayers.get(id);
    if (!layer) return;
    if (e.type === "mouseenter") {
      layer.setStyle({ color: "#8b3a2f", weight: 6, opacity: 1 });
      layer.bringToFront();
    } else {
      layer.setStyle(styleFor(id));
      if (progress.has(id)) layer.bringToFront();
    }
  }

  // -------- Modals --------
  function openShare() {
    const code = encodeProgress(progress);
    const planCode = encodePlanned(planned);
    const params = new URLSearchParams();
    if (code) params.set("c", code);
    if (planCode) params.set("pl", planCode);
    if (activeProfile !== DEFAULT_PROFILE) params.set("p", activeProfile);
    const hashStr = params.toString();
    const url = `${location.origin}${location.pathname}${hashStr ? "#" + hashStr : ""}`;
    $("share-url").value = url;
    $("share-code").value = code || "(no segments hiked yet)";
    $("share-modal").classList.add("show");
  }
  function copyShareUrl() {
    const inp = $("share-url");
    inp.select();
    navigator.clipboard.writeText(inp.value).catch(() => document.execCommand("copy"));
    const btn = $("share-copy");
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => (btn.textContent = orig), 1200);
  }
  function doLoad() {
    const raw = $("load-code").value.trim();
    if (!raw) { $("load-modal").classList.remove("show"); return; }
    let code = raw;
    let profileName = null;
    const m = raw.match(/[#&?]c=([A-Za-z0-9_-]+)/);
    if (m) code = m[1];
    const pm = raw.match(/[#&?]p=([^&]+)/);
    if (pm) { try { profileName = decodeURIComponent(pm[1]); } catch (e) {} }
    let plCode = "";
    const plm = raw.match(/[#&?]pl=([A-Za-z0-9_-]+)/);
    if (plm) plCode = plm[1];
    try {
      const nextProg = decodeProgress(code);
      const nextPlanned = decodePlanned(plCode);
      if (profileName && profileName !== activeProfile) {
        ensureProfile(profileName);
        activeProfile = profileName;
        saveActiveProfile();
        renderProfileSelect();
      }
      progress = nextProg;
      planned = nextPlanned;
      saveProgress();
      renderSections();
      updateStats();
      refreshMapStyles();
      $("load-modal").classList.remove("show");
    } catch (e) {
      alert("Invalid code. Please check and try again.");
    }
  }
  function doReset() {
    if (!confirm(`Clear all hiked sections, planned segments, and notes for profile "${activeProfile}"? This cannot be undone (unless you have a saved code).`)) return;
    progress = new Map();
    planned = new Set();
    notes = new Map();
    saveProgress();
    saveNotes();
    renderSections();
    updateStats();
    refreshMapStyles();
  }

  // -------- Profile actions --------
  function onAddProfile() {
    const name = (prompt("New profile name?") || "").trim();
    if (!name) return;
    if (profiles.includes(name)) { alert("A profile with that name already exists."); return; }
    profiles = [...profiles, name];
    saveProfileList();
    activeProfile = name;
    saveActiveProfile();
    progress = new Map();
    planned = new Set();
    notes = new Map();
    saveProgress();
    saveNotes();
    renderProfileSelect();
    renderSections();
    updateStats();
    refreshMapStyles();
  }
  function onRenameProfile() {
    const name = (prompt("Rename profile to?", activeProfile) || "").trim();
    if (!name || name === activeProfile) return;
    if (profiles.includes(name)) { alert("A profile with that name already exists."); return; }
    // Move localStorage data
    const oldProg = safeGet(progressKey(activeProfile));
    const oldNotes = safeGet(notesKey(activeProfile));
    if (oldProg) safeSet(progressKey(name), oldProg);
    if (oldNotes) safeSet(notesKey(name), oldNotes);
    try { localStorage.removeItem(progressKey(activeProfile)); } catch (e) {}
    try { localStorage.removeItem(notesKey(activeProfile)); } catch (e) {}
    profiles = profiles.map(p => p === activeProfile ? name : p);
    saveProfileList();
    activeProfile = name;
    saveActiveProfile();
    renderProfileSelect();
    saveProgress(); // updates URL
  }
  function onDeleteProfile() {
    if (profiles.length <= 1) { alert("Cannot delete the only profile. Reset instead."); return; }
    if (!confirm(`Delete profile "${activeProfile}" and all its data? This cannot be undone.`)) return;
    try { localStorage.removeItem(progressKey(activeProfile)); } catch (e) {}
    try { localStorage.removeItem(notesKey(activeProfile)); } catch (e) {}
    profiles = profiles.filter(p => p !== activeProfile);
    saveProfileList();
    activeProfile = profiles[0];
    saveActiveProfile();
    progress = loadProgressForActive();
    planned = loadPlannedForActive();
    notes = loadNotesForActive();
    {
      const td = loadTripsForActive();
      trips = td.trips;
      activeTripId = td.activeTripId;
      // If trips were loaded, prefer them as the source of truth.
      if (trips.length > 0) syncPlannedFromActiveTrip();
      else if (planned.size > 0) {
        // Wrap legacy planned set into a default trip and persist
        ensureActiveTrip();
        syncActiveTripFromPlanned();
        saveTrips();
      }
    }
    renderProfileSelect();
    renderSections();
    updateStats();
    refreshMapStyles();
  }

  // -------- Cloud sync (Firebase Auth + Firestore) --------
  function setSyncStatus(text, kind) {
    const el = $("sync-status");
    if (!el) return;
    el.className = kind || "";
    el.textContent = text || "";
  }
  function buildCloudPayload() {
    const profileData = {};
    for (const name of profiles) {
      const prog = safeGet(progressKey(name));
      const pl = safeGet(plannedKey(name));
      const nt = safeGet(notesKey(name));
      const tr = safeGet(tripsKey(name));
      profileData[name] = {
        hiked: prog ? safeJsonParse(prog, {}) : {},
        planned: pl ? safeJsonParse(pl, []) : [],
        notes: nt ? safeJsonParse(nt, {}) : {},
        trips: tr ? safeJsonParse(tr, { trips: [], activeTripId: null }) : { trips: [], activeTripId: null },
      };
    }
    return {
      profiles: profileData,
      activeProfile,
      profileNames: profiles,
      prefs,
    };
  }
  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }
  function applyCloudData(data) {
    if (!data) return;
    cloudInhibit = true;
    try {
      const cloudProfiles = data.profileNames || Object.keys(data.profiles || {});
      // Merge profile names: union of cloud + local
      const merged = Array.from(new Set([...cloudProfiles, ...profiles]));
      profiles = merged;
      saveProfileList();
      // Write each profile's cloud state to localStorage. Local-only profiles
      // (not present in cloud) keep their existing data.
      for (const [name, pdata] of Object.entries(data.profiles || {})) {
        if (pdata.hiked) safeSet(progressKey(name), JSON.stringify(pdata.hiked));
        if (pdata.planned) safeSet(plannedKey(name), JSON.stringify(pdata.planned));
        if (pdata.notes) safeSet(notesKey(name), JSON.stringify(pdata.notes));
        if (pdata.trips) safeSet(tripsKey(name), JSON.stringify(pdata.trips));
      }
      if (data.prefs) {
        prefs = { ...prefs, ...data.prefs };
        savePrefs();
      }
      // Reload current profile state from localStorage
      const wantActive = data.activeProfile && profiles.includes(data.activeProfile)
        ? data.activeProfile
        : activeProfile;
      activeProfile = wantActive;
      saveActiveProfile();
      progress = loadProgressForActive();
      planned = loadPlannedForActive();
      notes = loadNotesForActive();
      const td = loadTripsForActive();
      trips = td.trips;
      activeTripId = td.activeTripId;
      if (trips.length > 0) syncPlannedFromActiveTrip();
    } finally {
      cloudInhibit = false;
    }
  }
  function scheduleCloudSave() {
    if (!cloudUser || cloudInhibit) return;
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(async () => {
      if (!cloudUser) return;
      setSyncStatus("syncing…", "syncing");
      try {
        await window.AT_AUTH.saveCloudData(cloudUser.uid, buildCloudPayload());
        setSyncStatus("synced", "synced");
        setTimeout(() => setSyncStatus("", ""), 2000);
      } catch (e) {
        console.warn("cloud save failed:", e);
        setSyncStatus("offline (will retry)", "error");
      }
    }, 1500);
  }
  async function handleAuthChange(user) {
    cloudUser = user || null;
    const signinBtn = $("signin-btn");
    const signoutBtn = $("signout-btn");
    const nameEl = $("signed-in-as");
    if (user) {
      signinBtn.style.display = "none";
      signoutBtn.style.display = "";
      nameEl.style.display = "";
      nameEl.textContent = user.email || user.displayName || "signed in";
      setSyncStatus("loading…", "syncing");
      try {
        const cloud = await window.AT_AUTH.loadCloudData(user.uid);
        if (cloud) {
          // Merge: cloud takes precedence, but local-only profiles preserved.
          applyCloudData(cloud);
          renderProfileSelect();
          renderSections();
          updateStats();
          refreshMapStyles();
        }
        // Always push current state up so cloud is current and local additions sync.
        await window.AT_AUTH.saveCloudData(user.uid, buildCloudPayload());
        setSyncStatus("synced", "synced");
        setTimeout(() => setSyncStatus("", ""), 2000);
      } catch (e) {
        console.warn("initial cloud sync failed:", e);
        setSyncStatus("sync error", "error");
      }
    } else {
      signinBtn.style.display = "";
      signoutBtn.style.display = "none";
      nameEl.style.display = "none";
      nameEl.textContent = "";
      setSyncStatus("", "");
    }
  }
  function wireAuthUI() {
    if (!window.AT_AUTH) {
      // The module hasn't loaded yet; wait for the ready event.
      window.addEventListener("at-auth-ready", wireAuthUI, { once: true });
      return;
    }
    window.AT_AUTH.onAuthChange(handleAuthChange);
    $("signin-btn").addEventListener("click", async () => {
      try {
        setSyncStatus("opening sign-in…", "syncing");
        await window.AT_AUTH.signInWithGoogle();
      } catch (e) {
        console.warn("sign-in failed:", e);
        setSyncStatus(`sign-in failed: ${e.code || e.message}`, "error");
      }
    });
    $("signout-btn").addEventListener("click", async () => {
      try { await window.AT_AUTH.signOut(); } catch (e) {}
    });
  }

  // -------- Backup file (full state) --------
  function buildBackup() {
    return {
      app: "at-section-tracker",
      version: 2,
      exported: new Date().toISOString(),
      profile: activeProfile,
      hiked: Object.fromEntries(progress),
      planned: [...planned],
      trips: { trips, activeTripId },
      notes: Object.fromEntries([...notes].filter(([, v]) => v)),
    };
  }
  function saveBackupFile() {
    const data = JSON.stringify(buildBackup(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `at-tracker-${activeProfile.replace(/[^a-z0-9]+/gi, "_")}-${todayISO()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadBackupFile(file) {
    const status = $("load-file-status");
    status.textContent = "Reading file…";
    let text;
    try { text = await file.text(); } catch (e) { status.textContent = `Read failed: ${e.message}`; return; }
    let obj;
    try { obj = JSON.parse(text); } catch (e) { status.textContent = `Not valid JSON: ${e.message}`; return; }
    if (!obj || obj.app !== "at-section-tracker") {
      status.textContent = "This doesn't look like an AT tracker backup file.";
      return;
    }
    // Apply profile
    const profileName = (obj.profile || "").trim() || activeProfile;
    if (profileName !== activeProfile) {
      ensureProfile(profileName);
      activeProfile = profileName;
      saveActiveProfile();
    }
    // Apply state
    progress = new Map(Object.entries(obj.hiked || {}).map(([k, v]) => [Number(k), String(v || "")]));
    planned = new Set((obj.planned || []).map(Number));
    notes = new Map(Object.entries(obj.notes || {}).map(([k, v]) => [Number(k), String(v || "")]));
    if (obj.trips && Array.isArray(obj.trips.trips)) {
      trips = obj.trips.trips;
      activeTripId = obj.trips.activeTripId || (trips[0] && trips[0].id) || null;
      if (trips.length > 0) syncPlannedFromActiveTrip();
      saveTrips();
    } else if (planned.size > 0) {
      ensureActiveTrip();
      syncActiveTripFromPlanned();
      saveTrips();
    }
    saveProgress();
    saveNotes();
    renderProfileSelect();
    renderSections();
    updateStats();
    refreshMapStyles();
    const counts = `${progress.size} hiked · ${planned.size} planned · ${notes.size} notes`;
    status.textContent = `Restored profile "${profileName}" (${counts}).`;
    setTimeout(() => $("load-modal").classList.remove("show"), 1500);
  }

  // -------- GPX export --------
  function gpxEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function exportGPX() {
    if (progress.size === 0) { alert("No segments marked as hiked yet."); return; }
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<gpx version="1.1" creator="AT Section Tracker" xmlns="http://www.topografix.com/GPX/1/1">');
    parts.push(`  <metadata>`);
    parts.push(`    <name>AT hiked sections — ${gpxEscape(activeProfile)}</name>`);
    parts.push(`    <time>${new Date().toISOString()}</time>`);
    parts.push(`  </metadata>`);
    const hikedSegs = [...progress.keys()].map(id => segIndex.get(id)).filter(Boolean).sort((a, b) => a.id - b.id);
    for (const seg of hikedSegs) {
      const date = progress.get(seg.id) || "";
      const note = notes.get(seg.id) || "";
      const dateISO = date ? `${date}T12:00:00Z` : "";
      parts.push(`  <trk>`);
      parts.push(`    <name>${gpxEscape(seg.from)} → ${gpxEscape(seg.to)}</name>`);
      parts.push(`    <desc>${gpxEscape(seg.state)} · ${seg.miles.toFixed(2)} mi${date ? ` · hiked ${date}` : ""}${note ? ` · ${gpxEscape(note)}` : ""}</desc>`);
      parts.push(`    <trkseg>`);
      for (const [lon, lat] of seg.geom) {
        parts.push(`      <trkpt lat="${lat}" lon="${lon}">${dateISO ? `<time>${dateISO}</time>` : ""}</trkpt>`);
      }
      parts.push(`    </trkseg>`);
      parts.push(`  </trk>`);
    }
    parts.push('</gpx>');
    const blob = new Blob([parts.join("\n")], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `at-hiked-${activeProfile.replace(/[^a-z0-9]+/gi, "_")}-${todayISO()}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------- KML export (Google Earth) --------
  function kmlEscape(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  // Color: KML uses aabbggrr (alpha-blue-green-red), so we have to flip
  // an rrggbb input. alpha is the byte that controls opacity, ff = fully opaque.
  function rgbToKml(rgb, alpha) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(rgb);
    if (!m) return "ff007d2a";
    return `${alpha || "ff"}${m[3].toLowerCase()}${m[2].toLowerCase()}${m[1].toLowerCase()}`;
  }
  function exportKML() {
    const hikedSegs = [...progress.keys()].map((id) => segIndex.get(id)).filter(Boolean).sort((a, b) => a.id - b.id);
    const plannedOnly = [...planned].filter((id) => !progress.has(id)).map((id) => segIndex.get(id)).filter(Boolean).sort((a, b) => a.id - b.id);
    if (hikedSegs.length === 0 && plannedOnly.length === 0) {
      alert("Nothing to export — mark some segments as hiked or planned first.");
      return;
    }
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
    lines.push(`  <Document>`);
    lines.push(`    <name>AT Section Tracker — ${kmlEscape(activeProfile)}</name>`);
    lines.push(`    <description>Hiked + planned Appalachian Trail sections, exported ${new Date().toISOString().slice(0, 10)}.</description>`);
    // Styles
    lines.push(`    <Style id="hiked"><LineStyle><color>${rgbToKml("#2a7d3a")}</color><width>5</width></LineStyle></Style>`);
    lines.push(`    <Style id="planned"><LineStyle><color>${rgbToKml("#1a5fb4")}</color><width>4</width></LineStyle></Style>`);
    lines.push(`    <Style id="trail"><LineStyle><color>${rgbToKml("#7a4f3a", "80")}</color><width>2</width></LineStyle></Style>`);
    lines.push(`    <Style id="shelter"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon><scale>0.7</scale></IconStyle></Style>`);
    lines.push(`    <Style id="peak"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/shapes/hiker.png</href></Icon><scale>0.8</scale></IconStyle></Style>`);
    lines.push(`    <Style id="day"><LineStyle><color>${rgbToKml("#1a5fb4")}</color><width>5</width></LineStyle></Style>`);
    lines.push(`    <Style id="town"><IconStyle><Icon><href>https://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon><scale>0.7</scale></IconStyle></Style>`);

    // Hiked folder
    if (hikedSegs.length > 0) {
      lines.push(`    <Folder><name>Hiked sections (${hikedSegs.length})</name>`);
      let cumMi = 0;
      for (const seg of hikedSegs) {
        cumMi += seg.miles;
        const date = progress.get(seg.id) || "";
        const note = notes.get(seg.id) || "";
        const desc = `${seg.state} · ${seg.miles.toFixed(2)} mi (cum ${cumMi.toFixed(1)})` +
          (date ? ` · hiked ${date}` : "") +
          (typeof seg.elev_gain === "number" ? ` · +${Math.round(seg.elev_gain)}/−${Math.round(seg.elev_loss)} ft` : "") +
          (note ? `\n${note}` : "");
        const coords = seg.geom.map(([lon, lat]) => `${lon},${lat},0`).join(" ");
        lines.push(`      <Placemark>`);
        lines.push(`        <name>${kmlEscape(seg.from)} → ${kmlEscape(seg.to)}</name>`);
        lines.push(`        <description>${kmlEscape(desc)}</description>`);
        lines.push(`        <styleUrl>#hiked</styleUrl>`);
        lines.push(`        <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`);
        lines.push(`      </Placemark>`);
      }
      lines.push(`    </Folder>`);
    }

    // Planned folder — split by day-by-day itinerary so Google Earth has
    // a fold-out for each day of the trip.
    if (plannedOnly.length > 0) {
      const t = getActiveTrip();
      const pace = Math.max(1, Math.min(50, Number(prefs.pace) || 12));
      const startDate = prefs.tripStartDate || todayISO();
      const zeroFreq = Math.max(0, Math.min(14, Number(prefs.zeroDayFreq) || 0));
      const itinerary = buildItinerary(plannedOnly, pace, startDate, zeroFreq);
      const hikeDays = itinerary.filter((d) => d.kind === "hike").length;
      lines.push(`    <Folder><name>Planned: ${plannedOnly.length} sections · ${hikeDays} day${hikeDays === 1 ? "" : "s"}${t ? " · " + kmlEscape(t.name) : ""}</name>`);
      lines.push(`      <description>${kmlEscape(t ? "Trip: " + t.name + " · " : "")}Pace ${pace} mi/day from ${startDate}</description>`);
      // Per-day sub-folders
      let hikeNum = 0;
      for (const d of itinerary) {
        if (d.kind === "zero") {
          lines.push(`      <Folder><name>🛌 Zero day · ${kmlEscape(d.date)}</name></Folder>`);
          continue;
        }
        hikeNum++;
        lines.push(`      <Folder><name>Day ${hikeNum} · ${kmlEscape(d.date)} · ${d.miles.toFixed(1)} mi</name>`);
        const dayDesc = `${kmlEscape(d.from)} → ${kmlEscape(d.to)}\n` +
          `${d.miles.toFixed(1)} mi · +${Math.round(d.gain)}/−${Math.round(d.loss)} ft`;
        lines.push(`        <description>${dayDesc}</description>`);
        for (const seg of (d.segs || [])) {
          const segDesc = `${seg.state} · ${seg.miles.toFixed(2)} mi` +
            (typeof seg.elev_gain === "number" ? ` · +${Math.round(seg.elev_gain)}/−${Math.round(seg.elev_loss)} ft` : "");
          const coords = seg.geom.map(([lon, lat]) => `${lon},${lat},0`).join(" ");
          lines.push(`        <Placemark>`);
          lines.push(`          <name>${kmlEscape(seg.from)} → ${kmlEscape(seg.to)}</name>`);
          lines.push(`          <description>${kmlEscape(segDesc)}</description>`);
          lines.push(`          <styleUrl>#planned</styleUrl>`);
          lines.push(`          <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>`);
          lines.push(`        </Placemark>`);
        }
        lines.push(`      </Folder>`);
      }
      lines.push(`    </Folder>`);
    }

    // Shelters / peaks / towns relevant to the route — only if planned or hiked is non-empty
    const allSegIds = new Set([...hikedSegs.map((s) => s.id), ...plannedOnly.map((s) => s.id)]);
    const relevantFeatures = [];
    if (FEATURES) {
      for (const segId of allSegIds) {
        const fs = segFeatures.get(segId);
        if (fs) for (const f of fs) relevantFeatures.push(f);
      }
    }
    const seenFeatIds = new Set();
    const shelterPlacemarks = [];
    const peakPlacemarks = [];
    const townPlacemarks = [];
    // Shelters from segment endpoints (always include if we have hiked/planned segs at that point)
    for (const seg of [...hikedSegs, ...plannedOnly]) {
      const checkName = (n) => {
        if (/shelter|lean.?to|cabin|hut/i.test(n)) {
          const key = `shelter:${n}`;
          if (!seenFeatIds.has(key)) {
            seenFeatIds.add(key);
            // Find lat/lon: search in DATA.shelters
            const sh = (DATA.shelters || []).find((x) => x.name === n);
            if (sh) {
              shelterPlacemarks.push({ name: n, lat: sh.lat, lon: sh.lon, state: sh.state });
            }
          }
        }
      };
      checkName(seg.from);
      checkName(seg.to);
    }
    // Wikitrail features (peaks, towns)
    for (const f of relevantFeatures) {
      if (!f.lat || !f.lon) continue;
      const key = `f:${f.id}`;
      if (seenFeatIds.has(key)) continue;
      seenFeatIds.add(key);
      if (f.kind === "peak") peakPlacemarks.push(f);
      else if (f.kind === "town") townPlacemarks.push(f);
    }
    if (shelterPlacemarks.length > 0) {
      lines.push(`    <Folder><name>Shelters on route (${shelterPlacemarks.length})</name>`);
      for (const s of shelterPlacemarks) {
        lines.push(`      <Placemark><name>${kmlEscape(s.name)}</name><description>${kmlEscape(s.state || "")}</description><styleUrl>#shelter</styleUrl><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`);
      }
      lines.push(`    </Folder>`);
    }
    if (peakPlacemarks.length > 0) {
      lines.push(`    <Folder><name>Peaks on route (${peakPlacemarks.length})</name>`);
      for (const p of peakPlacemarks) {
        const elev = typeof p.elev_m === "number" ? `${Math.round(p.elev_m * 3.28084)} ft` : "";
        lines.push(`      <Placemark><name>${kmlEscape(p.name)}</name><description>${kmlEscape(elev)}</description><styleUrl>#peak</styleUrl><Point><coordinates>${p.lon},${p.lat},0</coordinates></Point></Placemark>`);
      }
      lines.push(`    </Folder>`);
    }
    if (townPlacemarks.length > 0) {
      lines.push(`    <Folder><name>Towns on route (${townPlacemarks.length})</name>`);
      for (const tn of townPlacemarks) {
        lines.push(`      <Placemark><name>${kmlEscape(tn.name)}</name><description>${kmlEscape(tn.state || "")}</description><styleUrl>#town</styleUrl><Point><coordinates>${tn.lon},${tn.lat},0</coordinates></Point></Placemark>`);
      }
      lines.push(`    </Folder>`);
    }

    lines.push(`  </Document>`);
    lines.push(`</kml>`);

    const blob = new Blob([lines.join("\n")], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `at-tracker-${activeProfile.replace(/[^a-z0-9]+/gi, "_")}-${todayISO()}.kml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // -------- GPX import --------
  function openGpxImport() {
    $("gpx-file").value = "";
    $("gpx-date").value = todayISO();
    $("gpx-date").max = todayISO();
    $("gpx-import-status").textContent = "";
    $("gpx-import-modal").classList.add("show");
  }
  async function doGpxImport() {
    const file = $("gpx-file").files[0];
    if (!file) { $("gpx-import-status").textContent = "Choose a .gpx file first."; return; }
    const date = $("gpx-date").value || todayISO();
    $("gpx-import-status").textContent = "Parsing track…";
    let text;
    try { text = await file.text(); } catch (e) { $("gpx-import-status").textContent = `Read failed: ${e.message}`; return; }
    let xml;
    try { xml = new DOMParser().parseFromString(text, "application/xml"); }
    catch (e) { $("gpx-import-status").textContent = "Could not parse XML."; return; }
    if (xml.querySelector("parsererror")) { $("gpx-import-status").textContent = "Invalid GPX file."; return; }
    const trkpts = [...xml.getElementsByTagName("trkpt"), ...xml.getElementsByTagName("rtept"), ...xml.getElementsByTagName("wpt")];
    const points = trkpts.map(p => [parseFloat(p.getAttribute("lon")), parseFloat(p.getAttribute("lat"))])
      .filter(p => isFinite(p[0]) && isFinite(p[1]));
    if (points.length === 0) { $("gpx-import-status").textContent = "No track points found."; return; }
    $("gpx-import-status").textContent = `Matching ${points.length.toLocaleString()} track points to AT segments…`;

    // Build coarse spatial index of track points: 0.01° buckets (~1.1km lat, ~0.85km lon at 40°)
    const cellSize = 0.01;
    const grid = new Map();
    for (const p of points) {
      const cx = Math.floor(p[0] / cellSize);
      const cy = Math.floor(p[1] / cellSize);
      const key = `${cx}|${cy}`;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(p);
    }
    const TOL_KM = 0.1; // 100m
    const COVER_THRESHOLD = 0.6;

    function nearbyPoints(lon, lat) {
      const cx = Math.floor(lon / cellSize);
      const cy = Math.floor(lat / cellSize);
      const out = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(`${cx + dx}|${cy + dy}`);
          if (arr) for (const p of arr) out.push(p);
        }
      }
      return out;
    }
    function distKm(a, b) {
      const lat0 = (a[1] + b[1]) * 0.5 * Math.PI / 180;
      const dx = (a[0] - b[0]) * 111.32 * Math.cos(lat0);
      const dy = (a[1] - b[1]) * 110.574;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // For each segment, score what fraction of its vertices are within TOL_KM of any track point.
    let matched = 0;
    let touched = 0;
    for (const seg of DATA.segments) {
      const verts = seg.geom;
      let near = 0;
      for (const [lon, lat] of verts) {
        const cands = nearbyPoints(lon, lat);
        let isNear = false;
        for (const p of cands) {
          if (distKm([lon, lat], p) <= TOL_KM) { isNear = true; break; }
        }
        if (isNear) near++;
      }
      const cov = near / Math.max(1, verts.length);
      if (cov >= COVER_THRESHOLD) {
        if (!progress.has(seg.id)) matched++;
        progress.set(seg.id, date);
        touched++;
      }
    }
    if (touched === 0) {
      $("gpx-import-status").textContent = "No AT segments matched this track. Track may be off-trail or in a different region.";
      return;
    }
    saveProgress();
    renderSections();
    updateStats();
    refreshMapStyles();
    $("gpx-import-status").textContent = `Matched ${touched} segment${touched === 1 ? "" : "s"} (${matched} new). Closing in 2 seconds…`;
    setTimeout(() => $("gpx-import-modal").classList.remove("show"), 2000);
  }

  // -------- Pref changes --------
  function applyDirection() { prefs.direction = directionEl.value; savePrefs(); renderSections(); }
  function applyViewMode() { prefs.viewMode = viewModeEl.value; savePrefs(); renderSections(); }
  function applyShelterToggle() {
    prefs.showShelters = showSheltersEl.checked;
    savePrefs();
    if (!shelterLayer) return;
    if (prefs.showShelters) shelterLayer.addTo(map);
    else map.removeLayer(shelterLayer);
  }
  function applyColorByYear() { prefs.colorByYear = colorByYearEl.checked; savePrefs(); refreshMapStyles(); }

  // -------- Boot --------
  async function boot() {
    initMap();
    let data;
    try {
      const resp = await fetch(DATA_URL, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (e) {
      loadingEl.innerHTML = `<div class="err">Could not load AT data: ${escapeHtml(e.message)}<br>Make sure <code>at_data.json</code> is served alongside this page.</div>`;
      return;
    }
    DATA = data;
    DATA.segments.forEach((s) => segIndex.set(s.id, s));
    computeCumulative();

    // ---- v2 -> v3 user data migration (one-time, idempotent) ----
    // If the bundled data is v3+ and the user's localStorage still has
    // segment IDs from v2, look up each old segment's midpoint in v2 data
    // and remap to the closest v3 segment. Saves a lot of grief over losing
    // your hiked / planned / notes when we change the trail data.
    try {
      if ((data.version || 1) >= 3 && !safeGet("at-tracker-migrated-v3")) {
        await migrateV2ToV3();
        safeSet("at-tracker-migrated-v3", "1");
      }
    } catch (e) {
      console.warn("v3 migration failed:", e);
    }
    // v3 -> v4 migration (KMZ-blended structure). Independent of v3 flag —
    // a user who upgraded straight from v2 to v4 still goes through both.
    try {
      if ((data.version || 1) >= 4 && !safeGet("at-tracker-migrated-v4")) {
        await migrateV3ToV4();
        safeSet("at-tracker-migrated-v4", "1");
      }
    } catch (e) {
      console.warn("v4 migration failed:", e);
    }

    // Load wikitrail features (resupply, maildrop, hostel, hotel, restaurant, etc.)
    // Optional — app keeps working if file is missing.
    try {
      const fr = await fetch("at_features.json", { cache: "no-cache" });
      if (fr.ok) {
        FEATURES = await fr.json();
        // Append hand-curated viewpoints that fill OSM coverage gaps
        // (especially the SW VA / Roan / Smokies stretch).
        if (Array.isArray(FEATURES.features) && Array.isArray(CURATED_VIEWS)) {
          FEATURES.features.push(...CURATED_VIEWS);
        }
        matchFeaturesToSegments();
        buildFeatureLayers();
      }
    } catch (e) {
      console.warn("at_features.json load failed:", e);
    }

    // Load lore (optional — app still works without it).
    try {
      const lr = await fetch(LORE_URL, { cache: "no-cache" });
      if (lr.ok) LORE = await lr.json();
    } catch (e) {
      console.warn("lore fetch failed, continuing without it:", e);
      LORE = [];
    }
    attachLoreToSegments();

    // One-time migration: move legacy single-profile data into the new "Me" profile.
    const legacyProg = safeGet("at-tracker-progress-v1");
    const legacyNotes = safeGet("at-tracker-notes-v1");
    if (legacyProg && !safeGet(progressKey(DEFAULT_PROFILE))) {
      safeSet(progressKey(DEFAULT_PROFILE), legacyProg);
      try { localStorage.removeItem("at-tracker-progress-v1"); } catch (e) {}
    }
    if (legacyNotes && !safeGet(notesKey(DEFAULT_PROFILE))) {
      safeSet(notesKey(DEFAULT_PROFILE), legacyNotes);
      try { localStorage.removeItem("at-tracker-notes-v1"); } catch (e) {}
    }
    profiles = loadProfileList();
    // If URL has p=, switch to that profile (or create it)
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const urlProfile = params.get("p");
    if (urlProfile) {
      ensureProfile(urlProfile);
      activeProfile = urlProfile;
      saveActiveProfile();
    } else {
      activeProfile = loadActiveProfile();
    }
    progress = loadProgressForActive();
    planned = loadPlannedForActive();
    notes = loadNotesForActive();
    {
      const td = loadTripsForActive();
      trips = td.trips;
      activeTripId = td.activeTripId;
      // If trips were loaded, prefer them as the source of truth.
      if (trips.length > 0) syncPlannedFromActiveTrip();
      else if (planned.size > 0) {
        // Wrap legacy planned set into a default trip and persist
        ensureActiveTrip();
        syncActiveTripFromPlanned();
        saveTrips();
      }
    }
    prefs = loadPrefs();
    // Apply any plan_*=… params in the URL hash (from a "Share plan" link)
    applyURLPlanMeta();

    directionEl.value = prefs.direction;
    viewModeEl.value = prefs.viewMode || "state";
    showSheltersEl.checked = prefs.showShelters;
    colorByYearEl.checked = prefs.colorByYear;
    applyTheme();

    loadingEl.style.display = "none";
    renderProfileSelect();
    drawSegmentsOnMap();
    drawLoreOnMap();
    renderSections();
    updateStats();
    refreshMapStyles();

    sectionsEl.addEventListener("click", onSidebarClick);
    sectionsEl.addEventListener("change", onSidebarChange);
    sectionsEl.addEventListener("input", onSidebarInput);
    sectionsEl.addEventListener("mouseover", (e) => {
      const row = e.target.closest("[data-seg]");
      if (row && !row._hovered) {
        row._hovered = true;
        onSidebarHover({ type: "mouseenter", target: row });
        row.addEventListener("mouseleave", () => {
          row._hovered = false;
          onSidebarHover({ type: "mouseleave", target: row });
        }, { once: true });
      }
    });

    filterEl.addEventListener("input", () => renderSections());
    filterHikedEl.addEventListener("change", () => renderSections());
    if (filterPlannedEl) filterPlannedEl.addEventListener("change", () => renderSections());
    $("multi-select-btn")?.addEventListener("click", toggleMultiSelect);
    $("add-trip-btn")?.addEventListener("click", toggleAddTripMode);
    // Banner is rendered dynamically; delegate cancel + Esc.
    document.addEventListener("click", (e) => {
      if (e.target.id === "add-trip-cancel") {
        e.preventDefault();
        exitAddTripMode();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && addTripMode) exitAddTripMode();
    });
    $("legend-toggle")?.addEventListener("click", toggleLegend);
    // Default: legend collapsed. Only stay expanded if user explicitly
    // opened it (stored value === "0"). This keeps the map clean on first
    // visit and respects the user's preference once set.
    try {
      if (localStorage.getItem("at-tracker-legend-collapsed") !== "0") {
        $("map-legend")?.classList.add("collapsed");
      }
    } catch (e) {}
    directionEl.addEventListener("change", applyDirection);
    viewModeEl.addEventListener("change", applyViewMode);
    showSheltersEl.addEventListener("change", applyShelterToggle);
    colorByYearEl.addEventListener("change", applyColorByYear);

    profileSelectEl.addEventListener("change", () => switchProfile(profileSelectEl.value));
    $("profile-add").addEventListener("click", onAddProfile);
    $("profile-rename").addEventListener("click", onRenameProfile);
    $("profile-delete").addEventListener("click", onDeleteProfile);

    // ----- Identity dropdown + overflow menus (top toolbar, modal footers).
    // Single delegated listener so we don't have to wire every menu by ID.
    const closeAllMenus = () => {
      document.querySelectorAll(".overflow-menu.open").forEach((m) => {
        m.classList.remove("open");
        const t = m.querySelector(".overflow-trigger");
        if (t) t.setAttribute("aria-expanded", "false");
      });
      const ident = $("identity-control");
      if (ident && ident.classList.contains("open")) {
        ident.classList.remove("open");
        $("identity-trigger")?.setAttribute("aria-expanded", "false");
      }
    };
    document.addEventListener("click", (e) => {
      // Identity trigger toggles the avatar panel.
      const identTrigger = e.target.closest("#identity-trigger");
      if (identTrigger) {
        e.stopPropagation();
        const ident = $("identity-control");
        const wasOpen = ident.classList.contains("open");
        closeAllMenus();
        if (!wasOpen) {
          ident.classList.add("open");
          identTrigger.setAttribute("aria-expanded", "true");
        }
        return;
      }
      // Overflow menu trigger toggles its own panel.
      const trigger = e.target.closest(".overflow-trigger");
      if (trigger) {
        const menu = trigger.closest(".overflow-menu");
        if (!menu) return;
        e.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        closeAllMenus();
        if (!wasOpen) {
          menu.classList.add("open");
          trigger.setAttribute("aria-expanded", "true");
        }
        return;
      }
      // Click on a menu item — close after the action runs.
      const inMenuItem = e.target.closest(".overflow-list button");
      if (inMenuItem) {
        // Defer close until the click handler has executed and (likely)
        // opened a modal; otherwise the modal sees a stray outside-click.
        setTimeout(closeAllMenus, 0);
        return;
      }
      // Click anywhere else closes any open menu/panel — but not when the
      // click is inside the still-open identity panel (form interactions).
      if (e.target.closest("#identity-panel")) return;
      if (e.target.closest(".overflow-list")) return;
      closeAllMenus();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllMenus();
    });

    $("share-btn").addEventListener("click", openShare);
    $("share-close").addEventListener("click", () => $("share-modal").classList.remove("show"));
    $("share-copy").addEventListener("click", copyShareUrl);
    $("save-file").addEventListener("click", saveBackupFile);
    $("load-btn").addEventListener("click", () => {
      $("load-code").value = "";
      $("load-file").value = "";
      $("load-file-status").textContent = "";
      $("load-modal").classList.add("show");
    });
    $("load-cancel").addEventListener("click", () => $("load-modal").classList.remove("show"));
    $("load-go").addEventListener("click", doLoad);
    $("load-file").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) loadBackupFile(f);
    });
    $("reset-btn").addEventListener("click", doReset);

    $("gpx-export-btn").addEventListener("click", exportGPX);
    $("gpx-import-btn").addEventListener("click", openGpxImport);
    $("kml-export-btn")?.addEventListener("click", exportKML);
    $("gpx-import-cancel").addEventListener("click", () => $("gpx-import-modal").classList.remove("show"));
    $("gpx-import-go").addEventListener("click", doGpxImport);

    $("bulk-date-cancel").addEventListener("click", () => { pendingBulkRange = null; $("bulk-date-modal").classList.remove("show"); });
    $("bulk-date-skip").addEventListener("click", () => applyBulkDate(todayISO()));
    $("bulk-date-go").addEventListener("click", () => applyBulkDate($("bulk-date-input").value || todayISO()));

    $("stats-btn").addEventListener("click", renderStats);
    $("stats-close").addEventListener("click", () => $("stats-modal").classList.remove("show"));
    $("planned-btn").addEventListener("click", renderPlannedSummary);
    $("planned-close").addEventListener("click", () => $("planned-modal").classList.remove("show"));
    $("planned-clear").addEventListener("click", clearAllPlanned);
    $("planned-mark-hiked").addEventListener("click", markPlannedAsHiked);
    $("planned-print")?.addEventListener("click", printPlannedView);
    $("planned-share")?.addEventListener("click", openSharePlan);
    $("planned-export-kml")?.addEventListener("click", exportKML);
    $("share-plan-close")?.addEventListener("click", () => $("share-plan-modal").classList.remove("show"));
    $("share-plan-copy-url")?.addEventListener("click", () => {
      const inp = $("share-plan-url");
      inp.select();
      navigator.clipboard.writeText(inp.value).catch(() => document.execCommand("copy"));
      const btn = $("share-plan-copy-url");
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = orig), 1200);
    });
    $("share-plan-copy-text")?.addEventListener("click", () => {
      const ta = $("share-plan-text");
      ta.select();
      navigator.clipboard.writeText(ta.value).catch(() => document.execCommand("copy"));
      const btn = $("share-plan-copy-text");
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = orig), 1200);
    });
    $("theme-btn").addEventListener("click", toggleTheme);

    // Auto-update theme if user has system pref and we're following it
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener && mq.addEventListener("change", () => {
        if (prefs.theme === null) applyTheme();
      });
    }

    $("print-btn").addEventListener("click", () => {
      // Expand all states so print shows everything
      document.querySelectorAll(".state.collapsed").forEach(s => s.classList.remove("collapsed"));
      window.print();
    });

    document.querySelectorAll(".modal-bg").forEach((m) => {
      m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); });
    });

    wireAuthUI();

    // Global search wiring
    $("search-btn")?.addEventListener("click", openSearch);
    $("search-input")?.addEventListener("input", (e) => renderSearchResults(e.target.value));
    $("search-input")?.addEventListener("keydown", searchKeyDown);
    $("search-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "search-overlay") closeSearch();
    });
    document.addEventListener("keydown", (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      const inField = tag === "input" || tag === "textarea" || tag === "select";
      if (e.key === "/" && !inField) {
        e.preventDefault();
        openSearch();
      } else if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        openSearch();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  // Register service worker for offline use. Only over http(s); skip on file://.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch((e) => {
        console.warn("service worker registration failed:", e);
      });
    });
  }
})();
