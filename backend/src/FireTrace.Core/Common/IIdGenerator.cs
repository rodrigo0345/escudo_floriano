namespace FireTrace.Core.Common;

/// <summary>Creates the ids of new resources, so the services that need one stay deterministic under test.</summary>
public interface IIdGenerator
{
    /// <summary>A short, readable id such as `veh-3f9a1c2b7d`.</summary>
    string New(string prefix);
}
