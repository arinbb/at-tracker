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
CACHE_DIR = Path(__file__).parent / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
ELEV_CACHE = CACHE_DIR / "elev.json"

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


def hav_km(a, b):
    lat1, lon1 = a[1], a[0]
    lat2, lon2 = b[1], b[0]
    R = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def ordered_chain(rel_member_way_ids, ways_by_id):
    """Build the canonical AT path by walking the relation's members in order.
    Each way is appended to the chain; we flip it if needed so its tail meets
    the previous tail. If there's a gap, we still continue (the AT is a single
    line — a 'gap' usually means an unmapped section, which we'll bridge with a
    straight line up to ~5 km, otherwise we start a new chain).
    Returns list of chains (each a list of (lon,lat) coords), ordered south->north."""
    GAP_BREAK_KM = 5.0  # if we can't bridge, start a new chain
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


def road_crossings(road_ways, chains_data):
    """For each road way, find every place where it crosses any chain of the AT.
    Returns list of {name, ref, lat, lon, chain, along_mi}."""
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
        # Build a label: prefer ref like "US-19E" / "VA-42", fall back to name.
        if ref and name and name not in ref:
            label = f"{name} ({ref})"
        elif ref:
            label = ref
        elif name:
            label = name
        else:
            continue  # skip unnamed roads
        # Bounding box prefilter for road
        rmin_x = min(p[0] for p in rcoords)
        rmax_x = max(p[0] for p in rcoords)
        rmin_y = min(p[1] for p in rcoords)
        rmax_y = max(p[1] for p in rcoords)
        for ci, ch in enumerate(chains_data):
            coords = ch["coords"]
            cum = ch["cum_mi"]
            for i in range(len(coords) - 1):
                a = coords[i]
                b = coords[i + 1]
                # Bounding box prefilter for AT segment
                ax, ay = a
                bx, by = b
                seg_min_x = min(ax, bx)
                seg_max_x = max(ax, bx)
                seg_min_y = min(ay, by)
                seg_max_y = max(ay, by)
                if seg_max_x < rmin_x or seg_min_x > rmax_x:
                    continue
                if seg_max_y < rmin_y or seg_min_y > rmax_y:
                    continue
                for j in range(len(rcoords) - 1):
                    c = rcoords[j]
                    d = rcoords[j + 1]
                    ix = segment_intersect(a, b, c, d)
                    if ix:
                        seg_len_km = hav_km(a, b)
                        if seg_len_km > 0:
                            partial = hav_km(a, ix) / seg_len_km
                        else:
                            partial = 0
                        partial_mi = (cum[i + 1] - cum[i]) * partial
                        along = cum[i] + partial_mi
                        out.append({
                            "label": label,
                            "lat": ix[1],
                            "lon": ix[0],
                            "chain": ci,
                            "along_mi": along,
                        })
    # Dedupe: a single road may cross the AT multiple times very close together
    # (parallel lanes, divided highways). Collapse those within 0.05 mi.
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
    main()
