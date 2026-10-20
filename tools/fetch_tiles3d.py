#!/usr/bin/env python3
"""One-time download of Google Photorealistic 3D Tiles for one FireTrace location, saved as a local 3D Tiles tileset in the data folder.

    python tools/fetch_tiles3d.py --location guimaraes-concelho

Output: `data/tiles3d/<location>/` (git-ignored, mounted by docker-compose, served to the app, checked by the ingest):
    tileset.json   every nested tileset flattened into one, content URIs rewritten to `tiles/<hash>.glb`
    tiles/*.glb    the tiles
    manifest.json  source, date, bounds, size and the attribution the tiles must show
    usage.json     the request ledger (how many requests/root requests this tool has ever made)
    .crawl/        cache of the tile lists, so a later run does not ask Google for them again

What it asks Google for, and nothing else (all on tile.googleapis.com):
    1 x GET /v1/3dtiles/root.json                   the ONLY billed request (it opens a 3 h session). Capped at --max-root-requests for the tool's lifetime.
    N x GET /v1/3dtiles/datasets/.../<id>.json      nested tile lists, only for the part that overlaps the location's bounds, cached on disk after the first run
    M x GET /v1/3dtiles/datasets/.../<id>.glb       the tiles themselves, only the M that fit the budget (--max-requests), sharpest around --focus
Tiles already on disk are never requested again.

The API key is NEVER stored: it comes from a hidden prompt (or stdin with `--key-stdin`, or this process's GOOGLE_MAPS_API_KEY), lives only in memory, is sent only as
`key=` and is masked in every message. Google's session token is not saved either.

Google's Map Tiles API policy prohibits pre-fetching, storing and offline use of this content. Keeping this copy is the operator's informed decision and risk. The
attribution Google embeds in each tile is collected into manifest.json and the app shows it whenever the tiles are drawn.
"""
from __future__ import annotations

import argparse
import getpass
import hashlib
import heapq
import http.client
import json
import math
import os
import re
import shutil
import struct
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

GOOGLE = "https://tile.googleapis.com"
ROOT_PATH = "/v1/3dtiles/root.json"
WGS84_A = 6378137.0
WGS84_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563)
MEAN_TILE_MB = 0.09  # measured on samples of this tileset, only used to announce the expected size


class BudgetExceeded(RuntimeError):
    pass


class Fetcher:
    """HTTP access to Google. Holds the key in memory only, never lets it reach a message, and refuses to go over the request caps."""

    def __init__(self, key: str, delay: float, max_requests: int, max_roots_left: int) -> None:
        self._key = key
        self._delay = delay
        self._max_requests = max_requests
        self._max_roots_left = max_roots_left
        self._lock = threading.Lock()
        self.requests = 0
        self.roots = 0
        self.session: str | None = None  # Google's session token (from the root tileset), memory only

    def mask(self, text: str) -> str:
        return text.replace(self._key, "***")

    def _count(self, root: bool) -> None:
        with self._lock:
            if self.requests >= self._max_requests:
                raise BudgetExceeded(f"request cap reached ({self._max_requests})")
            if root and self.roots >= self._max_roots_left:
                raise BudgetExceeded("root-request cap reached for this tool")
            self.requests += 1
            self.roots += 1 if root else 0

    def get(self, path: str, root: bool = False, retries: int = 6) -> bytes:
        if self.session and "session=" not in path:
            path += ("&" if "?" in path else "?") + f"session={self.session}"
        url = f"{GOOGLE}{path}{'&' if '?' in path else '?'}key={self._key}"
        for attempt in range(retries + 1):
            try:
                time.sleep(self._delay)
                self._count(root and attempt == 0)  # a retry of the root is not a second session, but it is still a request
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "firetrace-tiles-fetch/1"}), timeout=60) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                    wait = float(e.headers.get("Retry-After") or min(60, 2 ** (attempt + 1)))
                    self._delay = min(1.0, self._delay * 1.5)  # rate limited: every worker slows down
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"HTTP {e.code} for {self.mask(path.split('?')[0])}") from None
            except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ConnectionError) as e:
                if attempt < retries:
                    time.sleep(min(60, 2 ** (attempt + 1)))
                    continue
                raise RuntimeError(f"network error for {self.mask(path.split('?')[0])}: {self.mask(str(e))}") from None
        raise RuntimeError("unreachable")


# ----------------------------------------------------------------------------------------------------------- geometry
def ecef_to_latlon(x: float, y: float, z: float) -> tuple[float, float]:
    """ECEF (m) -> geodetic latitude/longitude (degrees), Bowring's iteration on WGS84."""
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - WGS84_E2))
    for _ in range(5):
        n = WGS84_A / math.sqrt(1 - WGS84_E2 * math.sin(lat) ** 2)
        lat = math.atan2(z + WGS84_E2 * n * math.sin(lat), p)
    return math.degrees(lat), math.degrees(lon)


def latlon_extent(volume: dict) -> tuple[float, float, float, float] | None:
    """(south, west, north, east) in degrees that a bounding volume covers; None if its shape is unknown."""
    if "box" in volume:
        b = volume["box"]
        c, axes = b[0:3], [b[3:6], b[6:9], b[9:12]]
        if max(abs(c[0]), abs(c[1]), abs(c[2])) < 1e6:
            return (-90.0, -180.0, 90.0, 180.0)  # contains the earth's centre: the global root
        lats, lons = [], []
        for sx in (-1, 1):
            for sy in (-1, 1):
                for sz in (-1, 1):
                    la, lo = ecef_to_latlon(*[c[i] + sx * axes[0][i] + sy * axes[1][i] + sz * axes[2][i] for i in range(3)])
                    lats.append(la)
                    lons.append(lo)
        return (min(lats), min(lons), max(lats), max(lons))
    if "region" in volume:
        w, s, e, n = volume["region"][:4]
        return (math.degrees(s), math.degrees(w), math.degrees(n), math.degrees(e))
    if "sphere" in volume:
        x, y, z, r = volume["sphere"]
        la, lo = ecef_to_latlon(x, y, z)
        d = math.degrees(r / WGS84_A)
        return (la - d, lo - d, la + d, lo + d)
    return None


def overlaps(extent: tuple[float, float, float, float] | None, bounds: tuple[float, float, float, float]) -> bool:
    if extent is None:
        return True
    s, w, n, e = extent
    return not (n < bounds[0] or s > bounds[2] or e < bounds[1] or w > bounds[3])


def centre_of(node: dict) -> tuple[float, float]:
    ext = latlon_extent(node.get("boundingVolume", {}))
    return ((ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2) if ext else (0.0, 0.0)


def km_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    dlat = (b[0] - a[0]) * 111.2
    dlon = (b[1] - a[1]) * 111.2 * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dlat, dlon)


# ----------------------------------------------------------------------------------------------------------- crawl
def strip_session(text: str) -> str:
    return re.sub(r"[?&]session=[A-Za-z0-9_\-]+", "", text)


def uri_of(node: dict) -> str | None:
    content = node.get("content") or {}
    return content.get("uri") or content.get("url")


def is_json(uri: str | None) -> bool:
    return bool(uri) and strip_session(uri).split("?")[0].endswith(".json")


def crawl(fetcher: Fetcher, cache: Path, bounds: tuple[float, float, float, float], floor: float, workers: int, log) -> dict:
    """The tile tree inside `bounds` (nested tilesets flattened), not refined below geometric error `floor` metres (finer lists cost many more requests and the budget never
    reaches them). Only tile LISTS are requested, and they are cached on disk without the session token."""
    root_bytes = fetcher.get(ROOT_PATH, root=True)
    if m := re.search(rb"session=([A-Za-z0-9_\-]+)", root_bytes):
        fetcher.session = m.group(1).decode()
    tileset = json.loads(strip_session(root_bytes.decode("utf-8")))
    cache.mkdir(parents=True, exist_ok=True)

    def nested_root(uri: str) -> dict:
        file = cache / f"{list_key(uri)}.json"
        if file.exists():
            return json.loads(file.read_text(encoding="utf-8"))["root"]
        text = strip_session(fetcher.get(uri).decode("utf-8"))
        file.write_text(text, encoding="utf-8")
        return json.loads(text)["root"]

    return build_tree(tileset, nested_root, bounds, floor, workers, fetcher, log)


def list_key(uri: str) -> str:
    return hashlib.sha1(strip_session(uri).split("?")[0].encode()).hexdigest()


def build_tree(tileset: dict, nested_root, bounds: tuple[float, float, float, float], floor: float, workers: int, fetcher: Fetcher | None, log) -> dict:
    root_out: dict = {}
    work = [(tileset["root"], root_out)]
    level = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        while work:
            nested = {id(raw): pool.submit(nested_root, uri_of(raw)) for raw, _ in work if is_json(uri_of(raw))}
            next_work = []
            for raw, out in work:
                out.update({k: v for k, v in raw.items() if k not in ("children", "content")})
                children, uri = raw.get("children", []), uri_of(raw)
                if id(raw) in nested:
                    inner = nested[id(raw)].result()  # the nested root stands in for this node: same area, its content and children go on
                    out.update({k: v for k, v in inner.items() if k not in ("children", "content")})
                    children, uri = inner.get("children", []), uri_of(inner)
                if uri:
                    out["content"] = {"uri": strip_session(uri)}
                for child in children if out.get("geometricError", 0) > floor else []:
                    if overlaps(latlon_extent(child.get("boundingVolume", {})), bounds):
                        child_out: dict = {}
                        out.setdefault("children", []).append(child_out)
                        next_work.append((child, child_out))
            level += 1
            if level % 3 == 0 or not next_work:
                log(f"  level {level}: {len(work)} nodes" + (f", {fetcher.requests} requests so far" if fetcher else ""))
            work = next_work
    return {"asset": {"version": "1.0"}, "geometricError": tileset.get("geometricError", 1e9), "root": root_out}


def cached_tileset(cache: Path, files: list[Path]) -> dict:
    """A stand-in for the root tileset, rebuilt from tile lists already on disk: the lists nothing else points to hang from a root like Google's."""
    docs = {f: json.loads(f.read_text(encoding="utf-8")) for f in files}
    referenced: set[str] = set()

    def scan(node: dict) -> None:
        uri = uri_of(node)
        if is_json(uri):
            referenced.add(list_key(uri))
        for c in node.get("children", []):
            scan(c)

    for doc in docs.values():
        scan(doc["root"])
    tops = [f for f in files if f.stem not in referenced]
    children = [{"boundingVolume": docs[f]["root"]["boundingVolume"], "geometricError": docs[f]["root"].get("geometricError", 1e9), "refine": "REPLACE", "content": {"uri": f"/cache/{f.stem}.json"}} for f in tops]
    return {"asset": {"version": "1.0"}, "geometricError": 1e100, "root": {"boundingVolume": {"box": [0, 0, 0, 7645212, 0, 0, 0, 7645212, 0, 0, 0, 7645212]}, "geometricError": 1e100, "refine": "REPLACE", "children": children}}


# ----------------------------------------------------------------------------------------------------------- choosing what to download
def select(root: dict, budget: int, focus: tuple[float, float]) -> set[int]:
    """
    Which nodes to keep so that the tiles to download number at most `budget`. Coarse first (every area gets a tile before any area gets a sharper one), and the sharper levels
    go to the nodes nearest `focus` first (the city centre): the map stays complete everywhere and is detailed where it matters. A parent's tile stays (it is what shows while
    its children load) and refining a node takes all of its children (a tile is replaced by all its children or by none).
    """
    included = {id(root)}
    cost = 1 if root.get("content") else 0
    heap: list[tuple[float, float, int, dict]] = []
    counter = 0

    def offer(node: dict) -> None:
        nonlocal counter
        if node.get("children"):
            counter += 1
            heapq.heappush(heap, (-round(node.get("geometricError", 0), 1), km_between(centre_of(node), focus), counter, node))

    def take(node: dict) -> None:
        """Nodes without a tile of their own cost nothing: go through them at once (their children, which do have tiles, are paid for here); the others wait their turn."""
        nonlocal cost
        stack = [node]
        while stack:
            n = stack.pop()
            if n.get("content"):
                offer(n)
            else:
                for c in n.get("children", []):
                    included.add(id(c))
                    cost += 1 if c.get("content") else 0
                    stack.append(c)

    take(root)
    while heap:
        _, _, _, node = heapq.heappop(heap)
        children = node["children"]
        add = sum(1 for c in children if c.get("content"))
        if cost + add > budget:
            continue  # this one no longer fits; a smaller one still may
        cost += add
        for c in children:
            included.add(id(c))
            take(c)  # a child with a tile was paid for in `add` just above; one without is walked through
    return included


def prune_missing(node: dict, have) -> dict:
    """Drops what is not on disk. A tile is replaced by ALL of its children or by none, so a node with a missing child keeps its own tile and loses all of its children."""
    kids = [prune_missing(c, have) for c in node.get("children", [])]
    out = {k: v for k, v in node.items() if k != "children"}
    if kids and all(have(k) for k in kids):
        out["children"] = kids
    return out


def build(node: dict, included: set[int]) -> dict:
    out = {k: v for k, v in node.items() if k != "children"}
    kids = [build(c, included) for c in node.get("children", []) if id(c) in included]
    if kids:
        out["children"] = kids
    return out


def contents(node: dict, found: dict[str, None]) -> None:
    if uri_of(node):
        found.setdefault(node["content"]["uri"], None)
    for c in node.get("children", []):
        contents(c, found)


def local_name(uri: str) -> str:
    return "tiles/" + hashlib.sha1(strip_session(uri).split("?")[0].encode()).hexdigest()[:20] + ".glb"


def rewrite(node: dict) -> None:
    if uri_of(node):
        node["content"]["uri"] = local_name(node["content"]["uri"])
    for c in node.get("children", []):
        rewrite(c)


def glb_copyright(data: bytes) -> str | None:
    """`asset.copyright` from the JSON chunk of a binary glTF (Google puts the data providers there)."""
    if len(data) < 20 or data[:4] != b"glTF":
        return None
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        return None
    try:
        return json.loads(data[20:20 + length]).get("asset", {}).get("copyright")
    except ValueError:
        return None


def download(fetcher: Fetcher, uris: list[str], out: Path, workers: int, log) -> tuple[int, set[str]]:
    (out / "tiles").mkdir(parents=True, exist_ok=True)
    total_bytes, copyrights, done = 0, set(), 0

    def one(uri: str) -> tuple[int, str | None]:
        target = out / local_name(uri)
        if target.exists() and target.stat().st_size > 0:
            data = target.read_bytes()  # already saved: not asked for again
            return len(data), glb_copyright(data)
        data = fetcher.get(uri)
        tmp = target.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(target)
        return len(data), glb_copyright(data)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, u) for u in uris]
        for f in as_completed(futures):
            size, cr = f.result()
            total_bytes += size
            done += 1
            if cr:
                copyrights.add(cr)
            if done % 250 == 0 or done == len(uris):
                log(f"  {done}/{len(uris)} tiles, {total_bytes / 1e6:.0f} MB, {fetcher.requests} requests so far")
    return total_bytes, copyrights


# ----------------------------------------------------------------------------------------------------------- main
def location_info(api: str, location: str) -> tuple[tuple[float, float, float, float], tuple[float, float]]:
    with urllib.request.urlopen(f"{api.rstrip('/')}/locations/{location}", timeout=30) as r:
        loc = json.load(r)
    b = loc["bounds"]
    c = loc.get("center") or {"lat": (b["south"] + b["north"]) / 2, "lon": (b["west"] + b["east"]) / 2}
    return (b["south"], b["west"], b["north"], b["east"]), (c["lat"], c["lon"])


def finalize(out: Path, bounds, focus, args, log) -> int:
    """Offline (no key, no request): write tileset.json and manifest.json from the tile lists and tiles already on disk, after an interrupted download."""
    cache = out / ".crawl"
    files = sorted(cache.glob("*.json"), key=lambda f: f.stat().st_mtime)
    if not files:
        raise SystemExit("No saved tile lists to rebuild from.")
    best = None
    # the cache may hold lists of several sessions; keep the group (by time written: a pause of more than 20 s between lists separates sessions) whose tiles are actually on disk
    groups: list[list[Path]] = [[files[0]]]
    for prev, cur in zip(files, files[1:]):
        (groups.append([cur]) if cur.stat().st_mtime - prev.stat().st_mtime > 20 else groups[-1].append(cur))
    for group in groups:
        tree = build_tree(cached_tileset(cache, group), lambda uri: json.loads((cache / (uri.rsplit("/", 1)[1] if uri.startswith("/cache/") else f"{list_key(uri)}.json")).read_text(encoding="utf-8"))["root"],
                          bounds, args.floor, args.workers, None, lambda m: None)
        flat = {**tree, "root": build(tree["root"], select(tree["root"], args.max_tiles, focus))}
        found: dict[str, None] = {}
        contents(flat["root"], found)
        missing = sum(1 for u in found if not (out / local_name(u)).exists())
        log(f"  group of {len(group)} lists: {len(found)} tiles, {missing} not on disk")
        if best is None or missing < best[0]:
            best = (missing, flat, found)
    assert best is not None
    missing, flat, found = best
    have = lambda node: not uri_of(node) or (out / local_name(node["content"]["uri"])).exists()
    flat["root"] = prune_missing(flat["root"], have)
    kept: dict[str, None] = {}
    contents(flat["root"], kept)
    total_bytes, copyrights = 0, set()
    for u in kept:
        data = (out / local_name(u)).read_bytes()
        total_bytes += len(data)
        if cr := glb_copyright(data):
            copyrights.add(cr)
    rewrite(flat["root"])
    (out / "tileset.json").write_text(json.dumps(flat, separators=(",", ":")), encoding="utf-8")
    attribution = sorted({p.strip() for c in copyrights for p in c.split(";") if p.strip()}) or ["Google"]
    manifest = {
        "source": "Google Photorealistic 3D Tiles (Map Tiles API)", "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "location": args.location,
        "bounds": {"south": bounds[0], "west": bounds[1], "north": bounds[2], "east": bounds[3]}, "focus": {"lat": focus[0], "lon": focus[1]},
        "tiles": len(kept), "bytes": total_bytes, "attribution": attribution,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    log(f"Finalized offline: {len(kept)} tiles ({missing} selected tiles were missing and left out), {total_bytes / 1e9:.2f} GB. No requests were made.")
    return 0


def read_key(args) -> str:
    if args.key_stdin:
        key = sys.stdin.readline().strip()
    elif os.environ.get("GOOGLE_MAPS_API_KEY"):
        key = os.environ["GOOGLE_MAPS_API_KEY"].strip()
    else:
        key = getpass.getpass("Google Map Tiles API key (hidden, not stored): ").strip()
    if not key:
        raise SystemExit("No API key given.")
    return key


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--location", default="guimaraes-concelho")
    ap.add_argument("--api", default="http://localhost:8080/api/v1", help="FireTrace API (used to read the location's bounds and centre)")
    ap.add_argument("--out", help="output folder (default data/tiles3d/<location>)")
    ap.add_argument("--max-requests", type=int, default=9500, help="hard cap on requests to Google in THIS run (tile lists + tiles)")
    ap.add_argument("--max-root-requests", type=int, default=3, help="hard cap on billed root requests over the tool's whole life (counted in usage.json)")
    ap.add_argument("--floor", type=float, default=8.0, help="never look for tiles finer than this geometric error (metres): bounds the number of tile lists requested")
    ap.add_argument("--max-tiles", type=int, default=7000, help="most tiles to download (the sharpest ones go around --focus)")
    ap.add_argument("--focus", help="lat,lon where the tiles are sharpest (default: the location's centre)")
    ap.add_argument("--workers", type=int, default=3, help="concurrent requests (Google rate-limits; the tool slows itself down on 429)")
    ap.add_argument("--delay", type=float, default=0.25, help="seconds between requests per worker")
    ap.add_argument("--force", action="store_true", help="download again without asking when tiles are already saved")
    ap.add_argument("--finalize", action="store_true", help="OFFLINE: write tileset.json/manifest.json from what is already on disk (after an interrupted download); no key, no requests")
    ap.add_argument("--key-stdin", action="store_true", help="read the key from the first line of stdin")
    args = ap.parse_args()

    log = lambda m: print(m, flush=True)
    bounds, centre = location_info(args.api, args.location)
    focus = tuple(float(v) for v in args.focus.split(",")) if args.focus else centre
    out = Path(args.out) if args.out else Path("data") / "tiles3d" / args.location
    saved, usage_file = out / "manifest.json", out / "usage.json"
    usage = json.loads(usage_file.read_text(encoding="utf-8")) if usage_file.exists() else {"rootRequests": 0, "requests": 0}

    if args.finalize:
        return finalize(out, bounds, focus, args, log)
    if saved.exists() and not args.force:
        # a later run: the tiles are already here, so nothing is requested unless the user says so
        old = json.loads(saved.read_text(encoding="utf-8"))
        print(f"Tiles already saved in {out}: {old.get('tiles')} tiles, {old.get('bytes', 0) / 1e9:.2f} GB, fetched {old.get('fetchedAt')}.")
        if not (sys.stdin.isatty() and input("Download them again? [y/N] ").strip().lower() in ("y", "yes")):
            print("Keeping the saved tiles (use --force to download again).")
            return 0
    roots_left = args.max_root_requests - usage["rootRequests"]
    if roots_left <= 0:
        raise SystemExit(f"Root-request cap reached ({usage['rootRequests']}/{args.max_root_requests}, see {usage_file}). Raise --max-root-requests only if you accept the cost.")

    fetcher = Fetcher(read_key(args), args.delay, args.max_requests, roots_left)
    log(f"{args.location}: bounds S{bounds[0]:.4f} W{bounds[1]:.4f} N{bounds[2]:.4f} E{bounds[3]:.4f}; sharpest around {focus[0]:.4f},{focus[1]:.4f}")
    out.mkdir(parents=True, exist_ok=True)
    try:
        log("Reading the tile list (cached after the first run)...")
        tree = crawl(fetcher, out / ".crawl", bounds, args.floor, args.workers, log)
        budget = max(0, min(args.max_tiles, args.max_requests - fetcher.requests - 100))  # keep a margin for retries
        included = select(tree["root"], budget, focus)
        flat = {**tree, "root": build(tree["root"], included)}
        found: dict[str, None] = {}
        contents(flat["root"], found)
        uris = list(found)
        log(f"Selected {len(uris)} tiles (about {len(uris) * MEAN_TILE_MB / 1000:.1f} GB) within the {args.max_requests}-request cap; {fetcher.requests} requests used so far.")
        total_bytes, copyrights = download(fetcher, uris, out, args.workers, log)
        rewrite(flat["root"])
        (out / "tileset.json").write_text(json.dumps(flat, separators=(",", ":")), encoding="utf-8")
        attribution = sorted({p.strip() for c in copyrights for p in c.split(";") if p.strip()}) or ["Google"]
        manifest = {
            "source": "Google Photorealistic 3D Tiles (Map Tiles API)", "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"), "location": args.location,
            "bounds": {"south": bounds[0], "west": bounds[1], "north": bounds[2], "east": bounds[3]}, "focus": {"lat": focus[0], "lon": focus[1]},
            "tiles": len(uris), "bytes": total_bytes, "attribution": attribution,
        }
        saved.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
        shutil.rmtree(out / ".crawl", ignore_errors=True)  # only needed to --finalize an interrupted run
        log(f"Done: {len(uris)} tiles, {total_bytes / 1e9:.2f} GB in {out}. The key was not written anywhere.")
        return 0
    except BudgetExceeded as e:
        log(f"STOPPED: {e}. Tiles already downloaded are kept; run again to continue (a new run costs one root request).")
        return 2
    finally:
        usage["rootRequests"] += fetcher.roots
        usage["requests"] += fetcher.requests
        usage["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        usage_file.write_text(json.dumps(usage, indent=2), encoding="utf-8")
        log(f"Requests this run: {fetcher.requests} (root: {fetcher.roots}). Lifetime: {usage['requests']} (root: {usage['rootRequests']}/{args.max_root_requests}).")


if __name__ == "__main__":
    sys.exit(main())
