namespace FireTrace.ExternalData;

/// <summary>Keys of the services that exist in more than one flavour (see <see cref="ServiceCollectionExtensions.AddExternalData"/>).</summary>
public static class ExternalDataServiceKeys
{
    /// <summary>The <see cref="Store.IMapReader"/> that always reads from the database, without the in-memory cache (the ingest must see what it just wrote).</summary>
    public const string UncachedReader = "external-data-uncached-reader";
}
