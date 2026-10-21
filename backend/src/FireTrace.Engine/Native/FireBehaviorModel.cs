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
        double windTo = Angles.Normalize(windFromDeg + 180), upslope = Angles.Normalize(aspect + 180);
        var surface = RothermelSurfaceFire.Compute(fuel, m1, m10, m100, liveHerb, liveWoody, midflameFtMin, slopeTan, windTo, upslope, settings.MaxLengthToWidthRatio);

        double rain = RainFactor(precipMmH, surface.IntensityKwm);
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
                // How much of the crown burns grows with how far the surface fire is past initiation (Van Wagner 1993; the FBP System's crown fraction burned,
                // CFB = 1 − e^(−k·(R − R0))): a fire just past the threshold torches a few trees, one well past it takes the whole canopy. R0 is the surface rate
                // at initiation; for the same surface fuel Byram's intensity is proportional to the rate, so R0 = R × I0 / I.
                double surfaceRos = ros;
                double r0 = surfaceRos * initiation / intensity;
                double cfb = 1 - Math.Exp(-settings.CrownFractionBurnedRate * Math.Max(0, surfaceRos - r0));
                double activeRos = settings.CrownFireRosFactor * surfaceRos;
                double criticalRos = settings.CriticalCrownRosFactor / canopyBulk;
                active = activeRos >= criticalRos;
                if (active) ros = surfaceRos + cfb * Math.Max(0, activeRos - surfaceRos); // FBP: ROS = RSS + CFB × (RSC − RSS)
                // The canopy fuel a crown fire can burn (foliage and fine twigs): bulk density × crown length, capped at what stands really carry
                // (peak bulk density over the whole crown length overstates it several times; Scott & Reinhardt 2001 put stands at ~0.5–2 kg/m²).
                double crownLoad = Math.Min(canopyBulk * (canopyHeightM - canopyBaseM), settings.MaxCanopyFuelLoadKgM2); // kg/m²
                double crownIntensity = settings.CrownHeatContentKjKg * crownLoad * cfb * ros / 60;
                intensity += Math.Max(0, crownIntensity);
            }
        }

        return new CellBehavior(ros, surface.DirectionDeg, surface.LengthToWidth, intensity, crown, active);
    }

    /// <summary>
    /// How much of the spread survives the rain: none above the extinction rate, all of it below the start rate, linear in between.
    /// Grounded in Byram (1959) and Albini (1979): higher fireline intensity vaporizes incoming rain, raising the effective extinction threshold.
    /// </summary>
    public double RainFactor(double precipMmH, double intensityKwm = 0)
    {
        if (precipMmH <= settings.RainStartMmH) return 1;
        double intensityMultiplier = intensityKwm > 500.0
            ? 1.0 + Math.Min(2.0, Math.Log10(intensityKwm / 500.0))
            : 1.0;
        double effectiveExtinction = settings.RainExtinctionMmH * intensityMultiplier;
        if (precipMmH >= effectiveExtinction) return 0;
        return 1 - (precipMmH - settings.RainStartMmH) / (effectiveExtinction - settings.RainStartMmH);
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
