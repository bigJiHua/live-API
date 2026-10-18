package datamgr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"live/api/internal/db"
)

// ============================================================================
// 数据管理模型 —— from: model/index.js
// ============================================================================

// tableNameRe 对应 safeTableName 的白名单：/^[A-Za-z0-9_]+$/。
var tableNameRe = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

// safeTableName 对应 safeTableName(tableName)：非法表名抛错（status=400 语义）。
func safeTableName(tableName string) (string, error) {
	if !tableNameRe.MatchString(orEmpty(tableName)) {
		return "", errBadTable
	}
	return tableName, nil
}

var errBadTable = errors.New("非法表名")

// getTableList SHOW TABLES，返回表名数组（对应 Object.values(t)[0]）。
func getTableList() ([]string, error) {
	rows, err := db.DB().Query("SHOW TABLES")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []string{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		out = append(out, toStr(normVal(vals[0])))
	}
	return out, rows.Err()
}

// getTableStatus SHOW TABLE STATUS，返回结构化表状态。
func getTableStatus() ([]map[string]any, error) {
	rows, err := queryRows(db.DB(), "SHOW TABLE STATUS")
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, t := range rows {
		out = append(out, map[string]any{
			// 🔒 SYNC-A41（2026-10-13）：此处原用 firstValue(t) 取「map 任意一个值」。
			// firstValue 只适用于**单列**结果（SHOW TABLES）；而 SHOW TABLE STATUS 有 18 列，
			// Go 的 map 遍历顺序随机 ⇒ name 可能返回 Engine / Rows / Comment / Data_length…
			// ⇒ GET /data-manager/status 的表名是随机值，前端按表名索引全面错乱。
			// Node dataManager/model/index.js:22 是 `name: table.Name`（按列名取）。
			"name":        t["Name"],
			"engine":      t["Engine"],
			"rowCount":    t["Rows"],
			"dataLength":  t["Data_length"],
			"indexLength": t["Index_length"],
			"createTime":  t["Create_time"],
			"updateTime":  t["Update_time"],
			"collation":   t["Collation"],
			"comment":     t["Comment"],
		})
	}
	return out, nil
}

// firstValue 对应 Object.values(t)[0]：取行 map 的任一值。
//
// ⚠ 仅适用于**单列**结果（如 SHOW TABLES）。多列结果请按列名取值 ——
//
//	map 遍历顺序随机，多列时用它取"表名"会得到随机值（见 getTableStatus）。
func firstValue(row map[string]any) any {
	for _, v := range row {
		return v
	}
	return nil
}

// getTableStructure DESCRIBE，返回列结构。
func getTableStructure(tableName string) ([]map[string]any, error) {
	safe, err := safeTableName(tableName)
	if err != nil {
		return nil, err
	}
	rows, err := queryRows(db.DB(), "DESCRIBE `"+safe+"`")
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, col := range rows {
		out = append(out, map[string]any{
			"field":   col["Field"],
			"type":    col["Type"],
			"null":    col["Null"],
			"key":     col["Key"],
			"default": col["Default"],
			"extra":   col["Extra"],
		})
	}
	return out, nil
}

// getTableData 分页取表数据。
// fix BUG-015：pageSize 上限 1000（Node 版无上限，limit=100000 可拖库）。
func getTableData(tableName string, page, pageSize int) (map[string]any, error) {
	safe, err := safeTableName(tableName)
	if err != nil {
		return nil, err
	}
	if pageSize > 1000 {
		pageSize = 1000
	}
	if pageSize <= 0 {
		pageSize = 100
	}
	if page <= 0 {
		page = 1
	}
	offset := (page - 1) * pageSize

	rows, err := queryRows(db.DB(),
		"SELECT * FROM `"+safe+"` LIMIT ? OFFSET ?", pageSize, offset)
	if err != nil {
		return nil, err
	}
	countRow, err := queryRow(db.DB(), "SELECT COUNT(*) as total FROM `"+safe+"`")
	if err != nil {
		return nil, err
	}
	total := any(0)
	if countRow != nil {
		total = orZero(countRow["total"])
	}
	return map[string]any{
		"data":     rows,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	}, nil
}

// getFullTableData 对应 getFullTableData。
func getFullTableData(tableName string) ([]map[string]any, error) {
	safe, err := safeTableName(tableName)
	if err != nil {
		return nil, err
	}
	return queryRows(db.DB(), "SELECT * FROM `"+safe+"`")
}

// truncateTable TRUNCATE TABLE。
func truncateTable(tableName string) error {
	safe, err := safeTableName(tableName)
	if err != nil {
		return err
	}
	_, err = db.DB().Exec("TRUNCATE TABLE `" + safe + "`")
	return err
}

// dropTable DROP TABLE IF EXISTS。
func dropTable(tableName string) error {
	safe, err := safeTableName(tableName)
	if err != nil {
		return err
	}
	_, err = db.DB().Exec("DROP TABLE IF EXISTS `" + safe + "`")
	return err
}

// insertBatch 对应 insertBatch（事务内逐行 INSERT），返回 affectedRows。
func insertBatch(tableName string, data []map[string]any) (int64, error) {
	if len(data) == 0 {
		return 0, nil
	}
	safe, err := safeTableName(tableName)
	if err != nil {
		return 0, err
	}

	columns := make([]string, 0)
	for k := range data[0] {
		columns = append(columns, k)
	}
	// 稳定列顺序（Node Object.keys 顺序为插入序；Go map 无序，排序保证一致）
	sortStrings(columns)
	quoted := make([]string, len(columns))
	for i, c := range columns {
		quoted[i] = "`" + c + "`"
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?, ", len(columns)), ", ")
	sqlText := "INSERT INTO `" + safe + "` (" + strings.Join(quoted, ",") + ") VALUES (" + placeholders + ")"

	tx, err := db.GetPool().BeginTx(context.Background(), nil)
	if err != nil {
		return 0, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	for _, row := range data {
		args := make([]any, len(columns))
		for i, c := range columns {
			v := row[c]
			if v == nil {
				args[i] = nil // Node: row[col] === undefined ? null : row[col]
			} else {
				args[i] = v
			}
		}
		if _, err := tx.Exec(sqlText, args...); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	committed = true
	return int64(len(data)), nil
}

// getColumnNames SHOW COLUMNS，返回列名数组。
func getColumnNames(tableName string) ([]string, error) {
	safe, err := safeTableName(tableName)
	if err != nil {
		return nil, err
	}
	rows, err := queryRows(db.DB(), "SHOW COLUMNS FROM `"+safe+"`")
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, toStr(row["Field"]))
	}
	return out, nil
}

// ===== 助手 =====

// queryRows 查询多行并转 []map（列名 → 值）。
func queryRows(ex db.Commiter, query string, args ...any) ([]map[string]any, error) {
	rows, err := ex.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := make(map[string]any, len(cols))
		for i, c := range cols {
			m[c] = normVal(vals[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// queryRow 查询首行；无行返回 (nil, nil)。
func queryRow(ex db.Commiter, query string, args ...any) (map[string]any, error) {
	rows, err := queryRows(ex, query, args...)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}

// normVal []byte→string；time.Time→Node JSON.stringify(Date) 的 UTC ISO 串。
func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	case time.Time:
		return t.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return v
}

// toStr 对应 String(v) 常用子集。
func toStr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	return fmt.Sprintf("%v", v)
}

// orZero 对应 `x || 0`（nil → 0）。
func orZero(v any) any {
	if v == nil {
		return 0
	}
	return v
}

// orEmpty 空串 → 空串（占位，保持 safeTableName 与 Node `tableName || ”` 一致）。
func orEmpty(s string) string { return s }

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
