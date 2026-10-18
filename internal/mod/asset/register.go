package asset

import (
	"encoding/json"
	"strings"

	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// ============================================================================
// 总资产登记模型 —— from: model/register.js（SQL 逐字一致）
// ============================================================================

// registerTable 对应 AssetRegister.tableName = 'asset_register'。
const registerTable = "asset_register"

// RegisterCreate 对应 AssetRegister.create。from: asset/model/register.js:29-43
func RegisterCreate(userID string, totalAsset, creditDebt, totalBalance any, assetDetails any, remark any) (map[string]any, error) {
	id := idgen.BillID()
	now := tim.NowMS()
	today := formatLocalDate(tim.Now())
	registerTime := formatLocalDateTime(tim.Now())

	_, err := db.DB().Exec(`
      INSERT INTO `+registerTable+` 
      (id, user_id, total_asset, credit_debt, total_balance, asset_details, register_date, register_time, remark, create_time, update_time, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		id, userID, totalAsset, creditDebt, totalBalance,
		mustJSONString(assetDetails),
		today, registerTime,
		orNil(remark), now, now)
	if err != nil {
		return nil, err
	}

	return RegisterFindById(id, userID)
}

// mustJSONString 对应 JSON.stringify(assetDetails)（nil → "null"）。
func mustJSONString(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// parseRow 对应 AssetRegister.parseRow：解析行内 JSON 字段（mysql2 不自动解析 JSON/TEXT 列）。
// from: asset/model/register.js:48-66
func parseRow(row map[string]any) map[string]any {
	if row == nil {
		return nil
	}
	parsed := make(map[string]any, len(row))
	for k, v := range row {
		parsed[k] = v
	}
	for _, key := range []string{"asset_details", "exchange_rates"} {
		if s, ok := parsed[key].(string); ok {
			var v any
			dec := json.NewDecoder(strings.NewReader(s))
			dec.UseNumber()
			// 🔒 SYNC-A43：只在解析失败时兜底成{}（Node 的 JSON.parse("null") 不抛错，保持 null）
			if err := dec.Decode(&v); err != nil {
				parsed[key] = map[string]any{}
			} else {
				parsed[key] = v
			}
		}
	}
	return parsed
}

// RegisterFindById 根据ID查询。from: asset/model/register.js:71-77
func RegisterFindById(id, userID string) (map[string]any, error) {
	row, err := qRow(db.DB(),
		`SELECT * FROM `+registerTable+` WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		id, userID)
	if err != nil {
		return nil, err
	}
	return parseRow(row), nil
}

// RegisterFindAll 获取用户所有登记记录。from: asset/model/register.js:82-103
func RegisterFindAll(userID, startDate, endDate string) ([]map[string]any, error) {
	whereClause := "WHERE user_id = ? AND is_deleted = 0"
	params := []any{userID}

	if startDate != "" {
		whereClause += " AND register_date >= ?"
		params = append(params, startDate)
	}
	if endDate != "" {
		whereClause += " AND register_date <= ?"
		params = append(params, endDate)
	}

	query := `
      SELECT * FROM ` + registerTable + `
      ` + whereClause + `
      ORDER BY register_date DESC, create_time DESC
    `
	rows, err := qRows(db.DB(), query, params...)
	if err != nil {
		return nil, err
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, parseRow(row))
	}
	return out, nil
}

// RegisterGetLatest 获取最新登记记录。from: asset/model/register.js:108-116
func RegisterGetLatest(userID string) (map[string]any, error) {
	row, err := qRow(db.DB(), `
      SELECT * FROM `+registerTable+` 
      WHERE user_id = ? AND is_deleted = 0
      ORDER BY register_date DESC, create_time DESC LIMIT 1`, userID)
	if err != nil {
		return nil, err
	}
	return parseRow(row), nil
}

// RegisterUpdate 更新登记记录。updates 采用「键存在即更新」语义（对应 Node updates[key] !== undefined）。
// from: asset/model/register.js:121-151
func RegisterUpdate(id, userID string, updates map[string]any) (map[string]any, error) {
	now := tim.NowMS()
	fields := []string{}
	params := []any{}

	allowedFields := []string{"total_asset", "credit_debt", "total_balance", "asset_details", "remark"}
	for _, key := range allowedFields {
		v, ok := updates[key]
		if !ok {
			continue
		}
		fields = append(fields, key+" = ?")
		if key == "asset_details" {
			// Node: JSON.stringify(updates[key])（null → null → SQL NULL）
			if v == nil {
				params = append(params, nil)
			} else {
				params = append(params, mustJSONString(v))
			}
		} else {
			params = append(params, v)
		}
	}

	if len(fields) == 0 {
		return RegisterFindById(id, userID)
	}

	fields = append(fields, "update_time = ?")
	params = append(params, now)
	params = append(params, id, userID)

	_, err := db.DB().Exec(
		`UPDATE `+registerTable+` SET `+strings.Join(fields, ", ")+` WHERE id = ? AND user_id = ? AND is_deleted = 0`,
		params...)
	if err != nil {
		return nil, err
	}
	return RegisterFindById(id, userID)
}

// RegisterDelete 删除登记记录。from: asset/model/register.js:156-163
func RegisterDelete(id, userID string) (bool, error) {
	res, err := db.DB().Exec(
		`UPDATE `+registerTable+` SET is_deleted = 1, update_time = ? WHERE id = ? AND user_id = ?`,
		tim.NowMS(), id, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// orNil 对应 remark || null。
func orNil(v any) any {
	if truthyJS(v) {
		return v
	}
	return nil
}
