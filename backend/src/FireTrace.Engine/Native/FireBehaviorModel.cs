using FireTrace.Engine.Configuration;
using FireTrace.Engine.Contracts;
using FireTrace.Engine.Weather;

namespace FireTrace.Engine.Native;

/// <summary>
/// The fire physics of the native engine, as pure functions of the landscape bands and the weather of the minute: Rothermel's surface spread with
/// the fuel model of the cell, the midflame wind (canopy shelter, gusts), the slope and the aspect's drying, Van Wagner's crown-fire initiation and
/// active-crowning test, and the damping of rain. Nothing here reads or writes state.
/// </summary>
public sealed class FireBehaviorModel(NativeEngineSettings settings, FuelMoistureSettings moisture)
{
    /// <summary>1 km/h at 10 m is about 0.93 × the 20-ft wind Rothermel's wind factor expects; 1 km/h = 54.68 ft/min.</summary>
    const double KmhToTwentyFootFtPerMin = 54.68 * 0.93;
    const double DegreesToRadians = Math.PI / 180.0;

    /// <summary>How many minutes share one computed cell behaviour (the weather and moisture are interpolated, not static).</summary>
    public int BehaviorBucketMinutes => settings.BehaviorBucketMinutes;

    /// <summary>Foliar moisture (%) used when the scenario does not fix one; drives Van Wagner's crown initiation threshold.</summary>
    public double DefaultFoliarMoisturePct => settings.DefaultFoliarMoisturePct;

    /// <summary>What the fire does in cell `c` with this minute's fuel moisture and this wind, before the per-cell local adjustment.</summary>
    public CellBehavior Of(short[] bands, int n, int c, DeadFuelMoisture.Row row, double windKmh, double windFromDeg, double gustKmh, double precipMmH, double foliarPct)
    {
        var fuel = FuelModelCatalog.For(LandscapeBands.At(bands, n, LandscapeBands.Fuel, c));
        if (!fuel.Burnable) return CellBehavior.None;

        double slopeDeg = LandscapeBands.At(bands, n, LandscapeBands.Slope, c);
        double aspect = LandscapeBands.At(bands, n, LandscapeBands.Aspect, c);

        // Dead fine fuel on a south/west-facing slope is drier: the aspect swings the 1 h moisture by a few percent, never below the floor.
        double m1 = row.M1 / 100.0;
        if (slopeDeg >= 0.5 && settings.AspectMoistureSwingPct > 0)
        {
            double southness = -Math.Cos(aspect * DegreesToRadians); // +1 south-facing (drier), −1 north-facing (wetter)
            m1 -= settings.AspectMoistureSwingPct / 100.0 * southness;
        }
        m1 = Math.Clamp(m1, moisture.MinDeadMoisturePct / 100.0, 0.60);
        double m10 = Math.Clamp(row.M10 / 100.0, moisture.MinDeadMoisturePct / 100.0, 0.60);
        double m100 = Math.Clamp(row.M100 / 100.0, moisture.MinDeadMoisturePct / 100.0, 0.60);
        double liveHerb = Math.Clamp(row.Lh / 100.0, 0, 3.0), liveWoody = Math.Clamp(row.Lw / 100.0, 0, 3.0);

        // The 10-m wind first becomes a 20-ft wind, then the wind adjustment factor takes it to the fuel bed (canopy, fuel depth).
        double wind = gustKmh > windKmh ? windKmh + settings.GustFactor * (gustKmh - windKmh) : windKmh;
        double canopyCover = Math.Clamp(LandscapeBands.At(bands, n, LandscapeBands.CanopyCover, c) / 100.0, 0, 1);
        double canopyHeightFt = Math.Max(0, LandscapeBands.At(bands, n, LandscapeBands.CanopyHeight, c) / 10.0) * 3.28084;
        double waf = WindAdjustmentFactor.Of(fuel.DepthFt, canopyHeightFt, canopyCover, settings.MinWindAdjustmentFactor);
        double midflameFtMin = Math.Max(0, wind) * KmhToTwentyFootFtPerMin * waf;

        double slopeTan = slopeDeg >= 0.5 ? Math.Tan(Math.Min(slopeDeg, 80) * DegreesToRadians) : 0;
        var surface = RothermelSurfaceFire.Compute(fuel, m1, m10, m100, liveHerb, liveWoody, midflameFtMin, slopeTan,
            Angles.Normalize(windFromDeg + 180), Angles.Normalize(aspect + 180), settings.MaxLengthToWidthRatio);

        double rain = RainFactor(precipMmH);
        double ros = surface.MaxRosMPerMin * settings.SpreadCalibration * rain;
        double intensity = surface.IntensityKwm * settings.SpreadCalibration * rain;
        if (ros <= 1e-9 || intensity <= 0) return CellBehavior.None;

        // ---------------------------------------------------------------- crown fire: Van Wagner (1977) initiation and (1993) active-crowning test
        bool crown = false, active = false;
        double canopyCoverPct = canopyCover * 100;
        double canopyHeightM = canopyHeightFt / 3.28084;
        double canopyBaseM = LandscapeBands.At(bands, n, LandscapeBands.CanopyBase, c) / 10.0;
        double canopyBulk = LandscapeBands.At(bands, n, LandscapeBands.CanopyBulkDensity, c) / 100.0;
        if (canopyCoverPct >= settings.MinCrownCoverPct && canopyBaseM > 0.1 && canopyBulk > 0.01 && canopyHeightM > canopyBaseM)
        {
            double foliar = foliarPct > 0 ? foliarPct : settings.DefaultFoliarMoisturePct;
            double initiation = Math.Pow(0.010 * canopyBaseM * (460 + 25.9 * foliar), 1.5); // kW/m
            if (intensity >= initiation)
            {
                crown = true;
                double activeRos = settings.CrownFireRosFactor * ros;
                double criticalRos = settings.CriticalCrownRosFactor / canopyBulk;
                active = activeRos >= criticalRos;
                if (active) ros = Math.Max(ros, activeRos);
                double crownLoad = canopyBulk * (canopyHeightM - canopyBaseM); // kg/m²
                double crownIntensity = settings.CrownHeatContentKjKg * crownLoad * (active ? 1.0 : settings.PassiveCrownFuelFraction) * ros / 60;
                intensity += Math.Max(0, crownIntensity);
            }
        }

        return new CellBehavior(ros, surface.DirectionDeg, surface.LengthToWidth, intensity, crown, active);
    }

    /// <summary>How much of the spread survives the rain: none above the extinction rate, all of it below the start rate, linear in between.</summary>
    public double RainFactor(double precipMmH)
    {
        if (precipMmH <= settings.RainStartMmH) return 1;
        if (precipMmH >= settings.RainExtinctionMmH) return 0;
        return 1 - (precipMmH - settings.RainStartMmH) / (settings.RainExtinctionMmH - settings.RainStartMmH);
    }

    /// <summary>
    /// Huygens' ellipse: the fraction of the maximum spread rate in a direction `bearingDeg`, for an ellipse elongated along `maxDirectionDeg`
    /// with length-to-width `lb` (the standard FARSITE/FlamMap formula, 1 along the major axis and (1−e)/(1+e) at the back).
    /// </summary>
    public static double EllipseFactor(double bearingDeg, double maxDirectionDeg, double lb)
    {
        if (lb <= 1) return 1;
        double ecc = Math.Sqrt(Math.Max(1 - 1 / (lb * lb), 0));
        double theta = (bearingDeg - maxDirectionDeg) * DegreesToRadians;
        return (1 - ecc) / (1 - ecc * Math.Cos(theta));
    }
}
