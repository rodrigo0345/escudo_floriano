namespace FireTrace.Engine.Native;

/// <summary>
/// One standard surface fuel model (Scott &amp; Burgan 40, the same table ELMFIRE reads from the FBFM40 band): the oven-dry load of each size class,
/// its surface-area-to-volume ratio, the fuel bed depth, the moisture of extinction and the heat content. Loads are lb/ft², ratios ft²/ft³ and depth ft,
/// the units of Rothermel (1972); the calculations convert to SI at the boundary.
/// </summary>
/// <param name="Code">Scott &amp; Burgan number stored in the landscape band (91–99 non-burnable, 101+ grass, 121+ grass-shrub, 141+ shrub, 161+ timber understory, 181+ litter).</param>
/// <param name="Name">Standard short name (GR2, SH5, TU5…).</param>
/// <param name="DepthFt">Fuel bed depth (ft).</param>
/// <param name="MoistureOfExtinctionPct">Dead fuel moisture of extinction (% of oven-dry weight).</param>
/// <param name="HeatContentBtuLb">Low heat content (Btu/lb), 8000 unless the model says otherwise.</param>
/// <param name="Load1h">Oven-dry load of the 1 h dead class (lb/ft²).</param>
/// <param name="Load10h">Oven-dry load of the 10 h dead class (lb/ft²).</param>
/// <param name="Load100h">Oven-dry load of the 100 h dead class (lb/ft²).</param>
/// <param name="LoadLiveHerb">Oven-dry live herbaceous load (lb/ft²).</param>
/// <param name="LoadLiveWoody">Oven-dry live woody load (lb/ft²).</param>
/// <param name="Sav1h">Surface-area-to-volume ratio of the 1 h class (ft⁻¹).</param>
/// <param name="Sav10h">Surface-area-to-volume ratio of the 10 h class (ft⁻¹).</param>
/// <param name="Sav100h">Surface-area-to-volume ratio of the 100 h class (ft⁻¹).</param>
/// <param name="SavLiveHerb">Surface-area-to-volume ratio of the live herbaceous class (ft⁻¹).</param>
/// <param name="SavLiveWoody">Surface-area-to-volume ratio of the live woody class (ft⁻¹).</param>
public sealed record FuelModelParameters(
    int Code, string Name, double DepthFt, double MoistureOfExtinctionPct, double HeatContentBtuLb,
    double Load1h, double Load10h, double Load100h, double LoadLiveHerb, double LoadLiveWoody,
    double Sav1h, double Sav10h, double Sav100h, double SavLiveHerb, double SavLiveWoody)
{
    /// <summary>Codes 91–99 are the non-burnable classes (water, rock, urban); everything else in the 40-model set carries fuel.</summary>
    public bool Burnable => Code is < 91 or > 99;

    /// <summary>Grass models with a live herbaceous class split their load into cured (dead) and green (live) fuel as the season advances.</summary>
    public bool Dynamic => Code > 100 && LoadLiveHerb > 0;
}
