// Package datamgr 复刻 src/modules/dataManager（数据管理：备份/导出/导入，管理员）。
// Node 挂载于 /api/v1/data-manager（api/index.js: router.use("/data-manager", dataManagerRouter)）。
package datamgr

import (
	"database/sql"
	"errors"
	"net/http"

	"live/api/internal/db"
	"live/api/internal/mw"
	"live/api/internal/resp"
	"live/api/internal/srv"
)

func init() { srv.Add("dataManager", Register) }

// requireAdmin 对应 api/index.js 的 requireAdmin：SELECT identity='admin'。
func requireAdmin(fn http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid := resp.UID(r)
		var identity string
		err := db.DB().QueryRow(
			"SELECT identity FROM user_info WHERE id = ? AND is_deleted = 0 LIMIT 1", uid).Scan(&identity)
		if err != nil {
			// 🔒 SYNC-A26（2026-10-12）：Node 是 `rows[0]?.identity !== 'admin'`
			//   ⇒ 用户不存在（无行）时同样落到 403，不是 500
			//   （dataManager/api/index.js:25）。原 Go 把 ErrNoRows 当 DB 异常 ⇒ 500。
			if err == sql.ErrNoRows || errors.Is(err, sql.ErrNoRows) {
				resp.JSON(w, 403, map[string]any{"status": 403, "message": "无权限访问数据管理功能"})
				return
			}
			resp.JSON(w, 500, map[string]any{"status": 500, "message": "权限检查失败"})
			return
		}
		if identity != "admin" {
			resp.JSON(w, 403, map[string]any{"status": 403, "message": "无权限访问数据管理功能"})
			return
		}
		fn(w, r)
	}
}

// Register 路由顺序严格同 Node src/modules/dataManager/api/index.js。
// 所有路由均挂 authGuard + requireAdmin（router.use(authGuard, requireAdmin)）；
// 写操作路由另挂 pinLockGuard 并声明风险模式。
func Register(mux *http.ServeMux) {
	auth := []func(http.Handler) http.Handler{mw.AuthGuard}
	authPin := []func(http.Handler) http.Handler{mw.AuthGuard, mw.PinLockGuard}

	mw.Route(mux, "GET", "/api/v1/data-manager/tables", auth, requireAdmin(GetTableList))
	mw.Route(mux, "GET", "/api/v1/data-manager/status", auth, requireAdmin(GetTableStatus))
	mw.Route(mux, "GET", "/api/v1/data-manager/structure/{tableName}", auth, requireAdmin(GetTableStructure))
	mw.Route(mux, "GET", "/api/v1/data-manager/data/{tableName}", auth, requireAdmin(GetTableData))
	mw.Route(mux, "GET", "/api/v1/data-manager/export/table/{tableName}", auth, requireAdmin(ExportSingleTable))
	mw.Route(mux, "GET", "/api/v1/data-manager/export/full", auth, requireAdmin(ExportFullDatabase))
	mw.Route(mux, "POST", "/api/v1/data-manager/validate", auth, requireAdmin(ValidateImportData))
	mw.Route(mux, "POST", "/api/v1/data-manager/import", auth, requireAdmin(ImportData))
	// import/sql：fix BUG-013——Node 版 multer 未配 limits；Go 版 handler 内限制 10MB
	mw.Route(mux, "POST", "/api/v1/data-manager/import/sql", authPin, requireAdmin(ImportSql))
	mw.Protect("POST", "/api/v1/data-manager/import/sql")
	mw.Route(mux, "GET", "/api/v1/data-manager/backups", auth, requireAdmin(GetBackupList))
	mw.Route(mux, "POST", "/api/v1/data-manager/backups/system", auth, requireAdmin(CreateSystemBackup))
	mw.Route(mux, "GET", "/api/v1/data-manager/backups/system", auth, requireAdmin(GetSystemBackups))
	mw.Route(mux, "DELETE", "/api/v1/data-manager/backups/{filename}", authPin, requireAdmin(DeleteBackup))
	mw.Protect("DELETE", "/api/v1/data-manager/backups/:filename")
	mw.Route(mux, "GET", "/api/v1/data-manager/download/{filename}", auth, requireAdmin(DownloadBackup))
	mw.Route(mux, "GET", "/api/v1/data-manager/export/task/{taskId}", auth, requireAdmin(GetExportTaskStatus))
	mw.Route(mux, "DELETE", "/api/v1/data-manager/export/task/{taskId}", authPin, requireAdmin(CancelExportTask))
	mw.Protect("DELETE", "/api/v1/data-manager/export/task/:taskId")
}
