package card

import (
	"live/api/internal/db"
	"live/api/internal/idgen"
	"live/api/internal/tim"
)

// 卡片操作日志模型 - 对应数据库 card_log 表 —— from: model/log.js

// logTable 对应 CardLog.tableName = 'card_log'。
const logTable = "card_log"

// LogFindAll 对应 CardLog.findAll(userId, filters)（当前无路由暴露，按模型层 1:1 复刻）。
// from: log.js:13-36
func LogFindAll(userID string, filters map[string]any) ([]map[string]any, error) {
	whereClause := "WHERE cl.user_id = ?"
	params := []any{userID}

	if v, ok := filters["cardId"]; ok && truthy(v) {
		whereClause += " AND cl.card_id = ?"
		params = append(params, toStr(v))
	}
	if v, ok := filters["operateType"]; ok && truthy(v) {
		whereClause += " AND cl.operate_type = ?"
		params = append(params, toStr(v))
	}

	query := `
      SELECT cl.*, c.alias as card_alias, c.last4_no as card_last4
      FROM card_log cl
      LEFT JOIN card_base c ON cl.card_id = c.id
      ` + whereClause + `
      ORDER BY cl.operate_time DESC
    `
	return qRows(db.DB(), query, params...)
}

// LogCreate 对应 CardLog.create：写一条操作日志。
// from: log.js:41-60
func LogCreate(userID, cardID, operateType, operateTime, operateIP string) (map[string]any, error) {
	id := idgen.BillID()
	query := `
      INSERT INTO card_log (
        id, card_id, user_id, operate_type, operate_time, operate_ip, is_deleted
      ) VALUES (?, ?, ?, ?, ?, ?, 0)
    `
	if _, err := db.DB().Exec(query, []any{
		id, cardID, userID, operateType,
		operateTimeOrNow(operateTime), // Node `operateTime || String(Date.now())`
		operateIP,                     // Node `operateIp || ''`
	}...); err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "cardId": cardID, "userId": userID, "operateType": operateType}, nil
}

// Log 对应 CardLog.log(cardId, userId, operateType, operateIp)。
// from: log.js:65-73
func Log(cardID, userID, operateType, operateIP string) error {
	_, err := LogCreate(userID, cardID, operateType, tim.NowMS(), operateIP)
	return err
}

func operateTimeOrNow(s string) string {
	if s == "" {
		return tim.NowMS()
	}
	return s
}
