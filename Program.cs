using System.Net.WebSockets;
using RunFromStalin;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets();

var game = new GameServer();

// Lists the audio files dropped into wwwroot/sounds, grouped by name prefix,
// so the client can pick a random track per category. Add/remove files freely;
// no config to edit. Convention: name starts with "lobby", "game", or "kill".
app.MapGet("/api/sounds", () =>
{
    var dir = Path.Combine(app.Environment.WebRootPath ?? "wwwroot", "sounds");
    string[] Cat(string prefix)
    {
        if (!Directory.Exists(dir)) return Array.Empty<string>();
        return Directory.EnumerateFiles(dir)
            .Select(Path.GetFileName)
            .Where(f => f is not null && f.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                     && (f.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase)
                      || f.EndsWith(".ogg", StringComparison.OrdinalIgnoreCase)
                      || f.EndsWith(".wav", StringComparison.OrdinalIgnoreCase)))
            .Select(f => "/sounds/" + f)
            .OrderBy(f => f)
            .ToArray();
    }
    return Results.Json(new { lobby = Cat("lobby"), game = Cat("game"), kill = Cat("kill") });
});

app.Map("/ws", async context =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = 400;
        return;
    }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    await game.HandleClient(socket);
});

// Drive all room game loops on a single background ticker (~30Hz).
_ = Task.Run(async () =>
{
    var last = DateTime.UtcNow;
    while (true)
    {
        await Task.Delay(33);
        var now = DateTime.UtcNow;
        var dt = (float)(now - last).TotalSeconds;
        last = now;
        game.Tick(dt);
    }
});

// Hosting platforms (Render, Railway, Fly, etc.) inject the port via $PORT.
// Locally there's no PORT, so we fall back to 5000.
var port = Environment.GetEnvironmentVariable("PORT") ?? "5000";
var url = $"http://0.0.0.0:{port}";
Console.WriteLine();
Console.WriteLine("==================================================");
Console.WriteLine("  RUN FROM STALIN - server running");
Console.WriteLine($"  Listening on port {port}");
Console.WriteLine("  Local play:  http://localhost:5000");
Console.WriteLine("==================================================");
Console.WriteLine();

app.Run(url);
