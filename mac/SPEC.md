# Mac pipeline: daily summaries + Qwen audio → Music app

The iPhone web app stays the place to choose channels, keep the "known" list, and do deep dives.
Every day the Mac does the heavy work: find new uploads, summarise them with Gemini (free tier),
turn the summary **and every topic detail** into speech with the local Qwen TTS used by
`~/Cluade/steiner-reader` (MLX), and add the tracks to the Music app so they reach the iPhone.
Gemini is **not** used for audio.

No checking or fixing of the generated speech: one take per text, no candidate sampling, no ASR
scoring, no manual review. (Automatic reading fixes that need no review — e.g. an existing kana
dictionary — may be applied.)

## Shared folder

`iCloud Drive/YTダイジェスト/` = `~/Library/Mobile Documents/com~apple~CloudDocs/YTダイジェスト/`

| File | Written by | Read by |
|---|---|---|
| `mac-settings.json` | iPhone app (設定 → Macとの連携 → Macに設定を渡す) | Mac |
| `digest-YYYY-MM-DD.json` | Mac (one per run day) | iPhone app (Macの要約を取り込む) |

### `mac-settings.json` (iPhone → Mac)

```json
{
  "format": "yt-digest/mac-settings", "version": 1, "exportedAt": "2026-11-18T12:00:00.000Z",
  "channels": [{ "id": "UC…", "title": "おーちゃん【元外銀マン】" }],
  "settings": { "days": 3, "perChannel": 5, "skipShorts": true, "model": "gemini-3.8-flash", "fps": 0.2, "knownLimit": 600 },
  "known": ["既知の事実を1文ずつ", "…"],
  "deleted": ["videoId", "…"],
  "done": ["videoId already summarised on the iPhone", "…"]
}
```

- `channels`: only the channels to summarise.
- `known`: the iPhone's known facts. Merge into the Mac's own list (dedupe by text); the Mac's list
  then grows with the facts of what it summarises.
- `deleted` / `done`: skip these video IDs.

### `digest-YYYY-MM-DD.json` (Mac → iPhone)

```json
{
  "format": "yt-digest/digest", "version": 1, "generatedAt": "2026-11-18T04:40:00+09:00",
  "videos": [{
    "id": "11-char video id", "title": "…", "channelId": "UC…", "channelTitle": "…",
    "publishedAt": "ISO", "seconds": 2280, "thumb": "https://i.ytimg.com/…",
    "summary": {
      "overview": "…",
      "topics": [{ "title": "…", "summary": "…", "detail": "…", "time": "12:34" }],
      "skipped": ["…"], "facts": ["…"], "notes": "…"
    }
  }]
}
```

`summary` has exactly the shape the web app's Gemini call returns (see `js/gemini.js` → `SUMMARY_SCHEMA`).
If a run finds nothing new, still write the file with `"videos": []` only if it helps; otherwise skip.
If the same day runs twice, merge into the existing day file (no duplicates).

## Daily run

1. Read `mac-settings.json` (stop with a clear log line if missing).
2. For each channel: newest uploads via YouTube Data API v3, exactly like `js/youtube.js`
   (`playlistItems` on `"UU" + channelId[2:]`, then `videos` for duration and `liveBroadcastContent`).
   Keep uploads within `days`, not live/upcoming, longer than 180 s when `skipShorts`, and not in
   `deleted`, `done` or the Mac's processed list.
3. Summarise each video with Gemini REST using **the same system text, prompt, schema and request
   options as `summarize()` in `js/gemini.js`** (YouTube URL as `fileData`, `videoMetadata.fps`,
   `MEDIA_RESOLUTION_LOW`, newest `knownLimit` known facts in the prompt). Same error handling:
   wait 15/30/60 s on 503 "high demand"; on 429 honour `retryDelay`; if the model is retired and the
   error names a replacement, switch to it. Process videos one by one so each sees the facts added by
   the previous one. Append `facts` to the Mac's known list.
4. Speech text (same wording as the app):
   - summary track: `{channelTitle}の動画、{title}。` + `全体の要約です。{overview}` + `話題は{n}つです。` +
     for each topic `{i}つ目、{title}。{summary}`. If `topics` is empty: `{overview}` (or `新しい情報はありませんでした。`).
   - one detail track per topic: `{title}について、詳しく説明します。{detail}`
5. Synthesise each text with the steiner-reader Qwen (MLX) setup, single take, and encode to m4a (AAC).
6. Tag and add to Music:
   - Album: `YTダイジェスト YYYY-MM-DD` (run date), Album artist: `YTダイジェスト`, Artist: channel title, Genre: `Podcast`-like or `Spoken`.
   - Track order per video: summary, then details 1..n. Titles: `{video title}（要約）`, `{video title}｜詳しく{i}：{topic title}`.
   - Add with AppleScript (`tell application "Music" to add POSIX file …`) the same way steiner-reader does,
     so the tracks sync to the iPhone (Sync Library / iCloud Music Library).
7. Write/merge `digest-YYYY-MM-DD.json` into the shared folder.
8. Save state (processed IDs, known facts) outside the repo or in a gitignored file.

## Scheduling and config

- Run daily with launchd (`StartCalendarInterval`, e.g. 04:30). A job missed while the Mac sleeps runs on wake.
- Gemini API key and YouTube Data API key in a gitignored `mac/.env`.
- Log each run to a file; one failed video must not stop the others.
- Optional: remove albums older than N days from Music and their files.
