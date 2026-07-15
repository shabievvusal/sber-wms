using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using BackendDotnet.Models;
using BackendDotnet.Json;

namespace BackendDotnet.Data;

// DbContext поверх УЖЕ СУЩЕСТВУЮЩЕЙ таблицы `routes` (создана Node,
// route-rk-pg.js init(), та же база `zlp`, что и vs_users/vs_sessions из
// Фазы 0) — здесь нет ни Database.EnsureCreated(), ни миграций: EF только
// читает/пишет по уже готовой схеме.
public class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }

    public DbSet<RouteEntity> Routes => Set<RouteEntity>();
    public DbSet<TsdAssignmentEntity> TsdAssignments => Set<TsdAssignmentEntity>();
    public DbSet<TsdManualEmployeeEntity> TsdManualEmployees => Set<TsdManualEmployeeEntity>();
    public DbSet<EmployeeEntity> Employees => Set<EmployeeEntity>();
    public DbSet<WmsOpEntity> WmsOps => Set<WmsOpEntity>();
    public DbSet<WmsPlacementEntity> WmsPlacement => Set<WmsPlacementEntity>();
    public DbSet<WmsReceivingEntity> WmsReceiving => Set<WmsReceivingEntity>();
    public DbSet<WmsRemainsEntity> WmsRemains => Set<WmsRemainsEntity>();
    public DbSet<ProductWeightEntity> ProductWeights => Set<ProductWeightEntity>();
    public DbSet<WmsStorageAggEntity> WmsStorageAgg => Set<WmsStorageAggEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Фаза 3 — storage.js (4 домена: ops/placement/receiving/remains).
        // Таблицы созданы бэкфилл-скриптом migrate-storage-json-to-pg.js
        // (тем же приёмом, что и остальные *-pg.js модули) — dotnet не
        // создаёт схему, только читает/пишет по готовой.
        var ops = modelBuilder.Entity<WmsOpEntity>();
        ops.ToTable("wms_ops");
        ops.HasKey(o => o.Id);
        ops.Property(o => o.Id).HasColumnName("id");
        ops.Property(o => o.Date).HasColumnName("date");
        ops.Property(o => o.Hour).HasColumnName("hour");
        ops.Property(o => o.MergeKey).HasColumnName("merge_key");
        ops.Property(o => o.ItemId).HasColumnName("item_id");
        ops.Property(o => o.Type).HasColumnName("type");
        ops.Property(o => o.OperationType).HasColumnName("operation_type");
        ops.Property(o => o.ProductName).HasColumnName("product_name");
        ops.Property(o => o.NomenclatureCode).HasColumnName("nomenclature_code");
        ops.Property(o => o.Barcodes).HasColumnName("barcodes");
        ops.Property(o => o.ProductionDate).HasColumnName("production_date");
        ops.Property(o => o.BestBeforeDate).HasColumnName("best_before_date");
        ops.Property(o => o.SourceBarcode).HasColumnName("source_barcode");
        ops.Property(o => o.Cell).HasColumnName("cell");
        ops.Property(o => o.TargetBarcode).HasColumnName("target_barcode");
        ops.Property(o => o.StartedAt).HasColumnName("started_at");
        ops.Property(o => o.CompletedAt).HasColumnName("completed_at");
        ops.Property(o => o.Executor).HasColumnName("executor");
        ops.Property(o => o.ExecutorId).HasColumnName("executor_id");
        ops.Property(o => o.SrcOld).HasColumnName("src_old");
        ops.Property(o => o.SrcNew).HasColumnName("src_new");
        ops.Property(o => o.TgtOld).HasColumnName("tgt_old");
        ops.Property(o => o.TgtNew).HasColumnName("tgt_new");
        ops.Property(o => o.Quantity).HasColumnName("quantity");

        var placement = modelBuilder.Entity<WmsPlacementEntity>();
        placement.ToTable("wms_placement");
        placement.HasKey(p => p.Id);
        placement.Property(p => p.Id).HasColumnName("id");
        placement.Property(p => p.Date).HasColumnName("date");
        placement.Property(p => p.Hour).HasColumnName("hour");
        placement.Property(p => p.MergeKey).HasColumnName("merge_key");
        placement.Property(p => p.ItemId).HasColumnName("item_id");
        placement.Property(p => p.Status).HasColumnName("status");
        placement.Property(p => p.HandlingUnitBarcode).HasColumnName("handling_unit_barcode");
        placement.Property(p => p.SourceCellAddress).HasColumnName("source_cell_address");
        placement.Property(p => p.TargetCellAddress).HasColumnName("target_cell_address");
        placement.Property(p => p.SourceZoneId).HasColumnName("source_zone_id");
        placement.Property(p => p.SourceZoneName).HasColumnName("source_zone_name");
        placement.Property(p => p.ExecutorId).HasColumnName("executor_id");
        placement.Property(p => p.Executor).HasColumnName("executor");
        placement.Property(p => p.CreatedAt).HasColumnName("created_at");
        placement.Property(p => p.Issue).HasColumnName("issue");
        placement.Property(p => p.Condition).HasColumnName("condition");
        placement.Property(p => p.TemperatureMode).HasColumnName("temperature_mode");
        placement.Property(p => p.SkuCount).HasColumnName("sku_count");
        var placementTargetCells = placement.Property(p => p.TargetCellsAddresses)
            .HasColumnName("target_cells_addresses").HasColumnType("jsonb")
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonOptions.Default),
                v => string.IsNullOrEmpty(v) ? new List<string>() : JsonSerializer.Deserialize<List<string>>(v, JsonOptions.Default) ?? new List<string>());
        placementTargetCells.Metadata.SetValueComparer(ListComparer<string>());
        placement.Property(p => p.ResponsibleUser).HasColumnName("responsible_user").HasColumnType("jsonb")
            .HasConversion(JsonConverter<ResponsibleUser>()).Metadata.SetValueComparer(ObjectComparer<ResponsibleUser>());

        var receiving = modelBuilder.Entity<WmsReceivingEntity>();
        receiving.ToTable("wms_receiving");
        receiving.HasKey(r => r.Id);
        receiving.Property(r => r.Id).HasColumnName("id");
        receiving.Property(r => r.Date).HasColumnName("date");
        receiving.Property(r => r.Hour).HasColumnName("hour");
        receiving.Property(r => r.MergeKey).HasColumnName("merge_key");
        receiving.Property(r => r.ItemId).HasColumnName("item_id");
        receiving.Property(r => r.Status).HasColumnName("status");
        receiving.Property(r => r.Type).HasColumnName("type");
        receiving.Property(r => r.TaskNumber).HasColumnName("task_number");
        receiving.Property(r => r.OrderNumber).HasColumnName("order_number");
        receiving.Property(r => r.SupplierName).HasColumnName("supplier_name");
        receiving.Property(r => r.StartedAt).HasColumnName("started_at");
        receiving.Property(r => r.ExecutorId).HasColumnName("executor_id");
        receiving.Property(r => r.Executor).HasColumnName("executor");
        receiving.Property(r => r.CompletedAt).HasColumnName("completed_at");
        receiving.Property(r => r.VolumeInMilliliters).HasColumnName("volume_in_milliliters");
        receiving.Property(r => r.WeightInGrams).HasColumnName("weight_in_grams");
        receiving.Property(r => r.EoCount).HasColumnName("eo_count");
        receiving.Property(r => r.ResponsibleUser).HasColumnName("responsible_user").HasColumnType("jsonb")
            .HasConversion(JsonConverter<ResponsibleUser>()).Metadata.SetValueComparer(ObjectComparer<ResponsibleUser>());

        var remains = modelBuilder.Entity<WmsRemainsEntity>();
        remains.ToTable("wms_remains");
        remains.HasKey(r => r.Id);
        remains.Property(r => r.Id).HasColumnName("id");
        remains.Property(r => r.Date).HasColumnName("date");
        remains.Property(r => r.Hour).HasColumnName("hour");
        remains.Property(r => r.MergeKey).HasColumnName("merge_key");
        remains.Property(r => r.ItemId).HasColumnName("item_id");
        remains.Property(r => r.Status).HasColumnName("status");
        remains.Property(r => r.TaskType).HasColumnName("task_type");
        remains.Property(r => r.SourceCellAddress).HasColumnName("source_cell_address");
        remains.Property(r => r.SourceHandlingUnitBarcode).HasColumnName("source_handling_unit_barcode");
        remains.Property(r => r.TargetCellAddress).HasColumnName("target_cell_address");
        remains.Property(r => r.TargetHandlingUnitBarcode).HasColumnName("target_handling_unit_barcode");
        remains.Property(r => r.ExecutorId).HasColumnName("executor_id");
        remains.Property(r => r.Executor).HasColumnName("executor");
        remains.Property(r => r.CreatedAt).HasColumnName("created_at");
        remains.Property(r => r.ResponsibleUser).HasColumnName("responsible_user").HasColumnType("jsonb")
            .HasConversion(JsonConverter<ResponsibleUser>()).Metadata.SetValueComparer(ObjectComparer<ResponsibleUser>());
        var consolidationItems = remains.Property(r => r.ConsolidationItems)
            .HasColumnName("consolidation_items").HasColumnType("jsonb")
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonOptions.Default),
                v => string.IsNullOrEmpty(v) ? new List<JsonElement>() : JsonSerializer.Deserialize<List<JsonElement>>(v, JsonOptions.Default) ?? new List<JsonElement>());
        consolidationItems.Metadata.SetValueComparer(ListComparer<JsonElement>());

        var weights = modelBuilder.Entity<ProductWeightEntity>();
        weights.ToTable("product_weights");
        weights.HasKey(w => w.Article);
        weights.Property(w => w.Article).HasColumnName("article");
        weights.Property(w => w.Grams).HasColumnName("grams");

        var storageAgg = modelBuilder.Entity<WmsStorageAggEntity>();
        storageAgg.ToTable("wms_storage_agg");
        storageAgg.HasKey(s => new { s.Date, s.Shift });
        storageAgg.Property(s => s.Date).HasColumnName("date");
        storageAgg.Property(s => s.Shift).HasColumnName("shift");
        storageAgg.Property(s => s.TotalStorageCount).HasColumnName("total_storage_count");
        storageAgg.Property(s => s.TotalWeightGrams).HasColumnName("total_weight_grams");
        var storageByHour = storageAgg.Property(s => s.StorageByHour).HasColumnName("storage_by_hour").HasColumnType("jsonb")
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonOptions.Default),
                v => string.IsNullOrEmpty(v) ? new Dictionary<string, decimal>() : JsonSerializer.Deserialize<Dictionary<string, decimal>>(v, JsonOptions.Default) ?? new Dictionary<string, decimal>());
        storageByHour.Metadata.SetValueComparer(DictComparer<decimal>());
        var weightByEmployee = storageAgg.Property(s => s.WeightByEmployee).HasColumnName("weight_by_employee").HasColumnType("jsonb")
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonOptions.Default),
                v => string.IsNullOrEmpty(v) ? new Dictionary<string, decimal>() : JsonSerializer.Deserialize<Dictionary<string, decimal>>(v, JsonOptions.Default) ?? new Dictionary<string, decimal>());
        weightByEmployee.Metadata.SetValueComparer(DictComparer<decimal>());

        var tsd = modelBuilder.Entity<TsdAssignmentEntity>();
        tsd.ToTable("tsd_assignments");
        tsd.HasKey(t => t.Id);
        tsd.Property(t => t.Id).HasColumnName("id");
        tsd.Property(t => t.ExecutorId).HasColumnName("executor_id");
        tsd.Property(t => t.Fio).HasColumnName("fio");
        tsd.Property(t => t.Company).HasColumnName("company");
        tsd.Property(t => t.Tsd).HasColumnName("tsd");
        tsd.Property(t => t.AssignedAt).HasColumnName("assigned_at");
        tsd.Property(t => t.ReturnedAt).HasColumnName("returned_at");
        tsd.Property(t => t.ReturnedByExecutorId).HasColumnName("returned_by_executor_id");
        tsd.Property(t => t.ReturnedByFio).HasColumnName("returned_by_fio");
        tsd.Property(t => t.ReturnedByCompany).HasColumnName("returned_by_company");

        var tsdManual = modelBuilder.Entity<TsdManualEmployeeEntity>();
        tsdManual.ToTable("tsd_manual_employees");
        tsdManual.HasKey(t => t.Id);
        tsdManual.Property(t => t.Id).HasColumnName("id");
        tsdManual.Property(t => t.Fio).HasColumnName("fio");
        tsdManual.Property(t => t.Company).HasColumnName("company");
        tsdManual.Property(t => t.CreatedAt).HasColumnName("created_at");

        var empl = modelBuilder.Entity<EmployeeEntity>();
        empl.ToTable("employees");
        empl.HasKey(e => e.ExecutorId);
        empl.Property(e => e.ExecutorId).HasColumnName("executor_id");
        empl.Property(e => e.Fio).HasColumnName("fio");
        empl.Property(e => e.Company).HasColumnName("company");
        empl.Property(e => e.Phone).HasColumnName("phone");
        empl.Property(e => e.Password).HasColumnName("password");

        var route = modelBuilder.Entity<RouteEntity>();
        route.ToTable("routes");
        route.HasKey(r => r.RouteId);
        route.Property(r => r.RouteId).HasColumnName("route_id");
        route.Property(r => r.RouteNumber).HasColumnName("route_number");
        route.Property(r => r.Date).HasColumnName("date");
        route.Property(r => r.LogisticsCompany).HasColumnName("logistics_company");
        route.Property(r => r.ImportedAt).HasColumnName("imported_at");

        // ВАЖНО: везде, где эти свойства обновляются (Services/RouteService.cs),
        // всегда присваивается НОВЫЙ объект (не мутируются поля существующего) —
        // так смена значения гарантированно ловится трекингом изменений EF
        // (сравнение по ссылке) независимо от ValueComparer. ValueComparer ниже —
        // дополнительная подстраховка (сериализованное сравнение), а не замена
        // этому правилу.
        route.Property(r => r.Driver).HasColumnName("driver").HasColumnType("jsonb")
            .HasConversion(JsonConverter<Driver?>()).Metadata.SetValueComparer(ObjectComparer<Driver?>());
        route.Property(r => r.Vehicle).HasColumnName("vehicle").HasColumnType("jsonb")
            .HasConversion(JsonConverter<Vehicle?>()).Metadata.SetValueComparer(ObjectComparer<Vehicle?>());
        route.Property(r => r.Shipment).HasColumnName("shipment").HasColumnType("jsonb")
            .HasConversion(JsonConverter<ShipmentInfo?>()).Metadata.SetValueComparer(ObjectComparer<ShipmentInfo?>());
        route.Property(r => r.Receiving).HasColumnName("receiving").HasColumnType("jsonb")
            .HasConversion(JsonConverter<ReceivingInfo?>()).Metadata.SetValueComparer(ObjectComparer<ReceivingInfo?>());

        var cfzProp = route.Property(r => r.CfzAddresses).HasColumnName("cfz_addresses").HasColumnType("jsonb")
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonOptions.Default),
                v => string.IsNullOrEmpty(v) ? new List<CfzAddress>() : JsonSerializer.Deserialize<List<CfzAddress>>(v, JsonOptions.Default) ?? new List<CfzAddress>());
        cfzProp.Metadata.SetValueComparer(ListComparer<CfzAddress>());
    }

    // Небольшой generic-хелпер для JSONB-колонок с одиночным объектом
    // (Driver/Vehicle/ShipmentInfo/ReceivingInfo) — сериализация/десериализация
    // через общие camelCase-настройки (JsonOptions.Default), чтобы поля внутри
    // JSONB совпадали с тем, что Node писал (name/phone, tempBefore и т.д.).
    private static Microsoft.EntityFrameworkCore.Storage.ValueConversion.ValueConverter<T, string?> JsonConverter<T>()
        => new(
            v => v == null ? null : JsonSerializer.Serialize(v, JsonOptions.Default),
            v => string.IsNullOrEmpty(v) ? default! : JsonSerializer.Deserialize<T>(v, JsonOptions.Default)!);

    private static ValueComparer<List<T>> ListComparer<T>()
        => new(
            (a, b) => JsonSerializer.Serialize(a, JsonOptions.Default) == JsonSerializer.Serialize(b, JsonOptions.Default),
            v => JsonSerializer.Serialize(v, JsonOptions.Default).GetHashCode(),
            v => JsonSerializer.Deserialize<List<T>>(JsonSerializer.Serialize(v, JsonOptions.Default), JsonOptions.Default)!);

    private static ValueComparer<T> ObjectComparer<T>()
        => new(
            (a, b) => JsonSerializer.Serialize(a, JsonOptions.Default) == JsonSerializer.Serialize(b, JsonOptions.Default),
            v => JsonSerializer.Serialize(v, JsonOptions.Default).GetHashCode(),
            v => JsonSerializer.Deserialize<T>(JsonSerializer.Serialize(v, JsonOptions.Default), JsonOptions.Default)!);

    private static ValueComparer<Dictionary<string, T>> DictComparer<T>()
        => new(
            (a, b) => JsonSerializer.Serialize(a, JsonOptions.Default) == JsonSerializer.Serialize(b, JsonOptions.Default),
            v => JsonSerializer.Serialize(v, JsonOptions.Default).GetHashCode(),
            v => JsonSerializer.Deserialize<Dictionary<string, T>>(JsonSerializer.Serialize(v, JsonOptions.Default), JsonOptions.Default)!);
}
