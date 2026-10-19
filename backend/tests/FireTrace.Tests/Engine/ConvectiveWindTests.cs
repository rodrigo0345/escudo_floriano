using FireTrace.Core.Common;
using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Coupling;
using FireTrace.Engine.Weather;
using FireTrace.ExternalData.Map;
using FireTrace.Tests.Support;

namespace FireTrace.Tests.Engine;

public class ConvectiveWindTests
{
    const int N = 60;
    static readonly GridSpec Spec = new(41.4, -8.3, N, N, 60);
    static readonly ConvectionSettings Settings = TestSettings.All.Convection;
    static readonly WeatherTrack Westerly = WeatherTrack.Constant(20, 270, 30);

    static FireResult FireAt(int x, int y, ushort intensity)
    {
        var ignition = Enumerable.Repeat(-1, N * N).ToArray(); var flin = new ushort[N * N];
        ignition[y * N + x] = 0; flin[y * N + x] = intensity;
        return new FireResult { Ignition = ignition, IntensityKwm = flin, Flags = new byte[N * N] };
    }

    static (float Speed, float From) At(WindField f, int band, int x, int y)
    {
        int bx = (int)(x * Spec.CellM / f.CellM), by = (int)(y * Spec.CellM / f.CellM), i = band * f.Cols * f.Rows + by * f.Cols + bx;
        return (f.SpeedKmh[i], f.FromDeg[i]);
    }

    [Fact]
    public void Without_a_fire_the_wind_is_the_ambient_wind()
    {
        var none = new FireResult { Ignition = Enumerable.Repeat(-1, N * N).ToArray(), IntensityKwm = new ushort[N * N], Flags = new byte[N * N] };
        var f = ConvectiveWind.Field(Spec.ToEngineGrid(), none, Westerly, 3, 600, Settings);
        Assert.All(f.SpeedKmh, v => Assert.Equal(20f, v, 3));
        Assert.All(f.FromDeg, v => Assert.Equal(270f, v, 3));
    }

    [Fact]
    public void The_fire_pulls_air_in_so_it_reinforces_the_wind_behind_and_weakens_it_ahead()
    {
        var f = ConvectiveWind.Field(Spec.ToEngineGrid(), FireAt(30, 30, 8000), Westerly, 3, 600, Settings);
        var behind = At(f, 1, 22, 30); var ahead = At(f, 1, 38, 30);
        Assert.True(behind.Speed > 20f, "a oeste (atrás) o ar é puxado para o fogo, na direção do vento");
        Assert.True(ahead.Speed < 20f, "a leste (à frente) o ar é puxado contra o vento");
    }

    [Fact]
    public void Air_is_pulled_sideways_toward_the_fire_on_the_flanks_and_the_effect_is_bounded()
    {
        var f = ConvectiveWind.Field(Spec.ToEngineGrid(), FireAt(30, 30, 60000), Westerly, 3, 600, Settings);
        var north = At(f, 1, 30, 22);                     // a norte do fogo, o ar vai para sul: o vento (de oeste) ganha componente do norte
        Assert.InRange(north.From, 270f, 359f);
        double cap = Math.Min(Settings.MaxInducedKmh, Math.Max(Settings.MinInducedCapKmh, Settings.MaxInducedFraction * 20));
        Assert.All(f.SpeedKmh, v => Assert.InRange(v, 20 - cap - 0.01, 20 + cap + 0.01)); // o vento do tempo manda: o fogo só o curva dentro do limite
    }

    [Fact]
    public void A_stronger_fire_pulls_harder()
    {
        Assert.True(ConvectiveWind.InflowSpeed(10000, Settings) > ConvectiveWind.InflowSpeed(1000, Settings));
        Assert.Equal(0, ConvectiveWind.InflowSpeed(0, Settings));
    }
}
