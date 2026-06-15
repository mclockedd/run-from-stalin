using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Collections.Concurrent;

namespace RunFromStalin;

public class Player
{
    public string Id = Guid.NewGuid().ToString("N")[..8];
    public string Name = "Player";
    public WebSocket Socket = null!;
    public readonly SemaphoreSlim SendLock = new(1, 1);
    public float X, Y;
    public float InX, InY;   // desired movement direction (world space, normalized client-side)
    public float Face;       // yaw the player is looking, radians (cosmetic, for other clients)
    public bool IsStalin;
    public bool Caught;
    public bool Connected = true;
    public DateTime LastTaunt = DateTime.MinValue;
}

public class Wall
{
    public float X, Y, W, H;
    public Wall(float x, float y, float w, float h) { X = x; Y = y; W = w; H = h; }
}

public class Room
{
    public string Code = "";
    public string HostId = "";
    public string Phase = "lobby"; // lobby, wheel, countdown, playing, gameover
    public readonly ConcurrentDictionary<string, Player> Players = new();

    public float WheelTimer;
    public string WheelWinnerId = "";
    public string LastStalinId = "";   // to avoid picking the same Stalin twice in a row
    public float Countdown;
    public float TimeLeft;
    public float GameOverTimer;
    public string Winner = "";       // "stalin" | "runners"
    public string StalinName = "";

    // game arena
    public const float WorldW = 2800;
    public const float WorldH = 2000;
    public List<Wall> GameWalls = new();

    // lobby room
    public const float LobbyW = 1100;
    public const float LobbyH = 800;
    public List<Wall> LobbyWalls = new();

    // which map is active right now
    public float ActiveW => Phase == "lobby" ? LobbyW : WorldW;
    public float ActiveH => Phase == "lobby" ? LobbyH : WorldH;
    public List<Wall> ActiveWalls => Phase == "lobby" ? LobbyWalls : GameWalls;

    public Room()
    {
        BuildGameMap();
        BuildLobbyMap();
    }

    private void BuildGameMap()
    {
        GameWalls.Clear();
        float t = 30;
        GameWalls.Add(new Wall(0, 0, WorldW, t));
        GameWalls.Add(new Wall(0, WorldH - t, WorldW, t));
        GameWalls.Add(new Wall(0, 0, t, WorldH));
        GameWalls.Add(new Wall(WorldW - t, 0, t, WorldH));
        // Interior "buildings" scattered across the larger arena.
        var b = new (float x, float y, float w, float h)[]
        {
            (300, 250, 360, 140), (900, 200, 160, 360), (1400, 300, 400, 130),
            (2050, 250, 150, 400), (2400, 520, 160, 420), (250, 660, 150, 420),
            (700, 820, 420, 140), (1300, 650, 170, 170), (1520, 960, 360, 150),
            (2060, 820, 150, 300), (350, 1260, 420, 140), (960, 1220, 160, 420),
            (1360, 1420, 420, 140), (1920, 1320, 150, 420), (2360, 1260, 300, 150),
            (610, 1580, 300, 140), (2120, 1660, 420, 140), (1260, 1720, 300, 130),
        };
        foreach (var w in b) GameWalls.Add(new Wall(w.x, w.y, w.w, w.h));
    }

    private void BuildLobbyMap()
    {
        LobbyWalls.Clear();
        float t = 30;
        LobbyWalls.Add(new Wall(0, 0, LobbyW, t));
        LobbyWalls.Add(new Wall(0, LobbyH - t, LobbyW, t));
        LobbyWalls.Add(new Wall(0, 0, t, LobbyH));
        LobbyWalls.Add(new Wall(LobbyW - t, 0, t, LobbyH));
        // central pedestal (where the wheel "stands")
        LobbyWalls.Add(new Wall(LobbyW / 2 - 70, LobbyH / 2 - 70, 140, 140));
    }
}

public class GameServer
{
    private readonly ConcurrentDictionary<string, Room> _rooms = new();
    private static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    private const float RunnerSpeed = 230f;
    private const float StalinSpeed = 255f;
    private const float Radius = 18f;
    private const float CatchDist = 30f;
    private const float RoundSeconds = 120f;
    private static readonly TimeSpan TauntCooldown = TimeSpan.FromSeconds(1.2);

    // ---- connection handling -------------------------------------------------

    public async Task HandleClient(WebSocket socket)
    {
        Room? room = null;
        Player? player = null;
        var buffer = new byte[8192];
        var sb = new StringBuilder();

        try
        {
            while (socket.State == WebSocketState.Open)
            {
                sb.Clear();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, CancellationToken.None);
                    if (result.MessageType == WebSocketMessageType.Close)
                        return;
                    sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                } while (!result.EndOfMessage);

                JsonDocument doc;
                try { doc = JsonDocument.Parse(sb.ToString()); }
                catch { continue; }

                using (doc)
                {
                    var root = doc.RootElement;
                    var type = root.TryGetProperty("type", out var tEl) ? tEl.GetString() : null;

                    switch (type)
                    {
                        case "create":
                        case "join":
                            (room, player) = await HandleJoin(socket, root, type);
                            break;
                        case "input" when player != null:
                            player.InX = (float)GetDouble(root, "mx");
                            player.InY = (float)GetDouble(root, "my");
                            player.Face = (float)GetDouble(root, "face");
                            break;
                        case "spin" when room != null && player != null:
                            TrySpin(room, player);
                            break;
                        case "taunt" when room != null && player != null:
                            TryTaunt(room, player);
                            break;
                        case "restart" when room != null && player != null:
                            if (room.HostId == player.Id && (room.Phase == "gameover" || room.Phase == "playing"))
                                ResetToLobby(room);
                            break;
                    }
                }
            }
        }
        catch { /* socket died */ }
        finally
        {
            if (room != null && player != null)
            {
                player.Connected = false;
                room.Players.TryRemove(player.Id, out _);
                if (room.Players.IsEmpty)
                    _rooms.TryRemove(room.Code, out _);
                else if (room.HostId == player.Id)
                    room.HostId = room.Players.Keys.First();
                // state is rebroadcast every tick, so no explicit roster push needed
            }
        }
    }

    private async Task<(Room?, Player?)> HandleJoin(WebSocket socket, JsonElement root, string type)
    {
        var name = (root.TryGetProperty("name", out var nEl) ? nEl.GetString() : null) ?? "Player";
        name = name.Trim();
        if (name.Length == 0) name = "Player";
        if (name.Length > 14) name = name[..14];

        Room room;
        if (type == "create")
        {
            room = new Room { Code = NewCode() };
            _rooms[room.Code] = room;
        }
        else
        {
            var code = (root.TryGetProperty("code", out var cEl) ? cEl.GetString() : "")?.Trim().ToUpperInvariant() ?? "";
            if (!_rooms.TryGetValue(code, out var found))
            {
                await SendRaw(socket, new { type = "error", message = "No party found with that code." });
                return (null, null);
            }
            if (found.Phase != "lobby")
            {
                await SendRaw(socket, new { type = "error", message = "That party already started a round." });
                return (null, null);
            }
            room = found;
        }

        var player = new Player { Name = name, Socket = socket };
        if (room.Players.IsEmpty) room.HostId = player.Id;
        room.Players[player.Id] = player;
        PlaceInLobby(room, player);

        await SendRaw(socket, new { type = "joined", id = player.Id, code = room.Code, isHost = room.HostId == player.Id });
        return (room, player);
    }

    private void PlaceInLobby(Room room, Player p)
    {
        // spawn around the lower part of the room, facing the central pedestal
        int idx = room.Players.Count;
        double ang = idx * 1.1;
        p.X = (float)(Room.LobbyW / 2 + Math.Cos(ang) * 280);
        p.Y = (float)(Room.LobbyH / 2 + 230 + Math.Sin(ang) * 60);
        p.X = Math.Clamp(p.X, 80, Room.LobbyW - 80);
        p.Y = Math.Clamp(p.Y, 80, Room.LobbyH - 80);
        p.InX = p.InY = 0;
    }

    private string NewCode()
    {
        const string chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        var rng = Random.Shared;
        while (true)
        {
            var code = new string(Enumerable.Range(0, 4).Select(_ => chars[rng.Next(chars.Length)]).ToArray());
            if (!_rooms.ContainsKey(code)) return code;
        }
    }

    // ---- the wheel -----------------------------------------------------------

    private void TrySpin(Room room, Player requester)
    {
        if (room.HostId != requester.Id) return;
        if (room.Phase != "lobby") return;
        if (room.Players.Count < 2) return;

        var ids = room.Players.Keys.ToList();
        // Pick uniformly at random, but avoid repeating the previous Stalin when
        // there's more than one candidate — keeps it feeling fair and fresh.
        var pool = ids.Count > 2 && ids.Contains(room.LastStalinId)
            ? ids.Where(id => id != room.LastStalinId).ToList()
            : ids;
        room.WheelWinnerId = pool[Random.Shared.Next(pool.Count)];
        room.Phase = "wheel";
        room.WheelTimer = 4.5f;

        // Send players in a freshly shuffled order so the wheel layout varies each spin.
        var entries = room.Players.Values
            .OrderBy(_ => Random.Shared.Next())
            .Select(p => new { id = p.Id, name = p.Name })
            .ToList();
        _ = Broadcast(room, new { type = "wheel", winnerId = room.WheelWinnerId, players = entries });
    }

    // A taunt: clients play taunt.mp3 positionally from this player's location,
    // so Stalin can hear roughly where they are. Rate-limited to curb spam.
    private void TryTaunt(Room room, Player p)
    {
        if (room.Phase != "playing" || p.Caught) return;
        var now = DateTime.UtcNow;
        if (now - p.LastTaunt < TauntCooldown) return;
        p.LastTaunt = now;
        _ = Broadcast(room, new { type = "taunt", id = p.Id });
    }

    // ---- main tick (all rooms) ----------------------------------------------

    public void Tick(float dt)
    {
        if (dt > 0.1f) dt = 0.1f; // clamp big stalls
        foreach (var room in _rooms.Values)
        {
            switch (room.Phase)
            {
                case "lobby":
                    MoveEveryone(room, dt);
                    _ = BroadcastState(room);
                    break;
                case "wheel":
                    room.WheelTimer -= dt;
                    if (room.WheelTimer <= 0) StartRound(room);
                    break;
                case "countdown":
                    room.Countdown -= dt;
                    if (room.Countdown <= 0) room.Phase = "playing";
                    _ = BroadcastState(room);
                    break;
                case "playing":
                    UpdatePlaying(room, dt);
                    _ = BroadcastState(room);
                    break;
                case "gameover":
                    room.GameOverTimer -= dt;
                    if (room.GameOverTimer <= 0) ResetToLobby(room);
                    else _ = BroadcastState(room);
                    break;
            }
        }
    }

    private void StartRound(Room room)
    {
        var players = room.Players.Values.ToList();
        foreach (var p in players)
        {
            p.IsStalin = p.Id == room.WheelWinnerId;
            p.Caught = false;
            p.InX = p.InY = 0;
        }
        room.LastStalinId = room.WheelWinnerId;
        var stalin = players.FirstOrDefault(p => p.IsStalin);
        if (stalin != null) { stalin.X = Room.WorldW / 2; stalin.Y = Room.WorldH / 2; }
        var runners = players.Where(p => !p.IsStalin).ToList();
        for (int i = 0; i < runners.Count; i++)
        {
            double ang = (Math.PI * 2 * i) / Math.Max(1, runners.Count);
            runners[i].X = (float)(Room.WorldW / 2 + Math.Cos(ang) * 1150);
            runners[i].Y = (float)(Room.WorldH / 2 + Math.Sin(ang) * 820);
            runners[i].X = Math.Clamp(runners[i].X, 80, Room.WorldW - 80);
            runners[i].Y = Math.Clamp(runners[i].Y, 80, Room.WorldH - 80);
        }
        room.StalinName = stalin?.Name ?? "?";
        room.TimeLeft = RoundSeconds;
        room.Countdown = 3f;
        room.Phase = "countdown";
    }

    // Free walking with no game rules (used in the lobby).
    private void MoveEveryone(Room room, float dt)
    {
        foreach (var p in room.Players.Values)
            ApplyMovement(room, p, dt, RunnerSpeed);
    }

    private void UpdatePlaying(Room room, float dt)
    {
        room.TimeLeft -= dt;

        foreach (var p in room.Players.Values)
        {
            if (p.Caught) continue;
            ApplyMovement(room, p, dt, p.IsStalin ? StalinSpeed : RunnerSpeed);
        }

        var stalin = room.Players.Values.FirstOrDefault(p => p.IsStalin && !p.Caught);
        if (stalin != null)
        {
            foreach (var p in room.Players.Values)
            {
                if (p.IsStalin || p.Caught) continue;
                float dx = p.X - stalin.X, dy = p.Y - stalin.Y;
                if (dx * dx + dy * dy <= CatchDist * CatchDist)
                    p.Caught = true;
            }
        }

        bool anyRunnerFree = room.Players.Values.Any(p => !p.IsStalin && !p.Caught);
        if (!anyRunnerFree && room.Players.Values.Any(p => !p.IsStalin))
            EndRound(room, "stalin");
        else if (room.TimeLeft <= 0)
            EndRound(room, "runners");
    }

    private void ApplyMovement(Room room, Player p, float dt, float speed)
    {
        float vx = p.InX, vy = p.InY;
        float len = MathF.Sqrt(vx * vx + vy * vy);
        if (len <= 0.01f) return;
        if (len > 1f) { vx /= len; vy /= len; }
        MoveWithCollision(room, p, vx * speed * dt, vy * speed * dt);
    }

    private void EndRound(Room room, string winner)
    {
        room.Winner = winner;
        room.Phase = "gameover";
        room.GameOverTimer = 7f;
    }

    private void ResetToLobby(Room room)
    {
        room.Phase = "lobby";
        room.Winner = "";
        foreach (var p in room.Players.Values)
        {
            p.IsStalin = false;
            p.Caught = false;
            PlaceInLobby(room, p);
        }
    }

    // ---- collision (operates on the active map) ------------------------------

    private void MoveWithCollision(Room room, Player p, float dx, float dy)
    {
        var walls = room.ActiveWalls;
        p.X += dx;
        ResolveAxis(walls, p, true);
        p.Y += dy;
        ResolveAxis(walls, p, false);
        p.X = Math.Clamp(p.X, Radius, room.ActiveW - Radius);
        p.Y = Math.Clamp(p.Y, Radius, room.ActiveH - Radius);
    }

    private void ResolveAxis(List<Wall> walls, Player p, bool xAxis)
    {
        foreach (var w in walls)
        {
            float closestX = Math.Clamp(p.X, w.X, w.X + w.W);
            float closestY = Math.Clamp(p.Y, w.Y, w.Y + w.H);
            float dx = p.X - closestX, dy = p.Y - closestY;
            if (dx * dx + dy * dy >= Radius * Radius) continue;

            if (xAxis)
                p.X = (p.X < w.X + w.W / 2) ? w.X - Radius : w.X + w.W + Radius;
            else
                p.Y = (p.Y < w.Y + w.H / 2) ? w.Y - Radius : w.Y + w.H + Radius;
        }
    }

    // ---- broadcasting --------------------------------------------------------

    private Task BroadcastState(Room room)
    {
        var players = room.Players.Values.Select(p => new
        {
            id = p.Id,
            name = p.Name,
            x = MathF.Round(p.X, 1),
            y = MathF.Round(p.Y, 1),
            face = MathF.Round(p.Face, 3),
            stalin = p.IsStalin,
            caught = p.Caught
        }).ToList();

        var msg = new
        {
            type = "state",
            phase = room.Phase,
            code = room.Code,
            hostId = room.HostId,
            timeLeft = MathF.Max(0, MathF.Round(room.TimeLeft, 1)),
            countdown = MathF.Ceiling(MathF.Max(0, room.Countdown)),
            winner = room.Winner,
            stalinName = room.StalinName,
            world = new { w = room.ActiveW, h = room.ActiveH },
            walls = room.ActiveWalls.Select(w => new { x = w.X, y = w.Y, w = w.W, h = w.H }),
            players
        };
        return Broadcast(room, msg);
    }

    private async Task Broadcast(Room room, object payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOpts);
        foreach (var p in room.Players.Values)
            await SendBytes(p, json);
    }

    private async Task SendRaw(WebSocket socket, object payload)
    {
        var json = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOpts);
        try { await socket.SendAsync(json, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch { }
    }

    private async Task SendBytes(Player p, byte[] json)
    {
        if (p.Socket.State != WebSocketState.Open) return;
        await p.SendLock.WaitAsync();
        try { await p.Socket.SendAsync(json, WebSocketMessageType.Text, true, CancellationToken.None); }
        catch { }
        finally { p.SendLock.Release(); }
    }

    private static double GetDouble(JsonElement root, string name)
        => root.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number ? el.GetDouble() : 0;
}
