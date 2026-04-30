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
  function styleFor(segId) {
    const date = progress.get(segId);
    const hiked = progress.has(segId);
    const isPlanned = planned.has(segId);
    if (!hiked) {
      if (isPlanned) return { color: "#1a5fb4", weight: 4, opacity: 0.95, dashArray: "6 5" };
      return { color: "#7a4f3a", weight: 2.5, opacity: 0.85, dashArray: null };
    }
    let color = "#2a7d3a";
    if (prefs.colorByYear) {
      const year = date ? Number(date.slice(0, 4)) : null;
      color = yearColor(year);
    }
    return { color, weight: 5, opacity: 0.95, dashArray: null };
  }
  function drawSegmentsOnMap() {
    const bounds = L.latLngBounds([]);
    DATA.segments.forEach((seg) => {
      const latlngs = seg.geom.map(([lon, lat]) => [lat, lon]);
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
      if (!segsByState.has(seg.state)) segsByState.set(seg.state, []);
      segsByState.get(seg.state).push(seg);
    }
    if (reverse) {
      for (const list of segsByState.values()) list.reverse();
    }

    const orderedStates = [...DATA.states].sort((a, b) => (reverse ? b.order - a.order : a.order - b.order));
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
      html.push(`<span>${escapeHtml(st.name)}</span>`);
      html.push(`<span class="state-stats"><span class="done">${hikedCount}</span>/${segs.length} · ${hikedMi.toFixed(1)}/${totalStateMi.toFixed(1)} mi</span>`);
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
      const startDate = prefs.tripStartDate || todayISO();
      const zeroFreq = prefs.zeroDayFreq != null ? prefs.zeroDayFreq : 0;
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
  function buildItinerary(plannedSegs, paceMi, startISO, zeroFreq) {
    const days = [];
    let curMi = 0;
    let curGain = 0;
    let curLoss = 0;
    let dayStart = plannedSegs.length > 0 ? plannedSegs[0].from : null;
    let segIdx = 0;
    let consumedMiInCurSeg = 0; // miles used out of the current segment
    while (segIdx < plannedSegs.length) {
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
      days.push({
        from: dayStart,
        to: chosen.end,
        toIcon: chosen.endIcon,
        toKind: chosen.endKind,
        miles: chosen.mi,
        gain: chosen.gain,
        loss: chosen.loss,
      });
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
    const itinerary = buildItinerary(plannedSegs, pace, startISO, zeroFreq);
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
        rows.push(
          `<div class="iti-row"><span class="iti-day">${dayOfWeek(d.date)}</span>` +
          `<span class="iti-date">${escapeHtml(d.date)}</span>` +
          `<span class="iti-text">Day ${hikeNum}: <strong>${escapeHtml(d.from)}</strong> → <strong>${d.toIcon} ${escapeHtml(d.to)}</strong></span>` +
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
  // -------- Theme --------
  function applyTheme() {
    const wantDark = prefs.theme === "dark"
      || (prefs.theme === null && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("theme-dark", wantDark);
    const btn = $("theme-btn");
    if (btn) btn.textContent = wantDark ? "☼" : "☾";
  }
  function toggleTheme() {
    const isDark = document.body.classList.contains("theme-dark");
    prefs.theme = isDark ? "light" : "dark";
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
    const segs = DATA.segments.filter((s) => s.state === stateName);
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
    document.body.classList.toggle("multi-select", multiSelectMode);
    document.querySelectorAll(".seg[data-anchor]").forEach((el) => el.removeAttribute("data-anchor"));
    const btn = $("multi-select-btn");
    if (btn) btn.setAttribute("aria-pressed", String(multiSelectMode));
  }
  function toggleLegend() {
    const el = $("map-legend");
    if (!el) return;
    el.classList.toggle("collapsed");
    try { localStorage.setItem("at-tracker-legend-collapsed", el.classList.contains("collapsed") ? "1" : ""); } catch (e) {}
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

    // Load wikitrail features (resupply, maildrop, hostel, hotel, restaurant, etc.)
    // Optional — app keeps working if file is missing.
    try {
      const fr = await fetch("at_features.json", { cache: "no-cache" });
      if (fr.ok) {
        FEATURES = await fr.json();
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
    $("legend-toggle")?.addEventListener("click", toggleLegend);
    // Restore collapsed legend state from localStorage
    try {
      if (localStorage.getItem("at-tracker-legend-collapsed") === "1") {
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
