using System.Globalization;
using Microsoft.EntityFrameworkCore;
using BackendDotnet.Data;
using BackendDotnet.Models;

namespace BackendDotnet.Services;

// Подсчёт и удаление данных за смену (Настройки, admin/developer) по всем таблицам операций.
public partial class StatsService
{
    // ─── Удаление/подсчёт данных за смену (Настройки → Система, admin/developer) ──
    //
    // Та же граница смены, что и в GetShiftKeyFromMoscowDateHour/ListShiftsAsync
    // (day: 9–20 тот же день; night: 21–23 тот же день + 0–8 следующий).
    // Предикат написан отдельно на каждый из 4 DbSet (не через общий generic-
    // метод с интерфейсным ограничением) намеренно: EF Core транслирует
    // LINQ-выражение в SQL по member'ам КОНКРЕТНОГО типа сущности — если бы
    // `x.Date`/`x.Hour` резолвились через member интерфейса (как было бы при
    // `IQueryable<T> where T : IHasDateHour`), EF мог бы не найти маппинг и
    // либо упасть на трансляции, либо тихо уйти в client-evaluation. 4 почти
    // одинаковых метода — осознанный компромисс ради гарантированно рабочего
    // перевода в SQL, а не ради сухости кода.

    private static void ValidateShiftArgs(string dateStr, string shift)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(dateStr, @"^\d{4}-\d{2}-\d{2}$") || !DateOnly.TryParse(dateStr, out _))
            throw new ArgumentException("Неверный формат даты (YYYY-MM-DD)");
        if (shift != "day" && shift != "night")
            throw new ArgumentException("shift должен быть 'day' или 'night'");
    }

    private IQueryable<WmsOpEntity> OpsInShift(DateOnly date, string shift) =>
        shift == "day"
            ? _db.WmsOps.Where(x => x.Date == date && x.Hour >= 9 && x.Hour <= 20)
            : _db.WmsOps.Where(x => (x.Date == date && x.Hour >= 21) || (x.Date == date.AddDays(1) && x.Hour <= 8));

    private IQueryable<WmsPlacementEntity> PlacementInShift(DateOnly date, string shift) =>
        shift == "day"
            ? _db.WmsPlacement.Where(x => x.Date == date && x.Hour >= 9 && x.Hour <= 20)
            : _db.WmsPlacement.Where(x => (x.Date == date && x.Hour >= 21) || (x.Date == date.AddDays(1) && x.Hour <= 8));

    private IQueryable<WmsReceivingEntity> ReceivingInShift(DateOnly date, string shift) =>
        shift == "day"
            ? _db.WmsReceiving.Where(x => x.Date == date && x.Hour >= 9 && x.Hour <= 20)
            : _db.WmsReceiving.Where(x => (x.Date == date && x.Hour >= 21) || (x.Date == date.AddDays(1) && x.Hour <= 8));

    private IQueryable<WmsRemainsEntity> RemainsInShift(DateOnly date, string shift) =>
        shift == "day"
            ? _db.WmsRemains.Where(x => x.Date == date && x.Hour >= 9 && x.Hour <= 20)
            : _db.WmsRemains.Where(x => (x.Date == date && x.Hour >= 21) || (x.Date == date.AddDays(1) && x.Hour <= 8));

    private IQueryable<WmsStockMoveEntity> StockMovesInShift(DateOnly date, string shift) =>
        shift == "day"
            ? _db.WmsStockMoves.Where(x => x.Date == date && x.Hour >= 9 && x.Hour <= 20)
            : _db.WmsStockMoves.Where(x => (x.Date == date && x.Hour >= 21) || (x.Date == date.AddDays(1) && x.Hour <= 8));

    public async Task<ShiftDataCounts> CountShiftDataAsync(string dateStr, string shift)
    {
        ValidateShiftArgs(dateStr, shift);
        var date = DateOnly.Parse(dateStr);
        return new ShiftDataCounts
        {
            Ops = await OpsInShift(date, shift).CountAsync(),
            Placement = await PlacementInShift(date, shift).CountAsync(),
            Receiving = await ReceivingInShift(date, shift).CountAsync(),
            Remains = await RemainsInShift(date, shift).CountAsync(),
            StockMoves = await StockMovesInShift(date, shift).CountAsync(),
        };
    }

    public async Task<ShiftDataCounts> DeleteShiftDataAsync(string dateStr, string shift)
    {
        ValidateShiftArgs(dateStr, shift);
        var date = DateOnly.Parse(dateStr);
        return new ShiftDataCounts
        {
            Ops = await OpsInShift(date, shift).ExecuteDeleteAsync(),
            Placement = await PlacementInShift(date, shift).ExecuteDeleteAsync(),
            Receiving = await ReceivingInShift(date, shift).ExecuteDeleteAsync(),
            Remains = await RemainsInShift(date, shift).ExecuteDeleteAsync(),
            StockMoves = await StockMovesInShift(date, shift).ExecuteDeleteAsync(),
        };
    }
}
