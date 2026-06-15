# Run From Stalin

A real-time multiplayer party game. Everyone joins a party, the host **spins a wheel**,
and one unlucky player becomes **Stalin**. Stalin chases; everyone else runs and hides
around a top-down map. Survive the timer and the runners win — get caught and you're out.

Built with **ASP.NET Core + WebSockets** (server-authoritative) and an **HTML5 canvas** client.
No external dependencies — just the .NET SDK.

## Run it

```powershell
cd "C:\Users\mcloc\Downloads\RunFromStalin"
dotnet run
```

Then open **http://localhost:5000** in your browser.

## Play with friends (same network / LAN)

1. You host: enter a name → **Create Party** → you get a 4-letter code.
2. Friends open `http://<your-pc-ip>:5000` and **Join** with the code.
   - Find your IP with `ipconfig` (look for IPv4 Address).
   - First time, Windows Firewall may ask to allow the app — click **Allow**.
3. Host clicks **Spin the Wheel**. The wheel picks Stalin.
4. 3-second countdown (Stalin is frozen so runners can scatter), then GO.

## How to play

- **Move:** WASD or arrow keys.
- **Stalin (red ★):** touch a runner to catch them.
- **Runners (gold):** hide behind buildings, survive 90 seconds.
- **Win:** Stalin catches everyone → Stalin wins. Timer runs out → runners win.
- After each round it returns to the lobby — spin again for a new Stalin.

## Tuning

Gameplay constants live at the top of `GameServer.cs`:
`RunnerSpeed`, `StalinSpeed`, `Radius`, `CatchDist`, `RoundSeconds`.
The map (`Walls`) is defined in `Room.BuildMap()`.
