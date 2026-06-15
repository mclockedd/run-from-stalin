Put your three sound files in this folder, with EXACTLY these names:

  lobby-music.mp3   - loops while everyone is in the 3D lobby / wheel / game over
  game-music.mp3    - loops during the countdown and the round
  kill.mp3          - plays once each time Stalin catches a runner

Notes:
- .mp3 is the safest format (works in every browser). If your files are .wav or
  .ogg, either convert them to .mp3 or rename them AND update the file names in
  wwwroot/game.js (the `Sound` object near the top).
- If a file is missing, the game still runs fine — that sound is just silent.
- Music starts after you click "Create Party" / "Join" (browsers block audio
  until you interact with the page). There's a 🔊 mute button bottom-right.
