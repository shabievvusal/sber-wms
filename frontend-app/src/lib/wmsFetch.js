// Единственное место в проекте, где JS обязан работать в браузере: получение
// данных из wwh.samokat.ru требует токена ТЕКУЩЕЙ сессии пользователя — сервер
// сходить туда сам не может. Портировано как есть из
// ../../zlp-main-main/frontend/app/src/api/index.js (fetchRkFromWms), без
// логики уровня приложения — только сеть.
//
// Запросы разложены по разделам в lib/wms/*.js, здесь — общая точка входа.
export { getStoredToken, getWmsWarehouseId, switchWmsWarehouse } from './wms/core.js'
export { fetchRouteFromWMS, getShipmentOrders, getShipmentOrderDetail, fetchRkFromWms } from './wms/shipments.js'
export { getLiveMonitorViaBrowser, getPieceSelectionTasks, getPblZones, getPblGate, getPblTaskByBarcode, getProductsById, fetchLastKdkCompletedForExecutor, fetchLastCompletedForExecutor } from './wms/picking.js'
export { fetchDataViaBrowser, fetchPlacementViaBrowser, fetchRemainsViaBrowser, mergeNewEmployees, fetchStockMovesViaBrowser, fetchReceivingViaBrowser } from './wms/collect.js'
export { fetchInboundAroundDate, getReportMonitoringStats, getInboundTasks, getReportInboundInProgress, getReportInboundCompleted, getReportMovementsCount, getReportMovementsRest, getReportMoveToPickingCount, getReportMoveToPickingRest, getInboundTaskResponsibleUsers, getInboundTaskDetail, getEoRemaining } from './wms/reports.js'
export { fetchZgzMoves, syncZgzFromWms, fetchZoneCells } from './wms/zgz.js'
export { findProductsByBarcode, fetchProductStock, fetchWmsProductWeight, fillWeightsFromWms, getEoPicking } from './wms/products.js'
