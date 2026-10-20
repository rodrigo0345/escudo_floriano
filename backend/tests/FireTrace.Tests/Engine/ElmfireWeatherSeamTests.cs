using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Elmfire;
using FireTrace.Engine.Weather;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Engine;

/// <summary>
/// O seam com o contentor ELMFIRE: a rajada e a humidade foliar têm de chegar ao `wx_&lt;m&gt;.csv` e ao `meta.json`. O ELMFIRE não tem
/// campos próprios para nenhuma delas, por isso a rajada entra na velocidade do vento (com o mesmo `GustFactor` do motor nativo) e a
/// humidade foliar entra como chave opcional do `meta.json`. Não precisa do contentor: escreve a pasta e lê os ficheiros.
/// </summary>
public class ElmfireWeatherSeamTests
{
    static readonly string Jobs = Path.Combine(Path.GetTempPath(), "firetrace-seam-tests");

    static ElmfireJobFiles Files() => new(
        new ElmfireOptions(Jobs, "http://localhost:9000", TestSettings.All.Engine.MetIntervalSeconds, 5, 3, 3, TestSettings.All.Engine.Spotting),
        TestSettings.All.FuelMoisture, TestSettings.All.NativeEngine);

    static FireJob Job(double gustKmh, double? foliarPct)
    {
        var grid = new EngineGrid(4, 3, 30);
        var weather = new MemberWeather("rep", new WeatherTrack(new[] { new WeatherPoint(0, 10, 270, 25, 25, gustKmh) }));
        var moisture = new FuelMoistureSpec("fixed", new FuelMoisture(FoliarPct: foliarPct), null);
        return new FireJob(grid, new short[8 * grid.CellCount], new float[grid.CellCount], new[] { new IgnitionCell(1, 1) }, 60,
            new[] { weather }, 0, Spotting: false, FuelMoisture: foliarPct is null ? null : moisture);
    }

    [Fact]
    public async Task Gust_reaches_the_wind_column_and_foliar_moisture_reaches_meta()
    {
        string dir = Path.Combine(Jobs, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            await Files().WriteInputsAsync(dir, Job(30, 120), CancellationToken.None);
            string[] rows = await File.ReadAllLinesAsync(Path.Combine(dir, "wx_rep.csv"));
            Assert.Equal("ws,wd,m1,m10,m100,lh,lw", rows[0]);
            double wind = double.Parse(rows[1].Split(',')[0], System.Globalization.CultureInfo.InvariantCulture);
            // wind + GustFactor * (gust - wind) = 10 + 0.5 * (30 - 10)
            Assert.Equal(10 + TestSettings.All.NativeEngine.GustFactor * 20, wind, 3);
            string meta = await File.ReadAllTextAsync(Path.Combine(dir, "meta.json"));
            Assert.Contains("\"foliar_pct\":120", meta);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }

    [Fact]
    public async Task Without_a_gust_the_wind_column_is_the_mean_wind()
    {
        string dir = Path.Combine(Jobs, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            await Files().WriteInputsAsync(dir, Job(0, null), CancellationToken.None);
            string[] rows = await File.ReadAllLinesAsync(Path.Combine(dir, "wx_rep.csv"));
            double wind = double.Parse(rows[1].Split(',')[0], System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal(10, wind, 3);
            string meta = await File.ReadAllTextAsync(Path.Combine(dir, "meta.json"));
            // sem cenário explícito, usa a humidade foliar por omissão do motor nativo (a do ELMFIRE era um 90 escondido)
            Assert.Contains($"\"foliar_pct\":{TestSettings.All.NativeEngine.DefaultFoliarMoisturePct}", meta);
        }
        finally { Directory.Delete(dir, recursive: true); }
    }
}
