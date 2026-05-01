#!/usr/bin/env python3
"""Fetch AT trail + shelters from Overpass, stitch into one south->north line,
split at each shelter into segments, and write a compact data bundle."""
import json
import math
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# state name -> (relation_id, ordering_index south-to-north)
STATES = [
    ("Georgia",            2007643,  0),
    ("North Carolina/Tennessee", 18319351, 1),
    ("Virginia",           18321044, 2),
    ("West Virginia",      19123292, 3),
    ("Maryland",           18330829, 4),
    ("Pennsylvania",       18326382, 5),
    ("New Jersey/New York", 2007688, 6),
    ("Connecticut",        3352289,  7),
    ("Massachusetts",      2991960,  8),
    ("Vermont",            392991,   9),
    ("New Hampshire",      18319298, 10),
    ("Maine",              2007932,  11),
]

OUT_PATH = Path(__file__).parent / "at_data.json"
KMZ_PATH = Path(__file__).parent / "at_kmz_source.kmz"
CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
ELEV_CACHE = CACHE_DIR / "elev.json"

# Official NPS APPA "Features and Facilities" service. Joint NPS + ATC.
# Updated 2025-04. Public.
APPA_BASE = "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/ANST_Facilities/FeatureServer"
APPA_LAYERS = {
    "bridges": 0,
    "campsites": 1,
    "parking": 2,
    "privies": 3,
    "shelters": 4,
    "vistas": 5,
    "side_trails": 6,
    "treadway": 7,
}

# Open-Elevation supports POST batches up to ~1000 points.
OPEN_ELEV_URL = "https://api.open-elevation.com/api/v1/lookup"
OPEN_ELEV_BATCH = 500


def load_elev_cache() -> dict:
    if ELEV_CACHE.exists():
        try:
            return json.loads(ELEV_CACHE.read_text())
        except Exception:
            return {}
    return {}


def save_elev_cache(cache: dict) -> None:
    ELEV_CACHE.write_text(json.dumps(cache))


def elev_key(lon: float, lat: float) -> str:
    """Quantize to ~10m so nearby queries dedupe."""
    return f"{round(lat, 5)},{round(lon, 5)}"


def fetch_elevations(coords: list, cache: dict) -> list:
    """Return a list of elevations (meters) parallel to coords, using cache.
    Open-Elevation returns null for unknown points; we substitute None and
    interpolate at smoothing time."""
    keys = [elev_key(lon, lat) for lon, lat in coords]
    missing_idx = [i for i, k in enumerate(keys) if k not in cache]
    if not missing_idx:
        return [cache[k] for k in keys]
    print(f"    fetching {len(missing_idx)} elevations...", flush=True)
    for batch_start in range(0, len(missing_idx), OPEN_ELEV_BATCH):
        batch = missing_idx[batch_start:batch_start + OPEN_ELEV_BATCH]
        body = {
            "locations": [
                {"latitude": coords[i][1], "longitude": coords[i][0]} for i in batch
            ]
        }
        data = json.dumps(body).encode()
        last_err = None
        for attempt in range(4):
            try:
                req = urllib.request.Request(
                    OPEN_ELEV_URL,
                    data=data,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "at-tracker-build/1.0",
                    },
                )
                with urllib.request.urlopen(req, timeout=180) as r:
                    resp = json.loads(r.read())
                results = resp.get("results", [])
                for j, item in enumerate(results):
                    i = batch[j]
                    cache[keys[i]] = item.get("elevation")
                break
            except Exception as e:
                last_err = e
                print(f"      elev batch attempt {attempt+1} failed: {e}")
                time.sleep(8 * (attempt + 1))
        else:
            print(f"      WARNING: elevation batch failed: {last_err}")
            for i in batch:
                cache[keys[i]] = None
        save_elev_cache(cache)
        time.sleep(0.5)
    return [cache[k] for k in keys]


def smooth_and_compute_gain_loss(elevs_m: list) -> tuple:
    """Return (gain_m, loss_m). Skip Nones; lightly smooth with a 3-point
    moving average to avoid noise blow-up."""
    e = [x for x in elevs_m if x is not None]
    if len(e) < 2:
        return 0.0, 0.0
    sm = []
    for i in range(len(e)):
        a = e[max(0, i - 1)]
        b = e[i]
        c = e[min(len(e) - 1, i + 1)]
        sm.append((a + b + c) / 3.0)
    gain = 0.0
    loss = 0.0
    NOISE_M = 1.0
    last = sm[0]
    for v in sm[1:]:
        d = v - last
        if d > NOISE_M:
            gain += d
        elif d < -NOISE_M:
            loss += -d
        last = v
    return gain, loss


def cached_fetch(rel_id: int) -> dict:
    """Cache raw Overpass output per state on disk so repeated runs don't refetch."""
    p = CACHE_DIR / f"rel_{rel_id}.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    data = fetch_state(rel_id)
    p.write_text(json.dumps(data))
    return data


def overpass(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for attempt in range(8):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            req = urllib.request.Request(
                endpoint, data=body,
                headers={"User-Agent": "at-tracker-build/1.0 (arinbennett@gmail.com)"},
            )
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.loads(r.read())
        except Exception as e:
            last_err = e
            print(f"  overpass attempt {attempt+1} via {endpoint.split('//')[1].split('/')[0]} failed: {e}")
            # Exponential-ish backoff with jitter; rotate endpoint each try.
            time.sleep(min(60, 8 * (attempt + 1)))
    raise RuntimeError(f"overpass failed: {last_err}")


def fetch_state(rel_id: int) -> dict:
    """Two-stage fetch:
      Stage 1: trail relation + shelters (the relation recursion is unavoidable)
      Stage 2: roads inside the trail's bbox (no relation recursion -- just bbox)
    Stage 2 can't use `around.t:30` on long states because the implicit recursion
    blows past Overpass timeouts. A bbox query stays fast even for 400+ mile states."""
    q1 = f"""
[out:json][timeout:300];
rel({rel_id});
out body;
rel({rel_id});>>;
way._->.t;
.t out geom;
( node(around.t:800)[tourism=wilderness_hut];
  node(around.t:800)[amenity=shelter];
  node(around.t:800)[shelter_type=lean_to];
  node(around.t:800)[shelter_type=basic_hut];
  node(around.t:800)[building=shelter];
  way(around.t:800)[tourism=wilderness_hut];
  way(around.t:800)[amenity=shelter];
  way(around.t:800)[shelter_type=lean_to];
  way(around.t:800)[building=shelter]; );
out center;
"""
    a = overpass(q1)

    # Compute bbox of the trail ways from stage 1 with a small buffer.
    pts = []
    for el in a.get("elements", []):
        if el.get("type") == "way" and el.get("geometry"):
            for g in el["geometry"]:
                pts.append((g["lon"], g["lat"]))
    if not pts:
        return a
    min_x = min(p[0] for p in pts) - 0.005
    max_x = max(p[0] for p in pts) + 0.005
    min_y = min(p[1] for p in pts) - 0.005
    max_y = max(p[1] for p in pts) + 0.005

    time.sleep(1)
    q2 = f"""
[out:json][timeout:300][bbox:{min_y},{min_x},{max_y},{max_x}];
( way[highway~"^(motorway|trunk|primary|secondary|tertiary)$"][name];
  way[highway~"^(motorway|trunk|primary|secondary|tertiary)$"][ref]; );
out geom;
"""
    try:
        b = overpass(q2)
    except RuntimeError as e:
        print(f"  road fetch failed, continuing without roads: {e}")
        b = {"elements": []}
    return {"elements": (a.get("elements") or []) + (b.get("elements") or [])}


def fetch_appa_layer(layer_name: str) -> dict:
    """Fetch all features from one APPA REST layer as GeoJSON in WGS84.
    Cached per-layer in .cache/appa_<name>.json. Public service, no auth."""
    cache = CACHE_DIR / f"appa_{layer_name}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    layer_id = APPA_LAYERS[layer_name]
    print(f"  fetching APPA layer {layer_name} (id={layer_id})...")
    out = {"type": "FeatureCollection", "features": []}
    offset = 0
    page = 2000
    while True:
        params = {
            "where": "1=1",
            "outFields": "*",
            "returnGeometry": "true",
            "f": "geojson",
            "outSR": "4326",
            "resultOffset": str(offset),
            "resultRecordCount": str(page),
        }
        url = f"{APPA_BASE}/{layer_id}/query?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "at-tracker-build/1.0"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=300) as r:
                    data = json.loads(r.read())
                break
            except Exception as e:
                print(f"    retry {attempt+1}: {e}")
                time.sleep(5 * (attempt + 1))
        else:
            raise RuntimeError(f"failed to fetch APPA {layer_name}")
        feats = data.get("features", [])
        out["features"].extend(feats)
        if len(feats) < page or data.get("exceededTransferLimit") is False:
            break
        offset += len(feats)
        if offset > 10000:
            break
    cache.write_text(json.dumps(out))
    print(f"    {len(out['features'])} features")
    return out


def hav_km(a, b):
    lat1, lon1 = a[1], a[0]
    lat2, lon2 = b[1], b[0]
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def stitch_treadway(treadway_geojson: dict) -> list:
    """Stitch the 30 NPS-APPA Treadway club features into one ordered
    south-to-north list of (lon, lat) tuples. Each feature represents one
    trail-maintaining club's section of the AT.

    Approach:
      1. For each feature, extract its polyline coordinates (handle
         LineString and MultiLineString).
      2. Within a single MultiLineString feature (e.g. PATC across multiple
         counties), greedily concatenate parts in order.
      3. Across features, sort by southernmost endpoint's latitude and
         then chain head-to-tail, flipping each feature as needed to keep
         continuity.
    """
    feats = treadway_geojson.get("features", [])
    print(f"  stitching {len(feats)} Treadway features")
    chains = []  # list of {coords: [(lon,lat),...], name: str}
    for f in feats:
        geom = f.get("geometry", {})
        gtype = geom.get("type")
        coords_raw = geom.get("coordinates", [])
        if gtype == "LineString":
            parts = [coords_raw]
        elif gtype == "MultiLineString":
            parts = coords_raw
        else:
            continue
        # Stitch parts within this feature
        if not parts:
            continue
        parts = [[(c[0], c[1]) for c in p] for p in parts if len(p) >= 2]
        if not parts:
            continue
        parts.sort(key=lambda p: -len(p))  # longest first
        chain = list(parts.pop(0))
        used = [False] * len(parts)
        while not all(used):
            head, tail = chain[0], chain[-1]
            best = None  # (idx, action, dist)
            for i, p in enumerate(parts):
                if used[i]:
                    continue
                opts = (
                    ("tail+", hav_km(tail, p[0])),
                    ("tail-", hav_km(tail, p[-1])),
                    ("head+", hav_km(head, p[-1])),
                    ("head-", hav_km(head, p[0])),
                )
                for action, d in opts:
                    if best is None or d < best[2]:
                        best = (i, action, d)
            if best is None or best[2] > 0.5:
                break
            i, action, _ = best
            used[i] = True
            p = parts[i]
            if action == "tail+":
                chain.extend(p[1:])
            elif action == "tail-":
                chain.extend(reversed(p[:-1]))
            elif action == "head+":
                chain = list(reversed(p)) + chain[1:]
            elif action == "head-":
                chain = list(p) + chain[1:]
        # Orient this club's chain south-to-north
        if chain[0][1] > chain[-1][1]:
            chain.reverse()
        name = (f.get("properties") or {}).get("Name", "?")
        chains.append({"coords": chain, "name": name})

    # Greedy nearest-endpoint stitching: start with the feature whose lowest
    # endpoint is at the southernmost latitude (Springer Mtn end), then
    # repeatedly pick the unused feature whose start (or end, with flip)
    # is closest to the current master's tail. This avoids the failure mode
    # of latitude-only sorting where a feature's south endpoint is high
    # but its north endpoint is even higher (e.g. PATC spans 4 latitudes
    # of width and overlaps several other clubs).
    if not chains:
        return []
    chains.sort(key=lambda c: min(c["coords"][0][1], c["coords"][-1][1]))
    master_chain = chains.pop(0)
    master = list(master_chain["coords"])
    print(f"    seed: {master_chain['name']} ({len(master)} pts)")
    while chains:
        tail = master[-1]
        best_i, best_d, best_action = -1, float("inf"), "forward"
        for i, c in enumerate(chains):
            d_head = hav_km(tail, c["coords"][0])
            d_tail = hav_km(tail, c["coords"][-1])
            if d_head <= d_tail and d_head < best_d:
                best_d, best_i, best_action = d_head, i, "forward"
            elif d_tail < best_d:
                best_d, best_i, best_action = d_tail, i, "reverse"
        c = chains.pop(best_i)
        seg = c["coords"] if best_action == "forward" else list(reversed(c["coords"]))
        if best_d < 0.001:
            master.extend(seg[1:])
        else:
            master.extend(seg)
        print(f"    + {c['name']} (gap {best_d*1000:.0f}m)")
    if master[0][1] > master[-1][1]:
        master.reverse()
    return master


def ordered_chain(rel_member_way_ids, ways_by_id):
    """Build the canonical AT path by walking the relation's members in order.
    Each way is appended to the chain; we flip it if needed so its tail meets
    the previous tail. If there's a gap, we still continue (the AT is a single
    line — a 'gap' usually means an unmapped section, which we'll bridge with a
    straight line up to ~5 km, otherwise we start a new chain).
    Returns list of chains (each a list of (lon,lat) coords), ordered south->north."""
    GAP_BREAK_KM = 8.0  # if we can't bridge, start a new chain
    chain = []
    chains = []
    for wid in rel_member_way_ids:
        way = ways_by_id.get(wid)
        if not way or not way.get("geometry"):
            continue
        coords = [(g["lon"], g["lat"]) for g in way["geometry"]]
        if len(coords) < 2:
            continue
        if not chain:
            chain = list(coords)
            continue
        tail = chain[-1]
        d_fwd = hav_km(tail, coords[0])
        d_rev = hav_km(tail, coords[-1])
        # Pick whichever orientation lets us continue forward.
        if d_fwd <= d_rev:
            d, oriented = d_fwd, coords
        else:
            d, oriented = d_rev, list(reversed(coords))
        if d > GAP_BREAK_KM:
            # Genuine break — close the current chain and start fresh.
            if len(chain) >= 2:
                chains.append(chain)
            chain = list(oriented)
        else:
            # Append; if there's a small gap we just step across it (the linear
            # segment becomes a straight bridge, which is fine for display).
            if d < 1e-6:
                chain.extend(oriented[1:])
            else:
                chain.extend(oriented)
    if len(chain) >= 2:
        chains.append(chain)

    # Orient each chain south-to-north
    for i, c in enumerate(chains):
        if c[0][1] > c[-1][1]:
            chains[i] = list(reversed(c))

    chains.sort(key=lambda c: min(p[1] for p in c))
    return chains


def stitch_ways(ways):
    """Legacy greedy stitcher — kept for backwards compatibility but no longer
    used; the relation-order traversal handles the canonical AT path correctly."""
    raw = []
    for w in ways:
        if not w.get("geometry"):
            continue
        coords = [(g["lon"], g["lat"]) for g in w["geometry"]]
        if len(coords) >= 2:
            raw.append(coords)
    if not raw:
        return []

    # Build chains by greedy endpoint matching. First pass: tight tolerance
    # to preserve correct geometry. Second pass on the resulting chains:
    # bridge across slightly larger gaps so mapped fragments join up.
    used = [False] * len(raw)
    chains = []
    JOIN_KM = 0.05
    BRIDGE_KM = 1.5  # second-pass bridging tolerance for chain ends
    BRIDGE_MAX_LAT_DELTA = 0.05  # don't bridge across major latitude jumps

    while not all(used):
        start_i = used.index(False)
        used[start_i] = True
        chain = list(raw[start_i])

        extended = True
        while extended:
            extended = False
            head, tail = chain[0], chain[-1]
            best = None  # (d, i, action)
            for i, s in enumerate(raw):
                if used[i]:
                    continue
                a, b = s[0], s[-1]
                for action, d in (
                    ("tail+", hav_km(tail, a)),
                    ("tail-", hav_km(tail, b)),
                    ("head+", hav_km(head, b)),
                    ("head-", hav_km(head, a)),
                ):
                    if best is None or d < best[0]:
                        best = (d, i, action)
            if best and best[0] <= JOIN_KM:
                d, i, action = best
                used[i] = True
                s = raw[i]
                if action == "tail+":
                    chain.extend(s[1:])
                elif action == "tail-":
                    chain.extend(reversed(s[:-1]))
                elif action == "head+":
                    chain = list(reversed(s))[:-1] + chain
                elif action == "head-":
                    chain = s[:-1] + chain
                extended = True

        chains.append(chain)

    # Orient each chain south-to-north
    for i, c in enumerate(chains):
        if c[0][1] > c[-1][1]:
            chains[i] = list(reversed(c))

    # Second pass: bridge chains whose endpoints are within BRIDGE_KM. This
    # collapses fragments that are clearly the same trail with a small mapping
    # gap (frequent in Maine and PA).
    merged = True
    while merged:
        merged = False
        for i in range(len(chains)):
            if chains[i] is None:
                continue
            for j in range(len(chains)):
                if i == j or chains[j] is None:
                    continue
                a_head, a_tail = chains[i][0], chains[i][-1]
                b_head, b_tail = chains[j][0], chains[j][-1]
                opts = [
                    ("tail-head", hav_km(a_tail, b_head), lambda: chains[i] + chains[j]),
                    ("tail-tail", hav_km(a_tail, b_tail), lambda: chains[i] + list(reversed(chains[j]))),
                    ("head-tail", hav_km(a_head, b_tail), lambda: chains[j] + chains[i]),
                    ("head-head", hav_km(a_head, b_head), lambda: list(reversed(chains[j])) + chains[i]),
                ]
                opts.sort(key=lambda o: o[1])
                if opts[0][1] <= BRIDGE_KM:
                    # Only bridge if the joining endpoints are at similar latitudes;
                    # this prevents linking unrelated trail fragments.
                    name = opts[0][0]
                    if name == "tail-head":
                        lat_a, lat_b = a_tail[1], b_head[1]
                    elif name == "tail-tail":
                        lat_a, lat_b = a_tail[1], b_tail[1]
                    elif name == "head-tail":
                        lat_a, lat_b = a_head[1], b_tail[1]
                    else:
                        lat_a, lat_b = a_head[1], b_head[1]
                    if abs(lat_a - lat_b) <= BRIDGE_MAX_LAT_DELTA:
                        chains[i] = opts[0][2]()
                        chains[j] = None
                        merged = True
                        break
            if merged:
                break
    chains = [c for c in chains if c is not None]

    # Orient each merged chain south-to-north
    for i, c in enumerate(chains):
        if c[0][1] > c[-1][1]:
            chains[i] = list(reversed(c))

    # Drop tiny stub chains (<0.25 mi) - mapping noise or side trails
    out = []
    for c in chains:
        length_mi = sum(hav_km(c[k - 1], c[k]) for k in range(1, len(c))) * 0.621371
        if length_mi >= 0.25:
            out.append(c)

    # Sort chains south-to-north by southernmost point
    out.sort(key=lambda c: min(p[1] for p in c))
    return out


def cumulative_miles(coords):
    """Return list of along-trail miles for each vertex."""
    out = [0.0]
    for i in range(1, len(coords)):
        out.append(out[-1] + hav_km(coords[i - 1], coords[i]) * 0.621371)
    return out


def nearest_on_line(pt, coords, cum_mi):
    """Find nearest point on the polyline to pt=(lon,lat).
    Returns (along_miles, perpendicular_distance_km, snapped_coord)."""
    best = (float("inf"), 0.0, coords[0])
    for i in range(len(coords) - 1):
        a, b = coords[i], coords[i + 1]
        # project pt onto segment a->b in equirectangular space
        ax, ay = a
        bx, by = b
        px, py = pt
        # convert to local meters approx
        lat0 = (ay + by) * 0.5
        kx = math.cos(math.radians(lat0)) * 111.32
        ky = 110.574
        ax2, ay2 = 0, 0
        bx2 = (bx - ax) * kx
        by2 = (by - ay) * ky
        px2 = (px - ax) * kx
        py2 = (py - ay) * ky
        seg_len_sq = bx2 * bx2 + by2 * by2
        if seg_len_sq == 0:
            t = 0
        else:
            t = max(0, min(1, (px2 * bx2 + py2 * by2) / seg_len_sq))
        sx2 = bx2 * t
        sy2 = by2 * t
        dx = px2 - sx2
        dy = py2 - sy2
        d = math.sqrt(dx * dx + dy * dy)  # km
        if d < best[0]:
            sx = ax + (bx - ax) * t
            sy = ay + (by - ay) * t
            seg_mi = (cum_mi[i + 1] - cum_mi[i]) * t
            along = cum_mi[i] + seg_mi
            best = (d, along, (sx, sy))
    return best[1], best[0], best[2]


def simplify(coords, tol_deg=0.0001):
    """Douglas-Peucker simplify."""
    if len(coords) < 3:
        return coords[:]

    def perp(p, a, b):
        if a == b:
            return hav_km(p, a)
        ax, ay = a
        bx, by = b
        px, py = p
        dx = bx - ax
        dy = by - ay
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0, min(1, t))
        sx = ax + dx * t
        sy = ay + dy * t
        return math.hypot(px - sx, py - sy)

    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        max_d = 0
        idx = -1
        for k in range(i + 1, j):
            d = perp(coords[k], coords[i], coords[j])
            if d > max_d:
                max_d = d
                idx = k
        if max_d > tol_deg and idx > 0:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [c for c, k in zip(coords, keep) if k]


def slice_along(coords, cum_mi, m_start, m_end):
    """Extract sub-line between two along-trail mile values."""
    out = []
    for i in range(len(coords)):
        if cum_mi[i] >= m_start and cum_mi[i] <= m_end:
            out.append(coords[i])
        if cum_mi[i] > m_end:
            break
    # ensure exact endpoints
    if not out or out[0] != coords[0]:
        for i in range(1, len(coords)):
            if cum_mi[i] >= m_start:
                t = (m_start - cum_mi[i - 1]) / max(1e-9, cum_mi[i] - cum_mi[i - 1])
                p = (
                    coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
                    coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
                )
                out = [p] + out
                break
    for i in range(len(coords) - 1):
        if cum_mi[i] <= m_end <= cum_mi[i + 1]:
            seg = max(1e-9, cum_mi[i + 1] - cum_mi[i])
            t = (m_end - cum_mi[i]) / seg
            p = (
                coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
                coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
            )
            if not out or out[-1] != p:
                out.append(p)
            break
    return out


def shelter_coord(n):
    """Extract (lon, lat) from an Overpass node or way (with center)."""
    if n["type"] == "node":
        return n["lon"], n["lat"]
    c = n.get("center")
    if c:
        return c["lon"], c["lat"]
    return None


def segment_intersect(a, b, c, d):
    """Return intersection point of segments AB and CD, or None.
    Inputs are (lon, lat) tuples; works in lon/lat planar approximation
    (good enough at AT scale for crossing detection)."""
    x1, y1 = a
    x2, y2 = b
    x3, y3 = c
    x4, y4 = d
    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-12:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1))
    return None


_GRID_CELL = 0.02  # ~1.4 mi; tune for sparser/denser indices


def _cells_for_bbox(min_x, max_x, min_y, max_y):
    """Yield integer (cell_x, cell_y) keys whose square covers the bbox."""
    cx0 = int(min_x // _GRID_CELL)
    cx1 = int(max_x // _GRID_CELL)
    cy0 = int(min_y // _GRID_CELL)
    cy1 = int(max_y // _GRID_CELL)
    for cx in range(cx0, cx1 + 1):
        for cy in range(cy0, cy1 + 1):
            yield cx, cy


def _build_trail_grid(chains_data):
    """Spatial index: cell_key -> list of (chain_idx, seg_idx) tuples.

    Each AT mini-segment is registered in every cell its bbox touches.
    Lookup is O(cells_per_query × seg_density) instead of O(num_trail_segs).
    """
    grid: dict = {}
    for ci, ch in enumerate(chains_data):
        coords = ch["coords"]
        for i in range(len(coords) - 1):
            ax, ay = coords[i]
            bx, by = coords[i + 1]
            for key in _cells_for_bbox(min(ax, bx), max(ax, bx), min(ay, by), max(ay, by)):
                grid.setdefault(key, []).append((ci, i))
    return grid


def road_crossings(road_ways, chains_data):
    """For each road way, find every place where it crosses any chain of the AT.

    Uses a spatial grid index over AT mini-segments so each road segment only
    checks against the handful of trail segs that share its grid cells, not
    every trail seg in the entire AT. This brings runtime from O(R × T) to
    roughly O(R × constant) and avoids the multi-hour hang on the bbox cache.
    """
    grid = _build_trail_grid(chains_data)
    out = []
    for w in road_ways:
        if not w.get("geometry"):
            continue
        rcoords = [(g["lon"], g["lat"]) for g in w["geometry"]]
        if len(rcoords) < 2:
            continue
        tags = w.get("tags", {}) or {}
        ref = (tags.get("ref") or "").strip()
        name = (tags.get("name") or "").strip()
        if ref and name and name not in ref:
            label = f"{name} ({ref})"
        elif ref:
            label = ref
        elif name:
            label = name
        else:
            continue
        for j in range(len(rcoords) - 1):
            c = rcoords[j]
            d = rcoords[j + 1]
            cx, cy = c
            dx, dy = d
            # Find AT mini-segs in any cell this road sub-segment touches.
            # A small set keeps duplicates (when a road bbox spans multiple
            # cells that all index the same AT seg) from being tested twice.
            seen = set()
            for key in _cells_for_bbox(min(cx, dx), max(cx, dx), min(cy, dy), max(cy, dy)):
                bucket = grid.get(key)
                if not bucket:
                    continue
                for ref_pair in bucket:
                    if ref_pair in seen:
                        continue
                    seen.add(ref_pair)
                    ci, i = ref_pair
                    ch = chains_data[ci]
                    coords = ch["coords"]
                    cum = ch["cum_mi"]
                    a = coords[i]
                    b = coords[i + 1]
                    ix = segment_intersect(a, b, c, d)
                    if ix:
                        seg_len_km = hav_km(a, b)
                        partial = hav_km(a, ix) / seg_len_km if seg_len_km > 0 else 0
                        partial_mi = (cum[i + 1] - cum[i]) * partial
                        along = cum[i] + partial_mi
                        out.append({
                            "label": label,
                            "lat": ix[1],
                            "lon": ix[0],
                            "chain": ci,
                            "along_mi": along,
                        })
    # Dedupe near-duplicates (parallel lanes, divided highways).
    out.sort(key=lambda r: (r["chain"], r["along_mi"]))
    deduped = []
    for r in out:
        if (
            deduped
            and deduped[-1]["chain"] == r["chain"]
            and deduped[-1]["label"] == r["label"]
            and abs(deduped[-1]["along_mi"] - r["along_mi"]) < 0.05
        ):
            continue
        deduped.append(r)
    return deduped


def _filter_roads_to_trail_corridor(road_ways, chains_data):
    """Drop road ways whose bbox doesn't intersect any trail cell.

    The Overpass bbox query returns every road in the AT envelope, which is
    a wide rectangle (e.g. all of Eastern PA). The actual trail occupies a
    thin corridor through that rectangle. Cheaply rejecting roads that
    don't touch a trail-cell collapses the input by ~95% before the heavy
    intersection loop runs, and frees the underlying memory immediately.
    """
    trail_cells = set()
    for ch in chains_data:
        coords = ch["coords"]
        for i in range(len(coords) - 1):
            ax, ay = coords[i]
            bx, by = coords[i + 1]
            for key in _cells_for_bbox(min(ax, bx), max(ax, bx), min(ay, by), max(ay, by)):
                trail_cells.add(key)
    kept = []
    for w in road_ways:
        geom = w.get("geometry")
        if not geom or len(geom) < 2:
            continue
        rmin_x = min(g["lon"] for g in geom)
        rmax_x = max(g["lon"] for g in geom)
        rmin_y = min(g["lat"] for g in geom)
        rmax_y = max(g["lat"] for g in geom)
        for key in _cells_for_bbox(rmin_x, rmax_x, rmin_y, rmax_y):
            if key in trail_cells:
                kept.append(w)
                break
    return kept


def _backfill_geom_from_v2(segments):
    """Replace sparse v3 segment geometry with v2 OSM-derived geometry.

    A segment is "sparse" when either it has only 2 coords or contains an
    internal hop > 1 km — both indicate the NPS Treadway feed had a gap
    that the stitcher walked across with a straight line. The v2 dataset
    (OSM-stitched) covered those chunks, so we splice the v2 master
    polyline back in by matching v3 segment endpoints to nearest v2
    points.

    Modifies `segments` in place. Returns the number of segments touched.
    """
    v2_path = OUT_PATH.parent / "at_data_v2.json"
    if not v2_path.exists():
        return 0
    try:
        v2 = json.loads(v2_path.read_text())
    except Exception:
        return 0
    # Build the v2 master polyline (concatenate seg geoms, dedupe consecutive).
    v2_master = []
    for s in v2.get("segments", []):
        for p in s.get("geom", []):
            if not v2_master or v2_master[-1] != p:
                v2_master.append(p)
    if len(v2_master) < 2:
        return 0

    def hop_km(a, b):
        return hav_km((a[0], a[1]), (b[0], b[1]))

    def needs_backfill(geom):
        if not geom or len(geom) < 2:
            return False
        if len(geom) == 2:
            return hop_km(geom[0], geom[1]) > 0.5
        for i in range(len(geom) - 1):
            if hop_km(geom[i], geom[i + 1]) > 1.0:
                return True
        return False

    def nearest_idx(p, pts):
        best_i = 0
        best_d = float("inf")
        for i, q in enumerate(pts):
            d = hop_km(p, q)
            if d < best_d:
                best_d = d
                best_i = i
        return best_i, best_d

    touched = 0
    for s in segments:
        geom = s.get("geom") or []
        if not needs_backfill(geom):
            continue
        i0, d0 = nearest_idx(geom[0], v2_master)
        i1, d1 = nearest_idx(geom[-1], v2_master)
        # Endpoint matching can be loose — v2 and v3 use different break
        # points (so the same "shelter" or "road crossing" lat/lon may
        # differ by several km). Allow up to 10 km on either side.
        if d0 > 10.0 or d1 > 10.0:
            continue
        if abs(i0 - i1) < 2:
            continue
        if i0 < i1:
            sliced = v2_master[i0 : i1 + 1]
        else:
            sliced = list(reversed(v2_master[i1 : i0 + 1]))
        if len(sliced) < 3:
            continue
        # The spliced trail miles should be roughly comparable to the
        # segment's claimed miles. Allow 30%-300% to accommodate v2/v3
        # break-point differences without accepting wildly wrong slices.
        spliced_km = sum(hop_km(sliced[k], sliced[k + 1]) for k in range(len(sliced) - 1))
        spliced_mi = spliced_km / 1.609
        claimed_mi = s.get("miles", 0)
        if claimed_mi > 0 and (spliced_mi < 0.3 * claimed_mi or spliced_mi > 3.0 * claimed_mi):
            continue
        s["geom"] = [[round(c[0], 5), round(c[1], 5)] for c in sliced]
        touched += 1
    return touched


def parse_kmz(kmz_path):
    """Extract 44 trail paths + ~866 POIs from a KMZ file.

    Returns: {"paths": [{name, coords, folder}], "pois": {folder: [{name,lat,lon}]}}
    Coords are (lon, lat) tuples to match the rest of this file's convention.
    """
    import zipfile
    import xml.etree.ElementTree as ET
    with zipfile.ZipFile(kmz_path) as z:
        kml_name = next(n for n in z.namelist() if n.endswith(".kml"))
        with z.open(kml_name) as f:
            tree = ET.parse(f)
    ns = {"k": "http://www.opengis.net/kml/2.2"}
    root = tree.getroot()
    paths, pois = [], {}
    for folder in root.iter("{http://www.opengis.net/kml/2.2}Folder"):
        name_el = folder.find("k:name", ns)
        if name_el is None or name_el.text is None:
            continue
        fname = name_el.text
        for pm in folder.findall("k:Placemark", ns):
            pm_name_el = pm.find("k:name", ns)
            pm_name = pm_name_el.text if pm_name_el is not None else ""
            ls = pm.find("k:LineString/k:coordinates", ns)
            pt = pm.find("k:Point/k:coordinates", ns)
            if ls is not None and ls.text:
                coords = []
                for tok in ls.text.strip().split():
                    parts = tok.split(",")
                    if len(parts) >= 2:
                        try:
                            coords.append((float(parts[0]), float(parts[1])))
                        except ValueError:
                            pass
                if coords:
                    paths.append({"name": pm_name, "coords": coords, "folder": fname})
            elif pt is not None and pt.text:
                parts = pt.text.strip().split(",")
                if len(parts) >= 2:
                    try:
                        pois.setdefault(fname, []).append({
                            "name": pm_name,
                            "lon": float(parts[0]),
                            "lat": float(parts[1]),
                        })
                    except ValueError:
                        pass
    return {"paths": paths, "pois": pois}


def _build_kmz_master(paths):
    """Greedy nearest-endpoint chain of KMZ paths into one south-to-north line.

    The 44 KMZ paths are independent; the file order isn't guaranteed and any
    individual path may be reversed. Pick the southernmost-endpoint path as
    seed, then walk: for each unused path, choose the one whose head OR tail
    is closest to the running master's tail; reverse if needed; concatenate.
    """
    if not paths:
        return []
    remaining = list(paths)
    # Seed with the path whose southernmost endpoint is the lowest of all.
    def south_lat(p):
        return min(p["coords"][0][1], p["coords"][-1][1])
    remaining.sort(key=south_lat)
    seed = remaining.pop(0)
    master = list(seed["coords"])
    if master[0][1] > master[-1][1]:
        master.reverse()
    while remaining:
        tail = master[-1]
        best_i, best_d, best_action = -1, float("inf"), "forward"
        for i, p in enumerate(remaining):
            head = p["coords"][0]
            ptail = p["coords"][-1]
            d_head = hav_km(tail, head)
            d_tail = hav_km(tail, ptail)
            if d_head <= d_tail and d_head < best_d:
                best_d, best_i, best_action = d_head, i, "forward"
            elif d_tail < best_d:
                best_d, best_i, best_action = d_tail, i, "reverse"
        if best_i < 0:
            break
        p = remaining.pop(best_i)
        seg = p["coords"] if best_action == "forward" else list(reversed(p["coords"]))
        if best_d < 0.001:
            master.extend(seg[1:])
        else:
            master.extend(seg)
    return master


def _build_spatial_index(points, cell_deg=0.005):
    """Index a list of points by integer cell key for fast nearest-lookup."""
    grid = {}
    for i, p in enumerate(points):
        key = (int(p[0] // cell_deg), int(p[1] // cell_deg))
        grid.setdefault(key, []).append(i)
    return grid


def _nearest_in_grid(query, points, grid, cell_deg=0.005, search_radius=2):
    """Return (index, distance_km) of the nearest point to query."""
    cx, cy = int(query[0] // cell_deg), int(query[1] // cell_deg)
    best_i, best_d = -1, float("inf")
    for dx in range(-search_radius, search_radius + 1):
        for dy in range(-search_radius, search_radius + 1):
            for i in grid.get((cx + dx, cy + dy), []):
                d = hav_km(query, points[i])
                if d < best_d:
                    best_d = d
                    best_i = i
    return best_i, best_d


def _snap_kmz_to_nps(kmz_master, nps_master, threshold_m=100):
    """Snap each KMZ master point to the nearest NPS point if within threshold.

    Result: a hybrid polyline that follows the KMZ structure but uses NPS
    coordinates wherever the two datasets agree on the trail location.
    Where NPS data is missing (e.g. Daleville gap) the KMZ point is kept.
    """
    if not nps_master:
        return list(kmz_master), 0
    grid = _build_spatial_index(nps_master)
    threshold_km = threshold_m / 1000.0
    out = []
    snapped = 0
    for kp in kmz_master:
        idx, d = _nearest_in_grid(kp, nps_master, grid, search_radius=1)
        if idx >= 0 and d < threshold_km:
            out.append(nps_master[idx])
            snapped += 1
        else:
            out.append(kp)
    return out, snapped


def _project_pois_to_master(pois, master_coords, cum_mi, threshold_m=500):
    """For each POI, find its mile-along-trail by projection. Drop far-off POIs."""
    grid = _build_spatial_index(master_coords)
    threshold_km = threshold_m / 1000.0
    out = []
    for poi in pois:
        idx, d = _nearest_in_grid((poi["lon"], poi["lat"]), master_coords, grid, search_radius=4)
        if idx >= 0 and d < threshold_km:
            out.append({**poi, "mi": cum_mi[idx], "off_trail_km": d})
    return out


def _assign_states_from_v2(segments):
    """Stamp each v4 segment with the state of its nearest v2 segment midpoint.

    The v2 OSM dataset got states by which OSM relation a segment came from,
    which is the most authoritative geographic assignment we have. v3's
    mile-threshold approach failed because the master polyline isn't
    monotonic. Lat/lon proximity is reliable.
    """
    v2_path = OUT_PATH.parent / "at_data_v2.json"
    if not v2_path.exists():
        return 0
    v2 = json.loads(v2_path.read_text())
    anchors = []
    for s in v2.get("segments", []):
        g = s.get("geom") or []
        if not g:
            continue
        mp = g[len(g) // 2]
        anchors.append((mp, s.get("state", "?")))
    if not anchors:
        return 0
    grid = _build_spatial_index([a[0] for a in anchors], cell_deg=0.05)
    n = 0
    for s in segments:
        g = s.get("geom") or []
        if not g:
            continue
        mp = g[len(g) // 2]
        idx, _ = _nearest_in_grid(mp, [a[0] for a in anchors], grid, cell_deg=0.05, search_radius=4)
        if idx >= 0:
            s["state"] = anchors[idx][1]
            n += 1
    return n


def main_kmz():
    """V4 build pipeline: KMZ structure + NPS Treadway precision blend.

    Adopts the community-curated AT KMZ as the authoritative trail structure
    (44 named landmark-to-landmark paths, 866 organized POIs) and snaps its
    geometry to the NPS APPA Treadway feed wherever the two agree (within
    100 m), so we get the KMZ's clean topology + NPS's GIS precision. Falls
    back to the KMZ point alone where NPS has no nearby coverage (the
    Daleville/Pearisburg/NH-Maine gaps).

    Breakpoints come from the KMZ's shelter and road folders (240 + 54).
    State assignments come from v2 OSM relation membership via lat/lon
    proximity, which is monotonic in space and avoids the mile-threshold
    bugs that plagued v3.
    """
    print("=== STEP 1: Parse KMZ source ===")
    if not KMZ_PATH.exists():
        raise SystemExit(f"missing KMZ at {KMZ_PATH}")
    kmz = parse_kmz(KMZ_PATH)
    print(f"  paths: {len(kmz['paths'])}")
    for fname in sorted(kmz["pois"]):
        print(f"  POIs[{fname}]: {len(kmz['pois'][fname])}")

    print("=== STEP 2: Chain KMZ paths into south->north master ===")
    kmz_master = _build_kmz_master(kmz["paths"])
    raw_total_km = sum(hav_km(kmz_master[i], kmz_master[i + 1]) for i in range(len(kmz_master) - 1))
    print(f"  KMZ master coords: {len(kmz_master)}, length: {raw_total_km / 1.609:.1f} mi")

    print("=== STEP 3: Snap to NPS Treadway (blend) ===")
    treadway_geojson = fetch_appa_layer("treadway")
    nps_master = stitch_treadway(treadway_geojson)
    print(f"  NPS master coords: {len(nps_master)}")
    blended_master, snapped = _snap_kmz_to_nps(kmz_master, nps_master, threshold_m=100)
    pct = (100.0 * snapped / max(1, len(blended_master)))
    blended_total_km = sum(hav_km(blended_master[i], blended_master[i + 1]) for i in range(len(blended_master) - 1))
    print(f"  snapped {snapped}/{len(blended_master)} points to NPS ({pct:.1f}%)")
    print(f"  blended length: {blended_total_km / 1.609:.1f} mi")

    cum_mi = [0.0]
    for i in range(1, len(blended_master)):
        cum_mi.append(cum_mi[-1] + hav_km(blended_master[i - 1], blended_master[i]) / 1.609)
    total_mi = cum_mi[-1]

    print("=== STEP 4: Project KMZ POIs to master miles ===")
    shelter_pois = kmz["pois"].get("shelters", [])
    road_pois = kmz["pois"].get("roads", [])
    shelters = _project_pois_to_master(shelter_pois, blended_master, cum_mi, threshold_m=500)
    roads = _project_pois_to_master(road_pois, blended_master, cum_mi, threshold_m=500)
    print(f"  shelters on trail: {len(shelters)}/{len(shelter_pois)}")
    print(f"  road crossings on trail: {len(roads)}/{len(road_pois)}")

    breakpoints = [{"name": "Springer Mountain (Trail Start)", "mi": 0.0, "kind": "border"}]
    for sh in shelters:
        breakpoints.append({"name": sh["name"], "mi": sh["mi"], "kind": "shelter", "lat": sh["lat"], "lon": sh["lon"]})
    for rd in roads:
        breakpoints.append({"name": rd["name"], "mi": rd["mi"], "kind": "crossing", "lat": rd["lat"], "lon": rd["lon"]})
    breakpoints.append({"name": "Mount Katahdin (Trail End)", "mi": total_mi, "kind": "border"})
    breakpoints.sort(key=lambda b: b["mi"])
    collapsed = []
    for b in breakpoints:
        if collapsed and abs(collapsed[-1]["mi"] - b["mi"]) < 0.05:
            if b["name"] != collapsed[-1]["name"]:
                collapsed[-1] = {**collapsed[-1], "name": f"{collapsed[-1]['name']} / {b['name']}", "kind": "combined"}
            continue
        collapsed.append(b)
    breakpoints = collapsed
    print(f"  total breakpoints (post-dedup): {len(breakpoints)}")

    print("=== STEP 5: Build segments + elevation ===")
    elev_cache = load_elev_cache()
    out_segments = []
    seg_id = 0
    for i in range(len(breakpoints) - 1):
        a = breakpoints[i]
        b = breakpoints[i + 1]
        if b["mi"] - a["mi"] < 0.05:
            continue
        sub = slice_along(blended_master, cum_mi, a["mi"], b["mi"])
        sub = simplify(sub, tol_deg=0.00015)
        elevs_m = fetch_elevations(sub, elev_cache)
        gain_m, loss_m = smooth_and_compute_gain_loss(elevs_m)
        ft_per_m = 3.28084
        out_segments.append({
            "id": seg_id,
            "state": "?",
            "from": a["name"],
            "to": b["name"],
            "miles": round(b["mi"] - a["mi"], 2),
            "elev_gain": round(gain_m * ft_per_m, 1),
            "elev_loss": round(loss_m * ft_per_m, 1),
            "geom": [[round(c[0], 5), round(c[1], 5)] for c in sub],
        })
        seg_id += 1
    print(f"  segments built: {len(out_segments)}")
    save_elev_cache(elev_cache)

    print("=== STEP 6: Assign states via v2 anchors ===")
    n_assigned = _assign_states_from_v2(out_segments)
    print(f"  assigned: {n_assigned}/{len(out_segments)}")

    state_miles = {}
    for s in out_segments:
        state_miles[s["state"]] = state_miles.get(s["state"], 0) + s["miles"]
    canonical_order = [
        "Georgia", "North Carolina/Tennessee", "Virginia", "West Virginia",
        "Maryland", "Pennsylvania", "New Jersey/New York", "Connecticut",
        "Massachusetts", "Vermont", "New Hampshire", "Maine",
    ]
    out_states = [
        {"name": st, "order": canonical_order.index(st) if st in canonical_order else 99, "miles": round(m, 1)}
        for st, m in state_miles.items()
    ]
    out_states.sort(key=lambda x: x["order"])

    out_shelters = [{"name": s["name"], "lat": s["lat"], "lon": s["lon"]} for s in shelters]
    out_crossings = [{"label": c["name"], "lat": c["lat"], "lon": c["lon"]} for c in roads]
    bundle = {
        "version": 4,
        "generated": time.strftime("%Y-%m-%d"),
        "source": "AT KMZ (community-curated) + NPS APPA Treadway snap-fill",
        "states": out_states,
        "segments": out_segments,
        "shelters": out_shelters,
        "crossings": out_crossings,
    }
    OUT_PATH.write_text(json.dumps(bundle, separators=(",", ":")))
    total = sum(s["miles"] for s in out_segments)
    print(f"\n=== DONE ===")
    print(f"wrote {OUT_PATH} - {OUT_PATH.stat().st_size // 1024} KB")
    print(f"states={len(out_states)} segments={len(out_segments)} shelters={len(out_shelters)} crossings={len(out_crossings)}")
    print(f"total mileage: {total:.1f} mi")
    print("\nState breakdown:")
    for st in out_states:
        print(f"  {st['name']:25s} {st['miles']:7.1f} mi")


def main_nps():
    """V3 build pipeline driven by NPS APPA data.

    1. Fetch NPS Treadway centerline (30 club features) and stitch into one
       ordered list of (lon, lat) coords from Springer to Katahdin.
    2. Compute cumulative miles along the master line.
    3. Fetch NPS Shelters (280) and project each onto the master line by
       nearest-point. Filter to those within 800m of the trail.
    4. Fetch road crossings via OSM (NPS doesn't have these). Use the bbox
       of the master line and intersect with the trail.
    5. Determine each segment's state via cumulative-mile thresholds (we
       know roughly where state borders fall along the AT).
    6. Build segments: each consecutive pair of (NPS shelter | road crossing)
       becomes a segment.
    7. Compute elevation gain/loss per segment via Open-Elevation.
    8. Save at_data.json with version=3.
    """
    elev_cache = load_elev_cache()

    # 1. Fetch + stitch the NPS Treadway centerline
    print("=== STEP 1: NPS Treadway centerline ===")
    treadway = fetch_appa_layer("treadway")
    master_coords = stitch_treadway(treadway)
    if not master_coords:
        raise RuntimeError("failed to build master centerline from NPS Treadway")
    cum_mi = cumulative_miles(master_coords)
    total_mi = cum_mi[-1]
    print(f"master centerline: {len(master_coords)} pts, {total_mi:.1f} mi")

    # 2. Fetch + project NPS shelters
    print("=== STEP 2: NPS Shelters ===")
    shelters_geo = fetch_appa_layer("shelters")
    shelters_on_trail = []
    for f in shelters_geo.get("features", []):
        g = f.get("geometry", {})
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][0], g["coordinates"][1]
        along, perp_km, snap = nearest_on_line((lon, lat), master_coords, cum_mi)
        if perp_km > 0.8:  # > 800m off-trail = skip
            continue
        props = f.get("properties") or {}
        name = (props.get("Name") or "").strip()
        if not name:
            name = "Unnamed shelter"
        shelters_on_trail.append({
            "name": name,
            "lat": lat, "lon": lon,
            "mi": along,
            "perp_km": perp_km,
            "id": props.get("Acronym") or props.get("OBJECTID"),
        })
    shelters_on_trail.sort(key=lambda s: s["mi"])
    # Dedupe by name+mile
    deduped = []
    for s in shelters_on_trail:
        if deduped and deduped[-1]["name"] == s["name"] and abs(deduped[-1]["mi"] - s["mi"]) < 0.5:
            continue
        deduped.append(s)
    shelters_on_trail = deduped
    print(f"on-trail shelters: {len(shelters_on_trail)}")

    # 3. Fetch road crossings via OSM bbox query (NPS data lacks roads)
    print("=== STEP 3: Road crossings (OSM bbox) ===")
    bbox = (
        min(c[0] for c in master_coords) - 0.005,
        min(c[1] for c in master_coords) - 0.005,
        max(c[0] for c in master_coords) + 0.005,
        max(c[1] for c in master_coords) + 0.005,
    )
    cache_file = CACHE_DIR / "osm_roads_bbox.json"
    if cache_file.exists():
        roads_data = json.loads(cache_file.read_text())
    else:
        q = (
            "[out:json][timeout:300]"
            f"[bbox:{bbox[1]},{bbox[0]},{bbox[3]},{bbox[2]}];"
            '(way[highway~"^(motorway|trunk|primary|secondary|tertiary)$"][name];'
            'way[highway~"^(motorway|trunk|primary|secondary|tertiary)$"][ref];);'
            "out geom;"
        )
        try:
            roads_data = overpass(q)
            cache_file.write_text(json.dumps(roads_data))
        except Exception as e:
            print(f"  road fetch failed (will continue without): {e}")
            roads_data = {"elements": []}
    road_ways = [e for e in roads_data.get("elements", []) if e.get("type") == "way" and e.get("geometry")]
    print(f"  candidate road ways: {len(road_ways)}")
    chains_for_grid = [{"coords": master_coords, "cum_mi": cum_mi}]
    # Free the bulk Overpass response now that we've extracted the ways list.
    roads_data = None
    road_ways = _filter_roads_to_trail_corridor(road_ways, chains_for_grid)
    print(f"  road ways inside trail corridor: {len(road_ways)}")
    crossings = road_crossings(road_ways, chains_for_grid)
    crossings.sort(key=lambda c: c["along_mi"])
    # Dedupe by label+mile
    cross_dedup = []
    for c in crossings:
        if cross_dedup and cross_dedup[-1]["label"] == c["label"] and abs(cross_dedup[-1]["along_mi"] - c["along_mi"]) < 0.05:
            continue
        cross_dedup.append(c)
    crossings = cross_dedup
    print(f"  road crossings on trail: {len(crossings)}")

    # 4. Build the breakpoint list. State end-of-state synthetic markers help
    #    delimit state transitions in the segmentation.
    state_borders = [
        # (end_mile_from_springer, state_we_are_entering)
        # These thresholds match canonical AT state-mile estimates.
        (0,    "Georgia"),
        (78,   "North Carolina"),
        (165,  "North Carolina"),  # Smokies (NC/TN border) — keep NC
        (241,  "Tennessee"),
        (469,  "Virginia"),
        (998,  "West Virginia"),
        (1022, "Maryland"),
        (1063, "Pennsylvania"),
        (1295, "New Jersey"),
        (1322, "New York"),
        (1456, "Connecticut"),
        (1505, "Massachusetts"),
        (1595, "Vermont"),
        (1748, "New Hampshire"),
        (1903, "Maine"),
    ]
    def state_at(mi):
        last = "Georgia"
        for thresh, st in state_borders:
            if mi >= thresh:
                last = st
        return last
    # Add synthetic state-border breakpoints at each state transition
    breakpoints = [{"name": "Springer Mountain (Trail Start)", "mi": 0.0, "kind": "border"}]
    for s in shelters_on_trail:
        breakpoints.append({"name": s["name"], "mi": s["mi"], "kind": "shelter", "lat": s["lat"], "lon": s["lon"]})
    for c in crossings:
        breakpoints.append({"name": c["label"], "mi": c["along_mi"], "kind": "crossing", "lat": c["lat"], "lon": c["lon"]})
    for thresh, st in state_borders[1:]:
        breakpoints.append({"name": f"{state_borders[state_borders.index((thresh, st)) - 1][1]} / {st} state line", "mi": thresh, "kind": "state-line"})
    breakpoints.append({"name": "Mount Katahdin (Trail End)", "mi": total_mi, "kind": "border"})
    breakpoints.sort(key=lambda b: b["mi"])
    # Collapse same-mile breakpoints
    collapsed = []
    for b in breakpoints:
        if collapsed and abs(collapsed[-1]["mi"] - b["mi"]) < 0.05:
            if b["name"] != collapsed[-1]["name"]:
                collapsed[-1] = {**collapsed[-1], "name": f"{collapsed[-1]['name']} / {b['name']}", "kind": "combined"}
            continue
        collapsed.append(b)
    breakpoints = collapsed
    print(f"=== STEP 4: {len(breakpoints)} breakpoints ===")

    # 5. Build segments + compute elevation
    print("=== STEP 5: Segments + elevation ===")
    out_segments = []
    out_shelters = [{"name": s["name"], "lat": s["lat"], "lon": s["lon"], "state": state_at(s["mi"])} for s in shelters_on_trail]
    out_crossings = [{"label": c["label"], "lat": c["lat"], "lon": c["lon"], "state": state_at(c["along_mi"])} for c in crossings]
    seg_id = 0
    for i in range(len(breakpoints) - 1):
        a = breakpoints[i]
        b = breakpoints[i + 1]
        if b["mi"] - a["mi"] < 0.05:
            continue
        sub = slice_along(master_coords, cum_mi, a["mi"], b["mi"])
        sub = simplify(sub, tol_deg=0.00015)
        elevs_m = fetch_elevations(sub, elev_cache)
        gain_m, loss_m = smooth_and_compute_gain_loss(elevs_m)
        ft_per_m = 3.28084
        # State assigned by the segment's midpoint mile
        mid_mi = (a["mi"] + b["mi"]) / 2.0
        out_segments.append({
            "id": seg_id,
            "state": state_at(mid_mi),
            "from": a["name"],
            "to": b["name"],
            "miles": round(b["mi"] - a["mi"], 2),
            "elev_gain": round(gain_m * ft_per_m, 1),
            "elev_loss": round(loss_m * ft_per_m, 1),
            "geom": [[round(c[0], 5), round(c[1], 5)] for c in sub],
        })
        seg_id += 1
    print(f"segments built: {len(out_segments)}")

    # 5b. Backfill segment geometry from the v2 OSM master polyline for any
    # segment whose v3 geom is sparse or has internal straight-line jumps.
    # The NPS APPA Treadway feed is missing entire trail-club chunks
    # (notably around Daleville VA and parts of PA/NH), which left ~104
    # segments rendering as multi-mile straight bridges. v2 has those
    # chunks since OSM does. Splice them in.
    backfilled = _backfill_geom_from_v2(out_segments)
    if backfilled:
        print(f"backfilled v2 geometry into {backfilled} sparse v3 segments")

    # 6. Build state list with cumulative miles per state
    state_miles = {}
    state_order_idx = {st: i for i, (_, st) in enumerate(state_borders)}
    for s in out_segments:
        state_miles[s["state"]] = state_miles.get(s["state"], 0) + s["miles"]
    out_states = []
    for st_name, mi in state_miles.items():
        out_states.append({"name": st_name, "order": state_order_idx.get(st_name, 99), "miles": round(mi, 1)})
    out_states.sort(key=lambda s: s["order"])

    bundle = {
        "version": 3,
        "generated": time.strftime("%Y-%m-%d"),
        "source": "NPS APPA Features and Facilities (joint NPS + ATC)",
        "states": out_states,
        "segments": out_segments,
        "shelters": out_shelters,
        "crossings": out_crossings,
    }
    OUT_PATH.write_text(json.dumps(bundle, separators=(",", ":")))
    total = sum(s["miles"] for s in out_segments)
    print(f"\n=== DONE ===")
    print(f"wrote {OUT_PATH} - {OUT_PATH.stat().st_size//1024} KB")
    print(f"states={len(out_states)} segments={len(out_segments)} shelters={len(out_shelters)} crossings={len(out_crossings)}")
    print(f"total mileage: {total:.1f} mi")


def main():
    all_states = []
    elev_cache = load_elev_cache()
    for state_name, rel_id, idx in STATES:
        print(f"[{idx+1}/{len(STATES)}] {state_name} (rel {rel_id})")
        data = cached_fetch(rel_id)
        # Find the AT relation itself — it has members[] in canonical order.
        rel_elements = [e for e in data["elements"] if e["type"] == "relation" and e.get("id") == rel_id]
        ordered_way_ids = []
        if rel_elements:
            for m in rel_elements[0].get("members", []):
                if m.get("type") == "way":
                    ordered_way_ids.append(m["ref"])
                # Sub-relation members would need recursion here — unused for AT
                # state-level relations (verified flat).
        ways_all = [e for e in data["elements"] if e["type"] == "way"]
        # Trail ways: geometry but no shelter/highway tags (the .t out geom set)
        # Shelter ways: have center (from way out center)
        # Road ways: have geometry AND highway tag (from second out geom set)
        ROAD_HIGHWAYS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified"}
        def way_kind(w):
            tags = w.get("tags", {}) or {}
            if w.get("center") and not w.get("geometry"):
                return "shelter"
            if w.get("geometry") and tags.get("highway") in ROAD_HIGHWAYS:
                return "road"
            if w.get("geometry"):
                # shelter polygon
                if tags.get("amenity") == "shelter" or tags.get("tourism") == "wilderness_hut" or tags.get("building") == "shelter":
                    return "shelter-poly"
                # everything else with geometry is a trail piece (path/footway/track/no-highway)
                return "trail"
            return "skip"

        trail_ways = []
        shelter_ways = []
        road_ways = []
        for w in ways_all:
            kind = way_kind(w)
            if kind == "trail":
                trail_ways.append(w)
            elif kind in ("shelter", "shelter-poly"):
                # Normalize shelter polygons by giving them a center from geometry
                if kind == "shelter-poly" and not w.get("center") and w.get("geometry"):
                    avg_lat = sum(g["lat"] for g in w["geometry"]) / len(w["geometry"])
                    avg_lon = sum(g["lon"] for g in w["geometry"]) / len(w["geometry"])
                    w = {**w, "center": {"lat": avg_lat, "lon": avg_lon}}
                shelter_ways.append(w)
            elif kind == "road":
                road_ways.append(w)
        nodes = [e for e in data["elements"] if e["type"] == "node"]
        print(f"  trail_ways={len(trail_ways)} road_ways={len(road_ways)} shelter_nodes={len(nodes)} shelter_ways={len(shelter_ways)}")

        # Canonical chain: walk the AT relation's ordered way members.
        if ordered_way_ids:
            ways_by_id = {w["id"]: w for w in trail_ways}
            chains = ordered_chain(ordered_way_ids, ways_by_id)
        else:
            # Fallback (shouldn't happen with the new query) — old greedy approach.
            chains = stitch_ways(trail_ways)
        if not chains:
            print(f"  WARNING: no chains for {state_name}")
            continue

        chain_data = []
        total_mi = 0.0
        for c in chains:
            cum = cumulative_miles(c)
            chain_data.append({"coords": c, "cum_mi": cum, "miles": cum[-1]})
            total_mi += cum[-1]
        print(f"  {len(chains)} chains, total {total_mi:.1f} mi")

        # Place all shelters: assign each to its nearest chain, with along distance.
        shelter_pts = []
        unnamed_counter = [0]
        for n in nodes + shelter_ways:
            xy = shelter_coord(n)
            if not xy:
                continue
            tags = n.get("tags", {}) or {}
            # Try multiple OSM tags before falling back to "Unnamed".
            raw_name = (
                tags.get("name")
                or tags.get("alt_name")
                or tags.get("addr:housename")
                or tags.get("loc_name")
                or tags.get("official_name")
            )
            note = tags.get("note") or tags.get("description") or ""
            # Pull a name out of free-form note like "Wilcox South Lean-to" if needed
            if (not raw_name or raw_name.strip().isdigit()) and note:
                # First sentence/clause that looks like a proper name
                guess = note.split(".")[0].split(",")[0].strip()
                if 3 <= len(guess) <= 60 and not guess.isdigit():
                    raw_name = guess
            if raw_name and raw_name.strip() and not raw_name.strip().isdigit():
                name = raw_name.strip()
            else:
                unnamed_counter[0] += 1
                name = f"Unnamed shelter #{unnamed_counter[0]} ({state_name.split('/')[0]})"
            best = None
            for ci, ch in enumerate(chain_data):
                along, perp, _ = nearest_on_line(xy, ch["coords"], ch["cum_mi"])
                if best is None or perp < best[0]:
                    best = (perp, ci, along, xy[0], xy[1], name, n.get("id"))
            if best and best[0] <= 0.6:  # within 600m of some chain
                perp, ci, along, lon, lat, name, sid = best
                shelter_pts.append(
                    {"id": sid, "name": name, "lat": lat, "lon": lon, "chain": ci, "along_mi": along}
                )
        # Dedupe by (chain, name, along)
        shelter_pts.sort(key=lambda s: (s["chain"], s["along_mi"]))
        deduped = []
        for s in shelter_pts:
            if (
                deduped
                and deduped[-1]["chain"] == s["chain"]
                and deduped[-1]["name"] == s["name"]
                and abs(deduped[-1]["along_mi"] - s["along_mi"]) < 0.5
            ):
                continue
            deduped.append(s)
        shelter_pts = deduped
        print(f"  shelters on trail: {len(shelter_pts)}")

        crossings = road_crossings(road_ways, chain_data)
        print(f"  road crossings: {len(crossings)}")

        all_states.append(
            {
                "name": state_name,
                "order": idx,
                "chains": chain_data,
                "shelters": shelter_pts,
                "crossings": crossings,
                "total_mi": total_mi,
            }
        )
        time.sleep(2)

    # Build segments. Each chain is segmented by its shelters (plus endpoints).
    out_states = []
    out_segments = []
    out_shelters = []
    out_crossings = []
    seg_id = 0
    for st in sorted(all_states, key=lambda x: x["order"]):
        for ci, ch in enumerate(st["chains"]):
            chain_shelters = [s for s in st["shelters"] if s["chain"] == ci]
            chain_shelters.sort(key=lambda s: s["along_mi"])
            for s in chain_shelters:
                out_shelters.append({"name": s["name"], "lat": s["lat"], "lon": s["lon"], "state": st["name"]})

            chain_crossings = [c for c in st["crossings"] if c["chain"] == ci]
            chain_crossings.sort(key=lambda c: c["along_mi"])
            for c in chain_crossings:
                out_crossings.append({"label": c["label"], "lat": c["lat"], "lon": c["lon"], "state": st["name"]})

            chain_label = "" if len(st["chains"]) == 1 else f" (sect. {ci + 1})"
            south_name = f"{st['name']}{chain_label} south end"
            north_name = f"{st['name']}{chain_label} north end"
            mid = []
            for s in chain_shelters:
                mid.append({"name": s["name"], "along_mi": s["along_mi"], "kind": "shelter"})
            for c in chain_crossings:
                mid.append({"name": c["label"], "along_mi": c["along_mi"], "kind": "crossing"})
            mid.sort(key=lambda b: b["along_mi"])
            # Collapse very close breakpoints (e.g., shelter at a road crossing).
            collapsed = []
            for b in mid:
                if collapsed and abs(collapsed[-1]["along_mi"] - b["along_mi"]) < 0.05:
                    # Prefer to keep both names if different; mark as combined.
                    if b["name"] not in collapsed[-1]["name"]:
                        collapsed[-1] = {
                            "name": f"{collapsed[-1]['name']} / {b['name']}",
                            "along_mi": collapsed[-1]["along_mi"],
                            "kind": "combined",
                        }
                    continue
                collapsed.append(b)
            breakpoints = (
                [{"name": south_name, "along_mi": 0.0}]
                + collapsed
                + [{"name": north_name, "along_mi": ch["miles"]}]
            )
            for i in range(len(breakpoints) - 1):
                a = breakpoints[i]
                b = breakpoints[i + 1]
                if b["along_mi"] - a["along_mi"] < 0.05:
                    continue
                sub = slice_along(ch["coords"], ch["cum_mi"], a["along_mi"], b["along_mi"])
                sub = simplify(sub, tol_deg=0.00015)
                # Elevation: sample sub-line vertices via Open-Elevation.
                elevs_m = fetch_elevations(sub, elev_cache)
                gain_m, loss_m = smooth_and_compute_gain_loss(elevs_m)
                ft_per_m = 3.28084
                out_segments.append(
                    {
                        "id": seg_id,
                        "state": st["name"],
                        "from": a["name"],
                        "to": b["name"],
                        "miles": round(b["along_mi"] - a["along_mi"], 2),
                        "elev_gain": round(gain_m * ft_per_m, 1),
                        "elev_loss": round(loss_m * ft_per_m, 1),
                        "geom": [[round(c[0], 5), round(c[1], 5)] for c in sub],
                    }
                )
                seg_id += 1
        out_states.append({"name": st["name"], "order": st["order"], "miles": round(st["total_mi"], 1)})

    bundle = {
        "version": 2,
        "generated": time.strftime("%Y-%m-%d"),
        "states": out_states,
        "segments": out_segments,
        "shelters": out_shelters,
        "crossings": out_crossings,
    }
    OUT_PATH.write_text(json.dumps(bundle, separators=(",", ":")))
    print(f"\nWrote {OUT_PATH} - {OUT_PATH.stat().st_size/1024:.1f} KB")
    print(f"  states={len(out_states)} segments={len(out_segments)} shelters={len(out_shelters)}")
    total = sum(s["miles"] for s in out_segments)
    print(f"  total mileage: {total:.1f} mi")


if __name__ == "__main__":
    import sys
    if "--legacy-osm" in sys.argv:
        main()
    elif "--nps" in sys.argv:
        main_nps()
    else:
        main_kmz()
