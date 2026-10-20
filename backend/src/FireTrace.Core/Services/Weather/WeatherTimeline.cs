using FireTrace.Core.Configuration;
using FireTrace.Core.Domain.Common;
using FireTrace.Core.Domain.Weather;
using FireTrace.Engine.Weather;

namespace FireTrace.Core.Services.Weather;

/// <summary>
/// Constrói a meteorologia de uma simulação a partir da receita (`WeatherSpec`): parte da série real (ou de nada), fixa os pontos-chave e
/// aplica os eventos pela ordem. O resultado é uma série contínua que começa antes do início (aquecimento da humidade do combustível).
/// </summary>
public static class WeatherTimeline
{
    sealed class Cell(int minute)
    {
        public int Minute = minute;
        public double Wind, Dir, Humidity, Temp, Gust, Precip;
    }

    public static WeatherTrack Build(WeatherSpec spec, IReadOnlyList<WeatherSample> hourly, DateTimeOffset start, int durationMinutes, WeatherTimelineSettings t, int spinUpHours)
    {
        int from = -spinUpHours * 60, to = durationMinutes + t.MarginMinutes;
        var cells = Enumerable.Range(0, (to - from) / t.StepMinutes + 1).Select(i => new Cell(from + i * t.StepMinutes)).ToArray();

        if (spec.Base == WeatherBase.Provider)
        {
            if (hourly.Count == 0) throw new InvalidOperationException("Sem dados meteorológicos para o intervalo pedido.");
            var real = new WeatherTrack(hourly.Select(s => new WeatherPoint((s.Time - start).TotalMinutes, s.WindKmh ?? 0, s.WindFromDeg ?? 0, s.HumidityPct ?? t.ProviderFallback.HumidityPct, s.TempC ?? t.ProviderFallback.TempC,
                s.GustKmh ?? 0, s.PrecipitationMmH ?? 0)));
            foreach (var c in cells)
            {
                var p = real.At(c.Minute);
                (c.Wind, c.Dir, c.Humidity, c.Temp, c.Gust, c.Precip) = (p.WindKmh, p.WindFromDeg, p.HumidityPct, p.TempC, p.GustKmh, p.PrecipitationMmH);
            }
        }
        else foreach (var c in cells) (c.Wind, c.Dir, c.Humidity, c.Temp) = (t.NoneBase.WindKmh, t.NoneBase.WindFromDeg, t.NoneBase.HumidityPct, t.NoneBase.TempC);

        var interpolation = spec.Interpolation ?? new Interpolation();
        bool baseIsNone = spec.Base == WeatherBase.None;
        ApplyKeyframes(cells, spec.Keyframes ?? new(), start, interpolation, baseIsNone);
        foreach (var e in spec.Events ?? new()) if (e.Enabled) ApplyEvent(cells, e, start, interpolation, t, baseIsNone);

        return new WeatherTrack(cells.Select(c => new WeatherPoint(c.Minute, Math.Max(0, c.Wind), Angles.Normalize(c.Dir), Math.Clamp(c.Humidity, t.MinHumidityPct, t.MaxHumidityPct), c.Temp,
            Math.Max(c.Gust, 0), Math.Max(c.Precip, 0))));
    }

    // ------------------------------------------------------------------------------------------------ pontos-chave
    sealed record Anchor(double Minute, double Value, string Transition);

    static void ApplyKeyframes(Cell[] cells, List<WeatherKeyframe> keyframes, DateTimeOffset start, Interpolation interp, bool baseIsNone)
    {
        void Apply(Func<WeatherKeyframe, double?> pick, Action<Cell, double> set, bool angle = false)
        {
            var anchors = keyframes.Select(k => (K: k, V: pick(k))).Where(t => t.V is not null)
                .Select(t => new Anchor(t.K.At.MinutesFrom(start), t.V!.Value, t.K.Transition ?? interp.Default)).OrderBy(a => a.Minute).ToArray();
            if (anchors.Length == 0) return;
            foreach (var c in cells)
            {
                if (c.Minute < anchors[0].Minute) { if (baseIsNone) set(c, anchors[0].Value); continue; } // antes do primeiro ponto: série real (ou o primeiro valor)
                int i = Array.FindLastIndex(anchors, a => a.Minute <= c.Minute);
                if (i == anchors.Length - 1) { set(c, anchors[i].Value); continue; }
                var (a, b) = (anchors[i], anchors[i + 1]);
                double f = Ease((c.Minute - a.Minute) / (b.Minute - a.Minute), b.Transition);
                set(c, angle ? Angles.Lerp(a.Value, b.Value, f, interp.WindDirection) : a.Value + (b.Value - a.Value) * f);
            }
        }
        Apply(k => k.WindKmh, (c, v) => c.Wind = v);
        Apply(k => k.WindFromDeg, (c, v) => c.Dir = v, angle: true);
        Apply(k => k.TempC, (c, v) => c.Temp = v);
        Apply(k => k.HumidityPct, (c, v) => c.Humidity = v);
        Apply(k => k.GustKmh, (c, v) => c.Gust = v);
        Apply(k => k.PrecipitationMmH, (c, v) => c.Precip = v);
    }

    static double Ease(double f, string transition) => transition switch
    {
        "step" => f >= 1 ? 1 : 0,
        "smooth" => f * f * (3 - 2 * f),
        _ => f,
    };

    // ------------------------------------------------------------------------------------------------ eventos
    static void ApplyEvent(Cell[] cells, WeatherEvent e, DateTimeOffset start, Interpolation interp, WeatherTimelineSettings t, bool baseIsNone)
    {
        switch (e)
        {
            case WindShiftEvent s:
            {
                double t0 = s.Start.MinutesFrom(start), ramp = s.RampMinutes;
                double hold = s.HoldMinutes ?? double.PositiveInfinity, back = s.ReturnRampMinutes ?? (s.HoldMinutes is null ? 0 : ramp);
                foreach (var c in cells)
                {
                    double w = Envelope(c.Minute, t0, ramp, hold, back);
                    if (w <= 0) continue;
                    double target = s.ToDeg ?? c.Dir + (s.DeltaDeg ?? 0);
                    c.Dir = Angles.Lerp(c.Dir, target, w, s.Rotation);
                }
                break;
            }
            case WindScaleEvent s:
                foreach (var c in cells)
                {
                    double w = Window(c.Minute, s.Window, start, s.RampMinutes);
                    if (w <= 0) continue;
                    double k = 1 + (s.Factor - 1) * w;
                    c.Wind *= k; if (s.ApplyToGusts) c.Gust *= k;
                }
                break;
            case WindSetEvent s:
                foreach (var c in cells)
                {
                    double w = Window(c.Minute, s.Window, start, s.RampMinutes);
                    if (w <= 0) continue;
                    if (s.WindKmh is { } ws) c.Wind += (ws - c.Wind) * w;
                    if (s.WindFromDeg is { } wd) c.Dir = Angles.Lerp(c.Dir, wd, w, interp.WindDirection);
                }
                break;
            case GustBurstEvent s:
                foreach (var c in cells) if (Window(c.Minute, s.Window, start, 0) > 0) c.Gust = Math.Max(c.Gust, s.PeakGustKmh);
                break;
            case FrontPassageEvent s:
            {
                double t0 = s.At.MinutesFrom(start), dur = Math.Max(1, s.DurationMinutes);
                foreach (var c in cells)
                {
                    if (c.Minute < t0) continue;
                    double f = Math.Min(1, (c.Minute - t0) / dur), w = f * f * (3 - 2 * f); // a frente muda a massa de ar e a mudança fica
                    if (s.WindKmh is { } ws) c.Wind += (ws - c.Wind) * w;
                    if (s.WindFromDeg is { } wd) c.Dir = Angles.Lerp(c.Dir, wd, w, interp.WindDirection);
                    c.Temp += (s.TempDeltaC ?? 0) * w;
                    c.Humidity += (s.HumidityDeltaPct ?? 0) * w;
                    if (c.Minute <= t0 + dur) c.Precip += s.PrecipitationMmH ?? 0;
                }
                break;
            }
            case TemperatureShiftEvent s:
                foreach (var c in cells)
                {
                    double w = Window(c.Minute, s.Window, start, s.RampMinutes);
                    if (w > 0) c.Temp = s.SetC is { } set ? c.Temp + (set - c.Temp) * w : c.Temp + (s.DeltaC ?? 0) * w;
                }
                break;
            case HumidityShiftEvent s:
                foreach (var c in cells)
                {
                    double w = Window(c.Minute, s.Window, start, s.RampMinutes);
                    if (w > 0) c.Humidity = s.SetPct is { } set ? c.Humidity + (set - c.Humidity) * w : c.Humidity + (s.DeltaPct ?? 0) * w;
                }
                break;
            case PrecipitationEvent s:
                foreach (var c in cells)
                {
                    double w = Window(c.Minute, s.Window, start, s.RampMinutes);
                    if (w <= 0) continue;
                    c.Precip += s.IntensityMmH * w;
                    c.Humidity += (t.RainSaturationHumidityPct - c.Humidity) * w; // a chuva satura o ar: o combustível fino humedece
                }
                break;
            case CustomSeriesEvent s:
                ApplyKeyframes(cells, s.Samples.Select(x => new WeatherKeyframe
                {
                    At = new TimeSpec(Time: x.Time), WindKmh = x.WindKmh, WindFromDeg = x.WindFromDeg, TempC = x.TempC, HumidityPct = x.HumidityPct,
                    GustKmh = x.GustKmh, PrecipitationMmH = x.PrecipitationMmH,
                }).ToList(), start, interp, baseIsNone);
                break;
        }
    }

    /// <summary>0 fora da janela, 1 dentro; sobe e desce linearmente em `ramp` minutos nas bordas.</summary>
    static double Window(int minute, TimeWindow w, DateTimeOffset start, double ramp)
    {
        double s = w.Start.MinutesFrom(start), e = w.End.MinutesFrom(start);
        if (minute < s || minute > e) return 0;
        if (ramp <= 0) return 1;
        return Math.Min(1, Math.Min((minute - s) / ramp, (e - minute) / ramp + 0.0001));
    }

    /// <summary>Sobe em `ramp` minutos a partir de `t0`, mantém-se `hold` minutos e desce em `back` minutos.</summary>
    static double Envelope(int minute, double t0, double ramp, double hold, double back)
    {
        if (minute < t0) return 0;
        double up = ramp <= 0 ? 1 : Math.Min(1, (minute - t0) / ramp), end = t0 + ramp + hold;
        if (minute <= end) return up;
        if (back <= 0) return 0;
        return Math.Max(0, 1 - (minute - end) / back);
    }
}
