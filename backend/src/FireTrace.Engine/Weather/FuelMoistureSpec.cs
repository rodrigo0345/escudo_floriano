namespace FireTrace.Engine.Weather;

public sealed record FuelMoistureSpec(string Mode = "derived", FuelMoisture? Values = null, double? DeadBiasPct = null);
