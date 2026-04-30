#!/usr/bin/env python3
"""Scrape wikitrail.org for AT features (towns, post offices, resupply, hostels).

Output: at_features.json with shape:
  { "version": 1,
    "generated": "YYYY-MM-DD",
    "features": [ {name, kind, lat, lon, mi, off, off_dir, state, slug}, ... ] }

`mi` is wikitrail's miles-from-Springer figure; we will reproject to OUR
mile system in-app by snapping lat/lon to nearest segment.

Categorization is by URL slug + name pattern. The Sleep/Food/Other sections
on town feature pages give us extra resupply/lodging detail too.
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "at_features.json"
CACHE_DIR = ROOT / ".cache" / "wikitrail"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

USER_AGENT = "at-tracker-build/1.0 (+https://github.com/arinbb/at-tracker)"
BASE = "http://www.wikitrail.org"


def fetch(url: str, cache_key: str) -> str:
    cf = CACHE_DIR / cache_key
    if cf.exists():
        return cf.read_text()
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                txt = r.read().decode("utf-8", "replace")
            cf.write_text(txt)
            time.sleep(0.4)  # be polite
            return txt
        except Exception as e:
            print(f"  retry {attempt+1} for {cache_key}: {e}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}")


def list_sections() -> list:
    """Return list of (id, slug) for all AT sections."""
    html = fetch(f"{BASE}/trails/view/at/appalachian-trail", "trail.html")
    out = []
    for m in re.finditer(r'href="/sections/view/at/(\d+)/([^"]+)"', html):
        out.append((m.group(1), m.group(2)))
    # dedupe preserving order
    seen, uniq = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def parse_section(section_id: str, slug: str):
    """Yield {feature_id, feature_slug, name, mi_section, off} for each feature
    listed in the section's "Feature Info" cards block at the bottom.
    """
    html = fetch(
        f"{BASE}/sections/view/at/{section_id}/{slug}",
        f"section_{section_id}.html",
    )
    # Each card looks like:
    #   <div ... id="dialog<id>"> ... <h2>NAME</h2>
    #   <p> ELEV ft<br/> MI miles from <SECTION-START> <br/>OFF </p>
    #   ... <a href="/features/view/at/<id>/<slug>" ...
    card_re = re.compile(
        r'id="dialog(\d+)"[^<]*<div[^>]*>\s*<h1>Feature Info</h1>\s*</div>\s*'
        r'<div[^>]*>\s*<h2>([^<]+)</h2>\s*<p>([^<]*?)<br/>\s*([^<]*?)<br/>\s*([^<]*)</p>'
        r'.*?href="/features/view/at/\1/([a-z0-9\-]+)"',
        re.IGNORECASE | re.DOTALL,
    )
    for m in card_re.finditer(html):
        # group2=name, group3=elev, group4=mi-from-something, group5=off, group6=slug
        mile_match = re.search(r"([\d\.]+)\s*miles\s+from", m.group(4))
        off = m.group(5).strip()
        # off can be like "0.2E" or "" or "0.2 W"
        off_m = re.match(r"^([\d\.]+)\s*([NSEW])", off)
        yield {
            "section_id": section_id,
            "section_slug": slug,
            "feature_id": m.group(1),
            "feature_slug": m.group(6).lower(),
            "name": m.group(2).strip(),
            "mi_section": float(mile_match.group(1)) if mile_match else None,
            "off_dist": float(off_m.group(1)) if off_m else 0.0,
            "off_dir": off_m.group(2) if off_m else "",
        }


LAT_RE = re.compile(r'<span class="latitude">([\-\d\.]+)</span>')
LON_RE = re.compile(r'<span class="longitude">([\-\d\.]+)</span>')
SPRINGER_MI_RE = re.compile(r"Springer:</td>[^<]*<td[^>]*>[^<]*<td[^>]*>\s*<b>([\d\.]+)\s*miles", re.S)
KATAHDIN_MI_RE = re.compile(r"Katahdin:</td>[^<]*<td[^>]*>[^<]*<td[^>]*>\s*<b>([\d\.]+)\s*miles", re.S)
OFFTRAIL_RE = re.compile(r"Offtrail:</td>[^<]*<td[^>]*>[^<]*<td[^>]*>\s*<b>([^<]+)</b>", re.S)
REGION_RE = re.compile(r"Region:</td>[^<]*<td[^>]*>[^<]*<td[^>]*>\s*<b>([^<]+)</b>", re.S)


def parse_feature(feat_id: str, slug: str):
    html = fetch(
        f"{BASE}/features/view/at/{feat_id}/{slug}",
        f"feature_{feat_id}.html",
    )
    lat = LAT_RE.search(html)
    lon = LON_RE.search(html)
    mi = SPRINGER_MI_RE.search(html)
    off = OFFTRAIL_RE.search(html)
    reg = REGION_RE.search(html)
    return {
        "lat": float(lat.group(1)) if lat else None,
        "lon": float(lon.group(1)) if lon else None,
        "mi_springer": float(mi.group(1)) if mi else None,
        "offtrail": off.group(1).strip() if off else "",
        "region": reg.group(1).strip() if reg else "",
    }


# Two-letter state codes that may be the trailing slug component for towns.
STATE_CODES = {"ga", "nc", "tn", "va", "wv", "md", "pa", "nj", "ny", "ct", "ma", "vt", "nh", "me"}


def classify(name: str, slug: str) -> str:
    n = name.lower()
    s = slug.lower()
    # Post offices / maildrops
    if re.search(r"\bpo\b|\bp\.o\.|post office", n) or s.endswith("-po") or "-po-" in s:
        return "maildrop"
    # Towns: slug ends with state code (e.g. "suches-ga")
    if re.search(r"-(ga|nc|tn|va|wv|md|pa|nj|ny|ct|ma|vt|nh|me)$", s):
        return "town"
    # Hostels/cabins
    if re.search(r"hostel|inn$|\bcabin", n):
        return "hostel"
    # Resupply: stores, markets, supermarkets, grocery, outfitter
    if re.search(r"general store|grocery|supermarket|market|outfitter|gas|hardware", n):
        return "resupply"
    # Restaurants / food
    if re.search(r"restaurant|diner|cafe|grill|pizza|bbq", n):
        return "food"
    # Hotels
    if re.search(r"hotel|motel|lodge|resort", n):
        return "hotel"
    # Already covered by OSM data — skip
    if re.search(r"shelter|lean.?to|hut", n):
        return "shelter_skip"
    if re.search(r"\bgap\b|\bmtn\b|\bmountain\b|\bridge\b|\bcreek\b|\bbranch\b|\briver\b|\bpond\b|\blake\b|trail$|view$", n):
        return "landmark_skip"
    if re.search(r"\bus\s|\bsr\s|\broute\s|\bhwy\b|highway|road|^\d+", n):
        return "road_skip"
    return "other"


CSS_KIND_MAP = {
    "post_office": "maildrop",
    "short_term_resupply": "resupply",
    "long_term_resupply": "resupply",
    "outfitter": "outfitter",
    "hostel": "hostel",
    "hotel": "hotel",
    "restaurant": "restaurant",
    "bar": "restaurant",
    "campsite": "hostel",  # private campsites used for lodging
    "laundry": "service",
    "shuttle": "service",
    "medical": "medical",
    "barber": "service",
    "hardware": "service",
}

SUB_BUSINESS_RE = re.compile(
    r"<li class='ui-li-has-icon'>\s*<a href=\"/features/view/at/(\d+)/([a-z0-9\-]+)\">\s*"
    r"<span class='ui-li-icon (\w+?)16'[^>]*title='([^']+)'[^>]*></span>\s*([^<]+?)\s*</a>",
    re.IGNORECASE,
)


def parse_town_subbusinesses(town: dict) -> list:
    """Given a town feature record (with id, lat, lon, state), parse its
    feature page and yield sub-business records. Uses the town's lat/lon
    since wikitrail doesn't always have separate coords for each business."""
    try:
        html = fetch(
            f"{BASE}/features/view/at/{town['id']}/{town['slug']}",
            f"feature_{town['id']}.html",
        )
    except Exception as e:
        print(f"    town {town['id']} fetch failed: {e}")
        return []
    out = []
    for m in SUB_BUSINESS_RE.finditer(html):
        sub_id, sub_slug, css_kind, title, name = m.groups()
        kind = CSS_KIND_MAP.get(css_kind)
        if not kind:
            continue
        out.append({
            "id": sub_id,
            "slug": sub_slug,
            "name": name.strip(),
            "kind": kind,
            "lat": town["lat"],
            "lon": town["lon"],
            "mi_springer": town["mi_springer"],
            "off": town["off"],
            "off_dir": town["off_dir"],
            "state": town["state"],
            "parent_town": town["name"],
        })
    return out


AT_STATE_RELS = [
    2007643, 18319351, 18321044, 19123292, 18330829, 18326382,
    2007688, 3352289, 2991960, 392991, 18319298, 2007932,
]
OVERPASS_BASES = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def parse_ele(s):
    """OSM elevations come as plain meters most of the time, but mappers
    sometimes write '1234.5', '1234 m', '4030 ft', '4,030 ft'. Return meters
    or None on failure."""
    if not s:
        return None
    t = s.strip().replace(",", "").lower()
    m = re.match(r"^(\-?[\d\.]+)\s*([a-z]*)", t)
    if not m:
        return None
    try:
        v = float(m.group(1))
    except Exception:
        return None
    unit = m.group(2)
    if unit in ("", "m", "meter", "meters", "metre", "metres"):
        return int(round(v))
    if unit in ("ft", "feet", "foot"):
        return int(round(v * 0.3048))
    return None


def overpass_post(query: str) -> dict:
    body = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for base in OVERPASS_BASES:
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    base, data=body, headers={"User-Agent": USER_AGENT}
                )
                with urllib.request.urlopen(req, timeout=180) as r:
                    return json.loads(r.read())
            except Exception as e:
                last_err = e
                time.sleep(2 + attempt * 3)
    raise RuntimeError(f"all overpass endpoints failed: {last_err}")


def fetch_at_peaks_and_views() -> list:
    """Query Overpass for `natural=peak` + `tourism=viewpoint` near each
    AT state's relation. Cache each state's result. Only keep features
    with a name (so unnamed bumps don't pollute the feature list).
    """
    cache_file = CACHE_DIR / "osm_peaks.json"
    if cache_file.exists():
        return json.loads(cache_file.read_text())

    out = []
    seen = set()
    for rel_id in AT_STATE_RELS:
        per_cache = CACHE_DIR / f"osm_peaks_rel_{rel_id}.json"
        if per_cache.exists():
            try:
                rows = json.loads(per_cache.read_text())
                out.extend(rows)
                for r in rows:
                    seen.add((round(r["lat"], 4), round(r["lon"], 4)))
                continue
            except Exception:
                pass
        q = f"""
[out:json][timeout:300];
rel({rel_id});>>;
way._->.t;
( node(around.t:1500)[natural=peak][name];
  node(around.t:1500)[tourism=viewpoint][name]; );
out;
"""
        try:
            data = overpass_post(q)
        except Exception as e:
            print(f"  peaks rel {rel_id} failed: {e}")
            continue
        rows = []
        for el in data.get("elements", []):
            if el.get("type") != "node":
                continue
            tags = el.get("tags") or {}
            name = (tags.get("name") or "").strip()
            if not name:
                continue
            key = (round(el["lat"], 4), round(el["lon"], 4))
            if key in seen:
                continue
            seen.add(key)
            kind = "peak" if tags.get("natural") == "peak" else "view"
            rows.append({
                "id": f"osm_{el['id']}",
                "slug": "",
                "name": name,
                "kind": kind,
                "lat": el["lat"],
                "lon": el["lon"],
                "mi_springer": None,
                "off": 0.0,
                "off_dir": "",
                "state": "",
                "elev_m": parse_ele(tags.get("ele")),
            })
        per_cache.write_text(json.dumps(rows))
        out.extend(rows)
        time.sleep(2)
    cache_file.write_text(json.dumps(out))
    return out


# Official NPS APPA service — same constants as build_data.py
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


def fetch_appa_layer(layer_name: str) -> list:
    """Return all features from one APPA layer as a list of (lat, lon, props)."""
    cache_root = ROOT / ".cache"
    cache_root.mkdir(exist_ok=True)
    cache = cache_root / f"appa_{layer_name}.json"
    if cache.exists():
        data = json.loads(cache.read_text())
    else:
        layer_id = APPA_LAYERS[layer_name]
        print(f"  fetching APPA {layer_name} (id={layer_id})...")
        out = {"type": "FeatureCollection", "features": []}
        offset = 0
        page = 2000
        while True:
            params = {
                "where": "1=1", "outFields": "*", "returnGeometry": "true",
                "f": "geojson", "outSR": "4326",
                "resultOffset": str(offset), "resultRecordCount": str(page),
            }
            url = f"{APPA_BASE}/{layer_id}/query?" + urllib.parse.urlencode(params)
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as r:
                data_pg = json.loads(r.read())
            feats = data_pg.get("features", [])
            out["features"].extend(feats)
            if len(feats) < page:
                break
            offset += len(feats)
        cache.write_text(json.dumps(out))
        data = out
    return data.get("features", [])


def appa_features_for(kind_name: str, layer_name: str) -> list:
    """Convert NPS APPA layer features to our feature dict format."""
    out = []
    for f in fetch_appa_layer(layer_name):
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][0], g["coordinates"][1]
        props = f.get("properties") or {}
        name = (props.get("Name") or props.get("Acronym") or f"Unnamed {kind_name}").strip()
        out.append({
            "id": f"nps_{layer_name}_{props.get('OBJECTID') or props.get('GlobalID') or len(out)}",
            "slug": "",
            "name": name,
            "kind": kind_name,
            "lat": lat, "lon": lon,
            "mi_springer": None,
            "off": 0.0, "off_dir": "",
            "state": "",
            "parent_town": "",
            "source": "nps-appa",
        })
    return out


def main():
    sections = list_sections()
    print(f"sections: {len(sections)}")
    seen_features = {}
    for sid, sslug in sections:
        print(f"  section {sid}: {sslug}")
        try:
            for feat in parse_section(sid, sslug):
                fid = feat["feature_id"]
                if fid in seen_features:
                    continue
                kind = classify(feat["name"], feat["feature_slug"])
                if kind in ("shelter_skip", "landmark_skip", "road_skip", "other"):
                    seen_features[fid] = None
                    continue
                seen_features[fid] = (feat, kind)
        except Exception as e:
            print(f"  section {sid} failed: {e}")

    keepers = [(fid, *v) for fid, v in seen_features.items() if v is not None]
    print(f"candidate features: {len(keepers)}")

    out = []
    for i, (fid, feat, kind) in enumerate(keepers):
        if i % 50 == 0:
            print(f"  fetching feature {i+1}/{len(keepers)}")
        try:
            meta = parse_feature(fid, feat["feature_slug"])
        except Exception as e:
            print(f"    feature {fid} failed: {e}")
            continue
        if meta["lat"] is None or meta["lon"] is None:
            continue
        # Parse off-trail like "2.0W from trail" -> distance + dir
        off_m = re.match(r"^([\d\.]+)([NSEW])\s", meta["offtrail"]) if meta["offtrail"] else None
        out.append({
            "id": fid,
            "name": feat["name"],
            "kind": kind,
            "slug": feat["feature_slug"],
            "lat": meta["lat"],
            "lon": meta["lon"],
            "mi_springer": meta["mi_springer"],
            "off": float(off_m.group(1)) if off_m else 0.0,
            "off_dir": off_m.group(2) if off_m else "",
            "state": meta["region"],
        })
    # Second pass: for every town, fetch its feature page and pull sub-businesses
    # (PO, general store, hostel, etc.) with the town's lat/lon as approximation.
    extra = []
    for town in [f for f in out if f["kind"] == "town"]:
        for sub in parse_town_subbusinesses(town):
            # Skip duplicates already found in main pass
            if any(f["id"] == sub["id"] for f in out + extra):
                continue
            extra.append(sub)
    print(f"sub-businesses added: {len(extra)}")
    out.extend(extra)

    # Third pass: pull notable peaks + viewpoints from OSM, near the AT.
    try:
        peaks = fetch_at_peaks_and_views()
        print(f"OSM peaks/views added: {len(peaks)}")
        out.extend(peaks)
    except Exception as e:
        print(f"  OSM peaks fetch failed (continuing): {e}")

    # Fourth pass: add NPS APPA features (vistas, bridges, parking, privies,
    # campsites). These augment the wikitrail+OSM data with official sources.
    print("=== NPS APPA features ===")
    for kind_name, layer_name in [
        ("view", "vistas"),
        ("bridge", "bridges"),
        ("parking", "parking"),
        ("privy", "privies"),
        ("campsite", "campsites"),
    ]:
        appa_feats = appa_features_for(kind_name, layer_name)
        print(f"  {layer_name}: {len(appa_feats)} -> kind={kind_name}")
        out.extend(appa_feats)

    out.sort(key=lambda f: (f["mi_springer"] or 0))
    bundle = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%d"),
        "source": "wikitrail.org (CC BY-SA 3.0)",
        "features": out,
    }
    OUT.write_text(json.dumps(bundle, indent=1))
    print(f"\nwrote {OUT} - {OUT.stat().st_size//1024} KB")
    counts = {}
    for f in out:
        counts[f["kind"]] = counts.get(f["kind"], 0) + 1
    print("by kind:", counts)


if __name__ == "__main__":
    main()
