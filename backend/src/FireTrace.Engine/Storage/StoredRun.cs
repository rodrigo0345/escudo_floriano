using FireTrace.Engine.Contracts;

namespace FireTrace.Engine.Storage;

/// <summary>
/// A finished simulation as the engine produced it: the central run (`Ignition`: minute each cell starts burning, −1 = never), the ensemble members' runs,
/// intensity and crown-fire flags, all on `Grid`. `Attachments` are named blobs the caller wants kept with the run (the engine does not interpret them).
/// </summary>
public sealed record StoredRun(string Id, EngineGrid Grid, int[] Ignition, int[][] Members, ushort[] IntensityKwm, byte[] Flags, IReadOnlyDictionary<string, byte[]> Attachments);
