/* AT Section Tracker — vanilla JS app
 * Per-profile state stored in localStorage; URL hash holds shareable encoded snapshot.
 * Notes stored only in localStorage (not in share code, to keep URLs short).
 */
(() => {
  const DATA_URL = "at_data.json";
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
  let segIndex = new Map();
  let segCumulative = new Map();
  let progress = new Map();
  let planned = new Set();
  let notes = new Map();
  let prefs = {
    direction: "nobo",
    showShelters: true,
    colorByYear: false,
    viewMode: "state",
    theme: null, // null = follow system; "light" or "dark" = explicit
  };
  let profiles = [DEFAULT_PROFILE];
  let activeProfile = DEFAULT_PROFILE;
  let map = null;
  let segLayers = new Map();
  let shelterLayer = null;
  let lastShiftAnchor = null;
  let pendingBulkRange = null; // {from, to, ids}
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
  }
  function savePlanned() { saveProgress(); /* planned saves go through the same URL/LS path */ }
  function saveNotes() {
    const obj = {};
    for (const [k, v] of notes) if (v) obj[k] = v;
    safeSet(notesKey(activeProfile), JSON.stringify(obj));
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
    L.control.layers({ "OpenStreetMap": osm, "OpenTopoMap (terrain)": topo }, null, { position: "topright" }).addTo(map);

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
  function yearColor(year) {
    if (!year) return "#2a7d3a";
    const hue = ((year - 2000) * 47) % 360;
    return `hsl(${hue}, 60%, 38%)`;
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
          if (stateEl) stateEl.classList.remove("collapsed");
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
      const collapsedClass = filterText || onlyHiked || onlyPlanned ? "" : " collapsed";
      html.push(`<section class="state${collapsedClass}" data-state="${escapeHtml(st.name)}">`);
      html.push(`<header class="state-header">`);
      html.push(`<svg class="caret" viewBox="0 0 12 12" fill="currentColor"><path d="M3 4.5l3 3 3-3"/></svg>`);
      html.push(`<span>${escapeHtml(st.name)}</span>`);
      html.push(`<span class="state-stats"><span class="done">${hikedCount}</span>/${segs.length} · ${hikedMi.toFixed(1)}/${totalStateMi.toFixed(1)} mi</span>`);
      html.push(`</header>`);
      html.push(`<div class="state-body">`);
      const today = todayISO();
      for (const seg of visible) {
        const hiked = progress.has(seg.id);
        const date = progress.get(seg.id) || "";
        const note = notes.get(seg.id) || "";
        const cumStart = segCumulative.get(seg.id) || 0;
        const displayMi = reverse ? (totalMi - (cumStart + seg.miles)) : cumStart;
        const isPlanned = planned.has(seg.id);
        html.push(`<div class="seg${hiked ? " hiked" : ""}${isPlanned ? " planned" : ""}" data-seg="${seg.id}">`);
        html.push(`<input type="checkbox" data-toggle="${seg.id}" ${hiked ? "checked" : ""} title="Click to mark hiked; shift-click to mark a range"/>`);
        html.push(`<div class="name">${escapeHtml(seg.from)}<span class="arrow">→</span>${escapeHtml(seg.to)}</div>`);
        html.push(`<div class="miles"><span class="miles-text">${seg.miles.toFixed(1)} mi<span class="cum">@ ${displayMi.toFixed(1)} mi</span></span>` +
          `<button class="plan-btn" data-plan="${seg.id}" title="${isPlanned ? "Remove from planned" : "Mark as next planned hike"}" aria-label="Toggle planned"><svg viewBox="0 0 16 16" fill="${isPlanned ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.4"><path d="M3 14V2.5L8 4.5L13 2.5V11.5L8 13.5L3 11.5"/></svg></button>` +
          `<button class="zoom-btn" data-zoom="${seg.id}" title="Zoom map to this section" aria-label="Zoom to section"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001q.044.06.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1 1 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0M6.5 3a.5.5 0 0 1 .5.5V6h2.5a.5.5 0 0 1 0 1H7v2.5a.5.5 0 0 1-1 0V7H3.5a.5.5 0 0 1 0-1H6V3.5a.5.5 0 0 1 .5-.5"/></svg></button>` +
          `</div>`);
        html.push(`<div class="date-row">`);
        html.push(`<label style="font-size:12px;color:var(--muted)">Date:</label>`);
        html.push(`<input type="date" data-date="${seg.id}" value="${escapeHtml(date)}" max="${today}" />`);
        html.push(`</div>`);
        html.push(`<div class="notes-row"><textarea data-note="${seg.id}" placeholder="Notes (weather, who you hiked with, conditions…)" rows="1">${escapeHtml(note)}</textarea></div>`);
        html.push(`</div>`);
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
  function renderPlannedSummary() {
    // Only count plan-but-not-yet-hiked
    const plannedSegs = [...planned]
      .filter((id) => !progress.has(id))
      .map((id) => segIndex.get(id))
      .filter(Boolean)
      .sort((a, b) => a.id - b.id);

    const totalMi = plannedSegs.reduce((a, s) => a + s.miles, 0);
    const states = [...new Set(plannedSegs.map((s) => s.state))];
    // Elevation: use seg.elev_gain / seg.elev_loss if present in data (added at build time)
    const gain = plannedSegs.reduce((a, s) => a + (s.elev_gain || 0), 0);
    const loss = plannedSegs.reduce((a, s) => a + (s.elev_loss || 0), 0);
    const hasElev = plannedSegs.some((s) => typeof s.elev_gain === "number");

    // Find road crossings on the plan: any segment endpoint name that looks
    // like a road (contains "(US ", "(SR ", "Highway", "Road", or numeric ref)
    const breakpoints = new Set();
    for (const s of plannedSegs) {
      breakpoints.add(s.from);
      breakpoints.add(s.to);
    }
    const roadLike = [...breakpoints].filter((n) =>
      /\(US\s|\(SR\s|\(VA\s|\(NC\s|\(TN\s|\(NY\s|\(VT\s|\(NH\s|\(ME\s|\(CT\s|\(MA\s|\(GA\s|\(PA\s|\(MD\s|\(WV\s|\(NJ\s|Highway|Road|Parkway|Avenue|Boulevard|Drive|Pike/i.test(n)
    );
    const shelterLike = [...breakpoints].filter((n) =>
      /shelter|lean.?to|cabin|hut/i.test(n) && !roadLike.includes(n)
    );

    // Estimate trip days: assume a moderate 12 mi/day pace
    const estDays = totalMi > 0 ? Math.max(1, Math.round(totalMi / 12)) : 0;

    // Detect contiguous runs of planned segment ids
    const sorted = plannedSegs.map((s) => s.id).sort((a, b) => a - b);
    const allOrdered = [...DATA.segments].sort((a, b) => a.id - b.id);
    const idIndex = new Map(allOrdered.map((s, i) => [s.id, i]));
    let runs = [];
    let runStart = null, runEnd = null, runMi = 0;
    for (const id of sorted) {
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
      }
      statsRows.push(["States", states.join(", ") || "—"]);
      statsRows.push(["Estimated trip", `${estDays} day${estDays === 1 ? "" : "s"} @ 12 mi/day`]);
      if (runs.length > 1) {
        statsRows.push(["Number of distinct stretches", runs.length]);
        statsRows.push(["Longest stretch", `${Math.max(...runs.map((r) => r.mi)).toFixed(1)} mi`]);
      }
      html.push(grid(statsRows));

      html.push(`<h3>Sections</h3>`);
      let cumMi = 0;
      for (const s of plannedSegs) {
        cumMi += s.miles;
        html.push(`<div class="seg-line">${escapeHtml(s.from)} → ${escapeHtml(s.to)} <small style="color:var(--muted)">(${escapeHtml(s.state)})</small><span class="mi">${s.miles.toFixed(1)} mi · ${cumMi.toFixed(1)} cum</span></div>`);
      }

      if (roadLike.length > 0) {
        html.push(`<h3>Road access points</h3>`);
        html.push(`<div style="font-size: 12px;">${roadLike.map(escapeHtml).join(" · ")}</div>`);
      }
      if (shelterLike.length > 0) {
        html.push(`<h3>Shelters along the way</h3>`);
        html.push(`<div style="font-size: 12px;">${shelterLike.map(escapeHtml).join(" · ")}</div>`);
      }
      if (!hasElev) {
        html.push(`<h3>Note</h3>`);
        html.push(`<div style="font-size: 12px; color: var(--muted);">Elevation gain/loss not yet available — rebuild data with elevation enabled to add it.</div>`);
      }
    }
    $("planned-profile-name").textContent = activeProfile;
    $("planned-body").innerHTML = html.join("");
    $("planned-modal").classList.add("show");
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
    const planBtn = e.target.closest("[data-plan]");
    if (planBtn) {
      e.preventDefault();
      e.stopPropagation();
      const id = Number(planBtn.dataset.plan);
      if (planned.has(id)) planned.delete(id);
      else planned.add(id);
      saveProgress();
      renderSections();
      updateStats();
      refreshMapStyles();
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
    const header = e.target.closest(".state-header");
    if (header) {
      header.parentElement.classList.toggle("collapsed");
      return;
    }
    const cb = e.target.closest("[data-toggle]");
    if (cb) {
      const id = Number(cb.dataset.toggle);
      const desired = cb.checked;
      if (e.shiftKey && lastShiftAnchor !== null && lastShiftAnchor !== id) {
        const ids = rangeIds(lastShiftAnchor, id);
        // Roll back the visual flip from the click; modal will do the work.
        cb.checked = !desired;
        lastShiftAnchor = id;
        if (desired) {
          openBulkDate(ids, true);
        } else {
          // Bulk uncheck doesn't need a date prompt.
          for (const sid of ids) toggleSegment(sid, false);
          saveProgress();
          renderSections();
          updateStats();
          refreshMapStyles();
        }
        return;
      }
      toggleSegment(id, desired);
      lastShiftAnchor = id;
      saveProgress();
      renderSections();
      updateStats();
      refreshMapStyles();
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
      }
    }
  }
  function onSidebarInput(e) {
    const noteInput = e.target.closest("[data-note]");
    if (noteInput) {
      const id = Number(noteInput.dataset.note);
      notes.set(id, noteInput.value);
      saveNotes();
    }
  }
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
    renderProfileSelect();
    renderSections();
    updateStats();
    refreshMapStyles();
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
    prefs = loadPrefs();

    directionEl.value = prefs.direction;
    viewModeEl.value = prefs.viewMode || "state";
    showSheltersEl.checked = prefs.showShelters;
    colorByYearEl.checked = prefs.colorByYear;
    applyTheme();

    loadingEl.style.display = "none";
    renderProfileSelect();
    drawSegmentsOnMap();
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
    $("load-btn").addEventListener("click", () => { $("load-code").value = ""; $("load-modal").classList.add("show"); });
    $("load-cancel").addEventListener("click", () => $("load-modal").classList.remove("show"));
    $("load-go").addEventListener("click", doLoad);
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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
