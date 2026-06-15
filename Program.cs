using System.Net.WebSockets;
using RunFromStalin;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();
app.UseWebSockets();

var game = new GameServer();

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
