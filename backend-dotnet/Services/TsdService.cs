using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Перенос tsd-pg.js 1-в-1: активная выдача — returned_at IS NULL,
// история — строками (уникальный индекс в БД гарантирует одну активную
// выдачу на ТСД, как и в оригинале).
public class TsdService
{
    private readonly AppDbContext _db;

    public TsdService(AppDbContext db)
    {
        _db = db;
    }

    private static string Clean(string? value) => (value ?? "").Trim();

    private static TsdAssignment ToAssignment(TsdAssignmentEntity e) => new()
    {
        Id = e.Id,
        ExecutorId = e.ExecutorId,
        Fio = e.Fio,
        Company = e.Company,
        Tsd = e.Tsd,
        AssignedAt = e.AssignedAt.ToString("o"),
        ReturnedAt = e.ReturnedAt?.ToString("o"),
        ReturnedByExecutorId = e.ReturnedByExecutorId,
        ReturnedByFio = e.ReturnedByFio,
        ReturnedByCompany = e.ReturnedByCompany,
    };

    public async Task<List<TsdAssignment>> ListActiveAsync()
    {
        var rows = await _db.TsdAssignments.AsNoTracking()
            .Where(t => t.ReturnedAt == null)
            .OrderByDescending(t => t.AssignedAt)
            .ToListAsync();
        return rows.Select(ToAssignment).ToList();
    }

    public async Task<TsdAssignment> AssignAsync(TsdAssignRequest req)
    {
        var id = Clean(req.ExecutorId);
        var name = Clean(req.Fio);
        var comp = Clean(req.Company);
        var device = Clean(req.Tsd);
        if (id == "") throw new ArgumentException("executorId обязателен");
        if (device == "") throw new ArgumentException("Номер ТСД обязателен");

        await using var tx = await _db.Database.BeginTransactionAsync();
        var active = await _db.TsdAssignments
            .Where(t => t.ReturnedAt == null && t.Tsd == device)
            .ToListAsync();
        foreach (var a in active) a.ReturnedAt = DateTime.UtcNow;

        var entity = new TsdAssignmentEntity
        {
            ExecutorId = id,
            Fio = name,
            Company = comp,
            Tsd = device,
            AssignedAt = DateTime.UtcNow,
        };
        _db.TsdAssignments.Add(entity);
        await _db.SaveChangesAsync();
        await tx.CommitAsync();
        return ToAssignment(entity);
    }

    public async Task<TsdAssignment?> ReturnByExecutorAsync(string? executorId)
    {
        var id = Clean(executorId);
        if (id == "") throw new ArgumentException("executorId обязателен");
        var entity = await _db.TsdAssignments
            .FirstOrDefaultAsync(t => t.ExecutorId == id && t.ReturnedAt == null);
        if (entity == null) return null;
        entity.ReturnedAt = DateTime.UtcNow;
        await _db.SaveChangesAsync();
        return ToAssignment(entity);
    }

    public async Task<(TsdAssignment? Assignment, bool ForeignReturn)> ReturnByTsdAsync(TsdReturnByTsdRequest req)
    {
        var device = Clean(req.Tsd);
        if (device == "") throw new ArgumentException("Номер ТСД обязателен");
        var byId = Clean(req.ReturnedByExecutorId);
        var byFio = Clean(req.ReturnedByFio);
        var byCompany = Clean(req.ReturnedByCompany);

        var entity = await _db.TsdAssignments
            .FirstOrDefaultAsync(t => t.Tsd == device && t.ReturnedAt == null);
        if (entity == null) return (null, false);

        entity.ReturnedAt = DateTime.UtcNow;
        entity.ReturnedByExecutorId = byId;
        entity.ReturnedByFio = byFio;
        entity.ReturnedByCompany = byCompany;
        await _db.SaveChangesAsync();

        var assignment = ToAssignment(entity);
        var foreignReturn = byId != "" && assignment.ExecutorId != "" && byId != assignment.ExecutorId;
        return (assignment, foreignReturn);
    }

    public async Task<TsdSettings> GetSettingsAsync()
    {
        var rows = await _db.Database.SqlQueryRaw<string>(
            "SELECT value AS \"Value\" FROM tsd_settings WHERE key = 'total_count'").ToListAsync();
        var totalCount = rows.Count > 0 && int.TryParse(rows[0], out var v) ? Math.Max(0, v) : 0;
        return new TsdSettings { TotalCount = totalCount };
    }

    public async Task<TsdSettings> SetSettingsAsync(TsdSettingsRequest req)
    {
        var count = Math.Max(0, req.TotalCount);
        await _db.Database.ExecuteSqlInterpolatedAsync(
            $"INSERT INTO tsd_settings (key, value) VALUES ('total_count', {count.ToString()}) ON CONFLICT (key) DO UPDATE SET value = {count.ToString()}");
        return await GetSettingsAsync();
    }

    private static TsdManualEmployee ToManualEmployee(TsdManualEmployeeEntity e) => new()
    {
        Id = e.Id,
        Fio = e.Fio,
        Company = e.Company,
    };

    public async Task<List<TsdManualEmployee>> ListManualEmployeesAsync()
    {
        var rows = await _db.TsdManualEmployees.AsNoTracking()
            .OrderBy(e => e.Fio)
            .ToListAsync();
        return rows.Select(ToManualEmployee).ToList();
    }

    public async Task<TsdManualEmployee> AddManualEmployeeAsync(TsdManualEmployeeRequest req)
    {
        var fio = Clean(req.Fio);
        var company = Clean(req.Company);
        if (fio == "") throw new ArgumentException("ФИО обязательно");

        var entity = new TsdManualEmployeeEntity
        {
            Id = "manual-" + Guid.NewGuid().ToString("N")[..12],
            Fio = fio,
            Company = company,
            CreatedAt = DateTime.UtcNow,
        };
        _db.TsdManualEmployees.Add(entity);
        await _db.SaveChangesAsync();
        return ToManualEmployee(entity);
    }

    public async Task<TsdManualEmployee?> UpdateManualEmployeeAsync(string id, TsdManualEmployeeRequest req)
    {
        var entity = await _db.TsdManualEmployees.FirstOrDefaultAsync(e => e.Id == id);
        if (entity == null) return null;
        var fio = Clean(req.Fio);
        if (fio == "") throw new ArgumentException("ФИО обязательно");
        entity.Fio = fio;
        entity.Company = Clean(req.Company);
        await _db.SaveChangesAsync();
        return ToManualEmployee(entity);
    }

    public async Task<bool> DeleteManualEmployeeAsync(string id)
    {
        var entity = await _db.TsdManualEmployees.FirstOrDefaultAsync(e => e.Id == id);
        if (entity == null) return false;
        _db.TsdManualEmployees.Remove(entity);
        await _db.SaveChangesAsync();
        return true;
    }
}
