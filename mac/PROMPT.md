# Instruction for a Claude session on the Mac

Paste the text below into a new Claude Code session started on the Mac (folder `~/Cluade`).

---

YouTube新着ダイジェスト（https://github.com/yinamori-bot/yt-digest ）のMac側の仕組みを作ってください。

- `~/Cluade/yt-digest` に clone して（なければ）、`mac/SPEC.md` の仕様どおりに `mac/` 以下へ実装してください。
- 音声は `~/Cluade/steiner-reader` で使っている Qwen（MLX）の合成を使います。ただし**読み上げ音声のチェック・修正作業は不要**です：1つの文章につき1回だけ合成し、複数候補からの選択、ASRでの照合、聞き比べ、手作業の修正はしません（確認なしで自動で使える読み辞書の適用はかまいません）。
- 要約と、各話題の詳しい内容の**両方**をMacで音声にし、ミュージックアプリに追加してiPhoneで聞けるようにします。Geminiは要約だけに使い、音声には使いません。
- Gemini と YouTube Data API のキーは `mac/.env` に置きます（gitには入れない）。キーの値はわたしが入れるので、場所と書き方だけ教えてください。
- 毎日決まった時刻（例：4:30）に launchd で自動実行します。時刻はわたしに確認してください。
- まず1チャンネル・1本で、要約→音声→ミュージック追加→digest-日付.json の書き出しまで通して、iPhoneで聞けることを確かめてから、毎日の自動実行を設定してください。
- 終わったら `mac/README.md` に使い方を日本語で書き、yt-digest の main に push してください。
