#!/usr/bin/env python3
"""Add your own movies / episodes to the site.

Copies (or converts) a video into media/, makes a poster + backdrop from a
frame, converts .srt subtitles to .vtt, and updates library.json.

Needs Python 3.8+ and ffmpeg/ffprobe on your PATH (https://ffmpeg.org).

Examples
  python3 tools/add_title.py movie ~/Films/Heat.mkv --title "Heat" --year 1995 \
      --genres "Crime,Thriller" --description "A group of professional thieves…"

  python3 tools/add_title.py show --show "My Show" --year 2021 --genres Drama \
      --description "About my show" --poster ~/art/myshow.jpg

  python3 tools/add_title.py episode ~/tv/s01e01.mkv --show "My Show" \
      --season 1 --episode 1 --title "Pilot" --subs en=~/tv/s01e01.en.srt

Big files: GitHub rejects files over 100 MB. Add --hls to cut the video into
small segments (works for any length), or --compress to shrink it to 720p.
"""
import argparse
import datetime
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "library.json"
LANGS = {"en": "English", "es": "Español", "fr": "Français", "de": "Deutsch", "it": "Italiano",
         "pt": "Português", "ja": "日本語", "ko": "한국어", "zh": "中文", "ru": "Русский", "ar": "العربية"}
LIMIT = 95 * 1024 * 1024


def die(msg):
    sys.exit(f"error: {msg}")


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode:
        die(f"{cmd[0]} failed:\n{r.stderr[-1500:]}")
    return r.stdout


def need_ffmpeg():
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        die("ffmpeg/ffprobe not found. Install from https://ffmpeg.org and try again.")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "title"


def rel(p):
    return Path(p).resolve().relative_to(ROOT).as_posix()


def probe(path):
    """Returns (duration, video codec, audio codec, width, height) with phone rotation applied."""
    info = json.loads(run(["ffprobe", "-v", "error", "-show_entries",
                           "format=duration:stream=codec_type,codec_name,width,height:stream_tags=rotate:stream_side_data=rotation",
                           "-of", "json", str(path)]))
    streams = info.get("streams", [])
    vs = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s.get("codec_name") for s in streams if s.get("codec_type") == "audio"), None)
    v = w = h = None
    if vs:
        v, w, h = vs.get("codec_name"), vs.get("width"), vs.get("height")
        rot = (vs.get("tags") or {}).get("rotate")
        for sd in vs.get("side_data_list") or []:
            if "rotation" in sd:
                rot = sd["rotation"]
        try:
            if abs(int(float(rot))) % 180 == 90 and w and h:
                w, h = h, w
        except (TypeError, ValueError):
            pass
    return float(info["format"].get("duration", 0)), v, a, w, h


def runtime_str(sec):
    m = int(round(sec / 60))
    return f"{m // 60}h {m % 60:02d}m" if m >= 60 else f"{max(m, 1)}m"


def web_friendly(path, v, a):
    ext = path.suffix.lower()
    if ext in (".mp4", ".m4v") and v == "h264" and a in (None, "aac", "mp3"):
        return True
    return ext == ".webm" and v in ("vp8", "vp9", "av1") and a in (None, "opus", "vorbis")


def encode_args(src, v, a, compress, force_encode, vertical=False):
    copy = web_friendly(src, v, a) and not compress and not force_encode
    if copy:
        return ["-c", "copy"]
    args = ["-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "medium",
            "-crf", "27" if compress else "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k" if compress else "160k"]
    if compress:  # cap the short side at 720 px (720 wide for vertical video, 720 high otherwise)
        args += ["-vf", "scale='min(720,iw)':-2" if vertical else "scale=-2:'min(720,ih)'"]
    return args


def process_video(src, out_dir, base, hls, compress):
    """Returns (path to playable file relative to ROOT, duration seconds, is_vertical)."""
    need_ffmpeg()
    dur, v, a, w, h = probe(src)
    if not v:
        die(f"{src} has no video stream")
    vertical = bool(w and h and h > w)
    if vertical:
        print("  vertical (9:16-style) video detected")
    out_dir.mkdir(parents=True, exist_ok=True)
    if hls:
        d = out_dir / base
        d.mkdir(exist_ok=True)
        can_copy = v == "h264" and a in (None, "aac") and not compress
        enc = ["-c", "copy"] if can_copy else encode_args(src, v, a, compress, True, vertical)
        print(f"  cutting into HLS segments → {d}")
        run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), *enc, "-f", "hls", "-hls_time", "6",
             "-hls_playlist_type", "vod", "-hls_segment_filename", str(d / "seg_%05d.ts"), str(d / "index.m3u8")])
        return rel(d / "index.m3u8"), dur, vertical
    ext = ".webm" if web_friendly(src, v, a) and src.suffix.lower() == ".webm" and not compress else ".mp4"
    out = out_dir / (base + ext)
    if encode_args(src, v, a, compress, False, vertical) == ["-c", "copy"]:
        print(f"  already web-friendly, copying → {out}")
        shutil.copy2(src, out)
    else:
        print(f"  converting to MP4 (H.264/AAC) → {out}  (this can take a while)")
        run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), *encode_args(src, v, a, compress, False, vertical),
             "-movflags", "+faststart", str(out)])
    size = out.stat().st_size
    if size > LIMIT:
        print(f"  ! {out.name} is {size / 1048576:.0f} MB — GitHub blocks files over 100 MB.\n"
              f"    Re-run with --hls (segments) or --compress (720p), or host the file elsewhere.")
    return rel(out), dur, vertical


def grab_frame(src, dur, out, frac, vf):
    run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{max(dur * frac, 0):.2f}", "-i", str(src),
         "-frames:v", "1", "-vf", vf, "-q:v", "3", str(out)])


def make_art(src, dur, out_dir, name, vertical=False):
    """poster (2:3) + backdrop (16:9) from a frame, unless the user supplies their own."""
    poster, backdrop = out_dir / f"{name}poster.jpg", out_dir / f"{name}backdrop.jpg"
    if vertical:
        grab_frame(src, dur, poster, 0.12, "crop=iw:iw*3/2:0:(ih-iw*3/2)/2,scale=400:600")
        # tall frame centred over a blurred, darkened copy of itself
        grab_frame(src, dur, backdrop, 0.12,
                   "split[a][b];[a]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,"
                   "boxblur=30:3,eq=brightness=-0.25[bg];[b]scale=-2:720[fg];[bg][fg]overlay=(W-w)/2:0")
    else:
        grab_frame(src, dur, poster, 0.12, "crop=ih*2/3:ih,scale=400:600")
        grab_frame(src, dur, backdrop, 0.12, "scale=1280:-2")
    return rel(poster), rel(backdrop)


def copy_art(path, out_dir, name):
    p = Path(path).expanduser()
    if not p.is_file():
        die(f"image not found: {p}")
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{name}{p.suffix.lower()}"
    shutil.copy2(p, dest)
    return rel(dest)


def add_subs(specs, out_dir, base):
    out = []
    for spec in specs or []:
        lang, _, path = spec.partition("=")
        p = Path(path).expanduser()
        if not path or not p.is_file():
            die(f"--subs expects LANG=FILE (e.g. en=movie.srt); got {spec!r}")
        text = p.read_text(encoding="utf-8-sig", errors="replace").replace("\r\n", "\n")
        if p.suffix.lower() == ".srt":
            text = "WEBVTT\n\n" + re.sub(r"(\d{2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
        elif not text.startswith("WEBVTT"):
            die(f"{p.name}: only .srt and .vtt subtitles are supported")
        dest = out_dir / f"{base}.{lang}.vtt"
        dest.write_text(text, encoding="utf-8")
        entry = {"label": LANGS.get(lang, lang.upper()), "lang": lang, "src": rel(dest)}
        if not out:
            entry["default"] = True
        out.append(entry)
    return out


def load_lib():
    if LIB.exists():
        return json.loads(LIB.read_text(encoding="utf-8"))
    return {"siteName": "CINEVA", "items": []}


def save_lib(lib):
    LIB.write_text(json.dumps(lib, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    total = sum(f.stat().st_size for f in (ROOT / "media").rglob("*") if f.is_file())
    print(f"library.json updated. media/ is now {total / 1048576:.0f} MB "
          f"(GitHub recommends keeping a repo under ~1 GB).")


def find(lib, item_id):
    return next((i for i in lib["items"] if i["id"] == item_id), None)


def set_meta(item, a):
    if a.year:
        item["year"] = a.year
    if a.genres:
        item["genres"] = [g.strip() for g in a.genres.split(",") if g.strip()]
    for k in ("description", "rating", "director"):
        if getattr(a, k, None):
            item[k] = getattr(a, k)
    if getattr(a, "cast", None):
        item["cast"] = [c.strip() for c in a.cast.split(",") if c.strip()]
    if getattr(a, "featured", False):
        item["featured"] = True


# ---------- commands ----------
def cmd_movie(a):
    src = Path(a.file).expanduser()
    if not src.is_file():
        die(f"file not found: {src}")
    title = a.title or src.stem
    sid = slug(title)
    out_dir = ROOT / "media" / sid
    print(f"Adding movie: {title}")
    path, dur, vertical = process_video(src, out_dir, sid, a.hls, a.compress)
    lib = load_lib()
    item = find(lib, sid) or {"id": sid, "type": "movie"}
    item.update({"title": title, "type": "movie", "src": path, "runtime": runtime_str(dur),
                 "added": datetime.date.today().isoformat()})
    set_meta(item, a)
    if vertical:
        item["format"] = "vertical"
    if a.poster:
        item["poster"] = copy_art(a.poster, out_dir, "poster")
    if a.backdrop:
        item["backdrop"] = copy_art(a.backdrop, out_dir, "backdrop")
    if "poster" not in item or "backdrop" not in item:
        p, b = make_art(src, dur, out_dir, "", vertical)
        item.setdefault("poster", p)
        item.setdefault("backdrop", b)
    subs = add_subs(a.subs, out_dir, sid)
    if subs:
        item["subtitles"] = subs
    if find(lib, sid) is None:
        lib["items"].append(item)
    save_lib(lib)


def get_show(lib, name):
    sid = slug(name)
    show = find(lib, sid)
    if show is None:
        show = {"id": sid, "type": "show", "title": name, "added": datetime.date.today().isoformat(), "seasons": []}
        lib["items"].append(show)
    return show


def cmd_show(a):
    lib = load_lib()
    show = get_show(lib, a.show)
    set_meta(show, a)
    out_dir = ROOT / "media" / show["id"]
    if a.poster:
        show["poster"] = copy_art(a.poster, out_dir, "poster")
    if a.backdrop:
        show["backdrop"] = copy_art(a.backdrop, out_dir, "backdrop")
    save_lib(lib)


def cmd_episode(a):
    src = Path(a.file).expanduser()
    if not src.is_file():
        die(f"file not found: {src}")
    lib = load_lib()
    show = get_show(lib, a.show)
    out_dir = ROOT / "media" / show["id"]
    base = f"s{a.season:02d}e{a.episode:02d}"
    print(f"Adding {show['title']} S{a.season}:E{a.episode}")
    path, dur, vertical = process_video(src, out_dir, base, a.hls, a.compress)
    if vertical:
        show["format"] = "vertical"
    ep = {"number": a.episode, "title": a.title or f"Episode {a.episode}", "src": path, "runtime": runtime_str(dur)}
    if a.description:
        ep["description"] = a.description
    thumb = out_dir / f"{base}.jpg"
    grab_frame(src, dur, thumb, 0.2, "scale=480:-2")
    ep["thumb"] = rel(thumb)
    subs = add_subs(a.subs, out_dir, base)
    if subs:
        ep["subtitles"] = subs
    season = next((s for s in show["seasons"] if s.get("number") == a.season), None)
    if season is None:
        season = {"number": a.season, "episodes": []}
        show["seasons"].append(season)
        show["seasons"].sort(key=lambda s: s["number"])
    season["episodes"] = [e for e in season["episodes"] if e.get("number") != a.episode] + [ep]
    season["episodes"].sort(key=lambda e: e["number"])
    # Use the first episode's frame as show art if none yet.
    if "poster" not in show or "backdrop" not in show:
        p, b = make_art(src, dur, out_dir, "", vertical)
        show.setdefault("poster", p)
        show.setdefault("backdrop", b)
    save_lib(lib)


def common(p, video=True):
    p.add_argument("--year", type=int)
    p.add_argument("--genres", help='comma separated, e.g. "Drama,Comedy"')
    p.add_argument("--description")
    if video:
        p.add_argument("--hls", action="store_true", help="cut into small HLS segments (avoids the 100 MB file limit)")
        p.add_argument("--compress", action="store_true", help="re-encode to 720p to shrink the file")
        p.add_argument("--subs", action="append", metavar="LANG=FILE", help="subtitle (.srt/.vtt); repeatable")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    m = sub.add_parser("movie", help="add a movie")
    m.add_argument("file")
    m.add_argument("--title")
    m.add_argument("--rating", help="e.g. PG-13")
    m.add_argument("--director")
    m.add_argument("--cast", help="comma separated")
    m.add_argument("--poster", help="your own poster image (default: frame from the video)")
    m.add_argument("--backdrop", help="your own wide backdrop image")
    m.add_argument("--featured", action="store_true", help="may appear in the home page banner")
    common(m)
    m.set_defaults(fn=cmd_movie)

    s = sub.add_parser("show", help="create/update a TV show's details")
    s.add_argument("--show", required=True)
    s.add_argument("--rating")
    s.add_argument("--cast")
    s.add_argument("--poster")
    s.add_argument("--backdrop")
    s.add_argument("--featured", action="store_true")
    common(s, video=False)
    s.set_defaults(fn=cmd_show)

    e = sub.add_parser("episode", help="add an episode (creates the show if needed)")
    e.add_argument("file")
    e.add_argument("--show", required=True, help="show title")
    e.add_argument("--season", type=int, default=1)
    e.add_argument("--episode", type=int, required=True)
    e.add_argument("--title", help="episode title")
    e.add_argument("--description")
    e.add_argument("--hls", action="store_true")
    e.add_argument("--compress", action="store_true")
    e.add_argument("--subs", action="append", metavar="LANG=FILE")
    e.set_defaults(fn=cmd_episode)

    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
