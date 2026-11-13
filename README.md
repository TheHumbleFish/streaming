# CINEVA

A Netflix-style site for **your own videos**, built to run on GitHub Pages. It's plain HTML/CSS/JS, so there's no build step and no server.

Features: browse rows and a banner, search, movies and TV shows with seasons, subtitles (.vtt), resume where you left off, Continue Watching, My List, auto-play next episode, playback speed, keyboard shortcuts and a mobile layout.

## Put it online (GitHub Pages)

1. Create a new repository on GitHub and upload everything in this folder. Upload it as files, not as a zip.
2. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, pick `main` and `/ (root)`, then Save.
3. After a minute your site is live at `https://<your-username>.github.io/<repo-name>/`.

The demo titles in `library.json` and `media/demo/` are only placeholders. Delete them once you've added your own.

> **GitHub Pages sites are public.** Anyone with the link can watch. Only upload videos you own or have the right to share. A private repo doesn't make the published site private.

## Add your videos

### Option A: the helper script (recommended)

Needs Python 3 and [ffmpeg](https://ffmpeg.org). Run it on your computer inside this folder, then commit and push the result.

```bash
# a movie
python3 tools/add_title.py movie ~/Films/MyFilm.mkv --title "My Film" --year 2019 \
    --genres "Drama,Thriller" --description "What it's about" --subs en=~/Films/MyFilm.en.srt

# a TV show: set its details once, then add episodes
python3 tools/add_title.py show --show "My Show" --year 2021 --genres Comedy --description "About the show"
python3 tools/add_title.py episode ~/tv/s01e01.mkv --show "My Show" --season 1 --episode 1 --title "Pilot"
python3 tools/add_title.py episode ~/tv/s01e02.mkv --show "My Show" --season 1 --episode 2 --title "Second one"
```

The script converts anything browsers can't play into MP4 (H.264/AAC), makes a poster, backdrop and episode thumbnails from a frame (or use `--poster` / `--backdrop` for your own art), converts `.srt` subtitles to `.vtt`, and updates `library.json`.

### Option B: edit `library.json` by hand

Copy your files into `media/` and add an entry like the demo ones. Fields:

| Field | Notes |
|---|---|
| `id` | Unique, no spaces (used in links) |
| `type` | `"movie"` or `"show"` |
| `title`, `year`, `rating`, `runtime`, `genres`, `description`, `cast`, `director` | Shown in the UI; all optional except `id` and `title` |
| `poster` | Portrait image, about 400×600 |
| `backdrop` | Wide image, about 1280×720 (banner and details page) |
| `src` | Movie file path or URL (`.mp4`, `.webm` or `.m3u8`) |
| `subtitles` | `[{ "label": "English", "lang": "en", "src": "….vtt", "default": true }]` |
| `seasons` | Shows only: `[{ "number": 1, "episodes": [{ "number": 1, "title": "…", "src": "…", "thumb": "…" }] }]` |
| `featured` | `true` to allow it in the home page banner |
| `added` | `YYYY-MM-DD`, used by "Recently Added" |

`src` can also be a full `https://…` URL, so you can host the big files elsewhere (Cloudflare R2, Backblaze B2, Bunny, Internet Archive) and keep only the site on GitHub. The host must allow cross-origin playback and range requests.

## File size limits: read before uploading

- **GitHub rejects any single file over 100 MB.** A full movie as one MP4 usually exceeds this.
- Fixes: `--hls` cuts the video into small segments (any length works), `--compress` re-encodes to 720p, or you can host the video elsewhere (see above).
- GitHub Pages sites should stay under about **1 GB** and have a soft limit of about **100 GB bandwidth per month**. That's fine for friends and family, but too small for a real streaming service.
- HLS (`.m3u8`) plays natively in Safari. Other browsers load [hls.js](https://github.com/video-dev/hls.js) from a CDN on demand. To avoid the CDN, drop `hls.min.js` into `js/`.

## Vertical (reel-style) movies

Full-length movies shot or edited in 9:16 work out of the box. The player detects tall video by itself: on a computer it shows a centred full-height column over a blurred copy of the poster, and on a phone it fills the screen. Posters are already portrait, so they look right on the home page.

The helper script spots vertical files too, sets `"format": "vertical"` in `library.json`, and builds the poster and backdrop to suit. With `--compress`, vertical video is capped at 720 px wide (about 720×1280).

Vertical movies are still big files. Use `--hls` for anything long so each file stays under GitHub's 100 MB limit, and watch the overall repo size.

## Playback tips

- Browsers play **MP4 (H.264 + AAC)**, WebM, and HLS. They can't play raw `.mkv`, `.avi`, HEVC/H.265 (mostly) or `.srt` subtitles, so convert them first. The helper script does this.
- Watch progress and My List are stored in the browser (localStorage), so they're per device and don't sync.
- To test locally, don't double-click `index.html`. Run `python3 tools/serve.py` in this folder and open http://localhost:8000. Use this rather than `python3 -m http.server`, which can't serve byte ranges, so videos won't seek or resume. GitHub Pages is fine.

## Keyboard shortcuts

`Space`/`K` play/pause · `←` `→` ±5s · `J` `L` ±10s · `↑` `↓` volume · `M` mute · `F` fullscreen · `C` captions · `N` next episode · `0–9` jump to 0–90% · `Esc` close

## Customising

- Site name: `siteName` in `library.json`.
- Colours: the variables at the top of `css/style.css` (`--accent` is the red). The page is animated throughout and switches most motion off for visitors who have "reduce motion" set in their system.
